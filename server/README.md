# Vroom Vroom multiplayer server

A small Node.js (18+) app: HTTP + WebSocket on one port. It is authoritative for rooms,
matchmaking, teams, events (race laps, derby damage, cop busts, bomb passes), power-ups,
warps, results and reconnects. Clients simulate their own car physics and stream it to the
server, which rejects impossible movement (speed/teleport checks) and snaps cheaters back.

```bash
cd server
npm install
npm start          # listens on PORT (default 8787)
npm test           # end-to-end tests with bot clients
```

Endpoints: `GET /health`, `GET /rooms` (public rooms), `GET /results/:id` (shareable results),
WebSocket on the same port. Results persist to `server/data/results.json` (`RESULTS_FILE` to override).

## Deploying

GitHub Pages serves the game over **https**, so browsers will only connect to a **wss://** server.
Any host that runs a Docker container or a Node process and supports WebSockets works, e.g.
Fly.io, Render, Railway or a small VPS behind Caddy/nginx (which add TLS for you).

```bash
docker build -f server/Dockerfile -t vroom-server .    # run from the repo root
docker run -p 8787:8787 -v vroom-data:/app/server/data vroom-server
```

Then point the game at it: set `MP_SERVER_URL = 'wss://your-host.example'` in `src/config.js`
(or players can paste the address into the Online panel, or use a link with `?server=wss://...`).
