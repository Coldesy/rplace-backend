# R-Place Backend

## Overview

This is the backend for an interactive pixel canvas. Redis stores the board state,
and WebSockets broadcast pixel changes to connected clients.

### Project Structure

- `src/server.ts` - Creates the Fastify server, registers routes, initializes Redis scripts, and starts listening.
- `src/db/redis.ts` - Creates the Redis connection.
- `src/routes/board.ts` - Serves the current binary canvas at `GET /api/board`.
- `src/routes/ws.ts` - Registers the WebSocket endpoint at `/ws` and manages connected clients.
- `src/handlers/webSocket.ts` - Parses pixel placement messages, validates coordinates and colors, and broadcasts successful placements.
- `src/utilities/canvas.ts` - Calls the Redis placement script and calculates the pixel's canvas offset.
- `src/utilities/placement.lua` - Atomically rate-limits users, prevents duplicate placements, stores 4-bit colors, and increments the canvas sequence.
- `src/utilities/broadcast.ts` - Broadcasts updates to all connected WebSocket clients.
- `docker-compose.yml` - Runs Redis with persistent storage.

## Start Development

Install dependencies:

```bash
npm install
```

Start Redis:

```bash
docker compose up -d redis
```

Start the backend:

```bash
npm run dev
```

The server runs on `http://localhost:3001`.

## Start Production

Build the project:

```bash
npm run build
```

Start the server:

```bash
npm start
```
