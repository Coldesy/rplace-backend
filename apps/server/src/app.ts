import http from "node:http";
import { Pool } from "pg";
import { WebSocketServer, type WebSocket } from "ws";
import {
  DEFAULT_BOUNDS,
  type PixelUpdate,
  type ServerMessage,
  type UserView,
} from "@rplace/shared";
import type { AppConfig } from "./config.js";
import {
  createRedis,
  currentSeq,
  initLiveCanvas,
  loadEventsAfter,
  loadSnapshotPixels,
  type RedisClient,
} from "./canvas-store.js";
import { getUser, listUsers, pixelLogCount } from "./db.js";
import { placePixel } from "./placement.js";
import { asPlaceMessage, parseClientJson, type UserRow } from "./validate.js";

type SocketState = {
  user?: UserRow;
};

function send(socket: WebSocket, message: ServerMessage): void {
  socket.send(JSON.stringify(message));
}

function broadcast(wss: WebSocketServer, message: ServerMessage): void {
  const payload = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) {
      client.send(payload);
    }
  }
}

function toView(user: UserRow): UserView {
  return { id: user.id, display_name: user.display_name, banned: user.banned };
}

export async function createApp(config: AppConfig): Promise<{
  server: http.Server;
  redis: RedisClient;
  pool: Pool;
  close: () => Promise<void>;
}> {
  const redis = createRedis(config.redisUrl);
  const pool = new Pool({ connectionString: config.databaseUrl });
  await redis.connect();
  await initLiveCanvas(redis);

  const seq = await currentSeq(redis);
  const logCount = await pixelLogCount(pool);
  if (logCount > 0 && seq === 0) {
    console.warn(
      "pixel_log has rows but Redis seq is 0; prototype will not rebuild Redis (ADR-004)",
    );
  }

  const wss = new WebSocketServer({ noServer: true });

  const server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/mock-users") {
      const users = await listUsers(pool);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(users));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== config.wsPath) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  wss.on("connection", (socket) => {
    const state: SocketState = {};

    socket.on("message", async (data) => {
      try {
        const parsed = parseClientJson(String(data));
        if (!parsed) {
          send(socket, { type: "error", message: "invalid json" });
          return;
        }

        if (parsed.type === "hello") {
          const mockUserId = typeof parsed.mock_user_id === "string" ? parsed.mock_user_id : undefined;
          if (mockUserId) {
            state.user = await getUser(pool, mockUserId);
            if (!state.user) {
              send(socket, { type: "error", message: "unknown mock user" });
              return;
            }
          } else {
            state.user = undefined;
          }

          const lastSeq = typeof parsed.last_seq === "number" ? parsed.last_seq : undefined;
          const you = state.user ? toView(state.user) : undefined;
          await sendHelloSync(socket, redis, lastSeq, you);
          return;
        }

        if (parsed.type === "place") {
          const place = asPlaceMessage(parsed);
          if (!place) {
            send(socket, {
              type: "place_reject",
              placement_id: typeof parsed.placement_id === "string" ? parsed.placement_id : "00000000-0000-0000-0000-000000000000",
              reason: "invalid",
            });
            return;
          }
          const result = await placePixel(redis, pool, state.user, place);
          if (result.kind === "reject") {
            send(socket, {
              type: "place_reject",
              placement_id: result.placement_id,
              reason: result.reason,
            });
            return;
          }
          if (result.kind === "duplicate") {
            send(socket, {
              type: "place_duplicate",
              placement_id: result.placement_id,
              seq: result.seq,
              x: result.x,
              y: result.y,
              color_index: result.color_index,
            });
            return;
          }

          send(socket, {
            type: "place_ok",
            placement_id: result.placement_id,
            seq: result.seq,
            x: result.x,
            y: result.y,
            color_index: result.color_index,
          });

          const update: PixelUpdate = {
            seq: result.seq,
            x: result.x,
            y: result.y,
            color_index: result.color_index,
            user_id: result.user_id,
          };
          broadcast(wss, {
            type: "pixels",
            from_seq: result.seq,
            to_seq: result.seq,
            updates: [update],
          });
          return;
        }

        send(socket, { type: "error", message: `unknown type ${parsed.type}` });
      } catch (error) {
        console.error(error);
        send(socket, { type: "error", message: "internal error" });
      }
    });
  });

  const close = async () => {
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await pool.end();
    redis.disconnect();
  };

  return { server, redis, pool, close };
}

async function sendHelloSync(
  socket: WebSocket,
  redis: RedisClient,
  lastSeq: number | undefined,
  you?: UserView,
): Promise<void> {
  const seq = await currentSeq(redis);

  if (lastSeq === undefined || lastSeq < 0) {
    const pixels = await loadSnapshotPixels(redis);
    send(socket, { type: "snapshot", seq, bounds: DEFAULT_BOUNDS, pixels, you });
    return;
  }

  const gap = await loadEventsAfter(redis, lastSeq);
  if (gap) {
    send(socket, {
      type: "resync",
      mode: "gap",
      from_seq: lastSeq,
      to_seq: seq,
      updates: gap,
      you,
    });
    send(socket, { type: "pixels", from_seq: lastSeq, to_seq: seq, updates: gap });
    return;
  }

  const pixels = await loadSnapshotPixels(redis);
  send(socket, {
    type: "resync",
    mode: "snapshot",
    seq,
    bounds: DEFAULT_BOUNDS,
    pixels,
    you,
  });
  send(socket, { type: "snapshot", seq, bounds: DEFAULT_BOUNDS, pixels, you });
}
