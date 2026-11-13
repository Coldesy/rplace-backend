import { db } from '../db/postgres.js';
import { pixelPlacements } from '../db/schema.js';
import { redis } from '../db/redis.js';
import * as os from 'node:os';
import type { Redis } from 'ioredis';

export interface PlacementBatchItem {
    streamId: string;
    userId: string;
    offset: number;
    color: number;
    placementId: string;
    sequence: number;
}

export interface WorkerOptions {
    redisClient?: Redis;
    dbClient?: typeof db;
    streamName?: string;
    consumerGroup?: string;
    consumerName?: string;
    batchSize?: number;
    maxBatchWaitMs?: number;
    claimMinIdleMs?: number;
    claimBatchSize?: number;
    claimIntervalMs?: number;
    shutdownTimeoutMs?: number;
    closeRedisOnStop?: boolean;
    logger?: {
        info: (...args: any[]) => void;
        warn: (...args: any[]) => void;
        error: (...args: any[]) => void;
    };
}

export interface WorkerStats {
    isRunning: boolean;
    inMemoryBatchSize: number;
    totalPersisted: number;
    totalRecovered: number;
    claimCursor: string;
}

export interface ClaimResult {
    nextCursor: string;
    claimedCount: number;
    persistedCount: number;
    deletedCount: number;
}

export function parseStreamEntry(
    streamId: string,
    fields: string[] | Record<string, string>
): PlacementBatchItem | null {
    if (!streamId || !fields) return null;

    let userId = '';
    let offset = -1;
    let color = -1;
    let placementId = '';
    let sequence = -1;

    if (Array.isArray(fields)) {
        if (fields.length < 2) return null;
        for (let i = 0; i < fields.length; i += 2) {
            const k = fields[i];
            const v = fields[i + 1];
            if (k === 'user_id' || k === 'userId') userId = v;
            else if (k === 'offset') offset = Number(v);
            else if (k === 'color') color = Number(v);
            else if (k === 'placement_id' || k === 'placementId') placementId = v;
            else if (k === 'seq' || k === 'sequence') sequence = Number(v);
        }
    } else if (typeof fields === 'object') {
        const obj = fields as Record<string, any>;
        userId = obj.user_id || obj.userId || '';
        offset = Number(obj.offset);
        color = Number(obj.color);
        placementId = obj.placement_id || obj.placementId || '';
        sequence = Number(obj.seq || obj.sequence);
    }

    if (
        !userId ||
        isNaN(offset) ||
        offset < 0 ||
        isNaN(color) ||
        color < 0 ||
        !placementId ||
        isNaN(sequence) ||
        sequence <= 0
    ) {
        return null;
    }

    return {
        streamId,
        userId,
        offset,
        color,
        placementId,
        sequence
    };
}

export async function flushBatch(
    dbClient: any,
    redisClient: any,
    streamName: string,
    consumerGroup: string,
    batch: PlacementBatchItem[]
): Promise<number> {
    if (!batch || batch.length === 0) return 0;

    // Deduplicate within the batch itself to prevent duplicate insertion attempts
    const seen = new Map<string, PlacementBatchItem>();
    for (const item of batch) {
        seen.set(item.streamId, item);
    }
    const dedupedBatch = Array.from(seen.values());

    // Sort by sequence ascending for deterministic persistence order
    dedupedBatch.sort((a, b) => a.sequence - b.sequence);

    // 1. Insert into PostgreSQL with ON CONFLICT DO NOTHING for idempotency
    await dbClient.insert(pixelPlacements)
        .values(dedupedBatch)
        .onConflictDoNothing();

    // 2. Only after database write succeeds, acknowledge in Redis
    const streamIds = dedupedBatch.map((p) => p.streamId);
    await redisClient.xack(streamName, consumerGroup, ...streamIds);

    return dedupedBatch.length;
}

