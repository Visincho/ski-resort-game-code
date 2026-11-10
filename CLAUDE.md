# CLAUDE.md: Snowline

Snowline is a browser ski-resort tycoon (SimCity / Theme Hospital style) built on **real terrain**: AWS elevation tiles, plus real lifts, pistes, huts and village buildings from OpenStreetMap. It has a solo mode and a persistent OGame-style **online universe** hosted by the bundled Node server. The UI ships in English and Italian (the user is Italian; keep `i18n-it.js` complete).

Detailed docs live in [`docs/`](docs/README.md). Read the relevant one before changing a subsystem.

## Commands

```bash
npm start                 # server + game on http://localhost:8787 (PORT, DAY_MINUTES, DATA_DIR, CACHE_DIR, HOST, TRUST_PROXY)
npm run dev               # same, with node --watch on the server
npm run warm              # pre-download terrain tiles + OSM for all 33 famous resorts (server must be running)
npm run build:static      # dist/ for Cloudflare Pages (client + baked tiles/OSM); npm run deploy:cf publishes it
npm run music             # synthesize promo/music.wav
npm run trailer           # record + encode the promo trailers (needs: npm i -D puppeteer-core ffmpeg-static)
node --check <file.js>    # quick syntax check; there is no build step, linter or test suite
```

- **Runtime has zero npm dependencies.** three.js r187 (plus MapControls and the Line2 addons) is vendored in `public/vendor/` and loaded through an import map in `index.html`. Fonts are self-hosted in `public/fonts/`.
- The client is plain ES modules, so edits are live on reload. Restart the server only after changing `server/*` or `public/js/shared/*` (the server imports the shared modules).
- `cache/` (tiles, OSM, geocode) and `data/` (universe + saves) are gitignored runtime folders. To reset the universe: stop the server and delete `data/`.

## Layout

```
server/        server.js (static, routing, CORS, shutdown) · proxies.js (tiles/Overpass/Nominatim caches)
               api.js (universe REST API) · store.js (JSON persistence) · lib.js (helpers, rate limiters)
public/js/
  shared/      calendar.js (game-day math, ski seasons, competition schedule) · resorts.js (33 famous resorts)
               (imported by BOTH client and server: keep dependency-free and deterministic)
  main.js      menus (title/solo/load/universe), boot(), main loop, saving, app object (window.snowline)
  saves.js     local player profile, solo sessions in localStorage, session file export/import (newest savedAt wins)
  terrain.js   DEM fetch/stitch/resample, heightAt/surfaceAt/meshHeightAt, raycast, profile(), avalancheExposure()
  biome.js     forest/rock classification (deterministic noise)
  world.js     lifts, pistes, buildings, plan*/add* validation, navigation graph + routing, serialize
  osm.js       OSM -> layout importer (lifts, merged pistes, huts, bases, services)
  weather.js   Climate (deterministic seeded weather), forecast, sunPosition
  agents.js    Crowd: skier agents (needs, routing, queues, injuries, rendering positions)
  sim.js       Game: clock, day cycle, snow, demand, economy, staff, research, statuses, saves
  events.js    random events, avalanches, competitions (bids/hosting), awards, marketing; compTitle()
  catalog.js   static data: LIFTS, BUILDINGS, STAFF, RESEARCH, DIFF, PISTE_COST, skills
  render/      scene.js (renderer, terrain shader, sky, particles, camera) · layers.js (trees, village,
               lifts, pistes, buildings, carriers, skiers, previews, icons, night lights)
  ui/          hud.js (top bar, toolbar, inspector, toasts, labels) · windows.js (management windows)
               pistemap.js (2D trail map) · worldmap.js (TopoJSON world map)
  build.js     Builder: tools (select / lift / piste / building / demolish), picking, snapping
  skimode.js   ski-it-yourself (physics, timing, ghosts) and lift-ride camera
  net.js       UniverseClient (REST wrapper, market share)
  i18n.js, i18n-it.js   gettext-style t('English {x}') + Italian dictionary
  promo/director.js     scripted trailer scenes + social overlays (used only with ?record)
tools/         warm-cache.mjs · make-music.mjs · record-trailer.mjs
promo/         rendered trailers, covers, music, social copy (testi_social.md)
```

## Architecture in one paragraph

`main.js` `boot()` loads the `Terrain` (elevation tiles through the `/tiles` cache proxy, with AWS as fallback), then builds a `Biome` and a `World`. It fetches OSM data (`/api/osm`, which is slow the first time) and either loads a saved `state.world`, imports the real layout, or places a starter base. Then it creates the `Game` (sim), `Scene3D` + `Layers` (render), `HUD`, `Builder` and `SkiMode`. Every frame `loop()` calls `game.update(dt)` → `advance(minutes)`, which crosses the day events (`startDay` at midnight, open/close minutes, `endDay` at 18:30) and steps the `Crowd`. It then moves the camera, positions agents and carriers, and every 0.5 s updates the environment (sun, sky, fog, snowline, tree tint, night lights). Solo speed comes from `SPEEDS`/`IDLE_SPEEDS` in `sim.js`. In universe mode the clock is pinned to the server: `universeDay(info, now + offset)`, and gaps of more than 1.5 days run through `catchUp()` with the aggregate day model.

## Invariants and gotchas (read before editing)

