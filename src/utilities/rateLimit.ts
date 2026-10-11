export interface RateLimit {
    maxPixels: number;
    cooldown: number;
}



export const getRateLimit = (tier: number): RateLimit => {
    
    if (tier >= 100) {
        return { maxPixels: 10, cooldown: 5 };
    } else if (tier >= 50) {
        return { maxPixels: 5, cooldown: 10 };
    } else if (tier >= 20) {
        return { maxPixels: 3, cooldown: 15 };
    } else if (tier >= 10) {
        return { maxPixels: 2, cooldown: 30 };
    } else {
        return { maxPixels: 1, cooldown: 60 };
    }
};
