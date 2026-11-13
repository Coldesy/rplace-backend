import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    CANVAS_WIDTH,
    CANVAS_HEIGHT,
    CANVAS_BYTES,
    DEFAULT_CANVAS_WIDTH,
    DEFAULT_CANVAS_HEIGHT,
    MIN_CANVAS_DIMENSION,
    MAX_CANVAS_DIMENSION,
    parseDimension,
    calculateCanvasBytes
} from '../src/config/canvas.js';
import {
    CANVAS_KEY,
    CANVAS_META_KEY,
    CANVAS_SEQ_KEY,
    calculatePixelOffset,
    validateOrInitBoardState,
    type RedisCanvasClient
} from '../src/utilities/canvas.js';

class MockRedisClient implements RedisCanvasClient {
    public data = new Map<string, string | Buffer>();
    public hashData = new Map<string, Record<string, string>>();

    async hgetall(key: string): Promise<Record<string, string>> {
        return { ...(this.hashData.get(key) ?? {}) };
    }

    async hset(key: string, data: Record<string, string>): Promise<number> {
        const existing = this.hashData.get(key) ?? {};
        this.hashData.set(key, { ...existing, ...data });
        return Object.keys(data).length;
    }

    async strlen(key: string): Promise<number> {
        const val = this.data.get(key);
        if (!val) return 0;
        return Buffer.isBuffer(val) ? val.length : Buffer.byteLength(val);
    }

    async set(key: string, value: Buffer | string): Promise<'OK'> {
        this.data.set(key, value);
        return 'OK';
    }

    async setnx(key: string, value: string): Promise<number> {
        if (this.data.has(key)) return 0;
        this.data.set(key, value);
        return 1;
    }
}

describe('Canvas Configuration & Dimension Calculation', () => {
    it('Test A: Default dimensions (1000 x 600)', () => {
        const width = 1000;
        const height = 600;
        const totalPixels = width * height;
        const snapshotBytes = calculateCanvasBytes(width, height);

        assert.strictEqual(width, 1000);
        assert.strictEqual(height, 600);
        assert.strictEqual(totalPixels, 600_000);
        assert.strictEqual(snapshotBytes, 300_000);

        // Exported constants match defaults when no custom env is set
        assert.strictEqual(DEFAULT_CANVAS_WIDTH, 1000);
        assert.strictEqual(DEFAULT_CANVAS_HEIGHT, 600);
        assert.strictEqual(CANVAS_BYTES, 300_000);
    });

    it('Test B: Custom dimensions (1200 x 800)', () => {
        const width = 1200;
        const height = 800;
        const totalPixels = width * height;
        const snapshotBytes = calculateCanvasBytes(width, height);

        assert.strictEqual(totalPixels, 960_000);
        assert.strictEqual(snapshotBytes, 480_000);
    });

    it('Test C: Odd dimensions (1001 x 601)', () => {
        const width = 1001;
        const height = 601;
        const totalPixels = width * height;
        const snapshotBytes = calculateCanvasBytes(width, height);

        assert.strictEqual(totalPixels, 601_601);
        assert.strictEqual(snapshotBytes, 300_801);
    });

    it('Test D: Invalid values and boundary fallbacks', () => {
        const fallback = 1000;

        // Empty / missing values
        assert.strictEqual(parseDimension(undefined, fallback), fallback);
        assert.strictEqual(parseDimension('', fallback), fallback);
        assert.strictEqual(parseDimension('   ', fallback), fallback);

        // Non-numeric strings
        assert.strictEqual(parseDimension('abc', fallback), fallback);
        assert.strictEqual(parseDimension('1000px', fallback), fallback);
        assert.strictEqual(parseDimension('null', fallback), fallback);

        // Negative values
        assert.strictEqual(parseDimension('-1', fallback), fallback);
        assert.strictEqual(parseDimension('-1000', fallback), fallback);

        // Zero value
        assert.strictEqual(parseDimension('0', fallback), fallback);

        // Decimal dimensions
        assert.strictEqual(parseDimension('100.5', fallback), fallback);
        assert.strictEqual(parseDimension('600.0001', fallback), fallback);

        // Out of bounds (< 10 or > 10000)
        assert.strictEqual(parseDimension('9', fallback), fallback);
        assert.strictEqual(parseDimension('10001', fallback), fallback);
        assert.strictEqual(parseDimension('65536', fallback), fallback);

        // Valid boundaries (10 and 10000)
        assert.strictEqual(parseDimension('10', fallback), 10);
        assert.strictEqual(parseDimension('10000', fallback), 10000);
        assert.strictEqual(parseDimension('500', fallback), 500);
    });
});

