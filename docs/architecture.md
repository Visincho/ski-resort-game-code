# Architecture

Snowline is a static ES-module client (`public/`) served by a dependency-free Node server (`server/`). There is no bundler. three.js r187 is vendored and mapped with an import map:

```html
<script type="importmap">{ "imports": { "three": "./vendor/three.module.js", "three/addons/": "./vendor/addons/" } }</script>
```

## Module map

```
                       ┌──────────── shared/ (client + server) ────────────┐
                       │ calendar.js  game days, seasons, competition list │
                       │ resorts.js   33 famous resorts + climate defaults │
                       └───────────────────────────────────────────────────┘
main.js ── menus, boot(), loop(), save/load, window.snowline
  │
  ├─ saves.js    local player profile, solo sessions, session files (export / import)
  ├─ terrain.js  Terrain: DEM grid, heights, gradients, raycast, profiles
  ├─ biome.js    Biome: forest / rock density
  ├─ world.js    World: lifts, pistes, buildings, graph, routing
  ├─ osm.js      fetchOsm(), importLayout(), villageHouses(), findFreeSpot()
  ├─ sim.js      Game (Emitter): clock, days, snow, demand, economy …
  │    ├─ agents.js  Crowd: skier agents
  │    ├─ events.js  Events: random events, hazards, competitions, awards
  │    └─ weather.js Climate: deterministic weather
  ├─ render/scene.js   Scene3D: renderer, camera, terrain shader, sky, particles
  ├─ render/layers.js  Layers: everything drawn from the world + skiers
  ├─ ui/hud.js         HUD: top bar, toolbar, tool panels, inspector, toasts, labels
  │    └─ ui/windows.js   Windows: finance, staff, weather, events, research, …
  ├─ build.js          Builder: mouse tools
  ├─ skimode.js        SkiMode: ski-it-yourself + lift rides
  ├─ net.js            UniverseClient
  └─ i18n.js           t()
promo/director.js — trailer automation (only with ?record)
```

## Boot sequence (`main.js`)

1. **Menus.** `titleScreen()`, `soloScreen()` (resort cards + custom location through `WorldMap` and geocoding), `loadScreen()` (localStorage saves, per-save export, file import with conflict handling) and `universeScreen()` (login, then `dashboard()` with a world map, your resorts, free famous resorts and "found a new resort").
2. **`startNew({def, layout, difficulty, universe})`** builds a fresh state with `newState()` (sim.js):
   - **Start date:** the real layout starts on 14 Nov 2026 and empty mountains on 2 May 2026 (shifted for the southern hemisphere). In the universe, the start date is the server's current game day.
   - **Cash by layout:**

     | Layout | Easy | Normal | Hard |
     |---|---|---|---|
     | Real (`osm`) | €45M | €25M | €10M |
     | Empty | €60M | €35M | €18M |

     Sandbox gets €250M. In the universe, an empty start gets €35M; taking over the real resort gives €6M plus a loan of 30 % of the lift value.
   - **Scenario goals:** set by `scenarioFor()`.
3. **`boot()`**
   1. `new Terrain(def).load()`: elevation tiles, then a resampled metric grid (progress shown on the loading screen).
   2. `new Biome(terrain, treeline, townXZ)`, then `new World(terrain, biome, country)`.
   3. `fetchOsm(terrain.bbox)`, wrapped in `withSkip()`: a Skip button appears after 6 s, with a 240 s timeout.
   4. Choose the layout:
      - **Saved:** `world.load(state.world)`.
      - **Real:** `importLayout()`, then staff and fleet are sized to the resort and extra snowcat garages are added.
      - **Empty:** a free base station in the village.
   5. `new Game({terrain, biome, world, state, universe})`, then `startDay()` for a fresh game or `resumeDay()` for a loaded save (it restores the operating state and the remaining guests of the current day).
   6. `new Scene3D()` and `new Layers()`, then `buildVillage()`, `buildTrees()` and `rebuildAll()`.
   7. `new HUD(app)`, `new Builder()`, `new SkiMode()`; frame the camera; start the welcome advisor; start `requestAnimationFrame(loop)`.

## Main loop

