import { defineConfig } from 'vitest/config';

// Deliberately no `setupFiles: ['dotenv/config']` here: unit tests must not
// silently pick up a developer's .env. Integration tests instead check
// process.env.DATABASE_URL / REDIS_URL directly and skip with an explicit
// reason if those aren't already set in the environment the test runner
// was launched from.
export default defineConfig({
    test: {
        environment: 'node',
        testTimeout: 10000,
        hookTimeout: 10000
    }
});
