import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    parseStreamEntry,
    flushBatch,
    claimAbandonedMessages,
    PersistenceWorker,
    type PlacementBatchItem
} from '../src/utilities/pixelPlacementPersistence.js';

class MockRedis {
    public stream: Map<string, string[]> = new Map();
    public pending: Map<string, { consumer: string; idleMs: number; deliveryCount: number }> = new Map();
    public acks: string[] = [];
    public consumerGroups: Set<string> = new Set();
    public xautoclaimCalls: any[] = [];
    public xreadgroupCalls: any[] = [];
    public isQuit = false;

    async xgroup(cmd: string, streamName: string, groupName: string, id: string, mkstream?: string) {
        if (cmd === 'CREATE') {
            if (this.consumerGroups.has(groupName)) {
                throw new Error('BUSYGROUP Consumer Group name already exists');
            }
            this.consumerGroups.add(groupName);
            return 'OK';
        }
        return 'OK';
    }

    async xautoclaim(
        streamName: string,
        group: string,
        consumer: string,
        minIdle: number,
        start: string,
        countFlag?: string,
        count?: number
    ) {
        this.xautoclaimCalls.push({ streamName, group, consumer, minIdle, start, count });
        const claimedEntries: [string, string[]][] = [];
        let nextCursor = '0-0';

        for (const [id, meta] of this.pending.entries()) {
            if (meta.idleMs >= minIdle) {
                const fields = this.stream.get(id);
                if (fields) {
                    claimedEntries.push([id, fields]);
                    meta.consumer = consumer;
                }
            }
        }
        return [nextCursor, claimedEntries];
    }

    async xreadgroup(...args: any[]) {
        this.xreadgroupCalls.push(args);
        // Simulate Redis non-blocking or short bounded wait
        await new Promise((r) => setTimeout(r, 10));
        return null;
    }

    async xack(streamName: string, group: string, ...ids: string[]) {
        for (const id of ids) {
            this.acks.push(id);
            this.pending.delete(id);
        }
        return ids.length;
    }

    async quit() {
        this.isQuit = true;
        return 'OK';
    }

    duplicate() {
        return this;
    }
}

class MockDb {
    public insertedRows: any[] = [];
    public insertCalls: any[] = [];
    public shouldFail = false;
    public failureError = new Error('Database query timeout or connection failed');

