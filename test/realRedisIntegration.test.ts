import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Redis from 'ioredis';
import {
    claimAbandonedMessages,
    flushBatch,
    type PlacementBatchItem
} from '../src/utilities/pixelPlacementPersistence.js';

class MockDb {
    public insertedRows: any[] = [];
    public shouldFail = false;
    public failureError = new Error('Simulated PostgreSQL connection failure');

    insert(table: any) {
        return {
            values: (rows: any[]) => {
                return {
                    onConflictDoNothing: async () => {
                        if (this.shouldFail) {
                            throw this.failureError;
                        }
                        const newlyInserted: any[] = [];
                        for (const row of rows) {
                            const exists = this.insertedRows.some(
                                (r) => r.streamId === row.streamId || r.sequence === row.sequence
                            );
                            if (!exists) {
                                this.insertedRows.push({ ...row });
                                newlyInserted.push(row);
                            }
                        }
                        return newlyInserted;
                    }
                };
            }
        };
    }
}

const REDIS_LOCAL_PORT = 16379;
const REDIS_LOCAL_URL = `redis://127.0.0.1:${REDIS_LOCAL_PORT}`;

describe('Real Redis 7 Integration Tests (Isolated Local Container)', async () => {
    let redisClient: Redis | null = null;
    let mockDb: MockDb;
    let isRedisAvailable = false;
    const testStream = `audit4_stream_${Date.now()}`;
    const testGroup = `audit4_group_${Date.now()}`;

    before(async () => {
        try {
            const client = new Redis(REDIS_LOCAL_URL, {
                lazyConnect: true,
                maxRetriesPerRequest: 0,
                connectTimeout: 500,
                retryStrategy: () => null
            });
            client.on('error', () => {});
            await client.connect();
            redisClient = client;
            isRedisAvailable = true;
            mockDb = new MockDb();
        } catch {
            isRedisAvailable = false;
        }
    });

    after(async () => {
        if (redisClient && isRedisAvailable) {
            try {
                await redisClient.del(testStream);
                await redisClient.quit();
            } catch {}
        }
    });

    test('1-7. Real Redis 7 stream delivery, idle PEL accumulation, XAUTOCLAIM recovery, and XACK PEL purge', async (t) => {
        if (!isRedisAvailable || !redisClient) {
            t.skip('Local test Redis container on port 16379 is not running.');
            return;
        }

        // Step 1: Create test stream and consumer group
        await redisClient.xgroup('CREATE', testStream, testGroup, '0-0', 'MKSTREAM');

        // Add 2 test placements
        const id1 = await redisClient.xadd(
            testStream,
            '*',
            'user_id',
            'AuditUserA',
            'offset',
            '1000',
            'color',
            '4',
            'placement_id',
            'p100',
            'seq',
            '1001'
        );
        const id2 = await redisClient.xadd(
            testStream,
            '*',
            'user_id',
            'AuditUserB',
            'offset',
            '1004',
            'color',
            '7',
            'placement_id',
            'p101',
            'seq',
            '1002'
        );

        // Step 2 & 3: Deliver messages to consumer A and leave them pending (simulate crash)
        const readResult = await redisClient.xreadgroup(
            'GROUP',
            testGroup,
            'consumer-A',
            'COUNT',
            2,
            'STREAMS',
            testStream,
            '>'
        );
        assert.ok(readResult && readResult.length > 0);

        // Verify they are in PEL for consumer-A
        const pendingBefore = await redisClient.xpending(testStream, testGroup);
        assert.equal(pendingBefore[0], 2); // 2 pending entries

        // Step 4: Wait beyond the configured idle threshold (minIdleMs = 80ms)
        await new Promise((r) => setTimeout(r, 120));

        // Step 5: Reclaim them using the worker's actual claimAbandonedMessages implementation
        const recoveryResult = await claimAbandonedMessages(
            redisClient,
            mockDb,
            testStream,
            testGroup,
            'consumer-B-recovery',
            80, // minIdleMs
            '0-0',
            10
        );

        // Step 6: Verify message contents, IDs, and cursor handling
        assert.equal(recoveryResult.claimedCount, 2);
        assert.equal(recoveryResult.persistedCount, 2);
        assert.equal(recoveryResult.nextCursor, '0-0'); // single batch reached end
        assert.equal(mockDb.insertedRows.length, 2);
        assert.equal(mockDb.insertedRows[0].streamId, id1);
        assert.equal(mockDb.insertedRows[0].sequence, 1001);
        assert.equal(mockDb.insertedRows[0].userId, 'AuditUserA');
        assert.equal(mockDb.insertedRows[1].streamId, id2);
        assert.equal(mockDb.insertedRows[1].sequence, 1002);
        assert.equal(mockDb.insertedRows[1].userId, 'AuditUserB');

        // Step 7: Verify XACK removed the entries from the PEL in real Redis 7
        const pendingAfter = await redisClient.xpending(testStream, testGroup);
        assert.equal(pendingAfter[0], 0); // Exactly 0 pending entries remain!
    });

    test('8. Simulated PostgreSQL failure leaves entries unacknowledged in Redis PEL', async (t) => {
        if (!isRedisAvailable || !redisClient) {
            t.skip('Local test Redis container on port 16379 is not running.');
            return;
        }

        // Add a message and deliver to consumer-A
        const failId = await redisClient.xadd(
            testStream,
            '*',
            'user_id',
            'FailUser',
            'offset',
            '2000',
            'color',
            '1',
            'placement_id',
            'p_fail',
            'seq',
            '2001'
        );
        await redisClient.xreadgroup('GROUP', testGroup, 'consumer-A', 'COUNT', 1, 'STREAMS', testStream, '>');

        // Confirm it entered PEL
        const pending1 = await redisClient.xpending(testStream, testGroup);
        assert.equal(pending1[0], 1);

        // Wait beyond minIdleMs
        await new Promise((r) => setTimeout(r, 120));

        // Set DB to fail
        mockDb.shouldFail = true;

        await assert.rejects(
            async () => {
                await claimAbandonedMessages(
                    redisClient,
                    mockDb,
                    testStream,
                    testGroup,
                    'consumer-B-recovery',
                    80,
                    '0-0',
                    10
                );
            },
            { message: 'Simulated PostgreSQL connection failure' }
        );

        // Confirm the entry is STILL in the PEL in real Redis (was NOT acknowledged)
        const pendingAfterFailure = await redisClient.xpending(testStream, testGroup);
        assert.equal(pendingAfterFailure[0], 1);
        mockDb.shouldFail = false; // reset
    });

    test('9. Replay of recovered entries does not create duplicate database records', async (t) => {
        if (!isRedisAvailable || !redisClient) {
            t.skip('Local test Redis container on port 16379 is not running.');
            return;
        }

        // Message from test 8 is still pending in PEL
        // Now recover it with working DB
        const retryResult = await claimAbandonedMessages(
            redisClient,
            mockDb,
            testStream,
            testGroup,
            'consumer-B-recovery',
            0, // minIdle = 0 to claim immediately
            '0-0',
            10
        );

        assert.equal(retryResult.claimedCount, 1);
        assert.equal(retryResult.persistedCount, 1);

        // Simulate an immediate replay of the exact same message batch
        const replayBatch: PlacementBatchItem[] = [
            {
                streamId: mockDb.insertedRows[mockDb.insertedRows.length - 1].streamId,
                sequence: 2001,
                userId: 'FailUser',
                offset: 2000,
                color: 1,
                placementId: 'p_fail'
            }
        ];

        const initialRowCount = mockDb.insertedRows.length;
        const replayed = await flushBatch(mockDb, redisClient, testStream, testGroup, replayBatch);

        // flushBatch succeeded and returned count
        assert.equal(replayed, 1);
        // Database rows did NOT increase (no duplicate record created!)
        assert.equal(mockDb.insertedRows.length, initialRowCount);

        // PEL is completely empty
        const finalPending = await redisClient.xpending(testStream, testGroup);
        assert.equal(finalPending[0], 0);
    });
});
