// Narrow config helpers, loaded on demand rather than at import time.
//
// requireDatabaseUrl() exists for:
//   - the Postgres connection pool (src/db/postgres.ts)
//   - Postgres integration tests
//   - auth code that explicitly needs a database
// DATABASE_URL is NOT required to run `npm run dev` in mock mode.
//
// getAuthMode()/requireGithubAuthConfig() exist for Stage 2 GitHub OAuth.
// getAuthMode() is always safe to call. requireGithubAuthConfig() is only
// called when the mode is actually "github", so a mock-mode server never
// needs any GitHub/session/cookie env var set.

export function requireDatabaseUrl(): string {
    const value = process.env.DATABASE_URL;

    if (!value) {
        throw new Error(
            'DATABASE_URL is required for this operation but is not set. ' +
            'Set it in your environment or .env before running database ' +
            'migrations, the Postgres pool, or Postgres integration tests.'
        );
    }

    return value;
}

// --- Stage 2: auth mode + GitHub OAuth config ---
//
// getAuthMode() is safe to call unconditionally at server startup: it never
// requires any GitHub-specific env var, only validates AUTH_MODE itself.
// requireGithubAuthConfig() is only ever called when the mode is actually
// "github" — so a mock-mode server never needs any of these vars set.

export type AuthMode = 'mock' | 'github';

export function getAuthMode(): AuthMode {
    const raw = process.env.AUTH_MODE ?? 'mock';

    if (raw !== 'mock' && raw !== 'github') {
        throw new Error(`Invalid AUTH_MODE "${raw}" — must be "mock" or "github".`);
    }

    return raw;
}

export interface GithubAuthConfig {
    clientId: string;
    clientSecret: string;
    callbackUrl: string;
    frontendUrl: string;
    backendUrl: string;
    sessionTtlSeconds: number;
    oauthStateTtlSeconds: number;
    cookieSecure: boolean;
}

export function requireGithubAuthConfig(): GithubAuthConfig {
    const clientId = process.env.GITHUB_CLIENT_ID;
    const clientSecret = process.env.GITHUB_CLIENT_SECRET;
    const callbackUrl = process.env.GITHUB_CALLBACK_URL;
    const frontendUrl = process.env.FRONTEND_URL;
    const backendUrl = process.env.BACKEND_URL;

    const missing: string[] = [];
    if (!clientId) missing.push('GITHUB_CLIENT_ID');
    if (!clientSecret) missing.push('GITHUB_CLIENT_SECRET');
    if (!callbackUrl) missing.push('GITHUB_CALLBACK_URL');
    if (!frontendUrl) missing.push('FRONTEND_URL');
    if (!backendUrl) missing.push('BACKEND_URL');

    if (missing.length > 0) {
        throw new Error(
            `AUTH_MODE=github requires the following environment variable(s), ` +
            `which are not set: ${missing.join(', ')}`
        );
    }

    const sessionTtlSeconds = Number(process.env.SESSION_TTL_SECONDS ?? 604800);
    const oauthStateTtlSeconds = Number(process.env.OAUTH_STATE_TTL_SECONDS ?? 300);

    if (!Number.isFinite(sessionTtlSeconds) || sessionTtlSeconds <= 0) {
        throw new Error('SESSION_TTL_SECONDS must be a positive number.');
    }
    if (!Number.isFinite(oauthStateTtlSeconds) || oauthStateTtlSeconds <= 0) {
        throw new Error('OAUTH_STATE_TTL_SECONDS must be a positive number.');
    }

    return {
        clientId: clientId!,
        clientSecret: clientSecret!,
        callbackUrl: callbackUrl!,
        frontendUrl: frontendUrl!,
        backendUrl: backendUrl!,
        sessionTtlSeconds,
        oauthStateTtlSeconds,
        cookieSecure: process.env.COOKIE_SECURE === 'true'
    };
}
