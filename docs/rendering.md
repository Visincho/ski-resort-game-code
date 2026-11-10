# Rendering (three.js r187)

## Scene3D (`render/scene.js`)

- **Renderer:** WebGL with antialiasing, ACES filmic tone mapping at exposure 0.98, and pixel ratio up to 2 (1 on low graphics). `preserveDrawingBuffer` is on only in record mode.
- **Camera:** `PerspectiveCamera` (45° FOV; the trailer uses 62° in portrait and 42° in landscape), near 8 m, far 160 km. **MapControls:** left-drag pans, right-drag rotates, wheel zooms towards the cursor; polar limit 1.42 rad, distance 120 m up to 1.6 × the map size.
- **Per-frame camera handling** in `update()`:
  - WASD / arrow keys pan, Q/E rotate.
  - The target is clamped to the map and eased onto the ground height; the camera stays at least 25 m above the terrain.
  - `flyTo()` animates the camera; `lookAt(x, z, distance, {azimuth, polar})` places it.
  - With controls disabled (ski mode or recording), only the particles update.
- **Terrain mesh:** the DEM grid subsampled by `step = ceil(max(nx, nz)/520)` (stored as `terrain.meshStep`). Normals come from DEM gradients. Each vertex carries `aForest` (biome density) and `aNoise` (value noise for patchiness). A dark "skirt" cuts the map edges, and a large ground plane sits below for the horizon.
- **Terrain shader** (custom `ShaderMaterial`):
  - **Base colour:**
    - Meadow (winter browns or summer greens, via `uSummer`) blended with forest by `aForest`.
    - Rock where `1 − n.y` is between about 0.13 and 0.27 (roughly 30–43°). The tint `uRockColor` is pale for the Dolomites and darker elsewhere.
    - Bare high ground above `uTreeline`.
  - **Snow:** `smoothstep(snowline ± 90..160 m + noise)`, removed on slopes steeper than about 38–52°, thinner over forest. The snowline comes from the snowpack model.
  - **Lighting:** Lambert sun plus hemisphere ambient, a small specular "sparkle" on snow, and distance fog (near = far × 0.12).
  - **Overlays** (`uOverlay`): 1 = slope classes (green/blue/red/black/extreme/cliff), 2 = elevation ramp, 3 = avalanche terrain (28–52°, above the snowline).
  - **Contours:** optional 100 m lines with a 500 m major line (`fwidth` anti-aliased).
- **Sky:** a back-faced sphere with a gradient shader: horizon and top colours, a sun disc and glow, and stars at night.
- **`setEnvironment({day, minute, weather, snowline, summer})`** (called every 0.5 s):
  - Sun direction from `sunPosition()`. A low sun gives warm light and an orange horizon (alpenglow).
  - Overcast factor by weather state; fog distance by visibility (3.5 km in fog, up to about 90 km on clear days).
  - Night colours, and precipitation particles (6,000 points around the camera, round sprite; rain falls faster and is bluer).

## Layers (`render/layers.js`)

| Layer | Implementation |
|---|---|
| Trees | `InstancedMesh` (trunk + 2 cones merged with vertex colours). Jittered 56 m grid weighted by forest density, about 30k on Cortina. A spatial-hash clearing test removes trees under pistes (width/2 + 5 m), lift lines (9 m), buildings and houses. Colours tint towards white above the snowline (`updateTreeColors`) and are green in summer. |
| Village | Two `InstancedMesh` (walls, roofs) from OSM building centres, random sizes and colours, roofs blended with snow white. Walls glow warm at night. |
| Pistes | Per piste: a 40 m translucent ribbon (Lambert, double-sided, polygon offset) plus a constant-pixel **Line2** centre line (3 px colour over a 5.5 px white underlay). Colour by difficulty; orange while under construction; opacity 0.28 open, 0.1 closed, 0.6 selected. Lit pistes glow after dark (`updateNightLights`). |
| Lifts | Station boxes with roofs (size by type), **LineSegments2** cables (two strands with offset), towers as one global `InstancedMesh` (pole + cross-arm, height from the plan). Carriers are three `InstancedMesh` pools (chairs, gondolas, tram cabins), animated along the cable at a visual speed independent of game speed; trams shuttle. |
| Buildings | Procedural meshes per type (boxes and roofs; reservoir disc; park kickers; half-pipe; stepped grandstand; dome arena; tube sliding track; ramp ski jump; helipad…) plus a constant-size emoji **sprite icon**. Minor service icons hide beyond 4.5 km. |
| Skiers | One `InstancedMesh` (capsule) with jacket colours from `instanceColor`. Scale `clamp(camDist/420, 1, 22)` keeps them visible from afar; positions come from `Crowd.computePositions()` (S-turns across the piste, queues behind the bottom station, on the cable when riding). |
| Previews | Lift: fat line along the planned cable, towers and stations (green if valid, red if not). Piste: coloured ribbon + fat centre line + waypoint dots. Building: translucent box + ring, with a radius ring for towers or patrol coverage. |
| Selection | Yellow rings around the selected building or lift stations; status refresh on change. |

**Labels:** HTML elements in `#labels`, projected every frame by `HUD.updateLabels()`. Lift names show within 9 km and piste names within 3.8 km, with simple overlap avoidance. Toggle with **L**.

## Performance knobs

- **Low graphics:** 450 skiers (instead of 1,000), 2,500 village houses (instead of 9,000), pixel ratio 1.
- The terrain mesh is about 120k vertices on Cortina; trees are the largest triangle count (about 30k × 30 triangles). `layers._layoutTrees()` runs on every `rebuildAll()`, i.e. after construction or demolition.
- The simulation costs about 0.7 ms per 1.5 game minutes with about 900 agents.
- Fat lines need `resolution` updates; `updateLineResolution()` runs on window resize.
- Draw objects at `terrain.surfaceAt()` so they don't sink into the coarse mesh.

## 2D views

- **Piste map** (`ui/pistemap.js`): hillshade from the DEM (north-west light, snow above the snowline, rock, forest), piste and lift lines, rotated lift names, piste names, key building icons, title, legend, north arrow, 2 km scale bar and attribution. Clicking flies the camera there, and it can be downloaded as a PNG.
- **World map** (`ui/worldmap.js`): see world-data.md.
