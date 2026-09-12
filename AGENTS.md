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

## Development workflow

Before implementing a major feature:

1. Inspect the existing repository.
2. State the files that will be created or changed.
3. List assumptions and unresolved decisions.
4. Implement the smallest working slice.
5. Add or update tests.
6. Run the relevant checks.
7. Report failures honestly.

## Required checks

At minimum, the project should eventually provide:

- `npm run lint`
- `npm run typecheck`
- `npm test`
- `npm run build`

Use the actual package manager and commands selected for the repository.