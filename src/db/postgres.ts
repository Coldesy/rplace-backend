import { Pool } from 'pg';
import { requireDatabaseUrl } from '../config.js';

// Lazily constructed: importing this module never throws and never opens a
// connection, even if DATABASE_URL is unset. The pool is only created the
// first time getPool() is actually called (e.g. from a users.ts function or
// an integration test), which is what lets Stage 1's live mock server keep
// running with zero Postgres configuration.
let pool: Pool | null = null;

export function getPool(): Pool {
    if (!pool) {
        pool = new Pool({ connectionString: requireDatabaseUrl() });
    }

    return pool;
}

export async function closePool(): Promise<void> {
    if (pool) {
        await pool.end();
        pool = null;
    }
}