export async function claimAbandonedMessages(
    redisClient: any,
    dbClient: any,
    streamName: string,
    consumerGroup: string,
    consumerName: string,
    minIdleMs: number,
    startCursor: string = '0-0',
    batchSize: number = 100
): Promise<ClaimResult> {
    const rawResult = await redisClient.xautoclaim(
        streamName,
        consumerGroup,
        consumerName,
        minIdleMs,
        startCursor,
        'COUNT',
        batchSize
    );

    if (!rawResult || !Array.isArray(rawResult)) {
        return { nextCursor: '0-0', claimedCount: 0, persistedCount: 0, deletedCount: 0 };
    }

    const nextCursor = String(rawResult[0] || '0-0');
    const rawEntries = rawResult[1] || [];
    const deletedIds = Array.isArray(rawResult[2]) ? rawResult[2] : [];

    if (!Array.isArray(rawEntries) || rawEntries.length === 0) {
        return { nextCursor, claimedCount: 0, persistedCount: 0, deletedCount: deletedIds.length };
    }

    const items: PlacementBatchItem[] = [];
    const phantomIds: string[] = [];

    for (const entry of rawEntries) {
        if (!entry || !Array.isArray(entry) || entry.length < 2) continue;
        const [id, fields] = entry;
        if (!fields) {
            // Redis 6.2 compatibility: entry deleted from stream while in PEL
            phantomIds.push(id);
            continue;
        }
        const parsed = parseStreamEntry(id, fields);
        if (parsed) {
            items.push(parsed);
        }
    }

    // In Redis 6.2, acknowledge phantom IDs to clear them from PEL
    if (phantomIds.length > 0) {
        try {
            await redisClient.xack(streamName, consumerGroup, ...phantomIds);
        } catch {
            // Non-fatal if acknowledge fails
        }
    }

    let persistedCount = 0;
    if (items.length > 0) {
        persistedCount = await flushBatch(dbClient, redisClient, streamName, consumerGroup, items);
    }

    return {
        nextCursor,
        claimedCount: rawEntries.length,
        persistedCount,
        deletedCount: deletedIds.length + phantomIds.length
    };
}

export class PersistenceWorker {
    private streamRedis: any;
    private dbClient: any;
    private streamName: string;
    private consumerGroup: string;
    private consumerName: string;
    private batchSize: number;
    private maxBatchWaitMs: number;
    private claimMinIdleMs: number;
    private claimBatchSize: number;
    private claimIntervalMs: number;
    private shutdownTimeoutMs: number;
    private closeRedisOnStop: boolean;
    private logger: NonNullable<WorkerOptions['logger']>;

    private running = false;
    private batch: PlacementBatchItem[] = [];
    private batchDeadline = 0;
    private lastClaimTime = 0;
    private claimCursor = '0-0';
    private totalPersisted = 0;
    private totalRecovered = 0;

    private flushPromise: Promise<number> | null = null;
    private loopPromise: Promise<void> | null = null;
    private stopPromise: Promise<void> | null = null;

    constructor(options: WorkerOptions = {}) {
        this.closeRedisOnStop = options.closeRedisOnStop ?? true;
        this.streamRedis = options.redisClient ?? redis.duplicate();
        this.dbClient = options.dbClient ?? db;
        this.streamName = options.streamName ?? 'pixel_log';
        this.consumerGroup = options.consumerGroup ?? 'pixel-placement-persistence';
        this.consumerName = options.consumerName ?? (process.env.WORKER_NAME || os.hostname());
        this.batchSize = options.batchSize ?? 5000;
        this.maxBatchWaitMs = options.maxBatchWaitMs ?? 10_000;
        this.claimMinIdleMs = options.claimMinIdleMs ?? (Number(process.env.PENDING_RECOVERY_IDLE_MS) || 30_000);
        this.claimBatchSize = options.claimBatchSize ?? 100;
        this.claimIntervalMs = options.claimIntervalMs ?? 10_000;
        this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5_000;
        this.logger = options.logger ?? console;
    }

    public isRunning(): boolean {
        return this.running;
    }

