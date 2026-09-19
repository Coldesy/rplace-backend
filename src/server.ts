import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { redis } from "./db/redis.js";
import wsRoutes from "./routes/ws.js";
import boardRoutes from "./routes/board.js";
import { canvas } from "./utilities/canvas.js";

const app = Fastify({ logger: true });
const port = process.env.PORT || 3001
const host = process.env.HOST ?? "0.0.0.0";

await app.register(websocket);
await app.register(wsRoutes, { prefix: '/ws' });
await app.register(boardRoutes, { prefix: '/board' });

try {
    await canvas.init();
    redis.once("ready", async () => {
        console.log("Redis is ready, starting server...");
    });
    await app.listen({ port: Number(port), host: host });
    console.log(`Server is running on http://${host}:${port}`);
} catch (error) {
    console.error("Error starting server:", error);
}

