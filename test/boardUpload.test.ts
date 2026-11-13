import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import jwt from 'jsonwebtoken';
import {
    validateBoardUploadBuffer,
    ALLOWED_UPLOAD_USERS
} from '../src/routes/board.js';
import boardRoutes from '../src/routes/board.js';
import { redis } from '../src/db/redis.js';
import { CANVAS_BYTES, CANVAS_HEIGHT, CANVAS_WIDTH } from '../src/config/canvas.js';
import { CANVAS_KEY, CANVAS_META_KEY, CANVAS_SEQ_KEY } from '../src/utilities/canvas.js';

const TEST_SECRET = 'test-board-upload-jwt-secret-xyz987';

describe('Board-Data Upload & Format Validation Tests', () => {
    describe('Buffer Size & Format Validation Helper (validateBoardUploadBuffer)', () => {
        it('accepts exact 300,000-byte packed 4-bit buffer for 1000x600 canvas', () => {
            const validBuffer = Buffer.alloc(300_000, 0x12);
            const result = validateBoardUploadBuffer(validBuffer, 300_000, 1000, 600);
            assert.strictEqual(result.valid, true);
            assert.strictEqual(result.error, undefined);
        });

        it('rejects legacy 2,400,000-byte RGBA buffer with informative diagnostic message', () => {
            const rgbaBuffer = Buffer.alloc(2_400_000, 0xff);
            const result = validateBoardUploadBuffer(rgbaBuffer, 300_000, 1000, 600);
            assert.strictEqual(result.valid, false);
            assert.ok(result.error?.includes('Board data must be exactly 300000 bytes in packed 4-bit format'));
            assert.ok(result.error?.includes('Received 2400000 bytes (uncompressed RGBA format)'));
            assert.ok(result.error?.includes('Please quantize and pack pixels to 4-bit representation'));
        });

        it('rejects slightly smaller buffer (299,999 bytes)', () => {
            const tooSmall = Buffer.alloc(299_999);
            const result = validateBoardUploadBuffer(tooSmall, 300_000, 1000, 600);
            assert.strictEqual(result.valid, false);
            assert.strictEqual(result.error, 'Board data must be exactly 300000 bytes');
        });

        it('rejects slightly larger buffer (300,001 bytes)', () => {
            const tooLarge = Buffer.alloc(300_001);
            const result = validateBoardUploadBuffer(tooLarge, 300_000, 1000, 600);
            assert.strictEqual(result.valid, false);
            assert.strictEqual(result.error, 'Board data must be exactly 300000 bytes');
        });

        it('rejects empty buffer (0 bytes)', () => {
            const empty = Buffer.alloc(0);
            const result = validateBoardUploadBuffer(empty, 300_000, 1000, 600);
            assert.strictEqual(result.valid, false);
            assert.strictEqual(result.error, 'Board data must be exactly 300000 bytes');
        });

        it('rejects non-buffer values (strings, objects, null, undefined)', () => {
            assert.strictEqual(validateBoardUploadBuffer('raw string data').valid, false);
            assert.strictEqual(validateBoardUploadBuffer({ length: 300000 }).valid, false);
            assert.strictEqual(validateBoardUploadBuffer(null).valid, false);
            assert.strictEqual(validateBoardUploadBuffer(undefined).valid, false);
            assert.ok(validateBoardUploadBuffer('raw string').error?.includes('must be a binary buffer'));
        });

        it('supports dynamic custom dimensions (e.g. 1200x800 -> 480,000 bytes)', () => {
            const customPacked = Buffer.alloc(480_000);
            const customRGBA = Buffer.alloc(1200 * 800 * 4); // 3,840,000 bytes

            const validRes = validateBoardUploadBuffer(customPacked, 480_000, 1200, 800);
            assert.strictEqual(validRes.valid, true);

            const rgbaRes = validateBoardUploadBuffer(customRGBA, 480_000, 1200, 800);
            assert.strictEqual(rgbaRes.valid, false);
            assert.ok(rgbaRes.error?.includes('Board data must be exactly 480000 bytes in packed 4-bit format'));
            assert.ok(rgbaRes.error?.includes('Received 3840000 bytes (uncompressed RGBA format)'));
        });

        it('supports odd dimensions (e.g. 1001x601 -> 300,801 bytes)', () => {
            const oddPacked = Buffer.alloc(300_801);
            const result = validateBoardUploadBuffer(oddPacked, 300_801, 1001, 601);
            assert.strictEqual(result.valid, true);
        });
    });

    describe('Fastify Board Routes Integration (app.inject)', () => {
        let app: FastifyInstance;
        let mockRedisState: Map<string, Buffer | string>;
        let mockRedisHash: Map<string, Record<string, string>>;
        let origGetBuffer: any;
        let origGet: any;
        let origMulti: any;
        let origEnvSecret: string | undefined;

        beforeEach(async () => {
            origEnvSecret = process.env.JWT_SECRET;
            process.env.JWT_SECRET = TEST_SECRET;

            mockRedisState = new Map();
            mockRedisHash = new Map();

            // Set initial state
            mockRedisState.set(CANVAS_KEY, Buffer.alloc(CANVAS_BYTES, 0x34));
            mockRedisState.set(CANVAS_SEQ_KEY, '168');

            origGetBuffer = redis.getBuffer;
            origGet = redis.get;
            origMulti = redis.multi;

            (redis as any).getBuffer = async (key: string) => {
                const val = mockRedisState.get(key);
                return Buffer.isBuffer(val) ? val : null;
            };

            (redis as any).get = async (key: string) => {
                const val = mockRedisState.get(key);
                return typeof val === 'string' ? val : (val?.toString() ?? null);
            };

            (redis as any).multi = () => {
                const operations: (() => void)[] = [];
                let seqVal = Number(mockRedisState.get(CANVAS_SEQ_KEY) ?? '0');

                const pipeline = {
                    set(key: string, val: Buffer | string) {
                        operations.push(() => {
                            mockRedisState.set(key, val);
                        });
                        return pipeline;
                    },
                    incr(key: string) {
                        operations.push(() => {
                            seqVal++;
                            mockRedisState.set(key, String(seqVal));
                        });
                        return pipeline;
                    },
                    hset(key: string, data: Record<string, string>) {
                        operations.push(() => {
                            const existing = mockRedisHash.get(key) ?? {};
                            mockRedisHash.set(key, { ...existing, ...data });
                        });
                        return pipeline;
                    },
                    async exec() {
                        for (const op of operations) {
                            op();
                        }
                        return [
                            [null, 'OK'],
                            [null, seqVal],
                            [null, 4]
                        ];
                    }
                };
                return pipeline;
            };

            app = Fastify();
            await app.register(cookie);
            await app.register(boardRoutes, { prefix: '/api/board' });
            await app.ready();
        });

        afterEach(async () => {
            await app.close();
            (redis as any).getBuffer = origGetBuffer;
            (redis as any).get = origGet;
            (redis as any).multi = origMulti;
            if (origEnvSecret !== undefined) {
                process.env.JWT_SECRET = origEnvSecret;
            } else {
                delete process.env.JWT_SECRET;
            }
        });

        it('GET /api/board returns 300,000 bytes with sequence header and cache-control', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/api/board'
            });

            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.headers['content-type'], 'application/octet-stream');
            assert.strictEqual(res.headers['x-canvas-sequence'], '168');
            assert.strictEqual(res.headers['cache-control'], 'no-store');
            assert.strictEqual(res.rawPayload.length, CANVAS_BYTES);
            assert.strictEqual(res.rawPayload[0], 0x34);
        });

        it('PUT /api/board succeeds with valid 300,000-byte packed buffer from authorized user', async () => {
            const token = jwt.sign(
                { id: 'Coldesy', githubId: 'Coldesy', roles: { isAdmin: true } },
                TEST_SECRET,
                { expiresIn: '1h' }
            );

            const newBoardData = Buffer.alloc(CANVAS_BYTES, 0xab);

            const res = await app.inject({
                method: 'PUT',
                url: '/api/board',
                headers: {
                    authorization: `Bearer ${token}`,
                    'content-type': 'application/octet-stream'
                },
                payload: newBoardData
            });

            assert.strictEqual(res.statusCode, 200);
            const json = JSON.parse(res.payload);
            assert.strictEqual(json.message, 'Board uploaded successfully');
            assert.strictEqual(json.sequence, 169);

            // Verify Redis state updated
            const stored = mockRedisState.get(CANVAS_KEY) as Buffer;
            assert.strictEqual(stored.length, CANVAS_BYTES);
            assert.strictEqual(stored[0], 0xab);
            assert.strictEqual(mockRedisState.get(CANVAS_SEQ_KEY), '169');

            const meta = mockRedisHash.get(CANVAS_META_KEY);
            assert.strictEqual(meta?.width, String(CANVAS_WIDTH));
            assert.strictEqual(meta?.height, String(CANVAS_HEIGHT));
            assert.strictEqual(meta?.bytes, String(CANVAS_BYTES));
        });

        it('PUT /api/board succeeds for second authorized user (0xshellghost)', async () => {
            const token = jwt.sign(
                { id: '0xshellghost', username: '0xshellghost' },
                TEST_SECRET,
                { expiresIn: '1h' }
            );

            const newBoardData = Buffer.alloc(CANVAS_BYTES, 0x55);

            const res = await app.inject({
                method: 'PUT',
                url: '/api/board',
                headers: {
                    authorization: `Bearer ${token}`,
                    'content-type': 'application/octet-stream'
                },
                payload: newBoardData
            });

            assert.strictEqual(res.statusCode, 200);
            const json = JSON.parse(res.payload);
            assert.strictEqual(json.message, 'Board uploaded successfully');
        });

        it('PUT /api/board rejects 2,400,000-byte RGBA buffer with HTTP 400 and clear error', async () => {
            const token = jwt.sign(
                { id: 'Coldesy', githubId: 'Coldesy' },
                TEST_SECRET,
                { expiresIn: '1h' }
            );

            const legacyRgbaBuffer = Buffer.alloc(2_400_000, 0x00);

            const res = await app.inject({
                method: 'PUT',
                url: '/api/board',
                headers: {
                    authorization: `Bearer ${token}`,
                    'content-type': 'application/octet-stream'
                },
                payload: legacyRgbaBuffer
            });

            assert.strictEqual(res.statusCode, 400);
            const json = JSON.parse(res.payload);
            assert.ok(json.error?.includes('Board data must be exactly 300000 bytes in packed 4-bit format'));
            assert.ok(json.error?.includes('Received 2400000 bytes (uncompressed RGBA format)'));
        });

        it('PUT /api/board rejects incorrect size buffer (e.g. 100,000 bytes) with HTTP 400', async () => {
            const token = jwt.sign(
                { id: 'Coldesy', githubId: 'Coldesy' },
                TEST_SECRET,
                { expiresIn: '1h' }
            );

            const wrongSizeBuffer = Buffer.alloc(100_000);

            const res = await app.inject({
                method: 'PUT',
                url: '/api/board',
                headers: {
                    authorization: `Bearer ${token}`,
                    'content-type': 'application/octet-stream'
                },
                payload: wrongSizeBuffer
            });

            assert.strictEqual(res.statusCode, 400);
            const json = JSON.parse(res.payload);
            assert.strictEqual(json.error, 'Board data must be exactly 300000 bytes');
        });

        it('PUT /api/board rejects unauthenticated requests with HTTP 401', async () => {
            const res = await app.inject({
                method: 'PUT',
                url: '/api/board',
                headers: {
                    'content-type': 'application/octet-stream'
                },
                payload: Buffer.alloc(CANVAS_BYTES)
            });

            assert.strictEqual(res.statusCode, 401);
            const json = JSON.parse(res.payload);
            assert.strictEqual(json.error, 'Authentication required');
        });

        it('PUT /api/board rejects unauthorized users with HTTP 403', async () => {
            const token = jwt.sign(
                { id: 'some-random-user', githubId: 'some-random-user' },
                TEST_SECRET,
                { expiresIn: '1h' }
            );

            const res = await app.inject({
                method: 'PUT',
                url: '/api/board',
                headers: {
                    authorization: `Bearer ${token}`,
                    'content-type': 'application/octet-stream'
                },
                payload: Buffer.alloc(CANVAS_BYTES)
            });

            assert.strictEqual(res.statusCode, 403);
            const json = JSON.parse(res.payload);
            assert.strictEqual(json.error, 'Board upload is not allowed for this user');
        });

        it('PUT /api/board rejects expired tokens with HTTP 401', async () => {
            const expiredToken = jwt.sign(
                { id: 'Coldesy', githubId: 'Coldesy' },
                TEST_SECRET,
                { expiresIn: '-5s' }
            );

            const res = await app.inject({
                method: 'PUT',
                url: '/api/board',
                headers: {
                    authorization: `Bearer ${expiredToken}`,
                    'content-type': 'application/octet-stream'
                },
                payload: Buffer.alloc(CANVAS_BYTES)
            });

            assert.strictEqual(res.statusCode, 401);
            const json = JSON.parse(res.payload);
            assert.strictEqual(json.error, 'Token has expired');
        });
    });
});
