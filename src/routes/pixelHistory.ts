import { FastifyInstance, FastifyRequest } from 'fastify';
import { desc, eq } from 'drizzle-orm';
import { db } from '../db/postgres.js';
import { pixelPlacements } from '../db/schema.js';
import { CANVAS_HEIGHT, CANVAS_WIDTH } from '../config/canvas.js';

interface PixelParams {
	x: string;
	y: string;
}

export default async function pixelHistoryRoutes(app: FastifyInstance) {
	app.get('/:x/:y', async (request: FastifyRequest<{ Params: PixelParams }>, reply) => {
		const x = Number(request.params.x);
		const y = Number(request.params.y);

		if (
			!Number.isInteger(x) || x < 0 || x >= CANVAS_WIDTH ||
			!Number.isInteger(y) || y < 0 || y >= CANVAS_HEIGHT
		) {
			return reply.status(400).send({ error: 'Coordinates must be within the canvas bounds' });
		}

		const offset = ((y * CANVAS_WIDTH) + x) * 4;

		try {
			const [placement] = await db
				.select({
					color: pixelPlacements.color,
					userId: pixelPlacements.userId
				})
				.from(pixelPlacements)
				.where(eq(pixelPlacements.offset, offset))
				.orderBy(desc(pixelPlacements.sequence))
				.limit(1);

			if (!placement) {
				return reply.status(404).send({ error: 'Pixel has not been placed yet' });
			}

			return reply.send({
				x,
				y,
				color: placement.color,
				userId: placement.userId
			});
		} catch (error) {
			app.log.error(error, `Failed to fetch pixel history for (${x}, ${y})`);
			return reply.status(500).send({ error: 'Internal Server Error' });
		}
	});
}
