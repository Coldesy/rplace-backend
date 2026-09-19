import type { WebSocket } from 'ws';
import { broadcast } from '../utilities/broadcast.js';
import { canvas } from '../utilities/canvas.js';

export const handleMessage = async (socket: WebSocket, message: Buffer, userId: string) => {
    try {
        const data = JSON.parse(message.toString());

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
            const placementId = data.placementId || 'default'; // 60 seconds cooldown
            
            const result = await canvas.placePixel(
                userId,
                data.x,
                data.y,
                data.color,
                placementId,
                maxPixels,
                cooldown
            );

            if(!result.success){
                socket.send(JSON.stringify({
                    type: 'ERROR',
                    error: result.error,
                    ttl: result.ttl
                }));
                return;
            }


            broadcast(JSON.stringify({
                type: 'PIXEL_UPDATE',
                x: data.x,
                y: data.y,
                color: data.color,
                seq: result.seq
            }));
        }
    } catch (err) {
        const error = err instanceof Error ? err.message : 'Unknown placement error';
        console.error(`[USER: ${userId}] Failed to place pixel: ${error}`);
        socket.send(JSON.stringify({ type: 'ERROR', error: 'PLACEMENT_FAILED', message: error }));
    }
};