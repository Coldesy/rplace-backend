const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_USER_URL = 'https://api.github.com/user';
const REQUEST_TIMEOUT_MS = 5000;

export class GithubAuthError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'GithubAuthError';
    }
}

export function buildAuthorizeUrl(clientId: string, callbackUrl: string, state: string): string {
    const url = new URL(GITHUB_AUTHORIZE_URL);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', callbackUrl);
    url.searchParams.set('scope', 'read:user');
    url.searchParams.set('state', state);
    return url.toString();
}

export interface GithubProfile {
    id: number;
    login: string;
    avatarUrl: string | null;
}

/**
 * Exchanges an authorization code for an access token, server-side only.
 * The token is returned to the caller in-memory for one immediate profile
 * fetch and is never logged, persisted, or returned to the client.
 */
export async function exchangeCodeForToken(
    clientId: string,
    clientSecret: string,
    code: string,
    callbackUrl: string
): Promise<string> {
    let response: Response;

    try {
        response = await fetch(GITHUB_TOKEN_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json'
            },
            body: JSON.stringify({
                client_id: clientId,
                client_secret: clientSecret,
                code,
                redirect_uri: callbackUrl
            }),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
    } catch {
        // Deliberately no details from the caught error — it could echo
        // request internals. A generic, safe message only.
        throw new GithubAuthError('GitHub token exchange request failed.');
    }

    if (!response.ok) {
        throw new GithubAuthError(`GitHub token exchange returned HTTP ${response.status}.`);
    }

    let body: unknown;
    try {
        body = await response.json();
    } catch {
        throw new GithubAuthError('GitHub token exchange returned a malformed response.');
    }

    const parsed = body as { access_token?: unknown; error?: unknown };

    if (parsed.error || typeof parsed.access_token !== 'string' || parsed.access_token.length === 0) {
        throw new GithubAuthError('GitHub token exchange did not return a usable token.');
    }

    return parsed.access_token;
}

export async function fetchGithubProfile(accessToken: string): Promise<GithubProfile> {
    let response: Response;

    try {
        response = await fetch(GITHUB_USER_URL, {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                Accept: 'application/vnd.github+json',
                'User-Agent': 'rplace-backend'
            },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
    } catch {
        throw new GithubAuthError('GitHub profile request failed.');
    }

    if (!response.ok) {
        throw new GithubAuthError(`GitHub profile request returned HTTP ${response.status}.`);
    }

    let body: unknown;
    try {
        body = await response.json();
    } catch {
        throw new GithubAuthError('GitHub profile response was malformed.');
    }

    const parsed = body as { id?: unknown; login?: unknown; avatar_url?: unknown };

    if (typeof parsed.id !== 'number' || !Number.isInteger(parsed.id)) {
        throw new GithubAuthError('GitHub profile response did not include a valid numeric id.');
    }

    return {
        id: parsed.id,
        login: typeof parsed.login === 'string' ? parsed.login : '',
        avatarUrl: typeof parsed.avatar_url === 'string' ? parsed.avatar_url : null
    };
}
