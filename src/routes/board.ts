import { FastifyInstance } from 'fastify';
import jwt from 'jsonwebtoken';
import { redis } from '../db/redis.js';
import { CANVAS_BYTES, CANVAS_HEIGHT, CANVAS_WIDTH } from '../config/canvas.js';
import { CANVAS_KEY, CANVAS_META_KEY, CANVAS_SEQ_KEY } from '../utilities/canvas.js';

export const emptyBoard = Buffer.alloc(CANVAS_BYTES);
export const ALLOWED_UPLOAD_USERS = ['Coldesy', '0xshellghost'];

export interface JwtUserPayload extends jwt.JwtPayload {
	id?: string;
	githubId?: string;
	username?: string;
	roles?: {
		isAdmin?: boolean;
	};
}

export const getJwtSecret = (): string | undefined => {
	return process.env.JWT_SECRET || process.env.JWT || undefined;
};

export const extractAuthToken = (authHeader?: string, cookieToken?: string): string | undefined => {
	const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
	return bearerToken || cookieToken || undefined;
};

export const extractUserIdentity = (payload: JwtUserPayload | string | null | undefined): string | undefined => {
	if (!payload || typeof payload !== 'object') {
		return undefined;
	}

	// 1. Check githubId first (exact GitHub username issued by gh-portal-backend)
	if (typeof payload.githubId === 'string' && payload.githubId.trim() !== '') {
		return payload.githubId.trim();
	}

	// 2. Check username
	if (typeof payload.username === 'string' && payload.username.trim() !== '') {
		return payload.username.trim();
	}

	// 3. Check id (in gh-portal-backend, id is set to githubId)
	if (typeof payload.id === 'string' && payload.id.trim() !== '') {
		return payload.id.trim();
	}

	// 4. Check sub (standard JWT subject)
	if (typeof payload.sub === 'string' && payload.sub.trim() !== '') {
		return payload.sub.trim();
	}

	return undefined;
};

export const isUserAuthorizedForUpload = (identity: string | undefined): boolean => {
	if (!identity) return false;
	return ALLOWED_UPLOAD_USERS.includes(identity);
};

export const validateBoardUploadBuffer = (
	body: unknown,
	expectedBytes: number = CANVAS_BYTES,
	width: number = CANVAS_WIDTH,
	height: number = CANVAS_HEIGHT
): { valid: boolean; error?: string } => {
	if (!Buffer.isBuffer(body)) {
		return {
			valid: false,
			error: `Board data must be a binary buffer of exactly ${expectedBytes} bytes`
		};
	}

	if (body.length !== expectedBytes) {
		const rgbaExpected = width * height * 4;
		if (body.length === rgbaExpected) {
			return {
				valid: false,
				error: `Board data must be exactly ${expectedBytes} bytes in packed 4-bit format for ${width}x${height}. Received ${body.length} bytes (uncompressed RGBA format). Please quantize and pack pixels to 4-bit representation before uploading.`
			};
		}
		return {
			valid: false,
			error: `Board data must be exactly ${expectedBytes} bytes`
		};
	}

	return { valid: true };
};

export default async function boardRoutes(app: FastifyInstance) {
	const maxUploadBytes = Math.max(10 * 1024 * 1024, CANVAS_WIDTH * CANVAS_HEIGHT * 4);
	app.addContentTypeParser(
		'application/octet-stream',
		{ parseAs: 'buffer', bodyLimit: maxUploadBytes },
		(_request, body, done) => {
			done(null, body);
		}
	);

	app.get('/', async (_request, reply) => {
		try {
			const boardBuffer = await redis.getBuffer(CANVAS_KEY);
			if (!boardBuffer) {
				app.log.error('Canvas board state key is missing in Redis');
				return reply.status(500).send({ error: 'Canvas board state is unavailable' });
			}

			if (boardBuffer.length !== CANVAS_BYTES) {
				app.log.error(
					`Canvas board size mismatch: Redis has ${boardBuffer.length} bytes, expected ${CANVAS_BYTES} bytes for ${CANVAS_WIDTH}x${CANVAS_HEIGHT}`
				);
				return reply.status(500).send({ error: 'Canvas board state is corrupted or mismatched' });
			}

			const sequence = await redis.get(CANVAS_SEQ_KEY);
			reply.header('X-Canvas-Sequence', sequence || '0');
			reply.header('Content-Type', 'application/octet-stream');
			reply.header('Cache-Control', 'no-store');
			return reply.send(boardBuffer);
		} catch (error) {
			app.log.error(error, 'Failed to fetch board state');
			return reply.status(500).send({ error: 'Internal Server Error' });
		}
	});

	app.put<{ Body: Buffer }>('/', async (request, reply) => {
		const token = extractAuthToken(request.headers.authorization, request.cookies?.jwt);
		if (!token) {
			return reply.status(401).send({ error: 'Authentication required' });
		}

		const secret = getJwtSecret();
		if (!secret) {
			app.log.error('JWT secret is not configured (expected JWT_SECRET or JWT)');
			return reply.status(500).send({ error: 'Server authentication misconfiguration' });
		}

		let payload: JwtUserPayload;
		try {
			payload = jwt.verify(token, secret) as JwtUserPayload;
		} catch (err) {
			const errorMessage = err instanceof jwt.TokenExpiredError
				? 'Token has expired'
				: 'Invalid JWT token';
			return reply.status(401).send({ error: errorMessage });
		}

		const userId = extractUserIdentity(payload);
		if (!userId || !isUserAuthorizedForUpload(userId)) {
			return reply.status(403).send({ error: 'Board upload is not allowed for this user' });
		}

		const validation = validateBoardUploadBuffer(request.body);
		if (!validation.valid) {
			return reply.status(400).send({ error: validation.error });
		}

		try {
			const now = new Date().toISOString();
			const results = await redis.multi()
				.set(CANVAS_KEY, request.body)
				.incr(CANVAS_SEQ_KEY)
				.hset(CANVAS_META_KEY, {
					width: String(CANVAS_WIDTH),
					height: String(CANVAS_HEIGHT),
					bytes: String(CANVAS_BYTES),
					updatedAt: now
				})
				.exec();

			if (!results) {
				throw new Error('Redis transaction failed');
			}

			const [, sequenceResult] = results[1];
			return reply.send({
				message: 'Board uploaded successfully',
				sequence: Number(sequenceResult)
			});
		} catch (error) {
			app.log.error(error, 'Failed to upload board state');
			return reply.status(500).send({ error: 'Internal Server Error' });
		}
	});
}