    insert(table: any) {
        return {
            values: (rows: any[]) => {
                this.insertCalls.push(rows);
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

const silentLogger = {
    info: () => {},
    warn: () => {},
    error: () => {}
};

describe('Persistence Worker Reliability & Message Recovery', () => {
    let mockRedis: MockRedis;
    let mockDb: MockDb;

    beforeEach(() => {
        mockRedis = new MockRedis();
        mockDb = new MockDb();
    });

    test('1. Recovery of abandoned pending messages via XAUTOCLAIM', async () => {
        const id1 = '1794433075677-0';
        const fields1 = ['user_id', 'UserA', 'offset', '100', 'color', '3', 'placement_id', 'p1', 'seq', '101'];
        const id2 = '1794433075678-0';
        const fields2 = ['user_id', 'UserB', 'offset', '200', 'color', '5', 'placement_id', 'p2', 'seq', '102'];

        mockRedis.stream.set(id1, fields1);
        mockRedis.stream.set(id2, fields2);
        mockRedis.pending.set(id1, { consumer: 'old-crashed-worker', idleMs: 45_000, deliveryCount: 1 });
        mockRedis.pending.set(id2, { consumer: 'old-crashed-worker', idleMs: 50_000, deliveryCount: 1 });

        const result = await claimAbandonedMessages(
            mockRedis,
            mockDb,
            'pixel_log',
            'pixel-placement-persistence',
            'new-worker-1',
            30_000,
            '0-0',
            100
        );

        assert.equal(result.claimedCount, 2);
        assert.equal(result.persistedCount, 2);
        assert.equal(mockDb.insertedRows.length, 2);
        assert.equal(mockDb.insertedRows[0].sequence, 101);
        assert.equal(mockDb.insertedRows[1].sequence, 102);
        assert.deepEqual(mockRedis.acks, [id1, id2]);
        assert.equal(mockRedis.pending.size, 0);
    });

    test('2. Successful PostgreSQL insertion followed by XACK', async () => {
        const batch: PlacementBatchItem[] = [
            { streamId: 's1', sequence: 201, userId: 'User1', offset: 500, color: 1, placementId: 'p1' },
            { streamId: 's2', sequence: 202, userId: 'User2', offset: 504, color: 2, placementId: 'p2' }
        ];

        const flushed = await flushBatch(mockDb, mockRedis, 'pixel_log', 'pixel-placement-persistence', batch);

        assert.equal(flushed, 2);
        assert.equal(mockDb.insertedRows.length, 2);
        assert.deepEqual(mockRedis.acks, ['s1', 's2']);
    });

    test('3. Failed PostgreSQL insertion does NOT acknowledge in Redis (no XACK)', async () => {
        mockDb.shouldFail = true;

        const batch: PlacementBatchItem[] = [
            { streamId: 's_fail_1', sequence: 301, userId: 'UserF', offset: 800, color: 4, placementId: 'pf1' }
        ];

        await assert.rejects(
            async () => {
                await flushBatch(mockDb, mockRedis, 'pixel_log', 'pixel-placement-persistence', batch);
            },
            { message: 'Database query timeout or connection failed' }
        );

        assert.equal(mockRedis.acks.length, 0);
    });

    test('4. Idempotent replay of already persisted messages', async () => {
        mockDb.insertedRows.push({
            streamId: 's401',
            sequence: 401,
            userId: 'ExistingUser',
            offset: 1000,
            color: 1,
            placementId: 'p401'
        });

        const replayBatch: PlacementBatchItem[] = [
            { streamId: 's401', sequence: 401, userId: 'ExistingUser', offset: 1000, color: 1, placementId: 'p401' },
            { streamId: 's402', sequence: 402, userId: 'NewUser', offset: 1004, color: 2, placementId: 'p402' }
        ];

        const flushed = await flushBatch(mockDb, mockRedis, 'pixel_log', 'pixel-placement-persistence', replayBatch);

        assert.equal(flushed, 2);
        assert.equal(mockDb.insertedRows.length, 2);
        assert.equal(mockDb.insertedRows[0].sequence, 401);
        assert.equal(mockDb.insertedRows[1].sequence, 402);
        assert.deepEqual(mockRedis.acks, ['s401', 's402']);
    });

    test('5. Correct handling of multiple recovery batches and cursor advancement', async () => {
        let cursorCallCount = 0;
        mockRedis.xautoclaim = async (stream, group, consumer, minIdle, startCursor) => {
            cursorCallCount++;
            if (startCursor === '0-0') {
                return [
                    'cursor-batch-2',
                    [['s501', ['user_id', 'UA', 'offset', '10', 'color', '1', 'placement_id', 'p1', 'seq', '501']]]
                ];
            } else if (startCursor === 'cursor-batch-2') {
                return [
                    '0-0',
                    [['s502', ['user_id', 'UB', 'offset', '20', 'color', '2', 'placement_id', 'p2', 'seq', '502']]]
                ];
            }
            return ['0-0', []];
        };

        const batch1 = await claimAbandonedMessages(mockRedis, mockDb, 'pixel_log', 'grp', 'c1', 10_000, '0-0', 1);
        assert.equal(batch1.nextCursor, 'cursor-batch-2');
        assert.equal(batch1.persistedCount, 1);

        const batch2 = await claimAbandonedMessages(
            mockRedis,
            mockDb,
            'pixel_log',
            'grp',
            'c1',
            10_000,
            batch1.nextCursor,
            1
        );
        assert.equal(batch2.nextCursor, '0-0');
        assert.equal(batch2.persistedCount, 1);

        assert.equal(mockDb.insertedRows.length, 2);
        assert.equal(cursorCallCount, 2);
    });

    test('6. New messages continue processing normally alongside recovery', async () => {
        const worker = new PersistenceWorker({
            redisClient: mockRedis as any,
            dbClient: mockDb as any,
            batchSize: 2,
            maxBatchWaitMs: 30,
            claimMinIdleMs: 30_000,
            claimIntervalMs: 10_000,
            logger: silentLogger
        });

        let reads = 0;
        mockRedis.xreadgroup = async () => {
            reads++;
            if (reads === 1) {
                return [
                    [
                        'pixel_log',
                        [
                            ['msg-1', ['user_id', 'U1', 'offset', '12', 'color', '2', 'placement_id', 'p1', 'seq', '601']],
                            ['msg-2', ['user_id', 'U2', 'offset', '16', 'color', '3', 'placement_id', 'p2', 'seq', '602']]
                        ]
                    ]
                ];
            }
            await new Promise((r) => setTimeout(r, 10));
            return null;
        };

        await worker.start();
        // Give time for worker loop to read and flush
        await new Promise((r) => setTimeout(r, 60));
        await worker.stop();

        assert.ok(mockDb.insertedRows.length >= 2);
        assert.ok(mockRedis.acks.includes('msg-1'));
        assert.ok(mockRedis.acks.includes('msg-2'));
    });

    test('7. Repeated worker shutdown signals are safely handled idempotently', async () => {
        const worker = new PersistenceWorker({
            redisClient: mockRedis as any,
            dbClient: mockDb as any,
            maxBatchWaitMs: 30,
            logger: silentLogger
        });

        await worker.start();
        assert.equal(worker.isRunning(), true);

        await Promise.all([
            worker.stop(),
            worker.stop(),
            worker.stop()
        ]);

        assert.equal(worker.isRunning(), false);
        assert.equal(mockRedis.isQuit, true);
    });

    test('8. Graceful shutdown flushes in-memory batch to PostgreSQL and sends XACK', async () => {
        const worker = new PersistenceWorker({
            redisClient: mockRedis as any,
            dbClient: mockDb as any,
            batchSize: 100,
            maxBatchWaitMs: 60_000,
            logger: silentLogger
        });

        await worker.start();

        (worker as any).batch = [
            { streamId: 'shut-1', sequence: 801, userId: 'ShutUser1', offset: 200, color: 1, placementId: 'ps1' },
            { streamId: 'shut-2', sequence: 802, userId: 'ShutUser2', offset: 204, color: 2, placementId: 'ps2' }
        ];

        await worker.stop();

        assert.equal(mockDb.insertedRows.length, 2);
        assert.equal(mockDb.insertedRows[0].sequence, 801);
        assert.equal(mockDb.insertedRows[1].sequence, 802);
        assert.ok(mockRedis.acks.includes('shut-1'));
        assert.ok(mockRedis.acks.includes('shut-2'));
        assert.equal((worker as any).batch.length, 0);
    });

    test('9. Failed shutdown flush leaves unpersisted messages in Redis PEL for future recovery', async () => {
        mockDb.shouldFail = true;

        const worker = new PersistenceWorker({
            redisClient: mockRedis as any,
            dbClient: mockDb as any,
            batchSize: 100,
            maxBatchWaitMs: 60_000,
            logger: silentLogger
        });

        await worker.start();

        (worker as any).batch = [
            { streamId: 'unflushed-1', sequence: 901, userId: 'UFail', offset: 300, color: 5, placementId: 'pf1' }
        ];

        await assert.rejects(
            async () => {
                await worker.stop();
            },
            { message: 'Database query timeout or connection failed' }
        );

        assert.equal(mockRedis.acks.length, 0);
    });

    test('10. Recovery does not duplicate already persisted placement records', async () => {
        mockDb.insertedRows.push({
            streamId: 's1001',
            sequence: 1001,
            userId: 'Original1001',
            offset: 400,
            color: 2,
            placementId: 'p1001'
        });

        const id1 = 's1001';
        const fields1 = ['user_id', 'Original1001', 'offset', '400', 'color', '2', 'placement_id', 'p1001', 'seq', '1001'];
        const id2 = 's1002';
        const fields2 = ['user_id', 'New1002', 'offset', '404', 'color', '3', 'placement_id', 'p1002', 'seq', '1002'];

        mockRedis.stream.set(id1, fields1);
        mockRedis.stream.set(id2, fields2);
        mockRedis.pending.set(id1, { consumer: 'old-crashed', idleMs: 40_000, deliveryCount: 1 });
        mockRedis.pending.set(id2, { consumer: 'old-crashed', idleMs: 40_000, deliveryCount: 1 });

        const result = await claimAbandonedMessages(
            mockRedis,
            mockDb,
            'pixel_log',
            'pixel-placement-persistence',
            'active-worker',
            30_000,
            '0-0',
            100
        );

        assert.equal(result.claimedCount, 2);
        assert.equal(mockDb.insertedRows.length, 2);
        assert.equal(mockDb.insertedRows[0].sequence, 1001);
        assert.equal(mockDb.insertedRows[1].sequence, 1002);
        assert.deepEqual(mockRedis.acks, ['s1001', 's1002']);
    });

    test('11. Worker loop that fails to settle before deadline aborts shutdown without premature drain or disconnect', async () => {
        const worker = new PersistenceWorker({
            redisClient: mockRedis as any,
            dbClient: mockDb as any,
            logger: silentLogger
        });

        // Simulate an infinite hang inside xreadgroup
        let loopStarted = false;
        mockRedis.xreadgroup = () => {
            loopStarted = true;
            return new Promise(() => {}); // never resolves
        };

        await worker.start();
        while (!loopStarted) {
            await new Promise((r) => setTimeout(r, 5));
        }

        // Put an item in in-memory batch
        (worker as any).batch = [
            { streamId: 'hang-1', sequence: 1101, userId: 'HangUser', offset: 50, color: 1, placementId: 'phang' }
        ];

        // Call stop with a small 40ms timeout
        await assert.rejects(
            async () => {
                await worker.stop(40);
            },
            { message: /Persistence worker loop failed to terminate within 40ms/ }
        );

        // Verification 1: No final drain occurred while loop remained active
        assert.equal(mockDb.insertedRows.length, 0);

        // Verification 2: Redis was NOT disconnected prematurely
        assert.equal(mockRedis.isQuit, false);

        // Verification 3: No XACK was sent, so unacknowledged messages remain recoverable in Redis PEL
        assert.equal(mockRedis.acks.length, 0);
    });

    test('12. Message returned by XREADGROUP just as shutdown begins is captured, persisted, and acknowledged', async () => {
        const worker = new PersistenceWorker({
            redisClient: mockRedis as any,
            dbClient: mockDb as any,
            maxBatchWaitMs: 60_000,
            logger: silentLogger
        });

        let returnedMsg = false;
        let readCalledResolve!: () => void;
        const readCalledPromise = new Promise<void>((r) => {
            readCalledResolve = r;
        });

        mockRedis.xreadgroup = async () => {
            if (!returnedMsg) {
                returnedMsg = true;
                readCalledResolve();
                // Delay so stop() is called while xreadgroup is actively in flight
                await new Promise((r) => setTimeout(r, 20));
                return [
                    [
                        'pixel_log',
                        [
                            ['race-msg-1', ['user_id', 'RaceUser', 'offset', '888', 'color', '3', 'placement_id', 'prace', 'seq', '1201']]
                        ]
                    ]
                ];
            }
            return null;
        };

        await worker.start();
        // Wait until xreadgroup is actively executing
        await readCalledPromise;

        // Await the shutdown completion
        await worker.stop();

        // Verify the message that arrived during stop() was captured, flushed, and acknowledged
        assert.equal(mockDb.insertedRows.length, 1);
        assert.equal(mockDb.insertedRows[0].streamId, 'race-msg-1');
        assert.equal(mockDb.insertedRows[0].sequence, 1201);
        assert.ok(mockRedis.acks.includes('race-msg-1'));
    });
});
