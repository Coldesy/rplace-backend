import { describe, expect, it, vi } from 'vitest';

// Mocked in-memory Redis — these are unit tests, no live Redis involved.
vi.mock('../../src/db/redis.js', () => {
    const store = new Map<string, { value: string; expiresAt: number }>();
    return {
        redis: {
            set: vi.fn(async (key: string, value: string, mode?: string, ttl?: number) => {
                const expiresAt = mode === 'EX' && ttl ? Date.now() + ttl * 1000 : Infinity;
                store.set(key, { value, expiresAt });
                return 'OK';
            }),
            get: vi.fn(async (key: string) => {
                const entry = store.get(key);
                if (!entry) return null;
                if (entry.expiresAt < Date.now()) {
                    store.delete(key);
                    return null;
                }
                return entry.value;
            }),
            del: vi.fn(async (key: string) => {
                const existed = store.has(key);
                store.delete(key);
                return existed ? 1 : 0;
            })
        }
    };
});

const {
    createSession,
    verifySession,
    destroySession,
    setSessionCookie,
    clearSessionCookie,
    sessionCookieName
} = await import('../../src/auth/session.js');

interface FakeReply {
    setCookie: ReturnType<typeof vi.fn>;
    clearCookie: ReturnType<typeof vi.fn>;
    _cookies: Record<string, { value: string; options: unknown }>;
}

function fakeReply(): FakeReply {
    const cookies: Record<string, { value: string; options: unknown }> = {};
    return {
        setCookie: vi.fn((name: string, value: string, options: unknown) => {
            cookies[name] = { value, options };
        }),
        clearCookie: vi.fn((name: string) => {
            delete cookies[name];
        }),
        _cookies: cookies
    };
}

describe('sessionCookieName', () => {
    it('uses the plain "session" name when cookieSecure is false', () => {
        expect(sessionCookieName(false)).toBe('session');
    });

    it('uses "__Host-session" only when cookieSecure is true', () => {
        expect(sessionCookieName(true)).toBe('__Host-session');
    });
});

describe('session lifecycle', () => {
    it('creates a high-entropy opaque token that resolves back to the correct userId', async () => {
        const token = await createSession('user-123', 3600);

        // base64url of 32 random bytes -> 43 chars, no padding.
        expect(token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
        expect(await verifySession(token)).toBe('user-123');
    });

    it('two sessions produce different tokens', async () => {
        const a = await createSession('user-a', 3600);
        const b = await createSession('user-b', 3600);
        expect(a).not.toBe(b);
    });

    it('returns null for an unknown token', async () => {
        expect(await verifySession('not-a-real-token-xxxxxxxxxxxxxxxxxxxxxxxxxxxx')).toBeNull();
    });

    it('returns null for an undefined token', async () => {
        expect(await verifySession(undefined)).toBeNull();
    });

    it('destroying a session makes it no longer resolve', async () => {
        const token = await createSession('user-456', 3600);
        await destroySession(token);
        expect(await verifySession(token)).toBeNull();
    });

    it('destroying an undefined token is a safe no-op', async () => {
        await expect(destroySession(undefined)).resolves.toBeUndefined();
    });

    it('sets the plain session cookie with safe attributes when cookieSecure is false', () => {
        const reply = fakeReply();
        setSessionCookie(reply as never, 'some-opaque-token', 3600, false);

        expect(reply._cookies['session']).toMatchObject({
            value: 'some-opaque-token',
            options: expect.objectContaining({
                httpOnly: true,
                sameSite: 'lax',
                path: '/',
                secure: false
            })
        });
        expect(reply._cookies['__Host-session']).toBeUndefined();
    });

    it('sets the __Host-session cookie when cookieSecure is true', () => {
        const reply = fakeReply();
        setSessionCookie(reply as never, 'some-opaque-token', 3600, true);

        expect(reply._cookies['__Host-session']).toBeDefined();
        expect(reply._cookies['session']).toBeUndefined();
    });

    it('clears the correct cookie name for each security mode', () => {
        const plainReply = fakeReply();
        clearSessionCookie(plainReply as never, false);
        expect(plainReply.clearCookie).toHaveBeenCalledWith('session', expect.any(Object));

        const secureReply = fakeReply();
        clearSessionCookie(secureReply as never, true);
        expect(secureReply.clearCookie).toHaveBeenCalledWith('__Host-session', expect.any(Object));
    });
});
