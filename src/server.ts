import "dotenv/config";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import cookie from "@fastify/cookie";
import { redis } from "./db/redis.js";
import { checkPostgresConnection, postgresPool } from "./db/postgres.js";
import wsRoutes from "./routes/ws.js";
import boardRoutes from "./routes/board.js";
import leaderboardRoutes from "./routes/leaderboard.js";
import pixelHistoryRoutes from "./routes/pixelHistory.js";
import { canvas } from "./utilities/canvas.js";
import {
    startPixelPlacementPersistence,
    stopPixelPlacementPersistence
} from "./utilities/pixelPlacementPersistence.js";
import cors from "@fastify/cors";
import { getAllowedOrigins } from "./config/cors.js";

const app = Fastify({ logger: true });
const port = process.env.PORT || 3001;
const host = process.env.HOST ?? "0.0.0.0";

const allowedOrigins = getAllowedOrigins(process.env.FRONTEND_URL);

await app.register(cors, {
    origin: allowedOrigins,
    credentials: true,
    exposedHeaders: ['X-Canvas-Sequence']
});

await app.register(websocket);
await app.register(cookie);
await app.register(wsRoutes, { prefix: '/ws' });
await app.register(boardRoutes, { prefix: '/api/board' });
await app.register(leaderboardRoutes, { prefix: '/api/leaderboard' });
await app.register(pixelHistoryRoutes, { prefix: '/api/pixels' });

let isShuttingDown = false;

const gracefulShutdown = async (signal: string) => {
    if (isShuttingDown) {
        app.log.warn(`[Server] Shutdown already in progress. Ignoring ${signal}`);
        return;
    }
    isShuttingDown = true;
    app.log.info(`[Server] Received ${signal}. Starting graceful shutdown...`);

    const shutdownTimeout = setTimeout(() => {
        app.log.error('[Server] Graceful shutdown timed out (10s). Forcing process exit.');
        process.exit(1);
    }, 10_000);
    shutdownTimeout.unref();

    try {
        // 1. Close Fastify (stops accepting new connections, closes WebSockets & HTTP)
        await app.close();
        app.log.info('[Server] Fastify server closed.');

        // 2. Stop persistence worker (flushes in-memory batch & acknowledges in Redis)
        await stopPixelPlacementPersistence();
        app.log.info('[Server] Persistence worker cleanly stopped.');

        // 3. Close database and redis clients
        await redis.quit();
        await postgresPool.end();
        app.log.info('[Server] Database connections closed.');

        app.log.info('[Server] Graceful shutdown complete.');
        process.exit(0);
    } catch (err) {
        app.log.error({ err }, '[Server] Error during graceful shutdown:');
        process.exit(1);
    }
};

process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => void gracefulShutdown('SIGINT'));

try {
    await canvas.init();
    await checkPostgresConnection();
    await startPixelPlacementPersistence();
    redis.once("ready", async () => {
        console.log("Redis is ready, starting server...");
    });
    await app.listen({ port: Number(port), host });
    console.log(`Server is running on http://${host}:${port}`);
} catch (error) {
    console.error("Error starting server:", error);
}
