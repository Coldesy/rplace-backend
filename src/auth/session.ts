import { createHash, randomBytes } from 'node:crypto';
import type { FastifyReply } from 'fastify';
import { redis } from '../db/redis.js';

const SESSION_KEY_PREFIX = 'session:';

function hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
}

/**
 * `__Host-session` requires Secure, Path=/, and no Domain attribute to be
 * accepted by browsers at all — so it's only valid when we're actually
 * serving over HTTPS (cookieSecure === true, i.e. production). Local HTTP
 * dev uses the plain `session` name.
 */
export function sessionCookieName(cookieSecure: boolean): string {
    return cookieSecure ? '__Host-session' : 'session';
}

/** Creates a new session for an internal users.id and returns the opaque token to hand to the client. */
export async function createSession(userId: string, ttlSeconds: number): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    const key = SESSION_KEY_PREFIX + hashToken(token);

    await redis.set(key, JSON.stringify({ userId }), 'EX', ttlSeconds);

    return token;
}

/** Resolves a session token to an internal users.id, or null if missing/expired/invalid. */
export async function verifySession(token: string | undefined): Promise<string | null> {
    if (!token) return null;

    const key = SESSION_KEY_PREFIX + hashToken(token);
    const raw = await redis.get(key);
    if (!raw) return null;

    try {
        const parsed = JSON.parse(raw) as { userId?: string };
        return parsed.userId ?? null;
    } catch {
        return null;
    }
}

export async function destroySession(token: string | undefined): Promise<void> {
    if (!token) return;
    await redis.del(SESSION_KEY_PREFIX + hashToken(token));
}

export function setSessionCookie(
    reply: FastifyReply,
    token: string,
    ttlSeconds: number,
    cookieSecure: boolean
): void {
    reply.setCookie(sessionCookieName(cookieSecure), token, {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: cookieSecure,
        maxAge: ttlSeconds
    });
}

export function clearSessionCookie(reply: FastifyReply, cookieSecure: boolean): void {
    reply.clearCookie(sessionCookieName(cookieSecure), {
        path: '/',
        secure: cookieSecure,
        httpOnly: true,
        sameSite: 'lax'
    });
}
