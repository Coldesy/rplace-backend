import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { redis } from '../db/redis.js'
import { CANVAS_WIDTH, CANVAS_HEIGHT, CANVAS_BYTES, calculateCanvasBytes } from '../config/canvas.js'

export const CANVAS_KEY = 'canvas:state';
export const CANVAS_META_KEY = 'canvas:meta';
export const CANVAS_SEQ_KEY = 'canvas:seq';

export interface RedisCanvasClient {
    hgetall(key: string): Promise<Record<string, string>>;
    hset(key: string, data: Record<string, string>): Promise<unknown>;
    strlen(key: string): Promise<number>;
    set(key: string, value: Buffer | string): Promise<unknown>;
    setnx(key: string, value: string): Promise<number>;
}

export interface CanvasMetadata {
    width: number;
    height: number;
    bytes: number;
    createdAt?: string;
    adoptedAt?: string;
    updatedAt?: string;
}

export type BoardValidationResult =
    | { status: 'initialized'; metadata: CanvasMetadata }
    | { status: 'adopted'; metadata: CanvasMetadata }
    | { status: 'verified'; metadata: CanvasMetadata };

export const calculatePixelOffset = (x: number, y: number, width: number = CANVAS_WIDTH): number => {
    return ((y * width) + x) * 4;
};

export async function validateOrInitBoardState(
    redisClient: RedisCanvasClient,
    options: {
        width?: number;
        height?: number;
        bytes?: number;
    } = {}
): Promise<BoardValidationResult> {
    const width = options.width ?? CANVAS_WIDTH;
    const height = options.height ?? CANVAS_HEIGHT;
    const expectedBytes = options.bytes ?? calculateCanvasBytes(width, height);

    const meta = await redisClient.hgetall(CANVAS_META_KEY);

    // Case 1: Metadata exists in Redis
    if (meta && meta.width && meta.height) {
        const metaWidth = Number(meta.width);
        const metaHeight = Number(meta.height);
        const metaBytes = Number(meta.bytes ?? calculateCanvasBytes(metaWidth, metaHeight));

        if (metaWidth !== width || metaHeight !== height) {
            throw new Error(
                `Canvas dimension mismatch: Redis board metadata specifies ${metaWidth}x${metaHeight} (${metaBytes} bytes), ` +
                `but server is configured for ${width}x${height} (${expectedBytes} bytes). ` +
                `Existing board data cannot be silently reinterpreted with different dimensions. Refusing to start to protect board data.`
            );
        }

        const currentLen = await redisClient.strlen(CANVAS_KEY);
        if (currentLen === 0) {
            throw new Error(
                `Canvas state corrupted: metadata exists for ${metaWidth}x${metaHeight} (${expectedBytes} bytes), ` +
                `but key '${CANVAS_KEY}' is missing or empty in Redis.`
            );
        }

        if (currentLen !== expectedBytes) {
            throw new Error(
                `Canvas buffer length mismatch: Redis key '${CANVAS_KEY}' has length ${currentLen} bytes, ` +
                `expected ${expectedBytes} bytes for ${width}x${height}. Refusing to start to protect board data.`
            );
        }

        return {
            status: 'verified',
            metadata: { width: metaWidth, height: metaHeight, bytes: metaBytes, ...meta }
        };
    }

    // Case 2: Metadata does not exist
    const currentLen = await redisClient.strlen(CANVAS_KEY);

    // Subcase 2A: Genuinely empty Redis instance
    if (currentLen === 0) {
        const emptyBoard = Buffer.alloc(expectedBytes);
        const now = new Date().toISOString();
        await redisClient.set(CANVAS_KEY, emptyBoard);
        await redisClient.setnx(CANVAS_SEQ_KEY, '0');
        await redisClient.hset(CANVAS_META_KEY, {
            width: String(width),
            height: String(height),
            bytes: String(expectedBytes),
            createdAt: now,
            updatedAt: now
        });
        console.log(`Initialized empty board: ${width}x${height} (${expectedBytes} bytes) with metadata.`);
        return {
            status: 'initialized',
            metadata: { width, height, bytes: expectedBytes, createdAt: now }
        };
    }

    // Subcase 2B: Existing un-versioned board data (e.g. deployed 300,000-byte board)
    // For initial rollout, baseline is known 1000x600 board with 300,000 bytes.
    if (currentLen === 300000) {
        if (width === 1000 && height === 600) {
            const now = new Date().toISOString();
            await redisClient.hset(CANVAS_META_KEY, {
                width: '1000',
                height: '600',
                bytes: '300000',
                adoptedAt: now,
                updatedAt: now
            });
            console.log(`Safely adopted existing 300,000-byte board into metadata: 1000x600.`);
            return {
                status: 'adopted',
                metadata: { width: 1000, height: 600, bytes: 300000, adoptedAt: now }
            };
        } else {
            throw new Error(
                `Cannot adopt existing un-versioned board: Redis contains an existing 300000-byte board corresponding to ` +
                `the baseline 1000x600 dimensions, but the application is configured for ${width}x${height} (${expectedBytes} bytes). ` +
                `Please start with CANVAS_WIDTH=1000 and CANVAS_HEIGHT=600 to establish metadata, or run a data migration before changing dimensions.`
            );
        }
    }

    // Any other byte length without metadata cannot be guessed safely
    throw new Error(
        `Cannot adopt existing un-versioned board: Redis contains an existing ${currentLen}-byte board without metadata, ` +
        `which does not match the known 1000x600 baseline (300000 bytes). ` +
        `Dimensions cannot be established safely without prior metadata. Refusing to start to protect board data.`
    );
}

class Canvas{
    private ps: string | null = null;
    async init(){
        const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'placement.lua')
        const script = fs.readFileSync(scriptPath, 'utf-8')
        this.ps = await redis.script('LOAD', script) as string
        console.log(`Loaded placement script with SHA: ${this.ps}`)
        await validateOrInitBoardState(redis)
    }
    async placePixel(
        userId: string,
        x: number,
        y: number,
        colorId: number,
        placementId: string,
        maxPixels: number,
        cooldown: number
    ){
        
        if(!this.ps) throw new Error('Placement script not loaded')
        const offset = ((y * CANVAS_WIDTH) + x) * 4
        try{
            //console.log(`Placing pixel for user ${userId} Max pixels: ${maxPixels}, Cooldown: ${cooldown}`)
            const result = await redis.evalsha(
                this.ps,
                4,
                `cooldown:${userId}`,
                `canvas:state`,
                `pixel_log`,
                `canvas:seq`,
                 maxPixels,
                 cooldown,
                 offset,
                 colorId,
                 userId,
                 placementId
            ) as any[]
            if (result[0] === 'ok' && result[1] === 'DUPLICATE_IGNORED') {
                console.log(`Duplicate placement ignored for user ${userId} at (${x}, ${y}) with color ${colorId}.`)
                return { success: false, error: result[1] }
            }
            if (result[0] === 'rate_limited') {
                console.error(`Error placing pixel fouwur user ${userId}:`, result[1])
                return { success: false, error: 'RATE_LIMITED', ttl: result[1] }
            }

            return { success: true, remaining: result[3], seq: result[5] }

        }catch(err){
            console.error(`Error placing pixel for user ${userId}:`, err)
            throw err
        }
    }
}
export const canvas = new Canvas()