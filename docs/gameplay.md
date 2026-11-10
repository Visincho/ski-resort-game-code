# Gameplay and simulation reference

Every number below comes from the code: `catalog.js` for static data, `world.js` for build rules, `agents.js` for skiers, `sim.js` for the day cycle, demand and economy, `weather.js` for climate and `events.js` for events and competitions. If you change a value in code, update this file.

## Time

- **Game time:** `s.day` (integer days since 1970-01-01, UTC) plus `s.minute`.
- **Daily schedule:** lifts open at 08:30 (`openMinute` 510) and close at 16:30 (`closeMinute` 990). Guests arrive from about 07:35, with a peak around 09:00 and some late arrivals. Leftover guests are flushed at 17:55, and the day is settled at 18:30 (`endDay`).
- **Ski season** (`shared/calendar.js`): **29 Nov – 19 Apr** in the north and **14 Jun – 5 Oct** in the south. With *Open early/late* on, the resort may also open in Nov, Apr and May (north) or May, Jun and Oct (south) if there is snow. A season year runs Jul → Jun in the north and Jan → Dec in the south.
- **Speeds:**
  - Solo, while operating: `SPEEDS = [0, 2, 5, 12, 30]` game minutes per real second.
  - Solo, closed: `IDLE_SPEEDS = [0, 30, 120, 480, 1440]`.
  - Empty nights (with *Fast-forward through the night* on): at least 240 min/s.
  - Universe: fixed, by default 1 game day = 20 real minutes.

## Terrain rules

Terrain heights are real (see [world-data.md](world-data.md)).
- **Slope** is `atan(|∇h|)`, computed on the grid (cell ≈ 16–22 m).
- **South-facing factor** (`southness`) runs from −1 (north) to +1 (south). It speeds up melting and decides the inspector's exposure label.
- **Avalanche exposure** (`avalancheExposure`) is the share of uphill samples (60/110/160 m rings) whose slope is between 28° and 52°.
- **Forest** (`biome.js`): below the resort treeline ±130 m of noise, on slopes under about 38°, more than 0.5–1.3 km from the village centre. Bare rock starts above about 36–48°.

## Lifts

`world.planLift(type, p1, p2)` puts the bottom station at the lower end automatically.

| Type | Capacity (pph) | Speed (m/s) | Max length | Max grade | Base cost | €/m | Upkeep €/day | kW | Wind limit (km/h) | Build days (+/km) | Research |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Magic Carpet | 900 | 0.8 | 180 m | 25 % | 60k | 450 | 60 | 15 | – | 6 | |
| T-Bar | 1,100 | 3 | 1.6 km | 60 % | 350k | 700 | 260 | 90 | 85 | 18 (+10) | |
| Fixed-grip double chair | 1,200 | 2.3 | 2 km | 90 % | 1.4M | 1,100 | 600 | 160 | 60 | 35 (+15) | |
| Detachable quad | 2,400 | 5 | 2.8 km | 90 % | 4.2M | 1,700 | 1,300 | 320 | 65 | 50 (+18) | |
| 6-seat bubble chair | 3,200 | 6 | 3.2 km | 95 % | 7.5M | 2,100 | 1,900 | 420 | 70 | 60 (+20) | bubble |
| 10-person gondola | 3,000 | 6 | 6.5 km | 110 % | 9M | 3,000 | 2,400 | 480 | 70 | 75 (+22) | gondola |
| Aerial tramway | 900 | 11 | 4.5 km | 350 % | 13M | 3,600 | 2,600 | 600 | 90 | 100 (+25) | |
| 3S cable car | 4,000 | 7.5 | 8 km | 200 % | 26M | 5,200 | 4,200 | 900 | 105 | 140 (+30) | tri |

**Validation:**
- Both stations must be inside the map, with a minimum length (25 m for surface lifts, 120 m otherwise), the type's maximum length, at least 4 m of vertical, and an average grade within the type's maximum.
- A station may sit on a slope of at most 33° (40° for tramway and 3S).
- **Surface lifts** must keep climbing (no descents totalling more than 12 m), and the terrain grade along the track must stay under 1.25× the type's maximum.

