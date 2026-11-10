# User interface

All the UI is HTML/CSS layered over the WebGL canvas. Styles live in `public/css/style.css` (design tokens in `:root`); fonts are Barlow and Barlow Condensed, self-hosted (`public/css/fonts.css`).

## Screens (`main.js`)

| Screen | Contents |
|---|---|
| Title | Logo; the local player (name, player ID, Change name), or on first run a "Who is playing?" card (player name, or import a save file from another PC); Continue (latest save); New solo game; Online universe; Load / import; language chips (English / Italiano); data credit |
| Solo picker | Grid of the 33 resorts (flag, region, fame stars) plus "Anywhere on Earth". The detail panel shows blurb, fame, beds, treeline, snowfall, the start type (Real resort today / Empty mountain / Sandbox) and difficulty (Relaxed / Normal / Tough). The custom place picker has geocode search, a clickable world map and a name field. |
| Load | Saved games (load / export / delete, with "from …" / "last played by …" for games from other players) and save-file import. Import notices explain the outcome (imported, updated with Undo, kept your newer copy with Replace / Keep both, already up to date). |
| Universe | Login / create account, then a dashboard: world map (gold = mine, red = owned, white = free), my resorts (Play / Abandon), the selected site (claim with an empty or real start, or visit if owned), free famous resorts, and "found a new resort" (click the map or search) |
| Loading | Resort name, progress bar, current step, and a Skip button for slow OSM downloads |

## In-game HUD (`ui/hud.js`)

- **Top bar:**
  - ☰ menu, resort name and mode, date and time.
  - Speed buttons (disabled in the universe), plus *To winter* in the solo off-season.
  - Weather (icon, base/top temperatures, wind, snow at 2000 m, avalanche level; click to open the Weather window).
  - Guests today, star rating (rep/20), cash (red when negative).
- **Left toolbar:** Select · Lifts (panel of lift cards, locked ones show 🔒) · Piste (options panel: snowmaking, lighting, finish/cancel, difficulty legend) · Buildings (category chips + cards) · Demolish · Overlays (none / slope / elevation / avalanche + contours) · Names toggle · Back to the village · Ski it yourself.
- **Inspector (right):**
  - Lift: editable name, type, status badge, connectivity warnings (no way down from the top, no base), length, vertical, capacity, ride time, live queue and wait, riders today/yesterday, top-station temperature and wind, condition bar. Actions: open/close, Service, Ride, **Replace with another type**, Demolish.
  - Piste: editable name, difficulty, status, warnings (no lift reaches the start, dead end), length, drop, steepest gradient, exposure, snow depth (natural/made), surface and quality, temperature, runs, injuries, avalanche exposure. Toggles for snowmaking (shows the cost if not installed), nightly grooming and lighting. Actions: open/close, Ski it, Demolish.
  - Building: status, description, seats/occupancy, beds and price, parking, guests and revenue today/season, upkeep, "not connected" warning, open/close, demolish.
- **Toasts** (bottom-left): the last 6 messages, clickable when they point at a place or an entity (flies the camera there).
- **Advisor** (🧓, an original old ski instructor character): a speech bubble with the day's main complaint, praise, or the welcome tips.
- **Hint pill** (top centre) for the active tool, **plan tooltip** next to the cursor (stats, cost, errors), and **confirmation card** (cost, build days, rush job, snowmaking/lighting for pistes, optional name).
- **Dock** (bottom-right): Finances · Staff · Weather · Events · Research · Marketing · Resort · Piste map · Messages · Universe (online only).

## Windows (`ui/windows.js`)

There's one modal at a time; Esc or the backdrop closes it. Live windows re-render about every 2 s unless an input has focus.

