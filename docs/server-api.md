# Server reference (`server/`)

The server needs Node ≥ 18 and has no npm dependencies. Start it with `npm start` (or `npm run dev` for `node --watch`).

| File | Role |
|---|---|
| `server.js` | config, static files, routing, CORS, `/api` rate limit, timers, graceful shutdown |
| `proxies.js` | elevation tile cache, Overpass (OSM) cache, Nominatim geocoder |
| `api.js` | universe REST API (auth, sites, saves, news, competitions, alliances, messages, leaderboard) |
| `store.js` | JSON persistence (`data/universe.json` + per-site save files), seeding famous resorts |
| `lib.js` | HTTP helpers, `HttpError`, `RateLimiter`, `Limiter` (concurrency), haversine, text cleaning |

## Configuration (environment variables)

| Var | Default | Meaning |
|---|---|---|
| `PORT` | 8787 | HTTP port |
| `HOST` | 0.0.0.0 | bind address |
| `DAY_MINUTES` | 20 | real minutes per universe game day (changing it re-anchors the clock without a jump) |
| `DATA_DIR` | `./data` | universe + saves |
| `CACHE_DIR` | `./cache` | tiles, OSM, geocode |
| `TRUST_PROXY` | unset | `1` = use `X-Forwarded-For` for client IPs (behind a reverse proxy) |

## Static files

`public/` is served with correct MIME types (html, js, mjs, css, json, png, jpg, webp, svg, ico, woff2, txt, glb, wasm…). There's path-traversal protection and ETag/304 support. HTML, JS and CSS are sent with `Cache-Control: no-cache` for easy development. Only GET and HEAD are allowed.

## Proxies

| Endpoint | Behaviour |
|---|---|
| `GET /tiles/{z}/{x}/{y}.png` | z ≤ 15. Served from `cache/tiles/` or fetched from AWS Terrarium. At most 6 parallel upstream fetches, with identical concurrent requests de-duplicated. A year-long `Cache-Control` and CORS `*`. 502 on upstream failure (not cached, so retry). |
| `GET /api/osm?s=&w=&n=&e=` | Rejects boxes larger than 0.5° × 0.7°. Cache key: the 4-decimal bbox (`cache/osm/{s}_{w}_{n}_{e}.json`). Two Overpass queries (see [world-data.md](world-data.md)), one at a time; retries overpass-api.de twice on 429/5xx, then kumi. Results are cached forever. If only the building query fails, the response is 200 with `buildings: []` and `partial: true`, and it isn't cached. Both upstreams failing gives 502 `{error}`. |
| `GET /api/geocode?q=` | Nominatim search (jsonv2, addressdetails, limit 8), 1 request per second globally, cached in memory and in `cache/geocode.json`. Returns `[{ name, lat, lon, type, country, countryCode, bbox:[s,w,n,e] }]`. |

## Universe API

All responses are JSON. Errors are `{ error }` with a status of 400, 401 (missing or expired token), 403, 404, 409, 413 (body too big) or 429. Authenticated routes need `Authorization: Bearer <token>`. CORS is open (`*`), and OPTIONS is handled. Body limits: 64 KB, or 10 MB for `PUT state`.

### Info and auth

| Method & path | Auth | Body → Response |
|---|---|---|
| `GET /api/universe/info` | – | → `{ name, seed, startReal, startGameDay, dayRealMinutes, maxSitesPerPlayer, serverNow, gameDay, players, sites }` |
| `POST /api/auth/register` | – | `{ name (3–20 chars of [A-Za-z0-9_ .-], case-insensitively unique), password (≥ 4) }` → `{ token, player:{ id, name } }` |
| `POST /api/auth/login` | – | `{ name, password }` → `{ token, player }` (always runs scrypt, to avoid a timing side channel) |
| `POST /api/auth/logout` | required | → `{ ok:true }` |
| `GET /api/me` | required | → `{ player:{ id, name, createdAt, allianceId }, sites:[ids], allianceTag, unreadMessages }` |

### Sites and saves

