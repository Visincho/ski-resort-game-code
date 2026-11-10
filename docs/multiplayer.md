# The online universe

The universe is a persistent shared world in the style of OGame. Every player runs real ski resorts on one shared clock, and time keeps passing while they're offline. The bundled Node server hosts it: `npm start` (API reference: [server-api.md](server-api.md)).

## Clock

- The universe is created on the server's first start: `{ name: "Alpine Universe 1", seed, startReal: now, startGameDay: 1 Oct 2026, dayRealMinutes: DAY_MINUTES || 20, maxSitesPerPlayer: 3 }`.
- **Game day** = `startGameDay + (now − startReal) / (dayRealMinutes · 60000)` (`universeDay()` in `shared/calendar.js`). At the default 20 minutes per day, that's 72 game days per real day, so a winter season lasts about 2 real days and a year about 5.
- If you restart the server with a different `DAY_MINUTES`, it re-anchors the clock so the current game day doesn't jump.
- The client measures `offset = serverNow − local midpoint time` in `UniverseClient.info()` and always computes `universeDay(info, Date.now() + offset)`.
- **In game:**
  - The speed buttons are disabled.
  - `Game.update()` advances to the server time: up to 60 game minutes per frame when slightly behind, or `catchUp(day, minute)` when more than 1.5 days behind (after being away, or a background tab).
  - Catch-up days use the **aggregate day model** (`_aggregateDay`): statistical visitors, revenue, wear and happiness, with no agents.
  - The player then sees "While you were away: N days passed".

## Deterministic shared weather

Every client of a universe builds its `Climate` with `info.seed`. Weather is generated per region cell (lat/lon rounded to 0.5°) and per weather season, so Cortina, Alta Badia and Val Gardena get the same storms, cold snaps and powder days at the same time. Forecasts are deterministic too.

## Sites

- **Famous sites:** all 33 catalogue resorts start unowned.
- **New sites:** any player can found one anywhere (12 × 12 km). It must be 6 km or more from every existing site centre (haversine); search a place or click the map.
- **Per player:** up to 3 resorts (`maxSitesPerPlayer`).
- **Claiming a famous resort**, you choose:
  - **Empty mountain:** €35M, the village only.
  - **Take over the real resort:** the full OpenStreetMap layout, €6M cash and a loan of 30 % of the lift value.
- The choice is remembered in `localStorage` (`snowline.pendingLayout.<id>`) until the first save.
- **Abandon** deletes the saved resort for good, withdraws its open bids and frees the site.

## Saves

- The client PUTs `{ state, publicState, stats }` every 60 s, on *Save*, and on quit. `beforeunload` sends just the stats with `keepalive`.
- **`state`** is the full owner save, stored in `data/states/{id}.json`; only the owner can read it.
- **`publicState`** (`game.publicSnapshot()`) is the name, day, rating, fame, layout (`world.serialize()`), summary and last 5 seasons. It's stored separately in `{id}.public.json` and is what visitors load.
- **`stats`** (`game.statsForServer()`): `rating, fame, attract, visitorsSeason, value (assets + cash − loan), cash, pisteKm, lifts, top, day, hosted`. These feed the leaderboard and market share.
- **Loading** a site with saved state boots from it; the clock then catches up.

## Market share and competition between players

`UniverseClient.marketShare(site, myAttractiveness)` is recomputed every 2 minutes from the site list:

```
for every OTHER owned site with stats within 60 km:
   allied (same alliance tag)  → allies++
   otherwise                   → rivals += e^(−d/30 km) · A_other / max(0.15, A_mine)
share = clamp( 1/(1 + 0.45·rivals) · (1 + min(0.24, 0.06·allies)), 0.35, 1.3 )
```

`share` multiplies day-trippers fully and lodging guests with a floor of 0.6 (see [gameplay.md](gameplay.md#demand-gamecomputedemand)). Strong neighbours steal day visitors, while allied neighbours act like a shared ski pass (+6 % each, up to +24 %). The **Neighbours** tab shows nearby resorts and the current share.

## Alliances

- Found an alliance (3–30 characters, a 2–5 character tag), join one, or leave.
- If the founder leaves, the founder role passes to another member; empty alliances are deleted.
- Tags appear in the leaderboard and on the map. Alliance membership is what `marketShare()` uses.

## Competitions (server-arbitrated)

- **Calendar:** the client and server share it (`competitionsAround(day)` in `shared/calendar.js`). The server adds a status and bids: `open` until `bidDeadlineDay`, then `awarded` to the highest score (ties go to the earlier bid) or `closed` if there were no bids.
- **Resolution:** lazily on read, and by a 30 s timer. Only bids from sites still owned by the bidder count.
- **Bidding:** the client checks eligibility, pays the bid fee, computes its score (`events.bidScore`) and posts it (`POST /api/competitions/:id/bid`). Bids are public, so rival scores appear in the Events window.
- **Awarding:** after the deadline, `Events._resolveCompetitions()` reads the server result. If `winnerSiteId` is the player's site, the event is scheduled and hosted exactly as in solo mode.
- Note: World Championships 2027 is already `closed` on a fresh universe, because its deadline falls before the universe starts.

## Social features

- **Leaderboard:** resorts sorted by value (top 100), plus player and alliance totals.
- **News feed:** the server posts on join, claim, create, abandon, competition award and alliance founding. Clients post celebrity visits, avalanches and hosted events (at most 10 per minute per player; the client throttles to one every 8 s).
- **Private messages** between players, with read flags.
- **Visit:** load another player's `publicState` in a read-only 3D view (no simulation, the HUD in `.visit` mode). Use the menu to go back.

## Trust model and limits

- The game is **client-authoritative**: the server stores whatever saves, stats and bid scores the clients send (validated only for shape and size). That's fine for friends or a club, but a public competitive server would need server-side simulation or validation.
- Passwords are hashed with scrypt (16-byte salt, 64-byte key) and compared in constant time. Tokens are random 32-byte hex strings that last 30 days.
- **Rate limits:** auth 20/min per IP, news 10/min, messages 20/min, all `/api` 900/min per IP.
- Persistence is JSON files: fine for hundreds of players, not for thousands.
