import { getPool } from './postgres.js';

// Stage 1 kept this deliberately minimal (createUser/getUserById/
// getUserByGithubId only). Stage 2 adds the one function that was
// explicitly deferred: upsertUserFromGithub.

export interface UserRow {
    id: string;
    // node-pg returns BIGINT columns as strings by default (to avoid silent
    // precision loss past Number.MAX_SAFE_INTEGER), so github_id is typed
    // as a string here, not a number.
    github_id: string | null;
    github_login: string | null;
    avatar_url: string | null;
    created_at: Date;
    last_login_at: Date | null;
}

export interface CreateUserInput {
    githubId?: number | string | null;
    githubLogin?: string | null;
    avatarUrl?: string | null;
}

/** Inserts a row. With no input, inserts a fully-mock-compatible row (all GitHub fields NULL). */
export async function createUser(input: CreateUserInput = {}): Promise<UserRow> {
    const { rows } = await getPool().query<UserRow>(
        `INSERT INTO users (github_id, github_login, avatar_url)
         VALUES ($1, $2, $3)
         RETURNING id, github_id, github_login, avatar_url, created_at, last_login_at`,
        [input.githubId ?? null, input.githubLogin ?? null, input.avatarUrl ?? null]
    );

    return rows[0];
}

export async function getUserById(id: string): Promise<UserRow | null> {
    const { rows } = await getPool().query<UserRow>(
        `SELECT id, github_id, github_login, avatar_url, created_at, last_login_at
         FROM users
         WHERE id = $1`,
        [id]
    );

    return rows[0] ?? null;
}

export async function getUserByGithubId(githubId: number | string): Promise<UserRow | null> {
    const { rows } = await getPool().query<UserRow>(
        `SELECT id, github_id, github_login, avatar_url, created_at, last_login_at
         FROM users
         WHERE github_id = $1`,
        [githubId]
    );

    return rows[0] ?? null;
}

export interface UpsertGithubUserInput {
    githubId: number;
    /** Mutable metadata — updated on every login, never used to identify the user. */
    githubLogin: string;
    avatarUrl: string | null;
}

/**
 * Upserts a user keyed on the immutable github_id. github_login and
 * avatar_url are treated as mutable metadata and always overwritten with
 * the latest values from GitHub. last_login_at is set to now() on every
 * successful login, insert or update alike.
 */
export async function upsertUserFromGithub(input: UpsertGithubUserInput): Promise<UserRow> {
    const { rows } = await getPool().query<UserRow>(
        `INSERT INTO users (github_id, github_login, avatar_url, last_login_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (github_id) DO UPDATE
           SET github_login = EXCLUDED.github_login,
               avatar_url = EXCLUDED.avatar_url,
               last_login_at = now()
         RETURNING id, github_id, github_login, avatar_url, created_at, last_login_at`,
        [input.githubId, input.githubLogin, input.avatarUrl]
    );

    return rows[0];
}
