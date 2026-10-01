import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import cookie from "@fastify/cookie";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { redis } from "./db/redis.js";
import wsRoutes from "./routes/ws.js";
import boardRoutes from "./routes/board.js";
import authRoutes from "./routes/auth.js";
import { canvas } from "./utilities/canvas.js";
import { getAuthMode, requireGithubAuthConfig } from "./config.js";
import cors from "@fastify/cors";

const app = Fastify({
    logger: true,
    // Prevents Fastify's automatic per-request/response log lines, which
    // serialize the full request URL (including OAuth `code`/`state` query
    // params) and response headers (including Set-Cookie), from exposing
    // secrets. Our own explicit, sanitized app.log calls in src/routes/auth.ts
    // are unaffected by this flag and still log normally.
    disableRequestLogging: true
});
const port = process.env.PORT || 3001
const host = process.env.HOST ?? "0.0.0.0";

// AUTH_MODE defaults to "mock" and requires no GitHub/session/cookie env var.
// In "github" mode, requireGithubAuthConfig() fails startup fast if any
// required var is missing, rather than failing on the first request.
const authMode = getAuthMode();

if (authMode === "github") {
    const { frontendUrl } = requireGithubAuthConfig();
    await app.register(cors, {
        origin: frontendUrl,
        credentials: true,
        exposedHeaders: ['X-Canvas-Sequence']
    });
} else {
    // Unchanged from before Stage 2 — mock mode never sends credentialed
    // requests, so a wildcard origin is unaffected by the auth work.
    await app.register(cors, {
        origin: '*',
        exposedHeaders: ['X-Canvas-Sequence']
    });
}

// Registered unconditionally, before any route that reads cookies. Harmless
// in mock mode — nothing there reads request.cookies.
await app.register(cookie);

await app.register(websocket);
await app.register(wsRoutes, { prefix: '/ws' });
await app.register(boardRoutes, { prefix: '/api/board' });

if (authMode === "github") {
    await app.register(authRoutes, { prefix: '/auth' });
}

try {
    await canvas.init();
    redis.once("ready", async () => {
        console.log("Redis is ready, starting server...");
    });
    await app.listen({ port: Number(port), host });
    console.log(`Server is running on http://${host}:${port}`);
} catch (error) {
    console.error("Error starting server:", error);
}