describe('Pixel Indexing, Packing & Redis Bit Offsets', () => {
    it('Test E.1: Pixel offset calculations', () => {
        const width = 1000;
        const height = 600;

        // First pixel at (0, 0)
        assert.strictEqual(calculatePixelOffset(0, 0, width), 0);

        // Second pixel at (1, 0)
        assert.strictEqual(calculatePixelOffset(1, 0, width), 4);

        // Row boundary at (999, 0) -> pixel 999
        assert.strictEqual(calculatePixelOffset(999, 0, width), 999 * 4); // 3996

        // Next row start at (0, 1) -> pixel 1000
        assert.strictEqual(calculatePixelOffset(0, 1, width), 1000 * 4); // 4000

        // Last pixel at (999, 599) -> pixel 599,999
        const lastPixelIndex = (599 * width) + 999;
        assert.strictEqual(lastPixelIndex, 599_999);
        assert.strictEqual(calculatePixelOffset(999, 599, width), 599_999 * 4); // 2,399,996
    });

    it('Test E.2: 4-bit nibble packing and byte representation', () => {
        // In Redis BITFIELD u4 and the frontend:
        // Byte i stores pixel 2*i (high nibble, bits 4-7) and pixel 2*i + 1 (low nibble, bits 0-3).
        const buffer = Buffer.alloc(300_000);

        // Set pixel 0 to color 10 (0x0A) and pixel 1 to color 5 (0x05)
        const p0Color = 10;
        const p1Color = 5;
        buffer[0] = (p0Color << 4) | (p1Color & 0x0f);

        // Verify byte 0
        assert.strictEqual(buffer[0], 0xa5);
        assert.strictEqual(buffer[0] >> 4, p0Color);
        assert.strictEqual(buffer[0] & 0x0f, p1Color);

        // Set pixel 2 to color 15 (0x0F) and pixel 3 to color 0 (0x00)
        const p2Color = 15;
        const p3Color = 0;
        buffer[1] = (p2Color << 4) | (p3Color & 0x0f);

        assert.strictEqual(buffer[1], 0xf0);
        assert.strictEqual(buffer[1] >> 4, p2Color);
        assert.strictEqual(buffer[1] & 0x0f, p3Color);

        // Verify independent nibble updates
        // Changing only pixel 1's color to 12 (0x0C) without affecting pixel 0
        const newP1Color = 12;
        buffer[0] = (buffer[0] & 0xf0) | (newP1Color & 0x0f);
        assert.strictEqual(buffer[0] >> 4, p0Color); // pixel 0 remains 10
        assert.strictEqual(buffer[0] & 0x0f, newP1Color); // pixel 1 changed to 12
    });

    it('Test E.3: Odd pixel count buffer packing', () => {
        // For odd dimensions 1001 x 601 = 601,601 pixels.
        // Snapshot size = Math.ceil(601601 / 2) = 300,801 bytes.
        const width = 1001;
        const height = 601;
        const totalPixels = width * height;
        const byteCount = calculateCanvasBytes(width, height);

        assert.strictEqual(byteCount, 300_801);

        const oddBuffer = Buffer.alloc(byteCount);

        // Last pixel is at index 601,600 (even index)
        const lastPixelIndex = totalPixels - 1;
        const lastByteIndex = Math.floor(lastPixelIndex / 2);
        assert.strictEqual(lastByteIndex, 300_800);

        // Place color 7 at the last pixel (high nibble of last byte)
        oddBuffer[lastByteIndex] = (7 << 4);

        assert.strictEqual(oddBuffer[lastByteIndex] >> 4, 7);
        assert.strictEqual(oddBuffer[lastByteIndex] & 0x0f, 0); // padding low nibble is 0
    });
});

