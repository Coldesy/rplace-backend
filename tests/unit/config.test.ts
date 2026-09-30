import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getAuthMode, requireDatabaseUrl, requireGithubAuthConfig } from '../../src/config.js';

describe('requireDatabaseUrl', () => {
    const originalValue = process.env.DATABASE_URL;

    beforeEach(() => {
        delete process.env.DATABASE_URL;
    });

    afterEach(() => {
        if (originalValue === undefined) {
            delete process.env.DATABASE_URL;
        } else {
            process.env.DATABASE_URL = originalValue;
        }
    });

    it('throws a clear error when DATABASE_URL is unset', () => {
        expect(() => requireDatabaseUrl()).toThrowError(/DATABASE_URL is required/);
    });

    it('returns the value when DATABASE_URL is explicitly set in-test', () => {
        process.env.DATABASE_URL = 'postgres://example-test-value/db';
        expect(requireDatabaseUrl()).toBe('postgres://example-test-value/db');
    });
});

const AUTH_ENV_VARS = [
    'AUTH_MODE',
    'GITHUB_CLIENT_ID',
    'GITHUB_CLIENT_SECRET',
    'GITHUB_CALLBACK_URL',
    'FRONTEND_URL',
    'BACKEND_URL',
    'SESSION_TTL_SECONDS',
    'OAUTH_STATE_TTL_SECONDS',
    'COOKIE_SECURE'
] as const;

describe('getAuthMode', () => {
    const originalValues = Object.fromEntries(AUTH_ENV_VARS.map(name => [name, process.env[name]]));

    beforeEach(() => {
        for (const name of AUTH_ENV_VARS) delete process.env[name];
    });

    afterEach(() => {
        for (const name of AUTH_ENV_VARS) {
            const value = originalValues[name];
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    });

    it('defaults to "mock" when AUTH_MODE is unset', () => {
        expect(getAuthMode()).toBe('mock');
    });

    it('accepts an explicit "mock" value', () => {
        process.env.AUTH_MODE = 'mock';
        expect(getAuthMode()).toBe('mock');
    });

    it('accepts an explicit "github" value', () => {
        process.env.AUTH_MODE = 'github';
        expect(getAuthMode()).toBe('github');
    });

    it('throws on an invalid AUTH_MODE value', () => {
        process.env.AUTH_MODE = 'something-else';
        expect(() => getAuthMode()).toThrowError(/Invalid AUTH_MODE/);
    });
});

describe('requireGithubAuthConfig', () => {
    const originalValues = Object.fromEntries(AUTH_ENV_VARS.map(name => [name, process.env[name]]));

    beforeEach(() => {
        for (const name of AUTH_ENV_VARS) delete process.env[name];
    });

    afterEach(() => {
        for (const name of AUTH_ENV_VARS) {
            const value = originalValues[name];
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    });

    function setAllRequired() {
        process.env.GITHUB_CLIENT_ID = 'test-client-id';
        process.env.GITHUB_CLIENT_SECRET = 'test-client-secret';
        process.env.GITHUB_CALLBACK_URL = 'http://localhost:3001/auth/github/callback';
        process.env.FRONTEND_URL = 'http://localhost:5173';
        process.env.BACKEND_URL = 'http://localhost:3001';
    }

    it('throws listing every missing required variable', () => {
        expect(() => requireGithubAuthConfig()).toThrowError(
            /GITHUB_CLIENT_ID.*GITHUB_CLIENT_SECRET.*GITHUB_CALLBACK_URL.*FRONTEND_URL.*BACKEND_URL/s
        );
    });

    it('throws listing only the specific variables that are missing', () => {
        setAllRequired();
        delete process.env.GITHUB_CLIENT_SECRET;

        expect(() => requireGithubAuthConfig()).toThrowError(/GITHUB_CLIENT_SECRET/);
        expect(() => requireGithubAuthConfig()).not.toThrowError(/GITHUB_CLIENT_ID,/);
    });

    it('succeeds with all required variables set, applying sane defaults', () => {
        setAllRequired();

        const config = requireGithubAuthConfig();

        expect(config.clientId).toBe('test-client-id');
        expect(config.clientSecret).toBe('test-client-secret');
        expect(config.callbackUrl).toBe('http://localhost:3001/auth/github/callback');
        expect(config.frontendUrl).toBe('http://localhost:5173');
        expect(config.backendUrl).toBe('http://localhost:3001');
        expect(config.sessionTtlSeconds).toBe(604800);
        expect(config.oauthStateTtlSeconds).toBe(300);
        expect(config.cookieSecure).toBe(false);
    });

    it('respects explicit TTL and cookieSecure overrides', () => {
        setAllRequired();
        process.env.SESSION_TTL_SECONDS = '3600';
        process.env.OAUTH_STATE_TTL_SECONDS = '120';
        process.env.COOKIE_SECURE = 'true';

        const config = requireGithubAuthConfig();

        expect(config.sessionTtlSeconds).toBe(3600);
        expect(config.oauthStateTtlSeconds).toBe(120);
        expect(config.cookieSecure).toBe(true);
    });

    it('rejects a non-numeric or non-positive SESSION_TTL_SECONDS', () => {
        setAllRequired();
        process.env.SESSION_TTL_SECONDS = 'not-a-number';
        expect(() => requireGithubAuthConfig()).toThrowError(/SESSION_TTL_SECONDS/);

        process.env.SESSION_TTL_SECONDS = '0';
        expect(() => requireGithubAuthConfig()).toThrowError(/SESSION_TTL_SECONDS/);
    });

    it('only enables cookieSecure when COOKIE_SECURE is exactly "true"', () => {
        setAllRequired();
        process.env.COOKIE_SECURE = 'yes';
        expect(requireGithubAuthConfig().cookieSecure).toBe(false);
    });
});