| Method & path | Auth | Body → Response |
|---|---|---|
| `GET /api/sites` | – | → `[{ id, name, country, lat, lon, w, h, famous, ownerId, ownerName, allianceTag, stats, updatedAt, createdAt }]` |
| `POST /api/sites` | required | `{ name (2–40), country, lat [-70,72], lon, w, h (4–20 km) }` → site (owned by the caller). 409 if within 6 km of another site; 403 over the site limit. id = slug + 4 hex characters. |
| `POST /api/sites/:id/claim` | required | → site (200 if already yours). 409 if owned by someone else; 403 over the limit. |
| `POST /api/sites/:id/abandon` | required (owner) | → `{ ok:true, site }`. Deletes the save files, clears stats, withdraws open bids. |
| `GET /api/sites/:id/state` | optional | Owner gets `{ owner:true, state, savedAt }`; others get `{ owner:false, publicState, savedAt }` (either may be null). |
| `PUT /api/sites/:id/state` | required (owner) | `{ state?, publicState?, stats? }` (a partial update; omitted fields keep their saved value; `stats:null` clears; stats ≤ 4 KB) → `{ ok:true, savedAt }`. An empty body is 400. |

### News, competitions, alliances, messages, leaderboard

| Method & path | Auth | Notes |
|---|---|---|
| `GET /api/news?since=<ms>` | – | The last 100 items, newest first: `{ id, time, gameDay, kind, text, siteId, playerName }` (up to 1,000 kept). |
| `POST /api/news` | required | `{ kind ([A-Za-z0-9_-]{1,24}, else "player"), text ≤ 200, siteId }`. 10/min per player. An unknown siteId is 404. |
| `GET /api/competitions` | – | `competitionsAround(gameDay)` merged with `{ status:'open'\|'closed'\|'awarded', bids:[{ siteId, siteName, playerName, score, time }], winnerSiteId, winnerName, winnerPlayer }`. |
| `POST /api/competitions/:id/bid` | required | `{ siteId (yours), score 0–1e6 }`, only while open. One bid per site (a new bid replaces it). → the competition. |
| `GET /api/alliances` | – | `[{ id, name, tag, founderId, founderName, members:[{ id, name }], createdAt }]` |
| `POST /api/alliances` | required | `{ name 3–30, tag 2–5 alphanumeric }` → the alliance (the caller leaves their old one). |
| `POST /api/alliances/:id/join` · `POST /api/alliances/leave` | required | Founder hand-over on leave; empty alliances are deleted. |
| `GET /api/messages` | required | `{ inbox:[…], sent:[…] }` (last 100 each): `{ id, from, fromName, to, toName, subject, text, time, read }` |
| `POST /api/messages` | required | `{ toName, subject ≤ 80 (empty becomes "(no subject)"), text ≤ 2000 }`. 20/min. An unknown recipient is 404. |
| `POST /api/messages/:id/read` | required (recipient) | → `{ ok:true }` |
| `GET /api/leaderboard` | – | `{ resorts:[top 100 by value: { siteId, name, country, ownerName, allianceTag, rating, visitorsSeason, value, fame, pisteKm, lifts }], players:[{ name, sites, totalValue, allianceTag }], alliances:[{ tag, name, members, totalValue }] }` |

The server also posts news automatically for: player joined, site claimed, created or abandoned, competition awarded, alliance founded.

## Persistence

- **`data/universe.json`:** `info`, players (scrypt salt + hash), sessions (token → `{ playerId, created }`, 30-day expiry, purged hourly), sites (with stats), news, competition records, alliances, messages. Written at most every 3 s after a change, atomically (temp file + rename), and flushed synchronously on SIGINT/SIGTERM.
- **`data/states/{id}.json`** (`{ state, savedAt }`) and **`{id}.public.json`** (`{ publicState, savedAt }`), written separately so visitors don't download the owner's save.
- **Famous resorts:** on start-up, `store.seedFamousResorts()` imports `public/js/shared/resorts.js` and adds any missing catalogue entry as an unowned famous site.
- **Reset:** stop the server and delete `data/`. To keep downloaded map data, keep `cache/`.

## Timers

Competition resolution every 30 s, rate-limiter sweep every 60 s, session purge hourly.

## Deploying

Run `node server/server.js` behind a reverse proxy (nginx or Caddy) with TLS, set `TRUST_PROXY=1`, and persist `data/` and `cache/` on a volume. Remember the trust model in [multiplayer.md](multiplayer.md#trust-model-and-limits).