**Towers (aerial lifts):**
- Towers start at the type's span (110–1,200 m).
- They are raised, or added at the worst point, until the cable (with about 1.2 % sag) keeps its clearance above the terrain: 7 m for chairs, 12 m for gondolas, 25 m for trams.
- The maximum tower height is 45 m (140 m for trams, 110 m for 3S); anything taller is an error.
- Cost = base + €/m × slope length + Σ(20k + 60·h²) per tower.

**Building:**
- Construction takes `days` (+/km); a rush job costs +60 % and takes half the time.
- Building during the ski season costs +15 % and, unless rushed, takes 1.4× as long.
- Demolishing refunds 15 % of the value (60 % if the lift is still under construction).
- A lift can be **replaced** with another type on the same line. The trade-in is 25 % of the old value, and the lift is closed while the new one is built.

**Operation:**
- **Wind:** a lift closes for the day if the wind at its top station is above its limit. Wind increases with altitude (×0.5 to ×1.6).
- **Condition** drops by 0.05 × (lifts/3 ÷ mechanics) per operating day. Below 90 % it is restored in the off-season overhaul (paid); the *Service* button restores 100 % for 6 % of the base cost and 4 hours of closure.
- **Breakdowns** are checked every 15 min with probability `0.0016 · (1 + (100−condition)/18) · mf`. Here `mf = clamp(lifts/3 ÷ (mechanics+0.3), 0.35, 3.5)` (×1.4 if morale is below 40). Repairs take 30–150 min × √mf, with −0.4 reputation.
- **Dispatch rate** = capacity × (1.08 with RFID) × (0.75 + condition/400) persons/h.
- Enclosed lifts (gondola, tramway, 3S) also carry guests **down** on the way home, including the evening descents after 16:30.

## Pistes

`world.planPiste(points)` reverses the line so it runs downhill.

| Difficulty | Colour | Steepest sustained 100 m |
|---|---|---|
| Beginner | green | ≤ 14 % |
| Easy | blue | ≤ 27 % |
| Intermediate | red | ≤ 42 % |
| Expert | black | ≤ 75 % (100 % = 45° is the maximum) |

- A side slope above 50 % makes the piste one level harder.
- **Errors:** shorter than 60 m, less than 8 m of drop, an uphill section of more than 18 m, steeper than 100 % (a cliff), or leaving the map.
- **Warning:** more than 250 m of flat ground (snowboarders will have to push).
- **Cost** = €90/m × length × (1 + min(1.5, steepest)) + €160/m of forest cleared + €520/m for snowmaking + €210/m for lighting (−30 % with the LED research). Width is 40 m.
- **Build time** = 10 days + 8/km + forest clearing.

