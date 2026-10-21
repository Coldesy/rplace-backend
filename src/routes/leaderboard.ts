import { FastifyInstance, FastifyRequest } from 'fastify';
import { count, desc } from 'drizzle-orm';
import { db } from '../db/postgres.js';
import { pixelPlacements } from '../db/schema.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

interface LeaderboardQuery {
	limit?: string;
}

export default async function leaderboardRoutes(app: FastifyInstance) {
	app.get('/', async (request: FastifyRequest<{ Querystring: LeaderboardQuery }>, reply) => {
		const requestedLimit = request.query.limit === undefined
			? DEFAULT_LIMIT
			: Number(request.query.limit);

		if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
			return reply.status(400).send({ error: 'limit must be a positive integer' });
		}

		const limit = Math.min(requestedLimit, MAX_LIMIT);
		const placementCount = count(pixelPlacements.streamId);

		try {
			const leaderboard = await db
				.select({
					userId: pixelPlacements.userId,
					placements: placementCount
				})
				.from(pixelPlacements)
				.groupBy(pixelPlacements.userId)
				.orderBy(desc(placementCount), pixelPlacements.userId)
				.limit(limit);

			return reply.send({ data: leaderboard });
		} catch (error) {
			app.log.error(error, 'Failed to fetch leaderboard');
			return reply.status(500).send({ error: 'Internal Server Error' });
		}
	});
}