- **Units and axes:** metres; `x` = east, `z` = south, `y` = up. `GeoProjection` (util.js) converts lat/lon. Game time is `s.day` (integer days since 1970-01-01, UTC) plus `s.minute` (0–1440).
- **Runtime-only fields** on lifts and pistes (`pylons`, `cable`, `queue`, `riders`, `dispatchAcc`, `status`, `traffic`) are non-enumerable through `hide()` in world.js, so they are not serialized. Use `world._liftDerived(l, plan)` to rebuild them; never `Object.defineProperty` them directly. `nBottom/nTop/nStart/nEnd/node/segments` are graph links and are stripped in `serialize()`.
- **Node and edge ids change on every `world.rebuildGraph()`.** `world.onRebuild` → `crowd.remap()` moves every skier to the nearest new node and clears lift queues. Any new code that rebuilds the graph mid-day must go through `rebuildGraph()`.
- **Statuses** (`open`, `closed`, `construction`, `wind`, `broken`, `season`, `night`, `strike`, `nosnow`, `avalanche`, `race`) are computed in `Game._applyStatuses()`; call it after changing `open`, breakdowns or snow. Bump `world.invalidateStatus()` when routing should be recomputed (`Crowd.route` caches next-hop tables by `graphVersion:statusVersion:waitEpoch`).
- **Determinism:** weather comes from `Climate(seed, region = lat/lon rounded to 0.5°)`, seeded per weather season. In the universe, every client uses `info.seed`, so neighbouring resorts share storms. Don't use `Math.random()` in weather, the calendar or rivals; use `mulberry32(hash32(...))`.
- **Shared modules** (`public/js/shared/*`) must not import browser-only code. The server imports them at startup.
- **Difficulty comes from terrain:** `planPiste` uses the steepest sustained 100 m (`DIFF.maxGrad`: green ≤14 %, blue ≤27 %, red ≤42 %, black above that); more than 100 % (45°) is a cliff and is rejected. Imported OSM pistes keep their OSM difficulty.
- **Heights for rendering:** draw objects on `terrain.surfaceAt()` (the max of the fine DEM and the coarser mesh) so they never sink into the mesh. Use `heightAt()` for gameplay math.
- **Fat lines** (`Line2`/`LineSegments2`) use `lineMat()` in layers.js, with `depthWrite: false` to avoid z-fighting. The resolution is updated on resize.
- **i18n:** `t()` keys are the exact English source strings, so changing an English string changes its key. Add or update the matching entry in `i18n-it.js` (keep `{placeholders}` identical). For runtime-composed text, translate the parts (see `compTitle()` in events.js). Strings in world.js validation errors are English-only on purpose.
- **Escaping:** user and server text (names, news, messages) must go through `escapeHtml()` before `innerHTML`.
- **Record mode:** `?record` sets `app.external = true`, so the main loop idles and `promo/director.js` drives frames. It also sets `preserveDrawingBuffer`. Don't break `app.startNew` or the `window.snowline` app object; the recorder depends on them.
- **Solo saves** are `saves.js` envelopes keyed by a stable session id (`app.session`); importing a session you already have keeps the later `savedAt`. Keep `saveSolo()` synchronous: it also runs on `beforeunload` and when the tab becomes hidden. Bump the envelope `v` if its shape changes, and keep reading older saves.
- **Economy balance:** the main numbers are listed in `docs/gameplay.md`. If you retune, re-check with an aggregate season (in the console: `snowline.game.catchUp(snowline.game.s.day + 365)`, then inspect `s.seasons`). The target is real Cortina: about 1.2–1.3 M skier-days and roughly +€25–35 M a year.
- **External services:** Overpass is serialized (one query at a time) and slow on first fetch (30–200 s). The client waits up to 240 s with a Skip button. Respect Nominatim's 1 req/s. Keep OSM attribution visible (menu, piste map, trailer).
- **Trust model:** the universe is client-authoritative (stats, scores and saves come from the browser). That's fine for friends, not for a competitive public server.

## Testing recipes

- **Manual:** `npm start`, open the page, and use `window.snowline` in the console (`game`, `s3`, `layers`, `hud`, `builder`, `client`). Useful calls:
  - `snowline.game.catchUp(day)` fast-forwards.
  - `game.setSpeed(n)` changes speed.
  - `hud.windows.open('events')` opens a window.
  - `builder.setTool('lift','chair4')` picks a tool.
- **Headless and deterministic:** with the in-app browser hidden, `requestAnimationFrame` stops. Drive the sim manually with `game.update(0.05)` in a loop, or use puppeteer (`tools/record-trailer.mjs --frames=...` captures preview frames). Headless Chrome needs `--enable-gpu --use-angle=gl` for the GPU (it falls back to SwiftShader otherwise).
- **Sanity checks after sim changes:** run a live day and check `game.dayStats` (`stranded`, `injuries`), `game.lastComplaints`, and `s.history.slice(-1)[0]` (`inc`, `exp`, `happy`).
- **i18n coverage:** extract every `t('…')` literal and diff it against `IT` keys (the docs/i18n.md script).

## Conventions

- 2-space indent, single quotes, semicolons, ES modules, short JSDoc-less comments explaining *why*. Match the surrounding style.
- Keep modules focused; put static data in `catalog.js`; put formulas next to the simulation code that uses them.
- UI: dark glass panels, CSS tokens in `:root` (style.css), Barlow / Barlow Condensed. Avoid thick one-sided accent borders (the design hook flags them).
- Don't commit `cache/`, `data/` or `promo/frames_*`.