    public getStats(): WorkerStats {
        return {
            isRunning: this.running,
            inMemoryBatchSize: this.batch.length,
            totalPersisted: this.totalPersisted,
            totalRecovered: this.totalRecovered,
            claimCursor: this.claimCursor
        };
    }

    public async drainBatch(): Promise<number> {
        if (this.flushPromise) {
            await this.flushPromise;
        }

        if (this.batch.length === 0) return 0;

        const currentBatch = this.batch;
        this.batch = [];

        this.flushPromise = (async () => {
            try {
                const flushed = await flushBatch(
                    this.dbClient,
                    this.streamRedis,
                    this.streamName,
                    this.consumerGroup,
                    currentBatch
                );
                this.totalPersisted += flushed;
                return flushed;
            } catch (err) {
                // If flush fails, restore batch so messages are retried or remain pending in Redis PEL
                this.batch = [...currentBatch, ...this.batch];
                throw err;
            } finally {
                this.flushPromise = null;
            }
        })();

        return this.flushPromise;
    }

    public async start(): Promise<void> {
        if (this.running) {
            this.logger.warn('[PersistenceWorker] Worker already running.');
            return;
        }

        this.running = true;
        this.stopPromise = null;

        // Ensure consumer group exists
        try {
            await this.streamRedis.xgroup('CREATE', this.streamName, this.consumerGroup, '0-0', 'MKSTREAM');
        } catch (error) {
            if (!(error instanceof Error) || !error.message.includes('BUSYGROUP')) {
                throw error;
            }
        }

        // Run initial recovery sweep for any abandoned entries from a previous process crash
        try {
            const initialRecovery = await claimAbandonedMessages(
                this.streamRedis,
                this.dbClient,
                this.streamName,
                this.consumerGroup,
                this.consumerName,
                this.claimMinIdleMs,
                '0-0',
                this.claimBatchSize
            );
            if (initialRecovery.persistedCount > 0) {
                this.totalRecovered += initialRecovery.persistedCount;
                this.logger.info(`[PersistenceWorker] Initial recovery reclaimed and persisted ${initialRecovery.persistedCount} abandoned placement(s).`);
            }
            this.claimCursor = initialRecovery.nextCursor;
            this.lastClaimTime = Date.now();
        } catch (recErr) {
            this.logger.error('[PersistenceWorker] Initial abandoned message recovery warning:', recErr);
        }

        this.loopPromise = this.runLoop();
    }

    private async runLoop(): Promise<void> {
        try {
            while (this.running) {
                const now = Date.now();

                // 1. Periodic abandoned message recovery
                if (now - this.lastClaimTime >= this.claimIntervalMs) {
                    this.lastClaimTime = now;
                    try {
                        const claimRes = await claimAbandonedMessages(
                            this.streamRedis,
                            this.dbClient,
                            this.streamName,
                            this.consumerGroup,
                            this.consumerName,
                            this.claimMinIdleMs,
                            this.claimCursor,
                            this.claimBatchSize
                        );
                        this.claimCursor = claimRes.nextCursor;
                        if (claimRes.persistedCount > 0) {
                            this.totalRecovered += claimRes.persistedCount;
                            this.logger.info(`[PersistenceWorker] Reclaimed and persisted ${claimRes.persistedCount} abandoned placement(s).`);
                        }
                    } catch (claimErr) {
                        this.logger.error('[PersistenceWorker] Error recovering abandoned messages:', claimErr);
                    }
                }

                if (!this.running) break;

                // 2. Read new messages with bounded blocking to allow responsive shutdown
                if (this.batch.length === 0) {
                    this.batchDeadline = Date.now() + this.maxBatchWaitMs;
                }

                const remainingWaitMs = Math.max(1, this.batchDeadline - Date.now());
                const blockMs = Math.min(1000, remainingWaitMs);

                let result: any = null;
                try {
                    result = await this.streamRedis.xreadgroup(
                        'GROUP',
                        this.consumerGroup,
                        this.consumerName,
                        'COUNT',
                        this.batchSize - this.batch.length,
                        'BLOCK',
                        blockMs,
                        'STREAMS',
                        this.streamName,
                        '>'
                    );
                } catch (readErr: any) {
                    if (!this.running) break;
                    this.logger.error('[PersistenceWorker] Error reading stream:', readErr);
                    await new Promise((r) => setTimeout(r, 500));
                    continue;
                }

                // If xreadgroup returned messages, always parse them into the batch
                // before evaluating loop exit, ensuring zero messages are lost
                if (result && Array.isArray(result) && result.length > 0 && Array.isArray(result[0][1])) {
                    const entries = result[0][1];
                    for (const [streamId, fields] of entries) {
                        const item = parseStreamEntry(streamId, fields);
                        if (item) {
                            this.batch.push(item);
                        }
                    }
                }

                if (!this.running) break;

                const shouldFlush =
                    this.batch.length >= this.batchSize ||
                    (this.batch.length > 0 && Date.now() >= this.batchDeadline);

                if (shouldFlush) {
                    try {
                        await this.drainBatch();
                    } catch (flushErr) {
                        this.logger.error('[PersistenceWorker] Batch flush error; retaining batch for retry:', flushErr);
                    }
                }
            }
        } catch (error) {
            this.logger.error('[PersistenceWorker] Fatal worker loop error:', error);
        }
    }

