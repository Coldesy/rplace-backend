import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { requireDatabaseUrl } from '../../src/config.js';

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
