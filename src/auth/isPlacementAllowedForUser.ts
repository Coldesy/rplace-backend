/**
 * Placement authorization gate.
 *
 * IMPORTANT — this checks authentication ONLY. There is no ban/account-status
 * data anywhere in this system yet: no `status`/`banned` column on `users`,
 * and no moderation endpoint that could ever set one. This function does NOT
 * enforce bans, and must not be read as if it does — it has no way to know
 * whether a user is banned, because that data does not exist.
 *
 * `userId` is `null` exactly when the caller has no valid authenticated
 * session (github mode, anonymous or expired/invalid session).
 *
 * When the moderation phase adds a status column, this is the intended
 * extension point: fetch the user's status alongside their id and deny
 * placement here for a banned/suspended account.
 */
export function isPlacementAllowedForUser(userId: string | null): userId is string {
    return userId !== null;
}
