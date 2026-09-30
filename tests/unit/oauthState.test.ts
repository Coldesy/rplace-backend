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
            getdel: vi.fn(async (key: string) => {
                const entry = store.get(key);
                store.delete(key);
                if (!entry) return null;
                if (entry.expiresAt < Date.now()) return null;
                return entry.value;
            })
        }
    };
});

const { issueOAuthState, consumeOAuthState, clearOAuthStateCookie, OAUTH_STATE_COOKIE_NAME } =
    await import('../../src/auth/state.js');

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

describe('OAuth state', () => {
    it('generates a high-entropy, URL-safe state and sets it as an HttpOnly cookie', async () => {
        const reply = fakeReply();
        const state = await issueOAuthState(reply as never, 300, false);

        // base64url of 32 random bytes -> 43 chars, no padding.
        expect(state).toMatch(/^[A-Za-z0-9_-]{40,}$/);
        expect(reply._cookies[OAUTH_STATE_COOKIE_NAME].value).toBe(state);
        expect(reply._cookies[OAUTH_STATE_COOKIE_NAME].options).toMatchObject({
            httpOnly: true,
            sameSite: 'lax',
            path: '/',
            secure: false
        });
    });

    it('generates a different token on each call', async () => {
        const reply = fakeReply();
        const first = await issueOAuthState(reply as never, 300, false);
        const second = await issueOAuthState(reply as never, 300, false);
        expect(first).not.toBe(second);
    });

    it('validates a matching cookie/query state and consumes it', async () => {
        const reply = fakeReply();
        const state = await issueOAuthState(reply as never, 300, false);

        const result = await consumeOAuthState(state, state);
        expect(result.valid).toBe(true);
    });

    it('rejects a replayed state — second consumption fails', async () => {
        const reply = fakeReply();
        const state = await issueOAuthState(reply as never, 300, false);

        const first = await consumeOAuthState(state, state);
        expect(first.valid).toBe(true);

        const second = await consumeOAuthState(state, state);
        expect(second.valid).toBe(false);
        if (!second.valid) expect(second.reason).toBe('EXPIRED_OR_REPLAYED');
    });

    it('rejects mismatched cookie vs query state', async () => {
        const reply = fakeReply();
        const state = await issueOAuthState(reply as never, 300, false);

        const result = await consumeOAuthState(state, 'a-completely-different-state-value-xxxxxxxx');
        expect(result.valid).toBe(false);
        if (!result.valid) expect(result.reason).toBe('MISMATCH');
    });

    it('rejects missing state on either side', async () => {
        const missingCookie = await consumeOAuthState(undefined, 'some-state-value');
        expect(missingCookie.valid).toBe(false);
        if (!missingCookie.valid) expect(missingCookie.reason).toBe('MISSING');

        const missingQuery = await consumeOAuthState('some-state-value', undefined);
        expect(missingQuery.valid).toBe(false);
        if (!missingQuery.valid) expect(missingQuery.reason).toBe('MISSING');
    });

    it('rejects a state that was never issued (or already expired)', async () => {
        const neverIssued = 'never-issued-state-value-xxxxxxxxxxxxxxxxxxxxxxxx';
        const result = await consumeOAuthState(neverIssued, neverIssued);
        expect(result.valid).toBe(false);
        if (!result.valid) expect(result.reason).toBe('EXPIRED_OR_REPLAYED');
    });

    it('clears the state cookie with matching security attributes', () => {
        const reply = fakeReply();
        clearOAuthStateCookie(reply as never, true);

        expect(reply.clearCookie).toHaveBeenCalledWith(
            OAUTH_STATE_COOKIE_NAME,
            expect.objectContaining({ path: '/', secure: true, httpOnly: true, sameSite: 'lax' })
        );
    });
});
