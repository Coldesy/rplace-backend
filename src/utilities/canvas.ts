import fs  from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { redis } from '../db/redis.js'

class Canvas{
    private ps: string | null = null;
    private canvas_width = 1000;

    async init(){
        const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'placement.lua')
        const script = fs.readFileSync(scriptPath, 'utf-8')
        this.ps = await redis.script('LOAD', script)
        console.log(`Loaded placement script with SHA: ${this.ps}`)
    }
    async placePixel(
        userId: string,
        x: number,
        y: number,
        colorId: number,
        placementId: string,
        maxPixels: number,
        cooldown: number
    ){
        if(!this.ps) throw new Error('Placement script not loaded')
        const offset = (y * this.canvas_width) + x
        try{
            const result = await redis.evalsha(
                this.ps,
                4,
                `cooldown:${userId}`,
                `canvas:state`,
                `pixel_log`,
                `canvas:seq`,
                 maxPixels,
                 cooldown,
                 offset,
                 colorId,
                 userId,
                 placementId
            ) as any[]

            if(result[0]==='err'){
                return { success: false, error: result[1] ,ttl:result[2]}
            }
            return { success: true, remaining: result[3], seq: result[5] }

        }catch(err){
            console.error(`Error placing pixel for user ${userId}:`, err)
            throw err
        }
    }
}
export const canvas = new Canvas()