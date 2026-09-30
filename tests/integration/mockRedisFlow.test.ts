import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import Redis from 'ioredis';

/**
 * Exercises the CURRENT, unmodified Redis placement path
 * (src/utilities/canvas.ts -> src/utilities/placement.lua) directly, using a
 * raw string userId exactly as src/routes/ws.ts passes it today. This is a
 * regression baseline for Stage 1 — it proves today's mock-mode placement,
 * cooldown, and duplicate-placement behavior is unchanged by anything added
 * in this stage. It does not touch canvas.ts, placement.lua, or rateLimit.ts.
 *
 * Side effect: this test places one real pixel on whatever local dev Redis
 * instance DATABASE_URL/REDIS_URL points at (bottom-right corner, x=999,
 * y=599, to stay out of the way visually). That's expected for a test that
 * deliberately exercises the real Lua script end-to-end against live Redis;
 * it is not meant to run against a shared/staging instance.
 */

const CONNECTION_ERROR_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EHOSTUNREACH']);

interface ProbeResult {
    reachable: boolean;
    reason?: string;
}

async function probeRedisReachable(): Promise<ProbeResult> {
    const url = process.env.REDIS_URL;
    if (!url) {
        return { reachable: false, reason: 'REDIS_URL unavailable or Redis not reachable' };
    }

    const probeClient = new Redis(url, {
        lazyConnect: true,
        connectTimeout: 2000,
        retryStrategy: () => null, // never auto-retry during the probe
        maxRetriesPerRequest: 0
    });

    try {
        await probeClient.connect();
        await probeClient.ping();
        return { reachable: true };
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code && CONNECTION_ERROR_CODES.has(code)) {
            return { reachable: false, reason: 'REDIS_URL unavailable or Redis not reachable' };
        }
        // Reachable but something else went wrong (e.g. AUTH required and
        // rejected) — a real configuration problem, not "unavailable".
        throw error;
    } finally {
        probeClient.disconnect();
    }
}

const probe = await probeRedisReachable();

if (!probe.reachable) {
    console.warn(`Redis integration skipped: ${probe.reason}`);
}

describe.skipIf(!probe.reachable)('mock-mode placement flow (Redis integration)', () => {
    const testUserId = `test-user-${randomUUID()}`;
    const testX = 999;
    const testY = 599;
    const testColor = 2;

    afterAll(async () => {
        const { redis } = await import('../../src/db/redis.js');
        await redis.del(`cooldown:${testUserId}`);
        await redis.quit();
    });

    it('accepts a first placement, then rate-limits an immediate second one, for a raw string userId', async () => {
        const { canvas } = await import('../../src/utilities/canvas.js');
        await canvas.init();

        const first = await canvas.placePixel(
            testUserId,
            testX,
            testY,
            testColor,
            randomUUID(),
            1, // maxPixels, matches today's default tier (see rateLimit.ts)
            6  // cooldown seconds, matches today's default tier
        );

        expect(first.success).toBe(true);
        expect(first.remaining).toBe(0);
        expect(typeof first.seq).toBe('number');

        const second = await canvas.placePixel(
            testUserId,
            testX,
            testY,
            testColor,
            randomUUID(),
            1,
            6
        );

        expect(second.success).toBe(false);
        expect(second.error).toBe('RATE_LIMITED');
        expect(typeof second.ttl).toBe('number');
    });

    it('ignores a duplicate placementId as DUPLICATE_IGNORED without consuming cooldown budget', async () => {
        const { canvas } = await import('../../src/utilities/canvas.js');
        const { redis } = await import('../../src/db/redis.js');
        await redis.del(`cooldown:${testUserId}`);

        const placementId = randomUUID();

        const first = await canvas.placePixel(testUserId, testX, testY, testColor, placementId, 1, 6);
        expect(first.success).toBe(true);

        await redis.del(`cooldown:${testUserId}`); // isolate dedup check from cooldown

        const duplicate = await canvas.placePixel(testUserId, testX, testY, testColor, placementId, 1, 6);
        expect(duplicate.success).toBe(false);
        expect(duplicate.error).toBe('DUPLICATE_IGNORED');
    });
});
