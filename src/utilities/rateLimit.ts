export interface RateLimit {
    maxPixels: number;
    cooldown: number;
}



export const getRateLimit = (tier: number): RateLimit => {
    
    if (tier >= 400) {
        return { maxPixels: 32, cooldown: 60 };
    } else if (tier >= 300) {
        return { maxPixels: 16, cooldown: 60 };
    } else if (tier >= 150) {
        return { maxPixels: 8, cooldown: 60 };
    } else if (tier >= 50) {
        return { maxPixels: 4, cooldown: 60 };
    } else {
        return { maxPixels: 2, cooldown: 60 };
    }
};
