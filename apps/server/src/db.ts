import type { Pool, PoolClient } from "pg";
import type { UserRow } from "./validate.js";

export async function listUsers(pool: Pool): Promise<UserRow[]> {
  const result = await pool.query<UserRow>(
    "SELECT id, display_name, banned FROM users ORDER BY display_name",
  );
  return result.rows;
}

export async function getUser(pool: Pool, id: string): Promise<UserRow | undefined> {
  const result = await pool.query<UserRow>(
    "SELECT id, display_name, banned FROM users WHERE id = $1",
    [id],
  );
  return result.rows[0];
}

export async function pixelLogCount(pool: Pool): Promise<number> {
  const result = await pool.query<{ c: number }>("SELECT count(*)::int AS c FROM pixel_log");
  return result.rows[0]?.c ?? 0;
}

export async function insertPixelLog(
  client: Pool | PoolClient,
  row: {
    seq: number;
    placement_id: string;
    user_id: string;
    x: number;
    y: number;
    color_index: number;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO pixel_log (seq, placement_id, user_id, x, y, color_index)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [row.seq, row.placement_id, row.user_id, row.x, row.y, row.color_index],
  );
}

export async function getPixelLogByPlacement(
  pool: Pool,
  placementId: string,
): Promise<{
  seq: number;
  placement_id: string;
  user_id: string;
  x: number;
  y: number;
  color_index: number;
} | undefined> {
  const result = await pool.query(
    `SELECT seq, placement_id, user_id, x, y, color_index
     FROM pixel_log WHERE placement_id = $1`,
    [placementId],
  );
  return result.rows[0];
}

export function isUniqueViolation(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code: string }).code === "23505",
  );
}
