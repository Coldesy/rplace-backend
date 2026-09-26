import { FastifyInstance } from 'fastify';
import { redis } from '../db/redis.js';

const CANVAS_KEY = 'canvas:state';
const MAX_CANVAS_BYTES = 300_000;
const emptyBoard = Buffer.alloc(MAX_CANVAS_BYTES);

export default async function boardRoutes(app: FastifyInstance) {
	app.get('/', async (_request, reply) => {
		try {
			let boardBuffer = await redis.getBuffer(CANVAS_KEY);
			//console.log(boardBuffer)
			if (!boardBuffer) {
				await redis.set(CANVAS_KEY, emptyBoard, 'NX');
				boardBuffer = await redis.getBuffer(CANVAS_KEY);
			}

			if (!boardBuffer) {
				return reply.status(500).send({ error: 'Internal Server Error' });
			}

			const sequence = await redis.get('canvas:seq');
			reply.header('X-Canvas-Sequence', sequence || '0');
			reply.header('Content-Type', 'application/octet-stream');
			reply.header('Cache-Control', 'no-store');
			return reply.send(boardBuffer);
		} catch (error) {
			app.log.error(error, 'Failed to fetch board state');
			return reply.status(500).send({ error: 'Internal Server Error' });
		}
	});
}
