import type { WebSocket } from "@fastify/websocket";
export const activeClients=new Set<WebSocket>()

export const broadcast = (payload:string | Buffer)=>{
    for(const client of activeClients){
        if(client.readyState === client.OPEN){
            client.send(payload)
        }
}
}