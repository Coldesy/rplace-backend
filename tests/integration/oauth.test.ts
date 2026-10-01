import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { Client } from 'pg';
import Redis from 'ioredis';

const CONNECTION_ERROR_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EHOSTUNREACH']);

interface ProbeResult {
    reachable: boolean;
    reason?: string;
}

async function probePostgresReachable(): Promise<ProbeResult> {
    if (!process.env.DATABASE_URL) {
        return { reachable: false, reason: 'DATABASE_URL unavailable or database not reachable' };
    }
    const client = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 2000 });
    try {
        await client.connect();
        await client.query('SELECT 1');
        await client.end();
        return { reachable: true };
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code && CONNECTION_ERROR_CODES.has(code)) {
            return { reachable: false, reason: 'DATABASE_URL unavailable or database not reachable' };
        }
        throw error; // bad credentials / missing table etc — a real problem, not "unavailable"
    }
}

async function probeRedisReachable(): Promise<ProbeResult> {
    const url = process.env.REDIS_URL;
    if (!url) {
        return { reachable: false, reason: 'REDIS_URL unavailable or Redis not reachable' };
    }
    const client = new Redis(url, {
        lazyConnect: true,
        connectTimeout: 2000,
        retryStrategy: () => null,
        maxRetriesPerRequest: 0
    });
    try {
        await client.connect();
        await client.ping();
        return { reachable: true };
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code && CONNECTION_ERROR_CODES.has(code)) {
            return { reachable: false, reason: 'REDIS_URL unavailable or Redis not reachable' };
        }
        throw error;
    } finally {
        client.disconnect();
    }
}

const pgProbe = await probePostgresReachable();
const redisProbe = await probeRedisReachable();
const bothReachable = pgProbe.reachable && redisProbe.reachable;

if (!bothReachable) {
    const reasons = [pgProbe.reason, redisProbe.reason].filter(Boolean).join('; ');
    console.warn(`OAuth integration skipped: ${reasons}`);
}

interface CapturingLogger {
    level: string;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    debug: (...args: unknown[]) => void;
    fatal: (...args: unknown[]) => void;
    trace: (...args: unknown[]) => void;
    silent: (...args: unknown[]) => void;
    child: () => CapturingLogger;
}

/**
 * A minimal logger satisfying Fastify's FastifyBaseLogger interface, built
 * fresh rather than monkey-patching Fastify's live pino instance after the
 * fact (which risks silently failing or throwing on non-configurable
 * properties). child() returns the same capturing logger so any
 * request-scoped child logger still funnels into the same array.
 */
function createCapturingLogger(): { logger: CapturingLogger; calls: unknown[][] } {
    const calls: unknown[][] = [];
    const record = (...args: unknown[]) => {
        calls.push(args);
    };
    const logger: CapturingLogger = {
        level: 'trace',
        info: record,
        warn: record,
        error: record,
        debug: record,
        fatal: record,
        trace: record,
        silent: record,
        child: () => logger
    };
    return { logger, calls };
}

