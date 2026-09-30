// Narrow config helpers for Postgres-dependent code paths only.
//
// Nothing in the currently-running mock backend (src/server.ts, src/routes/*,
// src/handlers/*, src/utilities/*) imports this file. It exists for:
//   - the Postgres connection pool (src/db/postgres.ts)
//   - Postgres integration tests
//   - future auth code (Stage 2+) that explicitly needs a database
//
// DATABASE_URL is therefore NOT required to run `npm run dev` in Stage 1.

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
