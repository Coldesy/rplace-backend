import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { redis } from '../db/redis.js';

interface Placement {
    userId: string;
    offset: number;
    color: number;
    placementId: string;
    sequence: number;
    savedAt: string;
}

type StreamField = [string, string];
type StreamEntry = [string, StreamField[]];

const STREAM_KEY = 'pixel_log';
const GROUP_NAME = 'placement-json-writer';
const CONSUMER_NAME = process.env.WORKER_CONSUMER_NAME ?? `worker-${process.pid}`;
const DATA_PATH = path.resolve(process.env.PLACEMENTS_FILE ?? 'data/placements.json');
const FLUSH_INTERVAL_MS = 2 * 60 * 60 * 1000;
const MAX_BATCH_SIZE = 1_000;

const parsePlacement = (fields: StreamField[]): Placement => {
    const values = Object.fromEntries(fields);
    return {
        userId: values.user_id,
        offset: Number(values.offset),
        color: Number(values.color),
        placementId: values.placement_id,
        sequence: Number(values.seq),
        savedAt: new Date().toISOString()
    };
};

const loadPlacements = async (): Promise<Placement[]> => {
    try {
        return JSON.parse(await readFile(DATA_PATH, 'utf8')) as Placement[];
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return [];
        }
        throw error;
    }
};

const saveBatch = async (entries: StreamEntry[]): Promise<void> => {
    if (entries.length === 0) {
        return;
    }

    const existingPlacements = await loadPlacements();
    const existingIds = new Set(existingPlacements.map(({ placementId }) => placementId));
    const newPlacements = entries
        .map(([, fields]) => parsePlacement(fields))
        .filter(({ placementId }) => !existingIds.has(placementId));
    const placements = [...existingPlacements, ...newPlacements];
    const temporaryPath = `${DATA_PATH}.tmp`;

    await mkdir(path.dirname(DATA_PATH), { recursive: true });
    await writeFile(temporaryPath, `${JSON.stringify(placements, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, DATA_PATH);

    await redis.xack(STREAM_KEY, GROUP_NAME, ...entries.map(([id]) => id));
    console.log(`Saved ${entries.length} placements to ${DATA_PATH}`);
};

const ensureConsumerGroup = async (): Promise<void> => {
    try {
        await redis.xgroup('CREATE', STREAM_KEY, GROUP_NAME, '0', 'MKSTREAM');
    } catch (error: unknown) {
        if (!(error instanceof Error) || !error.message.includes('BUSYGROUP')) {
            throw error;
        }
    }
};

const readBatch = async (startId: string): Promise<StreamEntry[]> => {
    const result = await redis.xreadgroup(
        'GROUP', GROUP_NAME, CONSUMER_NAME,
        'COUNT', MAX_BATCH_SIZE,
        'BLOCK', 60_000,
        'STREAMS', STREAM_KEY, startId
    ) as [string, StreamEntry[]][] | null;

    return result?.[0]?.[1] ?? [];
};

const run = async (): Promise<void> => {
    await redis.connect();
    await ensureConsumerGroup();
    console.log(`Placement JSON worker started; writing to ${DATA_PATH}`);

    let pending = await readBatch('0');
    let lastFlush = Date.now();

    while (true) {
        pending.push(...await readBatch('>'));
        const shouldFlush = pending.length >= MAX_BATCH_SIZE ||
            (pending.length > 0 && Date.now() - lastFlush >= FLUSH_INTERVAL_MS);

        if (shouldFlush) {
            await saveBatch(pending);
            pending = [];
            lastFlush = Date.now();
        }
    }
};

run().catch((error) => {
    console.error('Placement JSON worker stopped:', error);
    process.exitCode = 1;
});
