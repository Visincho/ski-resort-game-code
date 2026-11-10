# Development guide

## Setup

```bash
node --version        # ≥ 18 (developed on 24)
npm start             # http://localhost:8787
npm run warm          # optional: pre-cache tiles + OSM for the 33 resorts (≈ 70 s each the first time)
```

There's no build step: edit files and reload. Restart the server after changing `server/*` or `public/js/shared/*`.

## Debugging

`window.snowline` (the `app` object) is available in the browser console:

```js
const g = snowline.game;
g.setSpeed(4);                          // solo speed
g.catchUp(g.s.day + 30);                // fast-forward 30 days (aggregate model)
g.s.cash += 50e6;                       // cheat money
g.s.minute = 720; snowline.envT = 10;   // jump to noon (environment refreshes next frame)
snowline.hud.windows.open('events');    // open a window
snowline.builder.setTool('lift', 'gondola');
snowline.s3.setOverlay(1);              // slope overlay
g.crowd.agents.length; g.dayStats; g.lastComplaints; g.s.history.at(-1);
g.world.summary(g.s.day);               // km, lifts, capacity, altitude range
```

- **Hidden tab / headless:** `requestAnimationFrame` stops when the page isn't visible. To advance the sim without rendering:

  ```js
  while (g.s.minute < 1100) g.update(0.05);
  ```

  To render a single frame manually: `snowline.s3.update(0.016); snowline.s3.render();`.
- **Visual checks without a visible browser:** use puppeteer with the GPU flags (see [promo.md](promo.md)), or `node tools/record-trailer.mjs h it --frames=…` for quick stills of the trailer scenes.
- **Syntax check everything:** `for f in $(find public/js server tools -name '*.js' -o -name '*.mjs' | grep -v vendor); do node --check $f; done`.

## Testing recipes

There's no automated test suite. These scripted checks have caught real bugs:

1. **A season of economy:** start a resort, run `g.catchUp(g.s.day + 365)`, then inspect `g.s.seasons[0]` (visitors, revenue, expenses, profit, happiness, awards) and `g.s.cash`. Reference: real Cortina gives about 1.29 M skier-days and about +€29 M a year on normal.
2. **A live agent day:** set `g.s.minute = 440; g.setSpeed(4)`, loop `g.update(0.05)` until 18:30, then check:
   - `g.dayStats.stranded`: should be a tiny share of visitors;
   - `injuries`: about 2–4 per 1,000 guests;
   - `g.dayHappy`: 60–85;
   - `g.lastComplaints`: the top complaints should make sense.
3. **Building flow:** start an empty mountain, place a lift and a piste through `builder` (or by clicking), then check `world.nodes` / `world.edges` connectivity and the inspector warnings.
4. **Competitions:** add a grandstand near the finish of a piste with a ≥ 750 m drop, `events.placeBid(comp)`, `catchUp` past the deadline and the event, then check `s.hosted` and the log.
5. **Universe:** register, claim, save (`snowline.save(true)`), reload, and check that the state came back; visit from a second account (raw `fetch` with another token).
6. **Solo saves and session files:** use a separate origin such as `http://127.0.0.1:8787` so your own `localhost` saves stay untouched. Create a player, start a game, advance it, reload, and check the Continue button and `snowline.save.<id>`. To test export without a download, stub `HTMLAnchorElement.prototype.click` and `fetch()` the blob URL. To test import, put a `File` in `#lFile` through a `DataTransfer` and dispatch `change`; cover the same, newer, older, legacy and malformed cases.
7. **i18n:** run the coverage script in [i18n.md](i18n.md).

## Adding content

| What | Where |
|---|---|
| A lift type | `LIFTS` in `catalog.js` (capacity, speed, maxLen, maxGrad, costs, wind, days, pylonSpan, optional `research`). Add carrier rendering in `layers.updateCarriers` if it needs a new kind, the OSM mapping in `osm.js mapLiftType`, and Italian names. |
| A building | `BUILDINGS` (category, cost, upkeep, size, days, height, colour, `service`/`seats`/`spend`/`dwell` for services, `beds`/`nightly` for lodging, `parking`, `radius`, `research`). Add a mesh case in `layers._addBuilding`, an icon in `ICONS`, effects in `sim.js`/`agents.js`, and Italian names. |
| A research project | `RESEARCH` plus its effect (`game.hasResearch(id)` checks). |
| A random event | `Events.onDayStart()` in `events.js` (use `this.rng()`, `g.notify(kind, t(...), focus, icon)`, `s.mods.push({until, demand / energy / visitors})`). |
| A competition | `competitionsForSeason()` in `shared/calendar.js` (restart the server), requirements in `req`, scale and prize handling in `events._competitionDay`. |
| A famous resort | `FAMOUS_RESORTS` in `shared/resorts.js` (centre, size, town, climate, treeline, fame, beds, day-trippers, blurb). Restart the server so the universe seeds it, run `npm run warm -- <id>`, and add the blurb translation. |
| A marketing campaign | `CAMPAIGNS` in `events.js`. |
| A window | `w_<name>(body)` in `windows.js` returning `{ title }`, plus a dock button in `hud.js`. |
| A trailer scene | `SCENES` and `TEXT` plus a `case` in `frame()` in `promo/director.js`. |

## Known limitations

- The universe is client-authoritative (see [multiplayer.md](multiplayer.md)).
- Terrain is about 20 m resolution and smoothed: small cliffs and gullies are softened, and the Dolomite towers look rounded.
- The OSM import depends on mapping quality. Pistes are chained only when consecutive ways share a name; piste areas and complex relations are skipped.
- Skiers walk in straight lines between nearby nodes, and there are no roads, buses or ski-in/ski-out logic for hotels.
- Ski mode physics are arcade-style, with no collisions with trees or skiers.
- There's no sound in the game; only the trailer has music.
- The first OSM download of an area is slow (Overpass), and the public Overpass servers can be overloaded.

## Ideas for next steps

- Server-side validation or simulation of universe saves; daily seasons and leaderboards.
- Glacier retreat and multi-year climate scenarios (the warming trend already exists in `weather.js`).
- Lift lines that bend (multi-section lifts, mid-stations), piste widening and terrain shaping.
- Ticket types (season passes, family offers), dynamic pricing and a shared regional ski pass (an alliance feature).
- Summer gameplay: bike park, hiking, events.
- Real satellite or OSM land-cover textures for forests and villages.
- Sound effects and ambience; a photo mode.
