# Project instructions

Build this project as a working local prototype before adding production integrations.

## Required stack

- Frontend: React, TypeScript, Vite
- Backend: Node.js, TypeScript
- Realtime: WebSocket
- Database: PostgreSQL
- Live state: Redis
- Local services: Docker Compose
- Tests: unit, integration, and WebSocket concurrency tests

## Important rules

- Read system-design.md before changing architecture.
- Do not claim production readiness.
- Do not add GitHub OAuth initially; use a mock authentication provider.
- Do not connect to the real OpenCode database initially; use a mock milestone provider.
- Do not silently decide unresolved consistency behavior.
- If a design decision is required, document it in DECISIONS.md.
- Never store secrets in source control.
- Every placement must have an idempotency key.
- Every accepted placement must receive a server sequence number.
- Add tests before or alongside implementation.
- Run type-checking, linting, and tests after every major change.
- Use database migrations rather than modifying the schema manually.
- Make admin actions auditable.
