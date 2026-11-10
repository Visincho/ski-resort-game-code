# ⛰ Snowline: ski resort tycoon on real mountains

A browser management game in the spirit of SimCity and Theme Hospital. You build and run a ski resort on **real terrain**: elevation data for any mountain on Earth, and optionally the **real lifts and pistes as they exist today**, imported from OpenStreetMap. Play solo, or join a persistent **online universe** (OGame style) where every player runs famous resorts, and anyone can found new ones anywhere.

![Snowline](https://img.shields.io/badge/three.js-r187-black) ![node](https://img.shields.io/badge/node-%E2%89%A518-green) ![deps](https://img.shields.io/badge/npm%20deps-0-blue)

## Quick start

```bash
npm start            # serves the game + universe API on http://localhost:8787
npm run warm         # optional: pre-download terrain + OSM data for all 33 famous resorts
```

Open <http://localhost:8787>. No build step and no npm dependencies. three.js is vendored in `public/vendor/`.

Environment variables: `PORT` (8787), `DAY_MINUTES` (real minutes per universe game day, default 20), `DATA_DIR`, `CACHE_DIR`, `HOST`, `TRUST_PROXY=1`.

## Documentation

- [`docs/`](docs/README.md) is the full reference:
  - [architecture](docs/architecture.md)
  - [gameplay formulas](docs/gameplay.md)
  - [real-world data](docs/world-data.md)
  - [rendering](docs/rendering.md)
  - [multiplayer](docs/multiplayer.md)
  - [server API](docs/server-api.md)
  - [UI](docs/ui.md)
  - [translations](docs/i18n.md)
  - [promo trailer](docs/promo.md)
  - [development guide](docs/development.md)
- [`CLAUDE.md`](CLAUDE.md) is a compact guide for AI-assisted development (commands, layout, invariants, gotchas).
- [`promo/`](promo/) holds the launch trailers (9:16 and 16:9, recorded from the real game), the covers, the original music and the social copy.

## What's in the game

**Real mountains**
- 33 famous ski areas (Cortina, Val Gardena, Alta Badia, Zermatt, Chamonix, Kitzbühel, St. Anton, Aspen, Whistler, Niseko, the Remarkables…) or **anywhere on Earth** (world map and place search).
- Terrain from AWS Terrain Tiles (≈13 m/pixel), cached by the server.
- **Real layout**: lifts, pistes, mountain huts and village buildings from OpenStreetMap. Cortina loads with all its real lifts, including the new 2026 *Cortina Skyline* gondola. Or start with an empty mountain and only the village.
- Piste difficulty comes from the **real gradient**: the steepest 100 m sets green, blue, red or black, and cliffs are rejected. Lift towers are placed against the real profile, with cable sag. Building a piste through forest costs extra to clear the trees.
- Overlays for slope, elevation and avalanche terrain, plus 100 m contour lines.

**Simulation**
- Up to about 1,000 visible skiers, each standing for *k* real guests. They queue, ride, ski the pistes that suit their level, have lunch in rifugi, need toilets, take lessons, go to après-ski and go home. Some get stranded if a lift top has no easy way down.
- Daily demand from the calendar (Christmas, February holidays, Easter, weekends), weather, powder days, snow quality, ticket price vs. a fair price, rating, fame, hotel beds, parking and marketing.
- **Weather and snow**: deterministic climate per region, Markov storms, cold snaps, warm spells, foehn, rain-on-snow and ice. A snowpack is tracked at each altitude. Pistes melt faster when they are low or face south. Snowmaking needs cold nights and water. Snowcats groom overnight. Slowly warming winters push the snowline up.
- **Avalanche danger** 1–5 builds from snowfall, wind and warming. You can blast at dawn, close exposed pistes, or build avalanche towers.
- Lift breakdowns, mechanics, patrol response times, injuries, lawsuits, safety inspectors, strikes, food poisoning, celebrities, coach tours, power cuts, energy spikes, grants and a recession or boom.
- Economy: tickets, food, rental, ski school, hotels, summer hikers, night skiing, events and TV, against wages, energy, maintenance, snowmaking, grooming, insurance, VAT, loans and research.
- **Competitions**: Alpine World Cup (Downhill, Super-G, GS, Slalom), Freestyle Big Air, World Championships and the **Winter Olympics**, with bids, eligibility (vertical drop, difficulty, snowmaking, a Finish Stadium, beds, rating, venues) and weather risk on race day.
- Research tree (RFID gates, bubble chairs, gondolas, 3S, efficient snow guns, winch snowcats, avalanche towers, snow farming…), season awards (including the Wooden Spoon), and scenario goals.
- You can replace old lifts with new types on the same line. There's also heli-skiing, night skiing, summer hikers and sightseers at panorama terraces.
- **Ski it yourself**: third-person skier on the real terrain, timed runs, and a ghost of your best descent. **Ride** any lift in first person. A **piste map** is generated from the DEM and can be exported as PNG.

**Online universe (`npm start` hosts it)**
- Accounts with scrypt-hashed passwords and token sessions.
- One shared clock. By default one game day is 20 real minutes, and time keeps running while you are offline: when you come back, the days you missed are simulated in fast mode.
- Every client gets the same weather: storms hit neighbouring resorts together.
- Claim a famous resort (empty, or take over the real one with a big loan) or found a new one anywhere at least 6 km from others. You can run up to 3 resorts.
- Regional market share: nearby player resorts compete for your day visitors.
- **Alliances** act as a shared ski pass: allied neighbours bring each other more guests.
- Server-arbitrated competition bids (highest score wins), a leaderboard, a news feed, private messages, and **visiting** other players' resorts in 3D.

## Controls

| | |
|---|---|
| Left-drag / WASD | pan |
| Right-drag / Q E | rotate |
| Wheel | zoom |
| Space, 1–4 | pause, game speed (solo) |
| L | toggle names |
| Esc | cancel tool / close window |
| Piste tool | click waypoints top → bottom; double-click or Enter to finish; Backspace to undo |
| Ski mode | W push, A/D carve, S brake, Space tuck, R retry, Esc exit |

## Project layout

```
server/            Node server (no deps): static files, tile + Overpass + geocode caching proxies, universe API
public/js/
  shared/          calendar + competition schedule + resort catalogue (used by client and server)
  terrain.js       DEM download, stitching, resampling, raycasting, profiles
  biome.js         forest / rock / meadow classification
  world.js         lifts, pistes, buildings, navigation graph, routing
  osm.js           OpenStreetMap → resort layout importer
  weather.js       climate, deterministic weather, forecast, sun position
  agents.js        skier agents
  sim.js           clock, day cycle, snow, demand, economy
  events.js        random events, hazards, competitions, awards, marketing
  render/          three.js scene (terrain shader, sky, particles) and layers
  ui/              HUD, windows, piste map, world map
  skimode.js       ski-it-yourself and lift rides
  net.js           universe client
  promo/director.js scripted trailer scenes (used with ?record)
tools/             warm-cache.mjs · make-music.mjs · record-trailer.mjs
docs/              full documentation
promo/             trailers, covers, music, social copy
```

## Data and credits

- Elevation: [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (Mapzen; SRTM, EU-DEM, USGS and other sources).
- Lifts, pistes, huts and buildings © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors (ODbL), via the Overpass API. Geocoding by Nominatim.
- Coastlines: Natural Earth via `world-atlas`.
- 3D: [three.js](https://threejs.org). Fonts: Barlow / Barlow Condensed (SIL OFL), self-hosted.

Snowline is an independent game. It is not affiliated with any ski resort, lift company or sports federation, and it uses resort names only to identify real places. Athletes and celebrities in the game are fictional.
