# R-Place Backend

## Overview

This is the backend for an interactive pixel canvas. Redis stores the board state,
and WebSockets broadcast pixel changes to connected clients.

### Project Structure

- `src/server.ts` - Creates the Fastify server, registers routes, initializes Redis scripts, and starts listening.
- `src/db/redis.ts` - Creates the Redis connection.
- `src/routes/board.ts` - Serves the current binary canvas at `GET /api/board`.
- `src/routes/ws.ts` - Registers the WebSocket endpoint at `/ws` and manages connected clients.
- `src/handlers/webSocket.ts` - Parses pixel placement messages, validates coordinates and colors, and broadcasts successful placements.
- `src/utilities/canvas.ts` - Calls the Redis placement script and calculates the pixel's canvas offset.
- `src/utilities/placement.lua` - Atomically rate-limits users, prevents duplicate placements, stores 4-bit colors, and increments the canvas sequence.
- `src/utilities/broadcast.ts` - Broadcasts updates to all connected WebSocket clients.
- `docker-compose.yml` - Runs Redis with persistent storage.

## Start Development

Install dependencies:

```bash
npm install
```

Start Redis:

```bash
docker compose up -d redis
```

Start the backend:

```bash
npm run dev
```

The server runs on `http://localhost:3001`.

## Start Production

Build the project:

```bash
npm run build
```

Start the server:

```bash
npm start
```

## Database (Postgres) — Stage 1 foundation

Postgres is **not** required to run `npm run dev` — the live mock backend
does not read `DATABASE_URL` and behaves exactly as before. Postgres is only
used by database migrations, the `users` table repository (`src/db/users.ts`,
`src/db/postgres.ts`), and the Postgres integration tests.

### Set up your `.env`

Git Bash:
```bash
cp .env.example .env
```

PowerShell:
```powershell
Copy-Item .env.example .env
```

If `.env` already exists, don't overwrite it — just add `DATABASE_URL` (and
`REDIS_URL`, for the Redis integration test) to it manually. See
`.env.example` for the exact values, which are derived directly from
`docker-compose.yml`'s `postgres` service.

### Start Postgres and run the migration

```bash
docker compose up -d postgres
npm install
npm run migrate:up
```

`npm run migrate:up` auto-loads `.env` from the project root (via
`node-pg-migrate`'s bundled dotenv support) — this only affects the
migration CLI, not the running server or the test suite.

`npm run migrate:down` is **destructive** for this initial migration: it
drops the `users` table entirely. It's for an empty local development
database only — never run it against a database with real data.

### Tests

```bash
npm run test:unit          # no live services required
npm run test:integration   # requires DATABASE_URL and REDIS_URL to already
                            # be set in your shell environment (not loaded
                            # from .env automatically) and the corresponding
                            # services reachable; otherwise each suite prints
                            # an explicit skip reason and skips only that suite
npm test                   # everything above
```

Integration tests distinguish "service unavailable" (skipped, with a printed
reason) from a real problem such as bad credentials or a missing `users`
table — those cause the test to fail rather than skip.

### Known gap

This project has no ESLint configuration or `lint` script yet. That's a
deliberate scope decision (tracked as a separate hygiene task), not an
oversight of this stage.
