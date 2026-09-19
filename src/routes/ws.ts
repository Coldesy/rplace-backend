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

        socket.on('message', (message: Buffer) => {
            handleMessage(socket, message, userId);
        });

        socket.on('close', () => {
            activeClients.delete(socket);
            app.log.info(`Client disconnected: ${userId}. Total active: ${activeClients.size}`);
        });
    });
}