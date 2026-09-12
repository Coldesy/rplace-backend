import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { ServerMessage } from "@rplace/shared";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const ALICE = "11111111-1111-1111-1111-111111111111";
const BOB = "22222222-2222-2222-2222-222222222222";

type TestClient = {
  ws: WebSocket;
  messages: ServerMessage[];
  close: () => Promise<void>;
};

let baseUrl = "";
let closeApp: (() => Promise<void>) | undefined;

function waitFor(
  client: TestClient,
  predicate: (message: ServerMessage) => boolean,
  timeoutMs = 5000,
): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const found = client.messages.find(predicate);
      if (found) {
        resolve(found);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error("timed out waiting for websocket message"));
        return;
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

async function openClient(mockUserId?: string, lastSeq?: number): Promise<TestClient> {
  const ws = new WebSocket(baseUrl);
  const messages: ServerMessage[] = [];
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  ws.on("message", (data) => {
    messages.push(JSON.parse(String(data)) as ServerMessage);
  });
  ws.send(JSON.stringify({ type: "hello", mock_user_id: mockUserId, last_seq: lastSeq }));
  const client = {
    ws,
    messages,
    close: () =>
      new Promise<void>((resolve) => {
        ws.once("close", () => resolve());
        ws.close();
      }),
  };
  await waitFor(client, (message) => message.type === "snapshot" || message.type === "resync");
  return client;
}

beforeAll(async () => {
  const app = await createApp(loadConfig());
  await new Promise<void>((resolve) => {
    app.server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = app.server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to bind test server");
  }
  baseUrl = `ws://127.0.0.1:${address.port}/ws`;
  closeApp = app.close;
});

afterAll(async () => {
  await closeApp?.();
});

describe("websocket concurrency", () => {
  it("broadcasts a placement to both clients", async () => {
    const a = await openClient(ALICE);
    const b = await openClient(BOB);
    const placement_id = randomUUID();
    a.messages.length = 0;
    b.messages.length = 0;
    a.ws.send(
      JSON.stringify({
        type: "place",
        placement_id,
        x: 12,
        y: -7,
        color_index: 9,
      }),
    );
    const ack = await waitFor(a, (message) => message.type === "place_ok" && message.placement_id === placement_id);
    const seen = await waitFor(b, (message) => message.type === "pixels");
    expect(ack.type).toBe("place_ok");
    expect(seen.type).toBe("pixels");
    if (seen.type === "pixels") {
      expect(seen.updates[0]?.color_index).toBe(9);
    }
    await a.close();
    await b.close();
  });

  it("treats concurrent duplicate placement_ids as one accept", async () => {
    const a = await openClient(ALICE);
    const placement_id = randomUUID();
    a.messages.length = 0;
    const payload = JSON.stringify({
      type: "place",
      placement_id,
      x: -11,
      y: 11,
      color_index: 4,
    });
    a.ws.send(payload);
    a.ws.send(payload);
    const ok = await waitFor(a, (message) => message.type === "place_ok" || message.type === "place_duplicate");
    const other = await waitFor(
      a,
      (message) =>
        (message.type === "place_ok" || message.type === "place_duplicate") && message !== ok,
    );
    const kinds = [ok.type, other.type].sort();
    expect(kinds).toEqual(["place_duplicate", "place_ok"]);
    if (ok.type !== "error" && other.type !== "error" && "seq" in ok && "seq" in other) {
      expect(ok.seq).toBe(other.seq);
    }
    await a.close();
  });

  it("last write wins when two users hit the same pixel", async () => {
    const a = await openClient(ALICE);
    const b = await openClient(BOB);
    a.messages.length = 0;
    b.messages.length = 0;
    a.ws.send(
      JSON.stringify({
        type: "place",
        placement_id: randomUUID(),
        x: 20,
        y: 20,
        color_index: 1,
      }),
    );
    b.ws.send(
      JSON.stringify({
        type: "place",
        placement_id: randomUUID(),
        x: 20,
        y: 20,
        color_index: 2,
      }),
    );
    const ackA = await waitFor(a, (message) => message.type === "place_ok");
    const ackB = await waitFor(b, (message) => message.type === "place_ok");
    expect(ackA.type).toBe("place_ok");
    expect(ackB.type).toBe("place_ok");
    if (ackA.type === "place_ok" && ackB.type === "place_ok") {
      expect(ackA.seq).not.toBe(ackB.seq);
    }
    await a.close();
    await b.close();
  });

  it("resyncs a reconnecting client with last_seq", async () => {
    const a = await openClient(ALICE);
    a.ws.send(
      JSON.stringify({
        type: "place",
        placement_id: randomUUID(),
        x: 0,
        y: 1,
        color_index: 8,
      }),
    );
    const ack = await waitFor(a, (message) => message.type === "place_ok");
    if (ack.type !== "place_ok") {
      throw new Error("expected place_ok");
    }
    await a.close();
    const b = await openClient(ALICE, ack.seq - 1);
    const gap = b.messages.find((message) => message.type === "pixels" || (message.type === "resync" && message.mode === "gap"));
    expect(gap).toBeTruthy();
    await b.close();
  });
});
