import { defineConfig } from 'drizzle-kit';
import { env } from 'node:process';

export default defineConfig({
    schema: './src/db/schema.ts',
    out: './drizzle',
    dialect: 'postgresql',
    dbCredentials: {
        url: env.DATABASE_URL ?? 'postgresql://laksh:laksh@localhost:5432/rplace'
    }
});