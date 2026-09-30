import { describe, expect, it } from 'vitest';
import { getRateLimit } from '../../src/utilities/rateLimit.js';

/**
 * LEGACY FALLBACK BEHAVIOR — regression baseline, not a design endorsement.
 *
 * `getRateLimit()` is documented (Phase 0 audit) as expecting a *tier name*
 * (e.g. "user-default"), but the current call site in
 * src/handlers/webSocket.ts actually passes the raw WebSocket `userId`
 * (e.g. "dev_frontend", "anonymous", or a future GitHub-derived id) instead
 * of a tier. Because that string never matches a key in `tierLimits`,
 * `getRateLimit()` silently falls through to `tierLimits["user-default"]`
 * for every caller today — which is why every user currently observes the
 * same 1-pixel / 6-second cooldown regardless of identity.
 *
 * This test file exists to freeze that observable behavior *before* any
 * auth/tier work changes it, not to assert that passing a raw user id here
 * is correct. Fixing the tier-resolution bug is explicitly out of scope for
 * Stage 1 and is expected to change these exact assertions later.
 */
describe('getRateLimit — legacy fallback behavior (pre-auth baseline)', () => {
    it('returns the default tier for a real tier key it does not recognize', () => {
        expect(getRateLimit('not-a-real-tier')).toEqual({ maxPixels: 1, cooldown: 6 });
    });

    it('returns the default tier when given a raw mock userId (current production call pattern)', () => {
        // Mirrors src/handlers/webSocket.ts:47 — getRateLimit(userId) — where
        // userId is a WS query value like "dev_frontend", not a tier name.
        expect(getRateLimit('dev_frontend')).toEqual({ maxPixels: 1, cooldown: 6 });
        expect(getRateLimit('anonymous')).toEqual({ maxPixels: 1, cooldown: 6 });
    });

    it('resolves a real tier key correctly when one is actually passed', () => {
        expect(getRateLimit('user-premium')).toEqual({ maxPixels: 5, cooldown: 30 });
        expect(getRateLimit('user-moderator')).toEqual({ maxPixels: 50, cooldown: 10 });
    });
});
