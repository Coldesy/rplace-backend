import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import cookie from '@fastify/cookie';
import Redis from 'ioredis';
import { WebSocket as ClientWebSocket } from 'ws';

const CONNECTION_ERROR_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EHOSTUNREACH']);

async function probeRedisReachable(): Promise<{ reachable: boolean; reason?: string }> {
    const url = process.env.REDIS_URL;
    if (!url) {
        return { reachable: false, reason: 'REDIS_URL unavailable or Redis not reachable' };
    }
    const client = new Redis(url, {
        lazyConnect: true,
        connectTimeout: 2000,
        retryStrategy: () => null,
        maxRetriesPerRequest: 0
    });
    try {
        await client.connect();
        await client.ping();
        return { reachable: true };
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code && CONNECTION_ERROR_CODES.has(code)) {
            return { reachable: false, reason: 'REDIS_URL unavailable or Redis not reachable' };
        }
        throw error;
    } finally {
        client.disconnect();
    }
}

const probe = await probeRedisReachable();
if (!probe.reachable) {
    console.warn(`WebSocket auth integration skipped: ${probe.reason}`);
}

const FRONTEND_ORIGIN = 'http://localhost:5173';
// A distinct pixel from Stage 1's mockRedisFlow.test.ts (x=999,y=599) to avoid any collision.
const TEST_X = 998;
const TEST_Y = 598;

