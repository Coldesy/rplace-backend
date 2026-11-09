import 'dotenv/config';
import { FastifyInstance, FastifyRequest } from 'fastify';
import jwt from 'jsonwebtoken';
import { activeClients } from '../utilities/broadcast.js';
import { handleMessage } from '../handlers/webSocket.js';

const PR_POINTS_CACHE_TTL = 10_000;

const fetchPRPoints = async (participantId: string): Promise<number> => {
    const response = await fetch(
        `${process.env.GH_BACKEND_URL}/api/v1/participant/${encodeURIComponent(participantId)}/pr-points`,
    );

    if (!response.ok) {
        throw new Error(`PR points request failed with status ${response.status}`);
    }

    const body = await response.json() as { data?: number };
    return body.data ?? 0;
};

export default async function wsRoutes(app: FastifyInstance) {
    app.get('/', { websocket: true }, async (socket, req: FastifyRequest) => {
        let userId = 'anonymous';

        // Parse the query directly so this works even when req.query is unavailable.
        const queryString = req.url.split('?')[1] ?? '';
        const params = new URLSearchParams(queryString);
        const queryToken = params.get('token') ?? undefined;
        const cookieToken = req.cookies?.jwt;
        const token = cookieToken ?? queryToken;

        app.log.info(
            {
                url: req.url,
                hasToken: Boolean(token),
            },
            'WebSocket request received',
        );

        if (!token) {
            app.log.warn('Closing WebSocket: missing JWT token');
            socket.close(1008, 'Missing JWT token');
            return;
        }

        try {
            const secret = process.env.JWT_SECRET ?? process.env.JWT;

            if (!secret) {
                throw new Error('JWT_SECRET or JWT is not configured');
            }

            const payload = jwt.verify(token, secret) as jwt.JwtPayload;

            if (typeof payload.id !== 'string') {
                app.log.warn('Closing WebSocket: JWT does not contain a valid id');
                socket.close(1008, 'Invalid JWT payload');
                return;
            }

            userId = payload.id;

            app.log.info({ userId }, 'WebSocket authenticated');
        } catch (error) {
            app.log.error(error, 'WebSocket JWT verification failed');
            socket.close(1008, 'Invalid JWT token');
            return;
        }

        let prPoints = 0;
        let prPointsFetchedAt = 0;

        const getCachedPRPoints = async (
            participantId: string,
        ): Promise<number> => {
            if (participantId === 'anonymous') {
                return 0;
            }

            const now = Date.now();

            if (now - prPointsFetchedAt < PR_POINTS_CACHE_TTL) {
                return prPoints;
            }

            try {
                prPoints = await fetchPRPoints(participantId);
                prPointsFetchedAt = now;
            } catch (error) {
                app.log.error(
                    error,
                    `Unable to fetch PR points for ${participantId}`,
                );
            }

            return prPoints;
        };

        activeClients.add(socket);

        socket.on('message', async (message: Buffer) => {
            try {
                await handleMessage(
                    socket,
                    message,
                    userId,
                    getCachedPRPoints,
                );
            } catch (error) {
                app.log.error(
                    error,
                    `Unhandled WebSocket message error for ${userId}`,
                );
            }
        });

        socket.on('error', (error) => {
            app.log.error(error, `WebSocket error for ${userId}`);
        });

        socket.on('close', (code, reason) => {
            app.log.info(
                {
                    userId,
                    code,
                    reason: reason.toString(),
                },
                'WebSocket closed',
            );

            activeClients.delete(socket);
        });
    });
}