**Network:**
- **Snapping:** piste ends attach to a node within 70 m; nodes within 42 m of a piste's middle split it into segments.
- **Walking links:** between nodes within 130 m (and within 380 m of a base station), if the climb is at most 35 m (70 m for bases).
- **Restaurants and huts** attach to the nearest node within 260 m and also serve as toilets (snack bars don't).

**Snow on a piste** (`p.snow`: `depth`, `made`, `quality` 0–100, `surface`, `fresh`, `ice`):
- **Morning:**
  - Snowfall at the piste's mean height ×0.85 is added. 8 cm or more of new snow makes the surface `powder`.
  - Rain removes 0.7 cm per mm and makes it `slush` + `ice`.
- **During the day:** each run removes quality: `70/max(300, length) × k × (40/width)` per agent-run (k = guests per agent).
- **Night:**
  - **Melt:** `(max(0, Tmean+2)·0.35 + Tmax·0.22) × (1 + 0.6·south·clear·sunSeason) × sunSeason`, ×0.85 on pistes. Then 0.3 %/day of settling.
  - **Warm day** (Tmax above 4 °C): the surface turns `slush`; a cold night after that freezes it to ice.
- **Status:**
  - Below 15 cm the piste is closed (`nosnow`); below 25 cm the surface is `thin`.
  - Otherwise the surface is `icy` (ice ≥ 0.5) or `groomed` / `packed` / `choppy` by quality (≥80 / ≥52 / lower), with powder and slush kept as they are.
- **Snowmaking** (overnight, only in season or within 21 days of it):
  - It runs on pistes with snowmaking whose depth is under the target (default 60 cm, 30–150) when the night temperature is under −2.5 °C (−1 °C with *Efficient Snow Guns*).
  - Output is `clamp((threshold − T)·2.6, 2, 22)` cm per night.
  - **Water:** 0.45 m³ per m³ of snow, 22,000 m³ a night plus 60,000 per reservoir.
  - **Cost:** €3.40/m³ of water (−30 % with the research, × energy modifiers).
  - Race pistes come first.
- **Grooming** (overnight):
  - Each snowcat grooms 9 km a night, ×0.7 if morale is below 35. You can run up to garages × 5 + 1 snowcats.
  - Lowest quality goes first and race pistes have priority.
  - A groomed piste reaches quality 94, or 74 on black pistes without *Winch Snowcats* (ice is only halved there).
  - Cost: €130/km. Ungroomed packed snow loses 4 quality a night.
- **Snow farming** (research): 3 days before opening, every snowmaking piste is topped up to a 40 cm base.

## Skiers (`agents.js`)

- **Visible agents:** `visitors / k` with `k = max(1, visitors / maxAgents)`. `maxAgents` is 1,000 (450 on low graphics).
- **Skill mix** 22/38/28/12 % (beginner/intermediate/advanced/expert). Average piste speed is 5 / 8.5 / 11.5 / 14 m/s, ×0.6 on pistes harder than their level and adjusted for snow quality and fog.
- **Arrival:**
  - At a base station, weighted by nearby car parks.
  - 55 % of beginners and 12 % of others go to the rental first, and half of the remaining beginners go to ski school.
  - Each picks a leave time 3–8.5 h after arrival (beginners leave an hour earlier).
- **Needs:**
  - Hunger fills over 3.2 h; lunch is between 11:30 and 15:00 when hunger is above 0.72.
  - Bladder fills over 2.6 h; above 0.85 they look for a toilet.
  - Energy lasts 5 h (6.5 h for advanced/expert), minus extra per run.
  - Tired, past their leave time or at closing, they head home (35 % stop at an après-ski bar first if there is one).
- **Routing:** reverse Dijkstra next-hop tables per (skill, goal). Edge costs are lift wait + ride time, piste time with a penalty for pistes too hard, and walking at 1.1 m/s.
  - **Free roaming** only takes edges from which home is still reachable.
  - **Going home**, a guest accepts pistes one level harder than they would choose, and enclosed lifts down.
  - If home stays unreachable for a while, the guest is **stranded** (big unhappiness, counted, and the advisor warns).
- **Choosing the next run:** pistes are weighted by `DIFF_PREF[skill][difficulty]` × snow quality × novelty (powder ×1.6 for advanced and experts). Lifts are weighted by the best piste at the top × `exp(−wait/900 s)`.
- **Happiness** starts at 68–78.
  - **Queues:** −0.25/min above 60 people, −0.5/min above 400 (×0.7 with the Resort App).
  - **Each run:**

    | Effect | Change |
    |---|---|
    | Piste suits their level | +1.6 |
    | One level too hard | −4 for beginners, −1.5 for others |
    | Two levels too hard | −8 |
    | Too easy for experts | small malus |
    | Ice / slush / thin / choppy | malus |
    | Powder | +4 for advanced/expert, −1.5 for beginners |
    | Groomed | +1.4 |
    | New piste for them | +1.2 |
    | Crowding above 900 skiers/km/h | −1.5 |
    | Sunny | +0.8 |
    | Snowstorm or fog | −1.2 |

  - **Services:** food (+4 × charm, minus price over 110 %), après-ski (+5), lessons (+7), rental (+2), toilets.
  - **Missing services:** −2 to −6. Cold chairlifts below −14 °C cost −1.5 without *Heated Seats*.
- **Injuries:** per person-run probability `0.0001 × (1 + 2·levels too hard) × (2 if icy) × (2.2 if thin) × (1.4 if crowded) × (1.5 in fog) × (1.25 for experts)`.
  - **Patrol response:** 50 min with no patrol base. Otherwise `(7 + 5·km to the nearest base) × clamp(1/(patrollers ÷ (piste km/6)), 0.6, 4)`, capped at 12 min with a helipad.
  - **Reputation:** −0.01 per injury, −0.05 more if the response is over 30 min. Serious injuries (10 %) cost −0.1, or −0.3 when the response is slow.
  - **Lawsuits:** above 35 min there's a 30 % chance of a €150–400k settlement.
- **Complaints and praise** are counted per day. The advisor quotes the top complaint once it exceeds `max(20, 1.5 % of visitors)`, and warns about queues of more than 600 people.

## Demand (`Game.computeDemand`)

**Attractiveness:**

```
A = clamp(0.08 + 0.33·(1−e^(−km/35)) + 0.12·(1−e^(−capacity/14000)) + 0.10·variety + 0.27·rep/100
          + 0.10·snowQuality + min(0.06, 0.03·terrain parks), 0.02, 1.15)
```

`variety` is the share of the 4 difficulties with at least 1.2 km open.

- **Calendar factor `sf` (north):**

  | Period | Factor |
  |---|---|
  | 24 Dec – 6 Jan | 1.65 |
  | 7–8 Dec | 1.35 |
  | November and until 14 Dec | 0.6 |
  | 1 Feb – 9 Mar | 1.28 |
  | Rest of March | 0.95 |
  | April | 0.6 |
  | Easter (−3 / +1 days, computed) | ≥ 1.25 |

  South: July 1.5, June 0.75, August 1.1, September 0.9.
- **Weekday factor** (Sun … Sat): lodging guests 1.2/0.8/0.78/0.8/0.82/0.95/1.3; day-trippers 1.6/0.45/0.4/0.45/0.5/0.75/1.9.
- **Weather factor:** sunny 1.15, partly 1.05, cloudy 0.9, fog 0.75, snow 0.82, heavy snow 0.62, storm 0.32, rain 0.42. A powder day (fresh snow and sun) gives ×1.3 for day-trippers. Below −12 °C at the village it's ×0.88, below −18 °C ×0.7.
- **Price:** `fair = 20 + 70·A` (shown in Finances); `pf = clamp(1 − 1.3·(price − fair)/fair, 0.12, 1.35)`.
- **Fame:** `fameF = 0.35 + 0.9·fame/100`. `mods` multiplies active marketing and economic modifiers.

**Visitors:**

```
occupancy      = clamp(0.38 · sf · 1.15A · fameF · √pf · mods, 0.03, 0.97)
lodgingSkiers  = (village beds + own beds) · occupancy · 0.82·clamp(weather·cold, 0.3, 1.15) · max(0.6, share)
dayTrippers    = def.day · weekday · weather · powder · cold · A · pf · fameF · mods · share     (capped by parking)
visitors       = (lodgingSkiers + dayTrippers) · (1 + event boosts)
```

- **Parking:** 1,200 per base station and 900 per car park.
- `share` is 1 in solo; in the universe it is the regional market share (see [multiplayer.md](multiplayer.md)).
- **Sightseers:** each Panorama Terrace at the top of an open gondola, tram, 3S or bubble chair brings `160 × clamp((top−1500)/1000, 0.2, 2) × (0.35 + fame/100) × weather` pedestrians. They pay 45 % of a ticket plus €12 of food.

## Economy

**Income:**

| Source | Rule |
|---|---|
| Tickets | visitors × day-pass price, paid up front each morning |
| Food & drink | per meal: hut €28, restaurant €22, snack bar €9, après-ski €30, × food price % |
| Rental, ski school | rental price per renter; school price per pupil, if there are enough instructors (8 pupils each) |
| Hotels | beds × occupancy × nightly price (★★★ €140, ★★★★★ €520, chalets €260) × lodging price %. Out of season: 35 % occupancy in summer, 8 % otherwise, at 60 % of the price |
| Summer season | hikers on gondolas and chairlifts if *summer operations* is on: 110 per lift × (0.4 + fame) × weather × €22 |
| Night skiing | Wed/Fri/Sat on lit open pistes: min(140/km, 25 % of visitors) × 45 % of a ticket (×1.25 with LED) |
| Heli-skiing | helipad on sunny or partly cloudy days: 6 × €480 × (2 on powder days) × (0.5 + fame/100) |
| Events | spectator tickets and food on race days; 65 % of the prize on success |
| Grants, awards, refunds | random grants, season awards, demolition refunds |

**Costs (per day):**

| Cost | Rule |
|---|---|
| Wages | patrol €210, mechanic €240, instructor €190, host €150, snowcat driver €230, lift operators 4 × €170 per running lift, all × wage level (80–150 %). Out of season the permanent staff get 30 %. Hiring costs 3 days' wages |
| Energy | kW × 8 h × €0.24/kWh per running lift (×0.75 with *Solar*, × energy spikes) |
| Maintenance | lift upkeep ×3.2 in season (×0.5 off-season), building upkeep (×0.5 off-season unless lodging), snowcats €180, pistes €70/km in season (€8 off-season) |
| Insurance | 0.008 % of asset value per day (about 2.9 %/yr) |
| VAT & fees | 10 % of gross operating income |
| Supplies | 55 % of food revenue, 45 % of hotel revenue, 25 % of rental revenue |
| Snowmaking, grooming | see Pistes |
| Interest | 4.5 %/yr on the loan |
| Fines | lawsuits, failed inspections, avalanche negligence |

**Bank:** the maximum loan is `max(€10M, 0.6 × asset value + fame × €200k)`. You can spend down to −€2M before purchases are refused. The bank warns when cash falls below −€5M.

**Reference result:** real Cortina on normal difficulty, one season simulated in aggregate gives about 1.29 M skier-days, about €112 M revenue and about €78 M costs, so roughly +€29 M a year after the off-season.

## Reputation and fame

- **Reputation (rating 0–100, ★ = rep/20)** moves each day towards the average guest happiness, at a rate of `clamp(0.02 + visitors/200000, 0.02, 0.09)`. Incidents and awards add or subtract directly.
- **Fame** moves towards `0.5·rep + 22·(1−e^(−km/60)) + 4·WC + 10·Worlds + 20·Olympics + 0.35·base fame + 2·luxury hotels` at 0.4 % a day, plus boosts from events and campaigns.

## Staff and morale

- **Suggested staffing** (Staff window): patrol = km/6 + 1, mechanics = lifts/3, instructors about 6 % of visitors / 8, hosts = seats/40, snowcats = 0.8 × km / 9.
- **Morale target** = `55 + (wage level − 1) × 130`, approached at 8 % a day.
  - Below 30, there's a 6 % daily strike chance (all lifts closed, −1.5 reputation).
  - Below 35, grooming slows down.
  - Too few hosts per seat risks food poisoning (−3 reputation).

## Weather (`weather.js`)

- **Climate per resort:**
  - `t1500`: mean January (July in the south) temperature at 1500 m. Annual amplitude is 15.5 °C, plus +0.045 °C per year after 2026 (warming).
  - `snow`: relative snowfall.
  - Lapse rate: 0.58 °C per 100 m.
- **Weather seasons:** each gets a character: 12 % *poor* (+1.6 °C, 60 % precipitation), 12 % *epic* (−1 °C, 145 %), otherwise normal. Days are generated sequentially with a seeded PRNG.
  - Temperature anomaly: AR(1) with ρ 0.72 and σ 2.6.
  - "Storminess": AR(1) with ρ 0.55 and σ 0.95. Precipitation happens when it exceeds a threshold lowered by snowiness.
  - **Regimes:** cold snap (2.2 %/day, −9 °C, 3–7 days), foehn (1.8 %, +6 °C, +35 km/h, 1–3 days), warm spell (1.5 %, +7 °C, 3–8 days).
- **States:**
  - Snowstorm: more than 22 mm and wind above 55 km/h.
  - Heavy snow: more than 14 mm. Snow: more than 0.5 mm.
  - Rain: any precipitation while 1500 m is above 3.5 °C.
  - Otherwise fog, overcast, partly cloudy or sunny, by cloud cover.
- **Snowfall at height h:**
  - Only if T(h) < 1.5 °C: `precip × clamp(1 − 0.06T, 0.9, 1.8) × clamp(0.7 + (h−1200)/2200, 0.55, 1.6)`, with a rain/snow mix between 0.3 and 1.5 °C.
  - The snowline drawn on the terrain is the lowest 250 m band with more than 8 cm of snowpack.
- **Forecast:** 3 days, or 5 days at double accuracy with a Weather Station. The error grows with lead time and is deterministic per issue day.
- **Sun position:** computed from latitude, day of year and time, with a 45 min offset for central European time.

## Avalanches

- **Danger level:** from new snow at 2000 m over the last 3 days (weights 1, 0.7, 0.4), ×1.35 when windy (wind above 45 km/h at 2400 m), ×1.3 when warming on fresh snow.

  | Effective load | < 10 | < 25 | < 50 | < 85 | ≥ 85 |
  |---|---|---|---|---|---|
  | Level | 1 | 2 | 3 | 4 | 5 |

- **Dawn control:** at level 3 or above, if the policy is on and you have a patrol base with at least 3 patrollers. It costs €6k + €2.5k × exposed pistes × (level − 2) and reduces risk ×0.2.
- **Per exposed piste** (`avyExp` > 0.08):
  - Daily risk is `(level − 2) × 0.012 × min(1, 3·avyExp)`, ×0.2 if controlled and ×0.2 under avalanche towers (1.5 km radius).
  - At level 4 or above the patrol closes pistes with `avyExp` above 0.25.
  - An avalanche closes the piste for 2–4 days. If it was open and uncontrolled, 0–2 skiers are caught (−5 reputation, €120k fine each).

## Random events (in season, live days only)

| Event | Chance/day | Effect |
|---|---|---|
| Staff strike | 6 % if morale < 30 | all lifts closed |
| Celebrity visit (fictional names) | 0.8 % | +8 % visitors for 3 days, +0.8 fame |
| School coaches (Mon–Thu) | 3 % | +12 % visitors |
| Power cut | 0.4 % | all lifts stop 40–120 min, announced in the morning |
| Safety inspection | 1 % | good: +2 reputation; bad: €100k+ fine, −2 reputation |
| Food poisoning | 1.5 % if hosts < seats/80 | −3 reputation |
| Lost child | 0.6 % | +1 or −2 reputation, depending on the patrol |
| Wildlife | 1.2 % | flavour message |
| Energy spike | 0.3 % | energy ×1.7 for 30 days |
| Recession / boom | 0.15 % | demand ×0.88 / ×1.08 for 60 days |
| Grant | 0.4 % | €200k – €1M |
| TV documentary | 0.4 % if rep > 72 | +2 fame |

The game also gives weather warnings for tomorrow (storm, heavy snow with cm, foehn, cold snap, rain with the snowline), announces powder days, and at season start (15 Nov) gives the outlook for an epic or poor winter.

## Competitions (`events.js` + `shared/calendar.js`)

**Schedule** (generated per season year):
- **11 northern World Cup events:** SG 6 Dec, GS 13 Dec, DH 20 Dec, SL 22 Dec, SL 11 Jan, DH 18 Jan, SG 25 Jan, Big Air 30 Jan, GS 1 Feb, DH 22 Feb, SL 8 Mar. Bids close 45 days before.
- **World Championships:** February of odd years; bids close 365 days before.
- **Winter Olympics:** February of years ≡ 2 (mod 4), i.e. 2030, 2034…; bids close 730 days before.
- **Southern Hemisphere Cup:** GS 16 Aug, SL 6 Sep.

**Requirements** (`eligibility()`; venues under construction count if they're ready by the event):

| Event | Rating | Beds | Piste | Buildings | Other |
|---|---|---|---|---|---|
| World Cup | ≥ 55 | ≥ 1,500 | discipline vertical (DH 750 m, SG 400 m, GS 300 m, SL 140 m), red or harder, snowmaking, Finish Stadium within 600 m of the finish | – | |
| Big Air | ≥ 55 | ≥ 1,500 | – | Terrain Park, Finish Stadium | |
| World Championships | ≥ 68 | ≥ 4,000 | speed piste | 2 stadiums | 1 World Cup hosted |
| Olympics | ≥ 78 | ≥ 9,000 | speed piste | 2 stadiums, Ice Arena, Sliding Centre, Ski Jump, Nordic Centre, Terrain Park, Superpipe | 2 World Cups hosted |

**Bid score:**

```
30·rep/100 + 20·fame/100 + 15·vertical fit + 10·snow reliability (top altitude) + 10·beds + history (≤20) + 2.5·lobbying
```

- **Bid fee:** WC €150k, Big Air €90k, Worlds €1.5M, Olympics €8M, ×(1 + 1.5·lobbying level), with lobbying level 0–2.
- **Solo:** 2–4 deterministic AI rivals from the famous-resort list (base scores 48–70). **Universe:** the server compares players' bids at the deadline.

**Hosting:**
- The race piste is reserved from 2 days before.
- Each race day can be postponed by storm, heavy snow, rain, fog (60 %), wind above 75 km/h at the top, or poor snow (under 35 cm or quality under 55).
- **Spectators:** `9000 × scale × (0.5 + fame/100)`, with scale 1 / 0.7 / 2.2 / 5 for WC / freestyle / Worlds / Olympics. They pay a ticket (€30, Olympics €60) plus food.
- **Success:** 65 % of the prize (WC €1.5M, Big Air €900k, Worlds €9M, Olympics €60M), fame +6 / +18 / +45, reputation +2 / +4 / +8.
- **If every day fails:** 20 % insurance payout and −2 fame.

## Season awards (at season rollover, if more than 5,000 visitors)

| Award | Condition | Prize |
|---|---|---|
| Golden Gondola | happiness ≥ 80 | €500k, +2 reputation |
| Safest Resort | < 1.1 injuries per 10k visitors (with > 30k visitors) | €200k |
| Snow King | ≥ 125 open days | €250k |
| Crowd Puller | > 1 M visitors | €400k |
| Golden Ski Pass | > €20 M profit | +1 reputation, +1 fame |
| Green Mountain | Solar researched and < 600k m³ of snowmaking | €150k |
| Wooden Spoon | happiness < 45 | −3 reputation |

## Research

| Id | Cost | Days | Effect |
|---|---|---|---|
| rfid | €600k | 20 | +8 % lift capacity |
| bubble | €1.5M | 35 | unlocks the 6-seat bubble chair |
| gondola | €2M | 40 | unlocks the 10-person gondola |
| cannons | €1.8M | 40 | snowmaking from −1 °C, 30 % cheaper |
| winch | €1.2M | 30 | black pistes groom to 94 and lose all ice |
| app | €800k | 25 | queue unhappiness ×0.7 |
| gazex | €2.5M | 45 | unlocks avalanche towers |
| solar | €2.2M | 40 | energy ×0.75, eligible for the eco award |
| tri (needs gondola) | €6M | 80 | unlocks the 3S cable car |
| snowfarm (needs cannons) | €2M | 50 | 40 cm base on snowmaking pistes before opening |
| led | €900k | 20 | lighting −30 % cost, night skiers ×1.25 |
| heated (needs bubble) | €700k | 15 | no cold-chairlift unhappiness |

One project runs at a time; the cost is paid up front and progress is one day per game day.

## Marketing

| Campaign | Cost | Days | Effect |
|---|---|---|---|
| Social media | €60k | 14 | demand ×1.06 |
| Influencers | €35k | 10 | ×1.04, +0.4 fame |
| Early-bird deals | €120k | 21 | ×1.09 |
| International ski fairs | €220k | 60 | ×1.05, +1.5 fame |
| TV & billboards | €450k | 30 | ×1.12, +2 fame |

## Buildings

| Type | Cost | Upkeep/day | Build days | Notes |
|---|---|---|---|---|
| Base Station | €1.8M | 900 | 30 | entry point, 1,200 parking |
| Car Park | €600k | 150 | 15 | +900 parking |
| Ski Rental | €450k | 250 | 15 | 120 seats, rental price |
| Ski School | €700k | 350 | 18 | 80 seats, lesson price, needs instructors |
| Mountain Hut | €1.4M | 500 | 40 | 90 seats, €28, charm 1.2 |
| Self-Service Restaurant | €2.6M | 1,100 | 45 | 280 seats, €22 |
| Snack Bar | €350k | 180 | 12 | 30 seats, €9 |
| Après-Ski Bar | €900k | 400 | 20 | 160 seats, €30, charm 1.3 |
| Toilets | €120k | 60 | 6 | 20 places |
| Ski Patrol & First Aid | €500k | 250 | 15 | patrol response, avalanche control |
| Snowcat Garage | €800k | 300 | 20 | 5 snowcats |
| Snowmaking Reservoir | €2.2M | 400 | 45 | +60,000 m³ water/night |
| Weather Station | €250k | 80 | 8 | 5-day forecast, 2× accuracy |
| Avalanche Towers | €900k | 120 | 20 | ×0.2 risk within 1.5 km (research) |
| Hotel ★★★ | €9M | 2,200 | 120 | 120 beds, €140 |
| Luxury Hotel ★★★★★ | €28M | 6,500 | 180 | 160 beds, €520, +2 fame target |
| Mountain Chalets | €3.5M | 700 | 60 | 40 beds, €260, high occupancy |
| Panorama Terrace | €1.2M | 200 | 25 | sightseers at a lift top |
| Terrain Park | €1.5M | 700 | 25 | +0.03 attractiveness, freestyle events |
| Superpipe | €2.5M | 900 | 30 | +0.03 attractiveness, Olympics |
| Finish Stadium | €3.5M | 500 | 45 | race requirement |
| Olympic Ice Arena | €45M | 8,000 | 300 | Olympics |
| Sliding Centre | €80M | 12,000 | 400 | Olympics |
| Ski Jumping Hill | €30M | 3,000 | 250 | slope ≥ 18°, Olympics |
| Nordic Centre | €12M | 1,500 | 150 | slope ≤ 9°, Olympics |
| Helipad | €1.5M | 900 | 20 | rescue ≤ 12 min, heli-skiing |

**Placement:**
- Maximum slope: 26° for most buildings, 16° for large ones (size above 30), 26° for parks, 9° for the Nordic Centre; ski jumps need at least 18°.
- No overlap with other buildings or lift stations.

## Scenarios (solo)

| Start | Goals |
|---|---|
| Real resort | rating 88 · guests in one season ≥ village beds × 85 · host 2 World Cup races |
| Empty mountain | rating 70 · 250,000 guests in a season · 40 km of pistes · host a World Cup race |
| Sandbox | no goals, €250M |

Completing every goal shows "Scenario complete!", and you can keep playing.
