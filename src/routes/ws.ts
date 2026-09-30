import { FastifyInstance, FastifyRequest } from 'fastify';
import { activeClients } from '../utilities/broadcast.js';
import { handleMessage } from '../handlers/webSocket.js';
import { getAuthMode, requireGithubAuthConfig } from '../config.js';
import { verifySession, sessionCookieName } from '../auth/session.js';

interface WsQuery {
    mock_user_id?: string;
}

export default async function wsRoutes(app: FastifyInstance) {
    app.get('/', { websocket: true }, async (socket, req: FastifyRequest<{ Querystring: WsQuery }>) => {
        const authMode = getAuthMode();
        let userId: string | null;

        if (authMode === 'github') {
            const config = requireGithubAuthConfig();

            // Origin allow-list — github mode only, per approved scope.
            const origin = req.headers.origin;
            if (origin !== config.frontendUrl) {
                app.log.warn(`Rejecting WebSocket connection from disallowed origin: ${origin ?? '(none)'}`);
                // The @fastify/websocket upgrade has already completed by the
                // time this handler runs, so this closes the socket
                // immediately after accept rather than refusing the HTTP
                // upgrade itself. In effect no disallowed-origin client can
                // exchange any further messages over this connection.
                socket.close(4403, 'ORIGIN_NOT_ALLOWED');
                return;
            }

            const cookieName = sessionCookieName(config.cookieSecure);
            const token = req.cookies?.[cookieName];
            userId = await verifySession(token);
            // mock_user_id and any other client-supplied identity are never
            // read here — identity comes only from the verified session.
        } else {
            // Unchanged from before Stage 2.
            userId = req.query.mock_user_id || 'anonymous';
        }

        activeClients.add(socket);
        app.log.info(`Client connected: ${userId ?? 'anonymous'}. Total active: ${activeClients.size}`);

        socket.send(JSON.stringify({ type: 'INIT_BOARD', message: 'Board binary will be served here' }));

        socket.on('message', async (message: Buffer) => {
            console.log(`Received message from user ${userId ?? 'anonymous'}:`, message);
            try {
                await handleMessage(socket, message, userId);
            } catch (error) {
                app.log.error(error, `Unhandled WebSocket message error for ${userId ?? 'anonymous'}`);
            }
        });

        socket.on('error', (error) => {
            app.log.error(error, `WebSocket error for ${userId ?? 'anonymous'}`);
        });

        socket.on('close', () => {
            activeClients.delete(socket);
            app.log.info(`Client disconnected: ${userId ?? 'anonymous'}. Total active: ${activeClients.size}`);
        });
    });
}