```
loop(now):
  if app.external → idle (recorder drives frames)
  game.update(dt)            // advance game minutes (solo: speed table; universe: server clock)
  ski.update(dt)             // when skiing or riding
  s3.update(dt)              // camera controls, WASD/QE, ground clamp, particles
  crowd.computePositions()   // agent world positions from graph state
  layers.updateAgents / updateIcons / updateCarriers
  every 0.5 s: s3.setEnvironment(day, minute, weather, snowline, summer)
               layers.updateTreeColors, updateNightLights, refreshStatus (on status/day change)
  hud.update(dt)             // 4 Hz top bar, inspector every 0.75 s, window ticks, labels every frame
  s3.render()
  autosave every 60 s (solo → localStorage, universe → PUT state) · universe sync every 120 s
```

`Game.update(dt)` turns real time into game minutes:
- **Solo:** `SPEEDS = [0, 2, 5, 12, 30]` game minutes per real second while the resort operates. Speed 1 runs a ski day (08:30–16:30) in 4 real minutes. When the resort is closed, `IDLE_SPEEDS = [0, 30, 120, 480, 1440]` apply. With `policy.autoNight`, empty nights run at ≥240 min/s.
- **Universe:** `target = universeDay(info, Date.now() + offset)`. More than 1.5 days behind triggers `catchUp(day, minute)` (aggregate days). Otherwise it advances at most 60 game minutes per frame.
- `advance(dm)` takes steps of at most 0.5 min during active hours and at most 20 min otherwise. It triggers `_applyStatuses()` when crossing open (08:30) and close (16:30), spawns arrivals, steps the crowd, and every 15 game minutes refreshes queue estimates, checks breakdowns and re-applies statuses. It flushes leftover skiers at 17:55, calls `endDay()` at 18:30, and `startDay()` at midnight.

## Day cycle

- **`startDay(fast)`**
  - Reset the ledger, day stats and complaints.
  - Weather of the day; season rollover (`endSeason()` when the season year changes).
  - Construction completions.
  - Snowfall and rain on the snowpack and pistes; avalanche danger.
  - `events.onDayStart()`, `_applyStatuses()`, automatic avalanche control.
  - Operating check: in season (or early opening) **and** a base station **and** an open lift **and** an open piste.
  - `computeDemand()` gives the visitors. A live day calls `_scheduleArrivals()` (agents, ticket revenue, sightseers). A fast day calls `_aggregateDay()` (statistical revenue, happiness and wear).
- **`endDay(fast)`**
  - Wages, energy, maintenance, insurance, VAT and fees, supplies, interest.
  - Hotel revenue, summer operations, night skiing, research progress, staff morale.
  - Reputation and fame.
  - `_overnight()`: melt, snowmaking, grooming.
  - Lift wear, `events.onDayEnd()` (competition resolution), the history record, the advisor, and the goal check.

## Game state (`game.s`, the save format)

`newState()` creates the full serializable state; `game.serialize()` writes `s.world` from `world.serialize()` and deep-copies it.

```js
{
  v, mode: 'solo'|'universe'|'visit', siteId, resortId, name, country,
  def: { id, name, country, region, lat, lon, w, h, town:[lat,lon], climate:{t1500,snow}, treeline, fame, beds, day },
  seed, day, minute, cash, loan, rep, fame,
  prices: { ticket, food, rental, school, lodging },          // food/lodging are multipliers
  staff: { patrol, mechanic, instructor, host }, snowcats, wageLevel, morale,
  policy: { avyControl, snowTarget, summerOps, autoNight, earlyOpen },
  research: { done:[ids], current, progress },
  marketing: [{ id, until, demand }], mods: [{ until, demand?, energy?, visitors? }],
  avy: { level, recent:[cm,cm,cm], controlled }, snowpack: [{ h, d }],   // every 250 m from 500 to 4800 m
  season: { year, visitors, revenue, expenses, injuries, peak, days, openDays, happySum, happyN, snowmade, events, awards },
  seasons: [...summaries], history: [...last 420 days: { day, visitors, inc, exp, cash, rep, w, t, snow, happy, inj, ledger }],
  comps: { [compId]: { status:'bid'|'won'|'lost', score, pisteId, lobby, title, rivals?, winner? } },
  hosted: { worldcup, worldchamps, olympics, freestyle }, scheduled: [...events],
  scenario: { title, goals:[{ type, target, label }] }, won, log: [...last 80 messages], stats,
  world: { lifts:[…], pistes:[…], buildings:[…] }
}
```