describe.skipIf(!bothReachable)('GitHub OAuth flow (integration)', () => {
    const authEnvVars = [
        'AUTH_MODE',
        'GITHUB_CLIENT_ID',
        'GITHUB_CLIENT_SECRET',
        'GITHUB_CALLBACK_URL',
        'FRONTEND_URL',
        'BACKEND_URL',
        'COOKIE_SECURE'
    ] as const;
    const originalEnv = Object.fromEntries(authEnvVars.map(name => [name, process.env[name]]));

    let app: FastifyInstance;
    const { logger: capturingLogger, calls: logCalls } = createCapturingLogger();
    const createdGithubIds: number[] = [];

    beforeAll(async () => {
        process.env.AUTH_MODE = 'github';
        process.env.GITHUB_CLIENT_ID = 'test-client-id';
        process.env.GITHUB_CLIENT_SECRET = 'test-client-secret-never-logged';
        process.env.GITHUB_CALLBACK_URL = 'http://localhost:3001/auth/github/callback';
        process.env.FRONTEND_URL = 'http://localhost:5173';
        process.env.BACKEND_URL = 'http://localhost:3001';
        process.env.COOKIE_SECURE = 'false';

        const authRoutesModule = await import('../../src/routes/auth.js');
        app = Fastify({ loggerInstance: capturingLogger as never, disableRequestLogging: true });
        await app.register(cookie);
        await app.register(authRoutesModule.default, { prefix: '/auth' });
        await app.ready();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    afterAll(async () => {
        await app.close();

        const { getPool, closePool } = await import('../../src/db/postgres.js');
        if (createdGithubIds.length > 0) {
            await getPool().query('DELETE FROM users WHERE github_id = ANY($1::bigint[])', [createdGithubIds]);
        }
        await closePool();

        for (const name of authEnvVars) {
            const value = originalEnv[name];
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    });

    function mockGithubSuccess(githubId: number, login: string, avatarUrl: string) {
        vi.stubGlobal(
            'fetch',
            vi.fn(async (url: string) => {
                if (url.includes('github.com/login/oauth/access_token')) {
                    return new Response(
                        JSON.stringify({ access_token: 'fake-access-token-never-logged', token_type: 'bearer', scope: 'read:user' }),
                        { status: 200 }
                    );
                }
                if (url.includes('api.github.com/user')) {
                    return new Response(JSON.stringify({ id: githubId, login, avatar_url: avatarUrl }), { status: 200 });
                }
                throw new Error(`Unexpected fetch to ${url} in test`);
            })
        );
    }

    async function startOAuthAttempt() {
        const startResponse = await app.inject({ method: 'GET', url: '/auth/github' });
        expect(startResponse.statusCode).toBe(302);

        const stateCookie = startResponse.cookies.find(c => c.name === 'oauth_state');
        expect(stateCookie).toBeDefined();

        const location = new URL(startResponse.headers.location as string);
        const state = location.searchParams.get('state');
        expect(state).toBe(stateCookie!.value);

        return { state: state!, stateCookieValue: stateCookie!.value };
    }

    it('completes the happy path: new user, session created, /auth/me returns safe fields', async () => {
        const githubId = 900001000 + Math.floor(Math.random() * 100000);
        createdGithubIds.push(githubId);

        const { state, stateCookieValue } = await startOAuthAttempt();
        mockGithubSuccess(githubId, 'octocat', 'https://example.com/octocat.png');

        const callbackResponse = await app.inject({
            method: 'GET',
            url: `/auth/github/callback?code=fake-code&state=${state}`,
            cookies: { oauth_state: stateCookieValue }
        });

        expect(callbackResponse.statusCode).toBe(302);
        expect(callbackResponse.headers.location).toBe('http://localhost:5173/');

        const sessionCookie = callbackResponse.cookies.find(c => c.name === 'session');
        expect(sessionCookie).toBeDefined();
        expect(sessionCookie!.httpOnly).toBe(true);
        expect(sessionCookie!.sameSite).toBe('Lax');
        expect(sessionCookie!.path).toBe('/');

        // The state cookie must be cleared after use.
        const clearedState = callbackResponse.cookies.find(c => c.name === 'oauth_state');
        expect(clearedState?.value === '' || clearedState?.expires !== undefined).toBeTruthy();

        const meResponse = await app.inject({
            method: 'GET',
            url: '/auth/me',
            cookies: { session: sessionCookie!.value }
        });

        expect(meResponse.statusCode).toBe(200);
        const body = meResponse.json();
        expect(body).toEqual({
            id: expect.any(String),
            login: 'octocat',
            avatarUrl: 'https://example.com/octocat.png'
        });
        // Never expose the numeric github_id or any token-shaped field.
        expect(body.github_id).toBeUndefined();
        expect(body.accessToken).toBeUndefined();
        expect(body.token).toBeUndefined();
    });

    it('upserts a returning user: same id, updated login/avatar, does not duplicate', async () => {
        const githubId = 900002000 + Math.floor(Math.random() * 100000);
        createdGithubIds.push(githubId);

        // First login.
        const first = await startOAuthAttempt();
        mockGithubSuccess(githubId, 'old-login', 'https://example.com/old.png');
        const firstCallback = await app.inject({
            method: 'GET',
            url: `/auth/github/callback?code=fake-code&state=${first.state}`,
            cookies: { oauth_state: first.stateCookieValue }
        });
        const firstSession = firstCallback.cookies.find(c => c.name === 'session')!.value;
        const firstMe = (await app.inject({ method: 'GET', url: '/auth/me', cookies: { session: firstSession } })).json();

        // Second login — GitHub login/avatar changed, id is the same.
        const second = await startOAuthAttempt();
        mockGithubSuccess(githubId, 'new-login', 'https://example.com/new.png');
        const secondCallback = await app.inject({
            method: 'GET',
            url: `/auth/github/callback?code=fake-code&state=${second.state}`,
            cookies: { oauth_state: second.stateCookieValue }
        });
        const secondSession = secondCallback.cookies.find(c => c.name === 'session')!.value;
        const secondMe = (await app.inject({ method: 'GET', url: '/auth/me', cookies: { session: secondSession } })).json();

        expect(secondMe.id).toBe(firstMe.id); // internal id stable across a login-name change
        expect(secondMe.login).toBe('new-login');
        expect(secondMe.avatarUrl).toBe('https://example.com/new.png');

        const { getPool } = await import('../../src/db/postgres.js');
        const { rows } = await getPool().query('SELECT count(*)::int AS count FROM users WHERE github_id = $1', [githubId]);
        expect(rows[0].count).toBe(1); // no duplicate row
    });

    it('rejects a callback with a replayed state (second use of the same state fails)', async () => {
        const githubId = 900003000 + Math.floor(Math.random() * 100000);
        createdGithubIds.push(githubId);

        const { state, stateCookieValue } = await startOAuthAttempt();
        mockGithubSuccess(githubId, 'replay-test', 'https://example.com/a.png');

        const firstAttempt = await app.inject({
            method: 'GET',
            url: `/auth/github/callback?code=fake-code&state=${state}`,
            cookies: { oauth_state: stateCookieValue }
        });
        expect(firstAttempt.headers.location).toBe('http://localhost:5173/');

        const replayedAttempt = await app.inject({
            method: 'GET',
            url: `/auth/github/callback?code=fake-code&state=${state}`,
            cookies: { oauth_state: stateCookieValue }
        });

        expect(replayedAttempt.statusCode).toBe(302);
        const location = new URL(replayedAttempt.headers.location as string);
        expect(location.searchParams.get('auth_error')).toBe('invalid_state');
        expect(replayedAttempt.cookies.find(c => c.name === 'session')).toBeUndefined();
    });

    it('rejects a callback with a mismatched state', async () => {
        const { stateCookieValue } = await startOAuthAttempt();

        const response = await app.inject({
            method: 'GET',
            url: '/auth/github/callback?code=fake-code&state=completely-different-value',
            cookies: { oauth_state: stateCookieValue }
        });

        const location = new URL(response.headers.location as string);
        expect(location.searchParams.get('auth_error')).toBe('invalid_state');
        expect(response.cookies.find(c => c.name === 'session')).toBeUndefined();
    });

    it('rejects a callback with no state cookie at all', async () => {
        const response = await app.inject({ method: 'GET', url: '/auth/github/callback?code=fake-code&state=whatever' });
        const location = new URL(response.headers.location as string);
        expect(location.searchParams.get('auth_error')).toBe('invalid_state');
    });

    it('redirects with access_denied when GitHub reports the user denied consent', async () => {
        const { state, stateCookieValue } = await startOAuthAttempt();

        const response = await app.inject({
            method: 'GET',
            url: `/auth/github/callback?error=access_denied&state=${state}`,
            cookies: { oauth_state: stateCookieValue }
        });

        const location = new URL(response.headers.location as string);
        expect(location.searchParams.get('auth_error')).toBe('access_denied');
    });

    it('redirects with missing_code when no code is present', async () => {
        const { state, stateCookieValue } = await startOAuthAttempt();

        const response = await app.inject({
            method: 'GET',
            url: `/auth/github/callback?state=${state}`,
            cookies: { oauth_state: stateCookieValue }
        });

        const location = new URL(response.headers.location as string);
        expect(location.searchParams.get('auth_error')).toBe('missing_code');
    });

    it('redirects with github_failed when the token exchange fails', async () => {
        const { state, stateCookieValue } = await startOAuthAttempt();
        vi.stubGlobal('fetch', vi.fn(async () => new Response('server error', { status: 500 })));

        const response = await app.inject({
            method: 'GET',
            url: `/auth/github/callback?code=fake-code&state=${state}`,
            cookies: { oauth_state: stateCookieValue }
        });

        const location = new URL(response.headers.location as string);
        expect(location.searchParams.get('auth_error')).toBe('github_failed');
        expect(response.cookies.find(c => c.name === 'session')).toBeUndefined();
    });

    it('redirects with github_failed when the token exchange request itself throws (e.g. timeout)', async () => {
        const { state, stateCookieValue } = await startOAuthAttempt();
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('simulated network timeout'); }));

        const response = await app.inject({
            method: 'GET',
            url: `/auth/github/callback?code=fake-code&state=${state}`,
            cookies: { oauth_state: stateCookieValue }
        });

        const location = new URL(response.headers.location as string);
        expect(location.searchParams.get('auth_error')).toBe('github_failed');
    });

    it('redirects with github_failed when the profile response is malformed (no numeric id)', async () => {
        const { state, stateCookieValue } = await startOAuthAttempt();
        vi.stubGlobal(
            'fetch',
            vi.fn(async (url: string) => {
                if (url.includes('access_token')) {
                    return new Response(JSON.stringify({ access_token: 'fake-token' }), { status: 200 });
                }
                return new Response(JSON.stringify({ login: 'no-id-here' }), { status: 200 });
            })
        );

        const response = await app.inject({
            method: 'GET',
            url: `/auth/github/callback?code=fake-code&state=${state}`,
            cookies: { oauth_state: stateCookieValue }
        });

        const location = new URL(response.headers.location as string);
        expect(location.searchParams.get('auth_error')).toBe('github_failed');
    });

    it('/auth/me returns 401 with no session cookie', async () => {
        const response = await app.inject({ method: 'GET', url: '/auth/me' });
        expect(response.statusCode).toBe(401);
        expect(response.json()).toEqual({ error: 'UNAUTHENTICATED' });
    });

    it('logout clears the session and is idempotent', async () => {
        const githubId = 900004000 + Math.floor(Math.random() * 100000);
        createdGithubIds.push(githubId);

        const { state, stateCookieValue } = await startOAuthAttempt();
        mockGithubSuccess(githubId, 'logout-test', 'https://example.com/a.png');
        const callback = await app.inject({
            method: 'GET',
            url: `/auth/github/callback?code=fake-code&state=${state}`,
            cookies: { oauth_state: stateCookieValue }
        });
        const sessionValue = callback.cookies.find(c => c.name === 'session')!.value;

        const logout1 = await app.inject({ method: 'POST', url: '/auth/logout', cookies: { session: sessionValue } });
        expect(logout1.statusCode).toBe(200);
        expect(logout1.json()).toEqual({ ok: true });

        const meAfterLogout = await app.inject({ method: 'GET', url: '/auth/me', cookies: { session: sessionValue } });
        expect(meAfterLogout.statusCode).toBe(401);

        const logout2 = await app.inject({ method: 'POST', url: '/auth/logout', cookies: { session: sessionValue } });
        expect(logout2.statusCode).toBe(200); // idempotent — logging out twice doesn't error
    });

    it('never logs the OAuth code, GitHub access token, client secret, session token, or state value', async () => {
        const githubId = 900005000 + Math.floor(Math.random() * 100000);
        createdGithubIds.push(githubId);

        // Isolate this test's flow from anything logged earlier in the suite.
        // No wrapping/restoring needed — capturingLogger already captures
        // every call made through app.log (and any child logger, since
        // child() returns the same instance) directly into this array.
        logCalls.length = 0;

        const { state, stateCookieValue } = await startOAuthAttempt();
        mockGithubSuccess(githubId, 'secret-check', 'https://example.com/a.png');
        const callback = await app.inject({
            method: 'GET',
            url: `/auth/github/callback?code=SECRET_CODE_VALUE&state=${state}`,
            cookies: { oauth_state: stateCookieValue }
        });
        const sessionValue = callback.cookies.find(c => c.name === 'session')!.value;

        const serialized = JSON.stringify(logCalls);
        expect(serialized).not.toContain('test-client-secret-never-logged');
        expect(serialized).not.toContain('fake-access-token-never-logged');
        expect(serialized).not.toContain('SECRET_CODE_VALUE');
        expect(serialized).not.toContain(state);
        expect(serialized).not.toContain(sessionValue);
    });
});