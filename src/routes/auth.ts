import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requireGithubAuthConfig } from '../config.js';
import {
    buildAuthorizeUrl,
    exchangeCodeForToken,
    fetchGithubProfile,
    GithubAuthError
} from '../auth/github.js';
import {
    clearOAuthStateCookie,
    consumeOAuthState,
    issueOAuthState,
    OAUTH_STATE_COOKIE_NAME
} from '../auth/state.js';
import {
    clearSessionCookie,
    createSession,
    destroySession,
    sessionCookieName,
    setSessionCookie,
    verifySession
} from '../auth/session.js';
import { upsertUserFromGithub, getUserById } from '../db/users.js';

interface CallbackQuery {
    code?: string;
    state?: string;
    error?: string;
}

/** Only ever redirects into the configured frontend origin — never an arbitrary client-supplied URL. */
function frontendRedirectWithError(frontendUrl: string, code: string): string {
    const target = new URL(frontendUrl);
    target.searchParams.set('auth_error', code);
    return target.toString();
}

export default async function authRoutes(app: FastifyInstance) {
    app.get('/github', async (_request, reply) => {
        const config = requireGithubAuthConfig();
        const state = await issueOAuthState(reply, config.oauthStateTtlSeconds, config.cookieSecure);
        return reply.redirect(buildAuthorizeUrl(config.clientId, config.callbackUrl, state));
    });

    app.get(
        '/github/callback',
        async (request: FastifyRequest<{ Querystring: CallbackQuery }>, reply) => {
            const config = requireGithubAuthConfig();

            const cookieState = request.cookies?.[OAUTH_STATE_COOKIE_NAME];
            const validation = await consumeOAuthState(cookieState, request.query.state);
            clearOAuthStateCookie(reply, config.cookieSecure);

            if (!validation.valid) {
                app.log.warn(`OAuth callback rejected: ${validation.reason}`);
                return reply.redirect(frontendRedirectWithError(config.frontendUrl, 'invalid_state'));
            }

            if (request.query.error) {
                // GitHub's own error code (e.g. access_denied) is logged but
                // never reflected verbatim into the redirect.
                app.log.info(`OAuth denied by GitHub: ${request.query.error}`);
                return reply.redirect(frontendRedirectWithError(config.frontendUrl, 'access_denied'));
            }

            if (!request.query.code) {
                return reply.redirect(frontendRedirectWithError(config.frontendUrl, 'missing_code'));
            }

            try {
                const accessToken = await exchangeCodeForToken(
                    config.clientId,
                    config.clientSecret,
                    request.query.code,
                    config.callbackUrl
                );
                const profile = await fetchGithubProfile(accessToken);
                // accessToken goes out of scope here — never logged, persisted, or returned.

                const user = await upsertUserFromGithub({
                    githubId: profile.id,
                    githubLogin: profile.login,
                    avatarUrl: profile.avatarUrl
                });

                const sessionToken = await createSession(user.id, config.sessionTtlSeconds);
                setSessionCookie(reply, sessionToken, config.sessionTtlSeconds, config.cookieSecure);

                return reply.redirect(config.frontendUrl);
            } catch (error) {
                if (error instanceof GithubAuthError) {
                    app.log.error(`GitHub OAuth failed: ${error.message}`);
                    return reply.redirect(frontendRedirectWithError(config.frontendUrl, 'github_failed'));
                }
                app.log.error(error, 'Unexpected error during OAuth callback');
                return reply.redirect(frontendRedirectWithError(config.frontendUrl, 'server_error'));
            }
        }
    );

    app.get('/me', async (request, reply) => {
        const config = requireGithubAuthConfig();
        const token = request.cookies?.[sessionCookieName(config.cookieSecure)];
        const userId = await verifySession(token);

        if (!userId) {
            return reply.status(401).send({ error: 'UNAUTHENTICATED' });
        }

        const user = await getUserById(userId);
        if (!user) {
            // Session pointed at a user that no longer exists.
            return reply.status(401).send({ error: 'UNAUTHENTICATED' });
        }

        // Safe display fields only — no github_id, no tokens, no internal id exposure beyond this.
        return reply.send({
            id: user.id,
            login: user.github_login,
            avatarUrl: user.avatar_url
        });
    });

    app.post('/logout', async (request, reply) => {
        const config = requireGithubAuthConfig();
        const token = request.cookies?.[sessionCookieName(config.cookieSecure)];

        await destroySession(token);
        clearSessionCookie(reply, config.cookieSecure);

        return reply.send({ ok: true });
    });
}
