import { afterAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { createUser, getUserById } from '../../src/db/users.js';
import { closePool, getPool } from '../../src/db/postgres.js';

const CONNECTION_ERROR_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EHOSTUNREACH']);

interface ProbeResult {
    reachable: boolean;
    reason?: string;
}

/**
 * Distinguishes "genuinely unavailable" (skip, per the approved rules) from
 * a real configuration problem such as bad credentials or a missing
 * database (must fail loudly, never be silently skipped).
 */
async function probePostgresReachable(): Promise<ProbeResult> {
    if (!process.env.DATABASE_URL) {
        return { reachable: false, reason: 'DATABASE_URL unavailable or database not reachable' };
    }

    const client = new Client({
        connectionString: process.env.DATABASE_URL,
        connectionTimeoutMillis: 2000
    });

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
        // Server responded but rejected the connection/query (bad credentials,
        // database does not exist, users table missing because the migration
        // was never run, etc.) — a real problem, not "unavailable". Re-throw
        // so the suite fails instead of silently skipping.
        throw error;
    }
}

const probe = await probePostgresReachable();

if (!probe.reachable) {
    console.warn(`PostgreSQL integration skipped: ${probe.reason}`);
}

describe.skipIf(!probe.reachable)('users table schema (Postgres integration)', () => {
    const insertedIds: string[] = [];

    afterAll(async () => {
        if (insertedIds.length > 0) {
            await getPool().query('DELETE FROM users WHERE id = ANY($1::uuid[])', [insertedIds]);
        }
        await closePool();
    });

    it('generates a UUID id and populates created_at on insert with no explicit values', async () => {
        const user = await createUser();
        insertedIds.push(user.id);

        expect(user.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
        expect(user.created_at).toBeInstanceOf(Date);
        expect(user.github_id).toBeNull();
        expect(user.github_login).toBeNull();
        expect(user.avatar_url).toBeNull();
        expect(user.last_login_at).toBeNull();

        const fetched = await getUserById(user.id);
        expect(fetched?.id).toBe(user.id);
    });

    it('allows multiple rows with github_id NULL', async () => {
        const first = await createUser();
        const second = await createUser();
        insertedIds.push(first.id, second.id);

        expect(first.github_id).toBeNull();
        expect(second.github_id).toBeNull();
        expect(first.id).not.toBe(second.id);
    });

    it('rejects a duplicate non-null github_id', async () => {
        const githubId = 900000000 + Math.floor(Math.random() * 1000);
        const first = await createUser({ githubId });
        insertedIds.push(first.id);

        await expect(createUser({ githubId })).rejects.toThrow();
    });

    it('has the expected column types and constraints', async () => {
        const { rows: columns } = await getPool().query<{
            column_name: string;
            data_type: string;
            is_nullable: 'YES' | 'NO';
        }>(
            `SELECT column_name, data_type, is_nullable
             FROM information_schema.columns
             WHERE table_name = 'users'
             ORDER BY ordinal_position`
        );

        const byName = Object.fromEntries(columns.map(c => [c.column_name, c]));

        expect(byName.id.data_type).toBe('uuid');
        expect(byName.id.is_nullable).toBe('NO');

        expect(byName.github_id.data_type).toBe('bigint');
        expect(byName.github_id.is_nullable).toBe('YES');

        expect(byName.github_login.data_type).toBe('text');
        expect(byName.github_login.is_nullable).toBe('YES');

        expect(byName.avatar_url.data_type).toBe('text');
        expect(byName.avatar_url.is_nullable).toBe('YES');

        expect(byName.created_at.data_type).toBe('timestamp with time zone');
        expect(byName.created_at.is_nullable).toBe('NO');

        expect(byName.last_login_at.data_type).toBe('timestamp with time zone');
        expect(byName.last_login_at.is_nullable).toBe('YES');

        const { rows: constraints } = await getPool().query<{ constraint_type: string; column_name: string }>(
            `SELECT tc.constraint_type, kcu.column_name
             FROM information_schema.table_constraints tc
             JOIN information_schema.key_column_usage kcu
               ON tc.constraint_name = kcu.constraint_name
             WHERE tc.table_name = 'users'`
        );

        expect(
            constraints.some(c => c.constraint_type === 'PRIMARY KEY' && c.column_name === 'id')
        ).toBe(true);
        expect(
            constraints.some(c => c.constraint_type === 'UNIQUE' && c.column_name === 'github_id')
        ).toBe(true);
    });
});