| Window | Contents |
|---|---|
| Finances | Today's ledger by category, yesterday, season totals, asset value, loan, 60-day cash/profit chart. Price sliders: day pass with the fair price shown, food %, rental, lesson, hotel %. Bank: borrow €2/10/25M, repay. |
| Staff | Each team's count, suggestion, wage and ±1/±5 buttons; snowcats (buy/sell, grooming km vs piste km, garage capacity); lift operators (automatic); wage-level slider; morale bar and strike warning |
| Weather & snow | Today plus a 3- or 5-day forecast (base and top temperatures, wind, snowfall, regime tags); snowpack by altitude; snowline and season outlook; avalanche danger panel; policies (dawn avalanche control, snowmaking target depth, early/late opening, summer operations, night fast-forward) |
| Events | Explanation, hosted counters, upcoming events at your resort, calendar (status, prize, fame, bid fee, eligibility with the reasons for failing, your score), bid buttons (normal / lobbying / heavy lobbying), rival bids in the universe |
| Research | Cards with state (done / in progress with a bar / locked / available), cost, days, prerequisites |
| Marketing | Rating, fame, hotel occupancy, campaign cards (launch, or running until a date) |
| Resort | Summary (pistes by difficulty, lifts, capacity, altitude range, beds, rating, fame, yesterday's happiness, total guests), goals with progress, top complaints, season history table |
| Piste map | Generated 2D trail map, click to fly there, Download PNG |
| Messages | Message log (click to focus) |
| Universe | Tabs: Leaderboard · News · Alliances (found/join/leave) · Messages (inbox, compose) · Neighbours (distance, owner, rating, Visit, your market share) |
| Season report | Shown at season rollover: skier-days, profit, open days, happiness, awards, events hosted |
| Menu | Resume, Save (to the server in the universe), Export save file, Skip to next ski season, language, low graphics, How to play, Quit, data credits |

## Building tools (`build.js`)

- **Picking:** `pick()` uses the ground hit point from `terrain.raycast()`. It checks buildings first (radius + tolerance), then lifts (distance to the line < 14 m + tolerance), then pistes (half-width + tolerance). The tolerance is `camera distance × 0.012`.
- **Lift tool:** click the bottom station, then the top (it snaps within 70 m of existing stations, piste ends and bases). The preview updates live with towers and errors; a confirmation card follows.
- **Piste tool:** click waypoints from top to bottom. Snapping to a lift bottom, base or piste end auto-finishes. Double-click or Enter finishes, Backspace or right-click undoes, Esc cancels. The difficulty colour updates live from the terrain.
- **Building tool:** a preview ring (plus a coverage radius for towers and patrol), then confirm.
- **Demolish:** hover highlights, and a click asks for confirmation (with the refund amount).

## Keyboard shortcuts

| Key | Action |
|---|---|
| WASD / arrows | pan |
| Q / E | rotate |
| Space | pause / resume (solo) |
| 1–4 | game speed (solo) |
| L | toggle names |
| H | back to the village |
| M | piste map |
| Delete | demolish the selection |
| Esc | cancel tool / close card / close window / deselect |
| Enter | finish piste / confirm |
| Backspace | undo the last piste point |
| Ski mode | W push, A/D carve, S brake, Space tuck, R retry, Esc exit |

## Ski it yourself (`skimode.js`)

- Starts at the top of the selected (or nearest) piste, or in free-ride mode.
- **Physics:**
  - Gravity along the DEM gradient.
  - Carving damps sideways velocity (grip 5, or 2.5 when braking).
  - Snow friction 0.04·g·cos θ and air drag (halved when tucking).
  - A wipe-out on slopes over 50° at speed.
- **Timed runs:** start on the first push, disqualified if you leave the piste by more than 2.5 × its width, finish within 40 m of the end.
- The **ghost** of your best valid run is stored in `localStorage` per resort and piste.
- **Lift ride:** a first-person camera along the cable at 2.5× speed, looking ahead with a gentle pan.

## Responsive behaviour

- Below 1100 px wide, secondary top-bar text and dock labels hide, and grids collapse to one column.
- Below 700 px, the top bar is compact, toasts move above the dock, and the dock scrolls sideways.
- Reduced motion turns off animations.
