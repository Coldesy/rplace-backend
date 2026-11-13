export const DEFAULT_ALLOWED_ORIGIN = 'https://events.geekhaven.in';

export const getAllowedOrigins = (configuredOrigin: string | undefined = process.env.FRONTEND_URL): string[] => {
    return Array.from(
        new Set([
            DEFAULT_ALLOWED_ORIGIN,
            ...(configuredOrigin ? [configuredOrigin] : ['http://localhost:3000'])
        ])
    );
};
