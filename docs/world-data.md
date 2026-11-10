# Real-world data

Snowline builds every map from open data at runtime. The server caches everything it downloads under `cache/`, so each area is downloaded only once.

## Elevation (`terrain.js`)

- **Source:** [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/), Terrarium-encoded PNGs (`elevation = R·256 + G + B/256 − 32768` metres). They combine SRTM, EU-DEM, USGS NED, national lidar and other sources.
- **Request path:** the client asks the server's caching proxy for `tiles/{z}/{x}/{y}.png` first, then falls back to `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/...` (CORS-enabled), so solo mode also works on static hosting.
- **Map definition:** a resort has a centre `lat/lon` and a size `w × h` km. `GeoProjection` gives a local tangent plane in metres around the centre (x east, z south).
- **Zoom:** the highest zoom ≤ 13 that needs at most 42 tiles (≈13 m/px at 46°N for z13). The tiles are drawn onto an `OffscreenCanvas`, decoded to `Float32`, then **resampled** bilinearly onto a regular metric grid.
- **Grid cell:** `max(16 m, max(w,h)/900)`; Cortina (19 × 11 km) gets 21 m, about 905 × 524 samples.
- **Smoothing:** one 3×3 weighted pass removes tile-quantization steps. Heights outside −500…9000 m are treated as no-data.
- **Fallback:** if more than 25 % of the tiles fail, `makeSynthetic()` creates procedural mountains so the game still runs.
- **APIs:**
  - `heightAt(x,z)`: bilinear on the grid.
  - `gradientAt`, `slopeDeg`, `southness`.
  - `meshHeightAt` (exactly matches the rendered mesh triangles) and `surfaceAt = max(heightAt, meshHeightAt)`.
  - `raycast` (adaptive ray march plus bisection, used for mouse picking).
  - `profile(pts)`: length, drop, steepest 100 m, maximum uphill run, flat length, maximum side slope, mean height, south exposure.
  - `avalancheExposure(pts)`.

## OpenStreetMap (`osm.js`, `server/proxies.js`)

`GET /api/osm?s&w&n&e` (the bounding box comes from `terrain.bbox`, rounded to 4 decimals) runs two Overpass queries on the server:
1. **Ski data:** `aerialway` ways; `piste:type=downhill` ways and relations (relations are flattened into member ways, up to 400 members and 40,000 points); `tourism=alpine_hut` nodes and ways; restaurant, cafe, bar, fast-food and pub nodes; town, village, hamlet and city places; parking ways (centroids).
2. **Building centres:** `out ids center` for up to 12,000 buildings, used for the village houses.

The server returns compact JSON: `{ lifts:[{id,name,type,tags,pts}], pistes:[{id,name,difficulty,area,tags,pts}], huts, places, parkings, buildings:[[lat,lon]] }`. It is cached forever in `cache/osm/`. Overpass runs one query at a time, retries `overpass-api.de` twice on 429/5xx, then falls back to `overpass.kumi.systems`. The first fetch of an area takes 30–200 s, so run `npm run warm` to pre-download all famous resorts. If the server is unavailable, the client queries Overpass directly with a reduced query.

### Import rules (`importLayout`)

1. **Lifts.** OSM types map to game types:

   | OSM `aerialway` | Game type |
   |---|---|
   | `magic_carpet` | carpet |
   | `t-bar`, `j-bar`, `platter`, `drag_lift`, `rope_tow`, `mixed_lift` | tbar |
   | `cable_car` (occupancy < 50) | 3S |
   | `cable_car` (otherwise) | tramway |
   | `gondola` (name contains "3S") | 3S |
   | `gondola` (otherwise) | gondola |
   | `chair_lift`, 6+ seats or bubble | chair6 |
   | `chair_lift`, 3+ seats or detachable | chair4 |
   | `chair_lift`, otherwise | chair2 |

   The station order is fixed by elevation. Real lifts are accepted even if the game's checks would reject them, unless they're degenerate (horizontal length under 15 m or vertical under 2 m). An `aerialway:capacity` tag between 100 and 6,000 overrides the capacity. Goods, station, zip-line and pylon ways are skipped.
2. **Pistes.** Each way is oriented downhill. Consecutive ways **with the same name** whose ends touch (within 25 m) are chained, so long pistes such as the Olimpia delle Tofane sections or Armentarola become single pistes. Area pistes are skipped. The line is simplified (Douglas–Peucker, 6 m); anything under 80 m or with under 5 m of drop is dropped. OSM difficulty maps to the game's: novice → green, easy → blue, intermediate → red, advanced/expert/freeride → black. Every imported piste gets snowmaking.
3. **Huts.** Alpine huts and restaurants at least 150 m above the main town, and within 300 m of a lift station or piste, become huts or restaurants (cafes become snack bars). They keep their OSM names.
4. **Base stations.** Lift bottoms within 260 m of a car park, or 700 m of a village, are chosen, from the lowest up, at least 600 m apart, and not right at another lift's top unless in a village. If none qualify, the lowest station gets one. **Every base** also gets a first-aid post, toilets and a rental. The first base also gets a ski school and a snowcat garage. `boot()` then sizes staff and the snowcat fleet to the resort and adds garages.
5. **Village.** Building centres become instanced houses, which also clear trees.

Cortina's import gives 31 lifts (including the 2026 *Cortina Skyline* gondola), about 113 pistes after chaining, 18 huts, 11 base areas and about 4,200 houses.

## Resort catalogue (`shared/resorts.js`)

There are 33 famous resorts across Italy (8), Switzerland (4), France (3), Austria (4), Germany, Slovenia, the US (3), Canada (2), Japan (2), Sweden, Spain, New Zealand, Chile and Australia.

Fields: `id, name, country, region, lat, lon, w, h (km), town:[lat,lon], climate:{t1500, snow}, treeline, fame, beds, day, blurb`.

- `t1500`: mean coldest-month temperature at 1500 m. `snow`: relative snowfall (Niseko 2.5, Sierra Nevada 0.5).
- `beds`: existing village lodging (not owned by the player). `day`: peak-day potential day-trippers.

For **custom places**, `defaultClimate(lat)` gives `t1500 = 16 − 0.45·|lat|`, a treeline of 3,500 m below 40°, falling to 2,100 m at 46° and then 70 m per degree, fame 22, 2,500 beds and 1,500 day-trippers.

The universe server seeds every catalogue entry as an unowned "famous" site on start-up.

## Geocoding

`GET /api/geocode?q=` proxies Nominatim (jsonv2, address details, 8 results), limited to 1 request per second and cached in `cache/geocode.json`. It powers place search in the solo picker and when founding a new site.

## World map

`public/data/land-110m.json` is the Natural Earth 110 m land TopoJSON (from `world-atlas`). `ui/worldmap.js` decodes it (delta-encoded arcs) and draws a pannable, zoomable Mercator map with site dots.

## Attribution (keep visible)

- "Elevation: AWS Terrain Tiles (Mapzen, SRTM, EU-DEM and others). Lifts, pistes and buildings: © OpenStreetMap contributors (ODbL)." This appears in the in-game menu, on the piste map and in the trailer end card.
- Fonts: Barlow / Barlow Condensed (SIL OFL), self-hosted in `public/fonts/`.
- The game is independent and not affiliated with any resort or lift company. Resort names identify places only. Athletes, celebrities and the mock players in the promo are fictional.