describe('Board Snapshot Handling & Dimension Safety', () => {
    it('Test F.1: Empty board allocation matches calculated snapshot bytes', () => {
        const emptyBoard1000x600 = Buffer.alloc(calculateCanvasBytes(1000, 600));
        assert.strictEqual(emptyBoard1000x600.length, 300_000);

        const emptyBoard1200x800 = Buffer.alloc(calculateCanvasBytes(1200, 800));
        assert.strictEqual(emptyBoard1200x800.length, 480_000);

        const emptyBoard1001x601 = Buffer.alloc(calculateCanvasBytes(1001, 601));
        assert.strictEqual(emptyBoard1001x601.length, 300_801);
    });

    it('Test F.2: Snapshot validation accepts exact size and rejects mismatches', () => {
        const expectedBytes = calculateCanvasBytes(1000, 600); // 300,000

        const validSnapshot = Buffer.alloc(300_000);
        const tooSmall = Buffer.alloc(299_999);
        const tooLarge = Buffer.alloc(300_001);
        const legacyBuggySize = Buffer.alloc(2_400_000);

        assert.strictEqual(validSnapshot.length === expectedBytes, true);
        assert.strictEqual(tooSmall.length === expectedBytes, false);
        assert.strictEqual(tooLarge.length === expectedBytes, false);
        assert.strictEqual(legacyBuggySize.length === expectedBytes, false);
    });

    it('Test F.3: Empty Redis initializes new board with consistent metadata', async () => {
        const mockRedis = new MockRedisClient();

        const result = await validateOrInitBoardState(mockRedis, {
            width: 1000,
            height: 600,
            bytes: 300_000
        });

        assert.strictEqual(result.status, 'initialized');
        assert.strictEqual(result.metadata.width, 1000);
        assert.strictEqual(result.metadata.height, 600);
        assert.strictEqual(result.metadata.bytes, 300_000);

        // Verify keys created in Redis
        assert.strictEqual(await mockRedis.strlen(CANVAS_KEY), 300_000);
        assert.strictEqual(mockRedis.data.get(CANVAS_SEQ_KEY), '0');

        const meta = await mockRedis.hgetall(CANVAS_META_KEY);
        assert.strictEqual(meta.width, '1000');
        assert.strictEqual(meta.height, '600');
        assert.strictEqual(meta.bytes, '300000');
    });

    it('Test F.4: Safely adopts existing baseline 300,000-byte board with 1000x600 config', async () => {
        const mockRedis = new MockRedisClient();

        // Simulate current deployed production state:
        // canvas:state exists with 300,000 bytes, canvas:seq is 134, but NO canvas:meta
        const existingData = Buffer.alloc(300_000, 0xaa);
        await mockRedis.set(CANVAS_KEY, existingData);
        await mockRedis.set(CANVAS_SEQ_KEY, '134');

        const result = await validateOrInitBoardState(mockRedis, {
            width: 1000,
            height: 600,
            bytes: 300_000
        });

        assert.strictEqual(result.status, 'adopted');
        assert.strictEqual(result.metadata.width, 1000);
        assert.strictEqual(result.metadata.height, 600);

        // Pixel data was NOT overwritten
        assert.strictEqual(await mockRedis.strlen(CANVAS_KEY), 300_000);
        const stateBuffer = mockRedis.data.get(CANVAS_KEY) as Buffer;
        assert.strictEqual(stateBuffer[0], 0xaa);
        assert.strictEqual(stateBuffer[299_999], 0xaa);
        assert.strictEqual(mockRedis.data.get(CANVAS_SEQ_KEY), '134');

        // Metadata recorded
        const meta = await mockRedis.hgetall(CANVAS_META_KEY);
        assert.strictEqual(meta.width, '1000');
        assert.strictEqual(meta.height, '600');
        assert.strictEqual(meta.bytes, '300000');
    });

    it('Test F.5: Rejects existing 300,000-byte board if started with mismatched dimensions', async () => {
        const mockRedis = new MockRedisClient();

        // 300,000 byte board exists without metadata
        await mockRedis.set(CANVAS_KEY, Buffer.alloc(300_000, 0xaa));

        // Attempting to start with 1200x800 (requires 480,000 bytes)
        await assert.rejects(
            async () => {
                await validateOrInitBoardState(mockRedis, {
                    width: 1200,
                    height: 800,
                    bytes: 480_000
                });
            },
            {
                message: /Cannot adopt existing un-versioned board/
            }
        );

        // Data was NOT overwritten or reset
        assert.strictEqual(await mockRedis.strlen(CANVAS_KEY), 300_000);
    });

    it('Test F.6: Rejects mismatched dimensions when metadata already exists', async () => {
        const mockRedis = new MockRedisClient();

        // Initialize 1000x600 board with metadata
        await validateOrInitBoardState(mockRedis, {
            width: 1000,
            height: 600,
            bytes: 300_000
        });

        // Subsequently starting server with 1200x800 must throw an actionable error
        await assert.rejects(
            async () => {
                await validateOrInitBoardState(mockRedis, {
                    width: 1200,
                    height: 800,
                    bytes: 480_000
                });
            },
            {
                message: /Canvas dimension mismatch: Redis board metadata specifies 1000x600/
            }
        );

        // Board data remains intact
        assert.strictEqual(await mockRedis.strlen(CANVAS_KEY), 300_000);
    });

    it('Test F.7: Throws error if canvas:state key is missing when metadata exists', async () => {
        const mockRedis = new MockRedisClient();

        // Metadata exists but canvas:state key is deleted or empty
        await mockRedis.hset(CANVAS_META_KEY, {
            width: '1000',
            height: '600',
            bytes: '300000'
        });

        await assert.rejects(
            async () => {
                await validateOrInitBoardState(mockRedis, {
                    width: 1000,
                    height: 600,
                    bytes: 300_000
                });
            },
            {
                message: /Canvas state corrupted: metadata exists for 1000x600/
            }
        );
    });
});