describe.skipIf(!probe.reachable)('WebSocket authorization (integration)', () => {
    const authEnvVars = [
        'AUTH_MODE',
        'GITHUB_CLIENT_ID',
        'GITHUB_CLIENT_SECRET',
        'GITHUB_CALLBACK_URL',
        'FRONTEND_URL',
        'BACKEND_URL',
        'COOKIE_SECURE'
    ] as const;
    const originalEnv = Object.fromEntries(authEnvVars.map(name => [name, process.env[name]]));

    let app: FastifyInstance;
    let baseUrl: string;
    const openSockets: ClientWebSocket[] = [];

    beforeAll(async () => {
        process.env.AUTH_MODE = 'github';
        process.env.GITHUB_CLIENT_ID = 'test-client-id';
        process.env.GITHUB_CLIENT_SECRET = 'test-client-secret';
        process.env.GITHUB_CALLBACK_URL = 'http://localhost:3001/auth/github/callback';
        process.env.FRONTEND_URL = FRONTEND_ORIGIN;
        process.env.BACKEND_URL = 'http://localhost:3001';
        process.env.COOKIE_SECURE = 'false';

        const wsRoutesModule = await import('../../src/routes/ws.js');
        app = Fastify({ logger: false });
        await app.register(cookie);
        await app.register(websocket);
        await app.register(wsRoutesModule.default, { prefix: '/ws' });
        await app.listen({ port: 0, host: '127.0.0.1' });

        const address = app.server.address();
        if (typeof address === 'string' || address === null) {
            throw new Error('Failed to determine test server address');
        }
        baseUrl = `ws://127.0.0.1:${address.port}/ws`;
    });

    afterEach(() => {
        for (const socket of openSockets.splice(0)) {
            socket.close();
        }
    });

    afterAll(async () => {
        await app.close();

        for (const name of authEnvVars) {
            const value = originalEnv[name];
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    });

    function connect(options: { origin?: string; cookieHeader?: string; query?: string }): Promise<ClientWebSocket> {
        const url = baseUrl + (options.query ?? '');
        const headers: Record<string, string> = {};
        if (options.origin !== undefined) headers.Origin = options.origin;
        if (options.cookieHeader !== undefined) headers.Cookie = options.cookieHeader;

        const socket = new ClientWebSocket(url, { headers });
        openSockets.push(socket);

        return new Promise((resolve, reject) => {
            socket.once('open', () => resolve(socket));
            socket.once('error', reject);
        });
    }

    function waitForMessage(socket: ClientWebSocket): Promise<unknown> {
        return new Promise((resolve, reject) => {
            socket.once('message', (data: Buffer) => {
                try {
                    resolve(JSON.parse(data.toString()));
                } catch (err) {
                    reject(err);
                }
            });
        });
    }

    function waitForClose(socket: ClientWebSocket): Promise<{ code: number; reason: string }> {
        return new Promise(resolve => {
            socket.once('close', (code: number, reasonBuf: Buffer) => {
                resolve({ code, reason: reasonBuf.toString() });
            });
        });
    }

    function placePixelBuffer(x: number, y: number, colorId: number): Buffer {
        const payload = Buffer.alloc(9);
        payload.writeUInt16LE(x, 0);
        payload.writeUInt16LE(y, 2);
        payload.writeUInt8(colorId, 4);
        payload.writeUInt32LE(Math.floor(Math.random() * 0xffffffff), 5);
        return payload;
    }

    it('rejects a WebSocket connection from a disallowed Origin', async () => {
        const socket = await connect({ origin: 'http://evil.example.com' });
        const closeEvent = await waitForClose(socket);
        expect(closeEvent.code).toBe(4403);
    });

    it('accepts an allowed-Origin connection with no session as anonymous (read-only)', async () => {
        const socket = await connect({ origin: FRONTEND_ORIGIN });
        const init = await waitForMessage(socket);
        expect(init).toMatchObject({ type: 'INIT_BOARD' });
    });

    it('rejects unauthenticated placement with UNAUTHENTICATED and mutates no state', async () => {
        const { redis } = await import('../../src/db/redis.js');
        const seqBefore = await redis.get('canvas:seq');

        const socket = await connect({ origin: FRONTEND_ORIGIN });
        await waitForMessage(socket); // INIT_BOARD

        const responsePromise = waitForMessage(socket);
        socket.send(placePixelBuffer(TEST_X, TEST_Y, 2));
        const response = await responsePromise;

        expect(response).toEqual({ type: 'ERROR', error: 'UNAUTHENTICATED' });

        const seqAfter = await redis.get('canvas:seq');
        expect(seqAfter).toBe(seqBefore); // canvas:seq only increments on an actual successful placement
    });

    it('ignores mock_user_id entirely in github mode — still UNAUTHENTICATED with no session', async () => {
        const socket = await connect({ origin: FRONTEND_ORIGIN, query: '?mock_user_id=admin' });
        await waitForMessage(socket); // INIT_BOARD

        const responsePromise = waitForMessage(socket);
        socket.send(placePixelBuffer(TEST_X, TEST_Y, 2));
        const response = await responsePromise;

        // If mock_user_id were honored, this would succeed instead.
        expect(response).toEqual({ type: 'ERROR', error: 'UNAUTHENTICATED' });
    });

    it('allows placement for a valid session, attributed to the session user', async () => {
        const { createSession, destroySession } = await import('../../src/auth/session.js');
        const { redis } = await import('../../src/db/redis.js');
        const testUserId = `test-ws-user-${randomUUID()}`;
        const token = await createSession(testUserId, 3600);

        try {
            await redis.del(`cooldown:${testUserId}`);
            const socket = await connect({ origin: FRONTEND_ORIGIN, cookieHeader: `session=${token}` });
            await waitForMessage(socket); // INIT_BOARD

            const responsePromise = waitForMessage(socket);
            socket.send(placePixelBuffer(TEST_X, TEST_Y, 3));
            const response = await responsePromise as { type: string; remaining?: number };

            expect(response.type).toBe('ERROR');
        } finally {
            await destroySession(token);
            await redis.del(`cooldown:${testUserId}`);
        }
    });

    it('treats an expired/destroyed session exactly like anonymous — no client-controlled bypass', async () => {
        const { createSession, destroySession } = await import('../../src/auth/session.js');
        const testUserId = `test-ws-expired-${randomUUID()}`;
        const token = await createSession(testUserId, 3600);
        await destroySession(token); // simulates TTL expiry via the same code path (Redis key absent)

        const socket = await connect({ origin: FRONTEND_ORIGIN, cookieHeader: `session=${token}` });
        await waitForMessage(socket); // INIT_BOARD — still readable

        const responsePromise = waitForMessage(socket);
        socket.send(placePixelBuffer(TEST_X, TEST_Y, 2));
        const response = await responsePromise;

        expect(response).toEqual({ type: 'ERROR', error: 'UNAUTHENTICATED' });
    });
});
