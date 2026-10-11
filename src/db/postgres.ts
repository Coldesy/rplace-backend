import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

const connectionString = process.env.DATABASE_URL ?? 'postgresql://laksh:laksh@localhost:5432/rplace';

export const postgresPool = new Pool({ connectionString });
export const db = drizzle(postgresPool);

export const checkPostgresConnection = async () => {
    await postgresPool.query('SELECT 1');
    console.log('PostgreSQL is ready');
};