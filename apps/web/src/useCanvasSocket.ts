import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_COLOR_INDEX,
  PIXEL_COUNT,
  coordToOffset,
  type PixelUpdate,
  type ServerMessage,
  type UserView,
} from "@rplace/shared";

const LAST_SEQ_KEY = "rplace:last_seq";

export type ConnectionStatus = "connecting" | "open" | "closed";

function wsUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws`;
}

function applyUpdate(pixels: number[], update: PixelUpdate): number[] {
  const next = pixels.slice();
  const offset = coordToOffset(update.x, update.y);
  if (offset >= 0 && offset < next.length) {
    next[offset] = update.color_index;
  }
  return next;
}

export function useCanvasSocket(mockUserId: string | undefined) {
  const [pixels, setPixels] = useState<number[]>(() =>
    Array.from({ length: PIXEL_COUNT }, () => DEFAULT_COLOR_INDEX),
  );
  const [seq, setSeq] = useState(0);
  const [you, setYou] = useState<UserView | undefined>();
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [lastError, setLastError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const seqRef = useRef(0);
  const userRef = useRef(mockUserId);
  userRef.current = mockUserId;

  const applySeq = useCallback((next: number) => {
    seqRef.current = next;
    setSeq(next);
    sessionStorage.setItem(LAST_SEQ_KEY, String(next));
  }, []);

  useEffect(() => {
    let stopped = false;
    let retry = 0;
    let timer: number | undefined;

    const connect = () => {
      setStatus("connecting");
      const ws = new WebSocket(wsUrl());
      wsRef.current = ws;

      ws.onopen = () => {
        retry = 0;
        setStatus("open");
        const stored = sessionStorage.getItem(LAST_SEQ_KEY);
        const lastSeq = stored === null ? undefined : Number(stored);
        ws.send(
          JSON.stringify({
            type: "hello",
            mock_user_id: userRef.current,
            last_seq: lastSeq,
          }),
        );
      };

      ws.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as ServerMessage;
        if (message.type === "snapshot" || (message.type === "resync" && message.mode === "snapshot")) {
          setPixels(message.pixels);
          applySeq(message.seq);
          setYou(message.you);
          return;
        }
        if (message.type === "resync" && message.mode === "gap") {
          setYou(message.you);
        }
        if (message.type === "pixels" || (message.type === "resync" && message.mode === "gap")) {
          setPixels((current) => {
            let next = current;
            for (const update of message.updates) {
              if (update.seq > seqRef.current) {
                next = applyUpdate(next, update);
              }
            }
            return next;
          });
          const maxSeq = message.updates.reduce((max, update) => Math.max(max, update.seq), seqRef.current);
          applySeq(Math.max(maxSeq, message.to_seq));
          return;
        }
        if (message.type === "place_ok" || message.type === "place_duplicate") {
          applySeq(Math.max(seqRef.current, message.seq));
          return;
        }
        if (message.type === "error") {
          setLastError(message.message);
        }
        if (message.type === "place_reject") {
          setLastError(`rejected: ${message.reason}`);
        }
      };

      ws.onclose = () => {
        setStatus("closed");
        wsRef.current = null;
        if (stopped) {
          return;
        }
        const delay = Math.min(5000, 250 * 2 ** retry);
        retry += 1;
        timer = window.setTimeout(connect, delay);
      };
    };

    connect();
    return () => {
      stopped = true;
      if (timer) {
        window.clearTimeout(timer);
      }
      wsRef.current?.close();
    };
  }, [applySeq, mockUserId]);

  const place = useCallback((x: number, y: number, colorIndex: number) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }
    ws.send(
      JSON.stringify({
        type: "place",
        placement_id: crypto.randomUUID(),
        x,
        y,
        color_index: colorIndex,
      }),
    );
  }, []);

  return { pixels, seq, you, status, lastError, place };
}
