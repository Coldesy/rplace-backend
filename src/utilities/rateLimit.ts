export interface RateLimit {
    maxPixels: number;
    cooldown: number;
}

const tierLimits: Record<string, RateLimit> = {
    "user-default": { maxPixels: 1, cooldown: 6 },
    "user-premium": { maxPixels: 5, cooldown: 30 },
    "user-moderator": { maxPixels: 50, cooldown: 10 }
};

export const getRateLimit = (tier: string): RateLimit => {
    return tierLimits[tier] ?? tierLimits["user-default"];
};
