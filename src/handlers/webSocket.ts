import type { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { broadcast } from '../utilities/broadcast.js';
import { canvas } from '../utilities/canvas.js';

const BINARY_PLACEMENT_BYTES = 9;

const encodePixelUpdate = (x: number, y: number, color: number, seq: number) => {
    const payload = Buffer.alloc(BINARY_PLACEMENT_BYTES);
    payload.writeUInt16LE(x, 0);
    payload.writeUInt16LE(y, 2);
    payload.writeUInt8(color, 4);
    payload.writeUInt32LE(seq, 5);
    return payload;
};

export const handleMessage = async (socket: WebSocket, message: Buffer, userId: string) => {
    try {
        let data: { type: string; x: number; y: number; color: number; placementId?: string };
       
        if (message.length === BINARY_PLACEMENT_BYTES) {
            data = {
                type: 'PLACE_PIXEL',
                x: message.readUInt16LE(0),
                y: message.readUInt16LE(2),
                color: message.readUInt8(4),
                placementId: String(message.readUInt32LE(5))
            };
        } else {
            data = JSON.parse(message.toString());
        }

        if (data.type === 'PLACE_PIXEL') {
            if (
                !Number.isInteger(data.x) || data.x < 0 || data.x >= 1000 ||
                !Number.isInteger(data.y) || data.y < 0 || data.y >= 600 ||
                !Number.isInteger(data.color) || data.color < 0 || data.color > 15
            ) {
                socket.send(JSON.stringify({ type: 'ERROR', error: 'INVALID_PIXEL' }));
                return;
            }

            const maxPixels = 1;
            const cooldown = 6;
            const placementId = data.placementId || randomUUID();
            
            const result = await canvas.placePixel(
                userId,
                data.x,
                data.y,
                data.color,
                placementId,
                maxPixels,
                cooldown
            );



            if (!result.success) {
                socket.send(JSON.stringify({
                    type: 'ERROR',
                    error: result.error,
                    ...(result.ttl !== undefined ? { ttl: result.ttl } : {})
                }));
                return;
            }

            broadcast(encodePixelUpdate(data.x, data.y, data.color, result.seq));
        }
    } catch (err) {
        const error = err instanceof Error ? err.message : 'Unknown placement error';
        console.error(`[USER: ${userId}] Failed to place pixel: ${error}`);
        socket.send(JSON.stringify({ type: 'ERROR', error: 'PLACEMENT_FAILED', message: error }));
    }
};