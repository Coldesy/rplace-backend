import { createHash, randomBytes } from 'node:crypto';
import type { FastifyReply } from 'fastify';
import { redis } from '../db/redis.js';

export const OAUTH_STATE_COOKIE_NAME = 'oauth_state';

const STATE_KEY_PREFIX = 'oauth_state:';

function hashState(state: string): string {
    return createHash('sha256').update(state).digest('hex');
}

/**
 * Generates a fresh OAuth state, records its hash in Redis with a TTL, and
 * sets it as a short-lived HttpOnly cookie bound to this OAuth attempt.
 * Returns the raw state value to embed in the GitHub authorize URL.
 */
export async function issueOAuthState(
    reply: FastifyReply,
    ttlSeconds: number,
    cookieSecure: boolean
): Promise<string> {
    const state = randomBytes(32).toString('base64url');
    const key = STATE_KEY_PREFIX + hashState(state);

    // Only a hash of the state is stored in Redis; the raw value lives only
    // in the HttpOnly cookie and briefly in the GitHub authorize URL.
    await redis.set(key, '1', 'EX', ttlSeconds);

    reply.setCookie(OAUTH_STATE_COOKIE_NAME, state, {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: cookieSecure,
        maxAge: ttlSeconds
    });

    return state;
}

export type StateValidationResult =
    | { valid: true }
    | { valid: false; reason: 'MISSING' | 'MISMATCH' | 'EXPIRED_OR_REPLAYED' };

/**
 * Validates the callback's state against the cookie's state, then atomically
 * consumes the Redis-side record via GETDEL so a replayed callback (same
 * state reused) can never validate a second time.
 */
export async function consumeOAuthState(
    cookieState: string | undefined,
    queryState: string | undefined
): Promise<StateValidationResult> {
    if (!cookieState || !queryState) {
        return { valid: false, reason: 'MISSING' };
    }

    if (cookieState !== queryState) {
        return { valid: false, reason: 'MISMATCH' };
    }

    const key = STATE_KEY_PREFIX + hashState(queryState);
    const consumed = await redis.getdel(key);

    if (!consumed) {
        return { valid: false, reason: 'EXPIRED_OR_REPLAYED' };
    }

    return { valid: true };
}

export function clearOAuthStateCookie(reply: FastifyReply, cookieSecure: boolean): void {
    reply.clearCookie(OAUTH_STATE_COOKIE_NAME, {
        path: '/',
        secure: cookieSecure,
        httpOnly: true,
        sameSite: 'lax'
    });
}