**World entities (serialized fields):**
- **Lift:** `id, kind:'lift', type, name, a:[x,z] (bottom), b:[x,z] (top), ya, yb, length, horiz, vertical, capacity, speed, built, buildUntil, condition, open, brokenFrom, brokenUntil, imported, stats, value`.
- **Piste:** `id, kind:'piste', name, pts:[[x,z]…] (top → bottom), difficulty 0–3, length, drop, top, bottom, meanH, steepest, south, avyExp, width, snowmaking, lighting, open, groom, imported, built, buildUntil, snow:{ depth, made, quality, surface, fresh, ice }, stats, value, raceUntil?, avalancheUntil?`.
- **Building:** `id, kind:'building', type, x, z, y, rot, open, imported, name, built, buildUntil, stats, value`.

**Saves:**
- **Solo** (`saves.js`): each game is a *session* with a stable id. It is stored as an envelope `{ format: 'snowline-session', v: 1, id, owner, by, created, savedAt, copyOf?, state }` under `snowline.save.<id>`, with an index in `snowline.saves` (`{ key, id, name, resortId, day, cash, savedAt, owner, by }`). `owner` is the player who started the game and `by` the one who saved it last (`{ id, name }`). `app.session` holds `{ id, owner, created }` for the running game.
  - **When it saves:** autosave every 60 s, Save in the menu, quit, `beforeunload`, and whenever the tab becomes hidden (`visibilitychange`: covers mobile and tabs that the OS discards without unloading). `saveSolo()` is synchronous so it completes while the page closes.
  - **Profile:** `snowline.profile` = `{ id, name, created }`. The id is the name's slug plus 10 random hex characters (`crypto.getRandomValues`, which also works on plain-http LAN hosts), e.g. `marco-1654777eb2`. Renaming keeps the id. The title screen asks for a name on first run; saves made before profiles existed are adopted by the first profile.
  - **Export:** "Export save file" (in-game menu, or ⬇ on a Load screen row) saves first, then downloads the envelope plus `exportedAt` as `<resort>_<y-m-d>_<id>.snowline.json`.
  - **Import** (Load screen): a new session id is just added. For an id you already have, the copy with the later `savedAt` wins: a newer file replaces yours (with Undo); an older file is ignored, with *Replace mine with the file* and *Keep both* (a fork with a new id and `copyOf`). Equal timestamps mean it's already up to date. On a fresh browser, importing your own file can adopt its player id (`adoptProfile`), which is how you move to another PC. Bare-state files from older versions import as new sessions timed by the file date; non-solo states and malformed ids are rejected. Timestamps come from each device's clock, so a PC with a wrong clock can make the wrong copy win: the notices show both save times and game dates.
  - Older saves (bare state under `snowline.save.<resortId>.<time>`) still load; the index gives them an id from the key and they become envelopes on their next save.
- **Universe:** `PUT /api/sites/:id/state` with `{ state, publicState: game.publicSnapshot(), stats: game.statsForServer() }`.
- **Other localStorage keys:** `snowline.profile`, `snowline.lang`, `snowline.quality`, `snowline.token`, `snowline.pref.*`, `snowline.best.<resort>.<piste>` (ski-mode ghosts), `snowline.pendingLayout.<site>`.

## The `app` object (`window.snowline`)

| Field | Meaning |
|---|---|
| `game, s3, layers, hud, builder, ski` | live instances (null in menus) |
| `universe` | `{ info, client, site, share, offset }` in universe mode |
| `visit` | `{ site }` when visiting another player's resort (no sim, HUD in `.visit` mode) |
| `client` | `UniverseClient` |
| `quality` | `'high'` or `'low'` (fewer skiers and village houses, pixel ratio 1) |
| `session` | `{ id, owner, created }` of the running solo game (null otherwise) |
| `external` | true with `?record`: the main loop idles |
| `save(manual)`, `exportSave()`, `setQuality()`, `startSkiMode(target)`, `quit()`, `visitSite(id)`, `startNew(opts)` | actions |

## Events emitted by `Game`

`message` (toast/advisor/log), `dayStart`, `dayEnd` (history record), `seasonEnd` (summary), `topology` (built or demolished), `entity`, `cash`, `speed`, `research`, `comps`, `catchup`, `won`.