    public async stop(timeoutMs?: number): Promise<void> {
        if (this.stopPromise) {
            return this.stopPromise;
        }

        this.stopPromise = (async () => {
            this.logger.info('[PersistenceWorker] Stopping persistence worker...');
            this.running = false;

            const maxTimeout = timeoutMs ?? this.shutdownTimeoutMs;

            // 1. Wait for main loop to completely settle before proceeding
            if (this.loopPromise) {
                let timer: NodeJS.Timeout | null = null;
                const timeoutPromise = new Promise<never>((_, reject) => {
                    timer = setTimeout(() => {
                        reject(new Error(`Persistence worker loop failed to terminate within ${maxTimeout}ms`));
                    }, maxTimeout);
                });

                try {
                    await Promise.race([this.loopPromise, timeoutPromise]);
                } finally {
                    if (timer) clearTimeout(timer);
                }
            }

            // 2. The loop is now guaranteed to be fully stopped. Drain any remaining in-memory placement(s)
            try {
                const flushed = await this.drainBatch();
                if (flushed > 0) {
                    this.logger.info(`[PersistenceWorker] Successfully flushed and acknowledged ${flushed} placement(s) on shutdown.`);
                }
            } catch (flushErr) {
                this.logger.error('[PersistenceWorker] Failed to flush in-memory batch during shutdown; entries remain pending in Redis PEL for recovery:', flushErr);
                throw flushErr;
            }

            // 3. Close Redis connection only after loop and drain are finished
            if (this.closeRedisOnStop && typeof this.streamRedis.quit === 'function') {
                try {
                    await this.streamRedis.quit();
                } catch {
                    if (typeof this.streamRedis.disconnect === 'function') {
                        this.streamRedis.disconnect();
                    }
                }
            }

            this.logger.info('[PersistenceWorker] Persistence worker stopped.');
        })();

        return this.stopPromise;
    }
}

// Global worker instance management
let activeWorkerInstance: PersistenceWorker | null = null;

export const startPixelPlacementPersistence = async (options?: WorkerOptions): Promise<PersistenceWorker> => {
    if (activeWorkerInstance && activeWorkerInstance.isRunning()) {
        return activeWorkerInstance;
    }
    activeWorkerInstance = new PersistenceWorker(options);
    await activeWorkerInstance.start();
    return activeWorkerInstance;
};

export const stopPixelPlacementPersistence = async (timeoutMs?: number): Promise<void> => {
    if (!activeWorkerInstance) return;
    try {
        await activeWorkerInstance.stop(timeoutMs);
    } finally {
        activeWorkerInstance = null;
    }
};

export const getPersistenceWorker = (): PersistenceWorker | null => {
    return activeWorkerInstance;
};
