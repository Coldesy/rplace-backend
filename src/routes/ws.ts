import { FastifyInstance, FastifyRequest } from 'fastify';
import { activeClients } from '../utilities/broadcast.js';
import { handleMessage } from '../handlers/webSocket.js';

interface WsQuery {
    mock_user_id?: string;
}

export default async function wsRoutes(app: FastifyInstance) {
    app.get('/', { websocket: true }, (socket, req: FastifyRequest<{ Querystring: WsQuery }>) => {
        const userId = req.query.mock_user_id || 'anonymous';
        
        activeClients.add(socket);
        app.log.info(`Client connected: ${userId}. Total active: ${activeClients.size}`);

        socket.send(JSON.stringify({ type: 'INIT_BOARD', message: 'Board binary will be served here' }));

        socket.on('message', async (message: Buffer) => {
            console.log(`Received message from user ${userId}:`, message);
            try {
                await handleMessage(socket, message, userId);
            } catch (error) {
                app.log.error(error, `Unhandled WebSocket message error for ${userId}`);
            }
        });

        socket.on('error', (error) => {
            app.log.error(error, `WebSocket error for ${userId}`);
        });

        socket.on('close', () => {
            activeClients.delete(socket);
            app.log.info(`Client disconnected: ${userId}. Total active: ${activeClients.size}`);
        });
    });
}