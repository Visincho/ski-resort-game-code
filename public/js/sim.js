// Core simulation: clock, day cycle, snow, demand, economy, staff, research, reputation.

import { Emitter, clamp, mulberry32, hash32, gauss, money, int, dist } from './util.js';
import { LIFTS, BUILDINGS, STAFF, SNOWCAT, LIFT_OPERATOR_WAGE, RESEARCH, PISTE_COST, DIFF } from './catalog.js';
import { Climate, WEATHER_INFO } from './weather.js';
import { ymdFromDay, dayFromYMD, seasonYear, seasonWindow, isSkiSeason, universeDay } from './shared/calendar.js';
import { Crowd } from './agents.js';
import { Events } from './events.js';
import { t } from './i18n.js';

export const SPEEDS = [0, 2, 5, 12, 30];
// off-season and closed days: nothing to watch, so time runs faster, but 1× stays slow enough to build (48 s per day)
const IDLE_SPEEDS = [0, 30, 120, 480, 1440];
const ENERGY_PRICE = 0.24; // EUR / kWh
const SNOW_M3_COST = 3.4;

function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return dayFromYMD(y, month, day);
}

export function newState({ def, mode = 'solo', seed, startDay, cash = 40e6, scenario = null, siteId = null }) {
  return {
    v: 1, mode, siteId, resortId: def.id, name: def.name, country: def.country || 'IT',
    def: { id: def.id, name: def.name, country: def.country, region: def.region, lat: def.lat, lon: def.lon, w: def.w, h: def.h, town: def.town, climate: def.climate, treeline: def.treeline, fame: def.fame, beds: def.beds, day: def.day },
    seed: seed ?? Math.floor(Math.random() * 2 ** 31),
    day: startDay, minute: 420, cash, loan: 0, rep: 50, fame: def.fame ?? 25,
    prices: { ticket: 58, food: 1.0, rental: 36, school: 62, lodging: 1.0 },
    staff: { patrol: 2, mechanic: 1, instructor: 4, host: 3 }, snowcats: 1, wageLevel: 1.0, morale: 70,
    policy: { avyControl: true, snowTarget: 60, summerOps: true, autoNight: true, earlyOpen: false },
    research: { done: [], current: null, progress: 0 },
    marketing: [], mods: [],
    avy: { level: 1, recent: [0, 0, 0], controlled: false },
    snowpack: null,
    season: null, seasons: [], history: [],
    comps: {}, hosted: { worldcup: 0, worldchamps: 0, olympics: 0, freestyle: 0 }, scheduled: [],
    scenario, goalsDone: [], won: false,
    log: [], stats: { totalVisitors: 0, daysPlayed: 0 },
    world: { lifts: [], pistes: [], buildings: [] },
  };
}

export class Game extends Emitter {
  constructor({ terrain, biome, world, state, universe = null }) {
    super();
    this.terrain = terrain; this.biome = biome; this.world = world; this.s = state;
    this.universe = universe; // {info, client}
    this.def = state.def;
    this.speed = 1;
    this.paused = false;
    this.openMinute = 510; this.closeMinute = 990;
    const townXZ = this.def.town ? terrain.proj.toXZ(this.def.town[0], this.def.town[1]) : [0, 0];
    this.townXZ = townXZ;
    this.refElev = terrain.heightAt(townXZ[0], townXZ[1]);
    const seed = universe ? universe.info.seed : state.seed;
    this.climate = new Climate({ lat: this.def.lat, lon: this.def.lon, t1500: this.def.climate?.t1500 ?? -4, snow: this.def.climate?.snow ?? 1, seed, refElev: this.refElev });
    this.crowd = new Crowd(this);
    this.world.onRebuild = () => this.crowd.remap();
    this.events = new Events(this);
    this.rng = mulberry32(hash32(state.seed, state.day, 'run'));
    this.ledger = this._emptyLedger();
    this.dayStats = this._emptyDayStats();
    this.arrivals = [];
    this.weatherNow = this.climate.day(state.day);
    this.operating = false;
    if (!state.snowpack) this._initSnowpack();
    if (!state.season) this._newSeason();
    this.world.ensureGraph();
    this._applyStatuses();
  }

  get minute() { return this.s.minute; }
  get day() { return this.s.day; }
  get hemi() { return this.def.lat < 0 ? 'S' : 'N'; }
  hasResearch(id) { return this.s.research.done.includes(id); }
  isBuilt(e) { return this.s.day >= e.buildUntil; }
  isOperational(b) { return this.isBuilt(b) && b.open !== false; }

  _emptyLedger() { return { income: {}, expense: {} }; }
  _emptyDayStats() { return { rides: 0, happySum: 0, happyN: 0, stranded: 0, injuries: 0, visitors: 0, spectators: 0, sightseers: 0, snowmadeM3: 0, groomedKm: 0 }; }

  earn(cat, v) { if (!v) return; this.s.cash += v; this.ledger.income[cat] = (this.ledger.income[cat] || 0) + v; }
  spend(cat, v) { if (!v) return; this.s.cash -= v; this.ledger.expense[cat] = (this.ledger.expense[cat] || 0) + v; }

  notify(kind, text, focus = null, icon = null) {
    const msg = { kind, text, focus, icon, day: this.s.day, minute: this.s.minute, id: Math.random().toString(36).slice(2) };
    this.s.log.unshift(msg);
    if (this.s.log.length > 80) this.s.log.length = 80;
    this.emit('message', msg);
    return msg;
  }

  // ---------- snowpack at reference elevations (drives the visible snowline) ----------
  _initSnowpack() {
    const levels = [];
    for (let h = 500; h <= 4800; h += 250) levels.push({ h, d: 0 });
    this.s.snowpack = levels;
    // spin-up: simulate the previous 120 days so the starting landscape looks right
    for (let d = this.s.day - 120; d < this.s.day; d++) this._snowpackDay(this.climate.day(d), d);
    const sp = this.s.snowpack;
    for (const p of this.world.pistes) if (!p.snow.depth) p.snow.depth = this.snowAt(p.meanH);
  }
  _snowpackDay(w, day) {
    for (const L of this.s.snowpack) {
      L.d += this.climate.snowfallAt(w, L.h);
      L.d -= this.melt(w, L.h, 0, day) + this.climate.rainAt(w, L.h) * 0.8;
      L.d = Math.max(0, L.d * 0.996);
      if (L.h > 3200) L.d = Math.max(L.d, 30); // glaciers
    }
  }
  snowAt(h) {
    const sp = this.s.snowpack;
    if (h <= sp[0].h) return sp[0].d;
    for (let i = 1; i < sp.length; i++) if (h <= sp[i].h) { const u = (h - sp[i - 1].h) / (sp[i].h - sp[i - 1].h); return sp[i - 1].d * (1 - u) + sp[i].d * u; }
    return sp[sp.length - 1].d;
  }
  get snowline() {
    for (const L of this.s.snowpack) if (L.d > 8) return L.h - 120;
    return 5000;
  }
  melt(w, h, south, day) {
    const tmax = this.climate.tempAt(w, h, 'max');
    const tmean = this.climate.tempAt(w, h);
    if (tmax <= 0) return 0;
    const ymd = ymdFromDay(day);
    const sunSeason = this.hemi === 'N' ? [0.5, 0.65, 0.85, 1.1, 1.3, 1.4, 1.4, 1.3, 1.1, 0.8, 0.6, 0.5][ymd.m - 1] : [1.4, 1.3, 1.1, 0.8, 0.6, 0.5, 0.5, 0.65, 0.85, 1.1, 1.3, 1.4][ymd.m - 1];
    const solar = 1 + 0.6 * south * w.clear * sunSeason;
    return (Math.max(0, tmean + 2) * 0.35 + tmax * 0.22) * solar * sunSeason;
  }

  // ---------- season bookkeeping ----------
  _newSeason() {
    const y = seasonYear(this.s.day, this.hemi);
    this.s.season = { year: y, visitors: 0, revenue: 0, expenses: 0, injuries: 0, peak: 0, days: 0, openDays: 0, happySum: 0, happyN: 0, snowmade: 0, events: [], awards: [] };
  }

  // ---------- statuses ----------
  _applyStatuses() {
    const day = this.s.day, w = this.weatherNow;
    const now = day * 1440 + this.s.minute;
    const inSeason = isSkiSeason(day, this.hemi) || this.s.policy.earlyOpen && this._earlyOK();
    let changed = false;
    const set = (e, st) => { if (e.status !== st) { e.status = st; changed = true; } };
    for (const l of this.world.lifts) {
      const T = LIFTS[l.type];
      if (!this.isBuilt(l)) set(l, 'construction');
      else if (!l.open) set(l, 'closed');
      else if (this.events.strikeToday) set(l, 'strike');
      else if (l.brokenUntil > now && (l.brokenFrom || 0) <= now) set(l, 'broken');
      else if (!inSeason) set(l, 'season');
      else if (this.climate.windAt(w, l.yb) > T.wind) set(l, 'wind');
      else if (this.s.minute < this.openMinute || this.s.minute > this.closeMinute) set(l, 'night');
      else set(l, 'open');
    }
    for (const p of this.world.pistes) {
      if (!this.isBuilt(p)) set(p, 'construction');
      else if (!p.open) set(p, 'closed');
      else if (!inSeason) set(p, 'season');
      else if (p.raceUntil && p.raceUntil >= day) set(p, 'race');
      else if (p.avalancheUntil && p.avalancheUntil >= day) set(p, 'avalanche');
      else if (p.snow.depth < 15) set(p, 'nosnow');
      else set(p, 'open');
    }
    if (changed) this.world.invalidateStatus();
  }
  _earlyOK() {
    const { m } = ymdFromDay(this.s.day);
    return this.hemi === 'N' ? (m === 11 || m === 4 || m === 5) : (m === 5 || m === 6 || m === 10);
  }

  liftStatusText(l) {
    return { open: 'Open', closed: 'Closed by you', construction: t('Under construction ({d} days)', { d: Math.max(0, l.buildUntil - this.s.day) }), broken: 'Broken down', season: 'Closed for the season', wind: 'Closed: wind', night: 'Closed (night)', strike: 'Staff strike' }[l.status] || l.status;
  }
  pisteStatusText(p) {
    return { open: 'Open', closed: 'Closed by you', construction: t('Under construction ({d} days)', { d: Math.max(0, p.buildUntil - this.s.day) }), season: 'Closed for the season', nosnow: 'Closed: not enough snow', avalanche: 'Closed: avalanche', race: 'Reserved for race' }[p.status] || p.status;
  }

  // ---------- time ----------
  setSpeed(n) { this.speed = n; this.paused = n === 0; this.emit('speed', n); }

  rate() {
    if (this.universe) return 1440 / (this.universe.info.dayRealMinutes * 60);
    if (this.paused) return 0;
    const base = SPEEDS[this.speed] || 2;
    if (!this.operating) return IDLE_SPEEDS[this.speed] || 30;
    const m = this.s.minute;
    if (this.s.policy.autoNight && (m < 440 || m > this.closeMinute + 70) && this.crowd.agents.length === 0) return Math.max(base, 240);
    return base;
  }

  update(realDt) {
    let gm;
    if (this.universe) {
      const target = universeDay(this.universe.info, Date.now() + (this.universe.offset || 0));
      gm = (target - (this.s.day + this.s.minute / 1440)) * 1440;
      if (gm > 1440 * 1.5) { this.catchUp(Math.floor(target), (target % 1) * 1440); return; }
      if (gm <= 0) return;
      gm = Math.min(gm, 60); // after a short absence, catch up over a few frames
    } else {
      gm = realDt * this.rate();
    }
    gm = Math.min(gm, 1440);
    let guard = 0;
    while (gm > 1e-6 && guard++ < 4000) {
      const active = this.operating && this.s.minute > 430 && this.s.minute < this.closeMinute + 80;
      const step = Math.min(gm, active ? 0.5 : 20);
      this.advance(step);
      gm -= step;
    }
  }

  advance(dm) {
    const s = this.s;
    const prev = s.minute;
    s.minute += dm;
    const crossed = m => prev < m && s.minute >= m;
    if (crossed(this.openMinute) || crossed(this.closeMinute)) this._applyStatuses();
    if (this.operating && s.minute > 440 && s.minute < this.closeMinute + 90) {
      // arrivals
      while (this.arrivals.length && this.arrivals[this.arrivals.length - 1].t <= s.minute) {
        const ar = this.arrivals.pop();
        if (ar.base && this.isOperational(ar.base.ref)) this.crowd.spawn(ar.base, s.minute, this.rng, ar);
      }
      this.crowd.update(dm * 60, s.minute, this.rng);
      if (Math.floor(prev / 15) !== Math.floor(s.minute / 15)) { this.crowd.refreshWaits(); this._checkBreakdowns(); this._applyStatuses(); }
      if (crossed(this.closeMinute + 85)) this._flushAgents();
    }
    if (crossed(1110)) this.endDay();
    if (s.minute >= 1440) {
      s.minute -= 1440;
      s.day += 1;
      this.startDay();
    }
  }

  _flushAgents() {
    for (const a of this.crowd.agents) { a.happy -= 10; this.crowd.depart(a); }
    if (this.crowd.agents.length > 3) this.crowd.complain('stranded', this.crowd.agents.length * 0.3);
    this.crowd.reset();
  }

  // catch up many days at once (universe mode after being away, or fast-forward)
  catchUp(targetDay, targetMinute = 420) {
    const from = this.s.day;
    if (targetDay <= from) return;
    this._flushAgents();
    const n = Math.min(targetDay - from, 2000);
    const rev0 = this.s.cash;
    for (let i = 1; i < n; i++) {
      this.s.day += 1; this.s.minute = 420;
      this.startDay(true);
      this.endDay(true);
    }
    // the last day is played live from targetMinute (and closed headless if the evening already passed)
    this.s.day += 1; this.s.minute = targetMinute;
    this.startDay();
    if (targetMinute >= 1110) this.endDay(true);
    this.notify('info', t('While you were away: {n} days passed. Cash change: {c}.', { n, c: money(this.s.cash - rev0) }), null, '⏩');
    this.emit('catchup', n);
  }

  // fast-forward to the next opening day (solo off-season)
  skipToSeason() {
    if (this.universe) return;
    let d = this.s.day;
    const target = (() => { for (let k = 1; k < 400; k++) if (isSkiSeason(d + k, this.hemi)) return d + k; return d + 1; })();
    this.catchUp(target);
  }

  // after loading a save mid-day: restore operating state and the rest of today's guests
  resumeDay() {
    this.weatherNow = this.climate.day(this.s.day);
    this._applyStatuses();
    this.world.ensureGraph();
    const inSeason = isSkiSeason(this.s.day, this.hemi) || (this.s.policy.earlyOpen && this._earlyOK());
    const hasBase = this.world.buildings.some(b => b.type === 'base' && this.isOperational(b));
    this.operating = inSeason && hasBase && this.world.lifts.some(l => l.status === 'open' || l.status === 'night') && this.world.pistes.some(p => p.status === 'open');
    const m = this.s.minute;
    if (this.operating && m < 840) {
      const v = Math.round(this.computeDemand(this.weatherNow, this.s.day) * clamp((840 - m) / 380, 0, 1));
      this.dayStats.visitors = v;
      this._scheduleArrivals(v, true); // today's tickets were already paid at midnight
      for (const a of this.arrivals) a.t = Math.max(a.t, m + 1);
      this.arrivals.sort((a, b) => b.t - a.t);
    }
  }

  // ---------- day cycle ----------
  startDay(fast = false) {
    const s = this.s;
    const day = s.day;
    const ymd = ymdFromDay(day);
    this.ledger = this._emptyLedger();
    this.dayStats = this._emptyDayStats();
    this.crowd.newDay();
    const w = this.weatherNow = this.climate.day(day);
    // new season?
    if (seasonYear(day, this.hemi) !== s.season.year) this.endSeason();
    // construction completion
    for (const e of [...this.world.lifts, ...this.world.pistes, ...this.world.buildings]) {
      if (e.buildUntil === day && e.built !== e.buildUntil) {
        const nm = e.kind === 'building' ? t(BUILDINGS[e.type].name) : e.name;
        if (!fast) this.notify('good', t('Construction complete: {n}', { n: nm }), e.id, '🏗️');
        this.world.invalidateTopo();
      }
    }
    // snow: natural fall/rain on pistes + reference snowpack
    this._snowpackDay(w, day);
    const fresh2000 = this.climate.snowfallAt(w, 2000);
    this.freshPowder = false;
    for (const p of this.world.pistes) {
      const sn = p.snow;
      const fall = this.climate.snowfallAt(w, p.meanH) * 0.85;
      const rain = this.climate.rainAt(w, p.meanH);
      sn.depth += fall;
      if (fall >= 8) { sn.surface = 'powder'; sn.quality = Math.max(sn.quality, 78); sn.fresh = fall; sn.ice = 0; this.freshPowder = true; }
      else sn.fresh = 0;
      if (rain > 1) { sn.depth -= rain * 0.7; sn.quality = Math.min(sn.quality, 45); sn.surface = 'slush'; sn.ice = 1; }
      sn.depth = Math.max(0, sn.depth);
      p.traffic = 0;
      p.stats.runsToday = 0;
      if (sn.surface === 'none' && sn.depth > 0) sn.surface = 'packed';
      this._labelSurface(p);
    }
    // snow farming: stored snow is spread on the snowmaking pistes when the season opens
    if (this.hasResearch('snowfarm') && day === seasonWindow(seasonYear(day, this.hemi), this.hemi).open - 3) {
      for (const p of this.world.pistes) if (p.snowmaking && this.isBuilt(p) && p.snow.depth < 40) { p.snow.made += 40 - p.snow.depth; p.snow.depth = 40; p.snow.quality = Math.max(p.snow.quality, 70); }
      if (!fast) this.notify('good', t('Snow farming: last winter\'s stored snow now covers your snowmaking pistes with a 40 cm base.'), null, '❄️');
    }
    // avalanche danger
    const A = s.avy;
    A.recent = [fresh2000, A.recent[0], A.recent[1]];
    const load = A.recent[0] + A.recent[1] * 0.7 + A.recent[2] * 0.4;
    const windy = this.climate.windAt(w, 2400) > 45 ? 1.35 : 1;
    const warm = this.climate.tempAt(w, 2200, 'max') > 3 && load > 10 ? 1.3 : 1;
    const eff = load * windy * warm;
    A.level = eff < 10 ? 1 : eff < 25 ? 2 : eff < 50 ? 3 : eff < 85 ? 4 : 5;
    A.controlled = false;
    // season / operating
    const inSeason = isSkiSeason(day, this.hemi) || (s.policy.earlyOpen && this._earlyOK());
    this.events.onDayStart(fast);
    this._applyStatuses();
    if (A.level >= 3 && s.policy.avyControl) this._avalancheControl(fast);
    this.world.ensureGraph();
    const openPistes = this.world.pistes.filter(p => p.status === 'open');
    const openLifts = this.world.lifts.filter(l => l.status === 'open' || l.status === 'night');
    const hasBase = this.world.buildings.some(b => b.type === 'base' && this.isOperational(b));
    const wasOperating = this.operating;
    this.operating = inSeason && hasBase && openLifts.length > 0 && openPistes.length > 0;
    if (inSeason && !fast) {
      if (!hasBase && this.world.lifts.length) this.notify('warn', t('Guests have nowhere to buy tickets: build a Base Station.'), null, '🎫');
      else if (hasBase && !openPistes.length && this.world.pistes.length) this.notify('warn', t('The resort is closed: not enough snow on any piste.'), null, '🟫');
    }
    if (this.operating && !wasOperating && !fast) this.notify('good', t('The lifts are turning: the resort is open today!'), null, '🚡');
    // demand + arrivals
    let visitors = 0;
    if (this.operating) visitors = this.computeDemand(w, day);
    this.dayStats.visitors = visitors;
    this.arrivals = [];
    if (this.operating && !fast) this._scheduleArrivals(visitors);
    else if (this.operating && fast) this._aggregateDay(visitors);
    if (!fast) {
      this.crowd.refreshWaits();
      this.emit('dayStart', { day, weather: w, visitors });
    }
  }

  _labelSurface(p) {
    const sn = p.snow;
    if (sn.depth < 25) sn.surface = sn.depth < 15 ? 'none' : 'thin';
    else if (sn.ice > 0.5) sn.surface = 'icy';
    else if (sn.surface === 'slush' || sn.surface === 'powder') { /* keep */ }
    else if (sn.quality >= 80) sn.surface = 'groomed';
    else if (sn.quality >= 52) sn.surface = 'packed';
    else sn.surface = 'choppy';
  }

  computeDemand(w, day) {
    const s = this.s, def = this.def;
    const open = this.world.pistes.filter(p => p.status === 'open');
    const km = open.reduce((a, p) => a + p.length, 0) / 1000;
    const cap = this.world.lifts.filter(l => l.status === 'open' || l.status === 'night').reduce((a, l) => a + l.capacity, 0);
    const byDiff = [0, 0, 0, 0];
    let qSum = 0, lSum = 0;
    for (const p of open) { byDiff[p.difficulty] += p.length / 1000; qSum += p.snow.quality * p.length; lSum += p.length; }
    const variety = byDiff.filter(v => v >= 1.2).length / 4;
    const snowQ = lSum ? qSum / lSum / 100 : 0;
    const size = 1 - Math.exp(-km / 35);
    const liftS = 1 - Math.exp(-cap / 14000);
    const parks = this.world.buildings.filter(b => (b.type === 'terrainpark' || b.type === 'halfpipe') && this.isOperational(b)).length;
    const A = clamp(0.08 + 0.33 * size + 0.12 * liftS + 0.1 * variety + 0.27 * (s.rep / 100) + 0.1 * snowQ + Math.min(0.06, parks * 0.03), 0.02, 1.15);
    this.attractiveness = A;
    // calendar
    const ymd = ymdFromDay(day);
    let sf = 1;
    const mmdd = ymd.m * 100 + ymd.d;
    if (this.hemi === 'N') {
      if (mmdd >= 1224 || mmdd <= 106) sf = 1.65;
      else if (mmdd === 1207 || mmdd === 1208) sf = 1.35;
      else if (ymd.m === 11 || mmdd < 1215) sf = 0.6;
      else if (mmdd >= 201 && mmdd <= 309) sf = 1.28;
      else if (ymd.m === 3) sf = 0.95;
      else if (ymd.m === 4) sf = 0.6;
      const e = easter(ymd.y);
      if (day >= e - 3 && day <= e + 1) sf = Math.max(sf, 1.25);
    } else {
      if (ymd.m === 7) sf = 1.5; else if (ymd.m === 6) sf = 0.75; else if (ymd.m === 8) sf = 1.1; else if (ymd.m === 9) sf = 0.9; else sf = 0.6;
    }
    const weekday = [1.2, 0.8, 0.78, 0.8, 0.82, 0.95, 1.3][ymd.dow];
    const dayTripWeek = [1.6, 0.45, 0.4, 0.45, 0.5, 0.75, 1.9][ymd.dow];
    const wm = { sunny: 1.15, partly: 1.05, cloudy: 0.9, fog: 0.75, snow: 0.82, heavysnow: 0.62, blizzard: 0.32, rain: 0.42 }[w.state] || 1;
    const powder = this.freshPowder && (w.state === 'sunny' || w.state === 'partly') ? 1.3 : 1;
    const tBase = this.climate.tempAt(w, this.refElev);
    const cold = tBase < -18 ? 0.7 : tBase < -12 ? 0.88 : 1;
    const fair = 20 + 70 * A;
    const pf = clamp(1 - 1.3 * (s.prices.ticket - fair) / fair, 0.12, 1.35);
    const fameF = 0.35 + (s.fame / 100) * 0.9;
    const mods = this.demandMods();
    const share = this.universe ? this.universe.share ?? 1 : 1;
    const beds = (def.beds || 2000) + this.ownBeds();
    const occ = clamp(0.38 * sf * (A * 1.15) * fameF * Math.sqrt(pf) * mods, 0.03, 0.97);
    this.occupancy = occ;
    const skiShare = 0.82 * clamp(wm * cold, 0.3, 1.15);
    const lodgingSkiers = beds * occ * skiShare * Math.max(0.6, share);
    let dayTrippers = (def.day || 1000) * dayTripWeek * wm * powder * cold * A * pf * fameF * mods * share;
    const parking = this.world.buildings.filter(b => this.isOperational(b) && BUILDINGS[b.type].parking).reduce((a, b) => a + BUILDINGS[b.type].parking, 0);
    if (dayTrippers > parking) { dayTrippers = parking; this._parkingFull = true; } else this._parkingFull = false;
    let v = Math.round(lodgingSkiers + dayTrippers);
    v = Math.round(v * (1 + (this.events.visitorBoost || 0)));
    return Math.max(0, v);
  }

  demandMods() {
    let m = 1;
    for (const x of this.s.mods) if (x.until >= this.s.day && x.demand) m *= x.demand;
    for (const c of this.s.marketing) if (c.until >= this.s.day) m *= c.demand;
    return m;
  }
  ownBeds() {
    return this.world.buildings.filter(b => this.isOperational(b) && BUILDINGS[b.type].beds).reduce((a, b) => a + BUILDINGS[b.type].beds, 0);
  }

  _scheduleArrivals(visitors, paid = false) {
    const maxAgents = this.maxAgents || 900;
    const k = Math.max(1, visitors / maxAgents);
    this.crowd.reset();
    this.crowd.k = k;
    const n = Math.round(visitors / k);
    const bases = this.world.buildings.filter(b => b.type === 'base' && this.isOperational(b) && b.node);
    if (!bases.length) return;
    const weights = bases.map(b => 1 + this.world.buildings.filter(c => c.type === 'parking' && dist(c.x, c.z, b.x, b.z) < 500).length * 0.7);
    const wsum = weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < n; i++) {
      let r = this.rng() * wsum, bi = 0;
      while (r > weights[bi] && bi < bases.length - 1) { r -= weights[bi]; bi++; }
      const t0 = clamp(470 + Math.abs(gauss(this.rng)) * 75 + (this.rng() < 0.15 ? 120 : 0), 455, 840);
      this.arrivals.push({ t: t0, base: bases[bi].node });
    }
    this.arrivals.sort((a, b) => b.t - a.t);
    if (paid) return;
    // ticket revenue up front
    this.earn('tickets', visitors * this.s.prices.ticket);
    this._sightseers();
  }

  _sightseers() {
    const w = this.weatherNow;
    let n = 0;
    for (const b of this.world.buildings) {
      if (b.type !== 'viewpoint' || !this.isOperational(b)) continue;
      const lift = this.world.lifts.find(l => l.status !== 'construction' && dist(l.b[0], l.b[1], b.x, b.z) < 300 && ['gondola', 'cablecar', 'tram3s', 'chair6'].includes(l.type));
      if (!lift || lift.status === 'wind' || lift.status === 'broken') continue;
      const elevBonus = clamp((lift.yb - 1500) / 1000, 0.2, 2);
      n += 160 * elevBonus * (0.35 + this.s.fame / 100) * (w.state === 'sunny' ? 1.4 : w.state === 'partly' ? 1 : 0.35);
    }
    n = Math.round(n);
    this.dayStats.sightseers = n;
    this.earn('tickets', n * this.s.prices.ticket * 0.45);
    this.earn('food', n * 12 * this.s.prices.food);
  }

  // headless approximation used for catch-up days
  _aggregateDay(visitors) {
    const s = this.s;
    this.crowd.k = 1;
    this.earn('tickets', visitors * s.prices.ticket);
    this._sightseers();
    const cap = this.world.lifts.filter(l => l.status === 'open' || l.status === 'night').reduce((a, l) => a + l.capacity * (0.75 + l.condition / 400), 0);
    const ridesWanted = visitors * 8.5;
    const ridesCap = cap * 7.5 * 0.62;
    const q = ridesCap > 0 ? clamp(ridesCap / Math.max(1, ridesWanted), 0, 1.5) : 0;
    const open = this.world.pistes.filter(p => p.status === 'open');
    let qSum = 0, lSum = 0;
    for (const p of open) { qSum += p.snow.quality * p.length; lSum += p.length; }
    const snowQ = lSum ? qSum / lSum : 50;
    const seats = this.world.buildings.filter(b => this.isOperational(b) && BUILDINGS[b.type].service === 'food').reduce((a, b) => a + BUILDINGS[b.type].seats, 0);
    const foodRatio = clamp(seats * 5 / Math.max(1, visitors * 0.75), 0, 1);
    const toilets = this.world.buildings.some(b => b.type === 'toilet' && this.isOperational(b)) ? 1 : 0;
    const wm = { sunny: 6, partly: 3, cloudy: 0, fog: -4, snow: -1, heavysnow: -3, blizzard: -8, rain: -9 }[this.weatherNow.state] || 0;
    const fair = 20 + 70 * (this.attractiveness || 0.5);
    let happy = 57 + (q >= 1 ? 6 : -(1 - q) * 45) + (snowQ - 60) / 4 + wm + (foodRatio - 0.6) * 15 + (toilets ? 0 : -6) - Math.max(0, s.prices.ticket - fair) / fair * 25;
    happy = clamp(happy, 5, 98);
    this.dayStats.happySum = happy * visitors; this.dayStats.happyN = visitors;
    this.dayStats.rides = Math.min(ridesWanted, ridesCap);
    const eaters = visitors * 0.75 * foodRatio;
    this.earn('food', eaters * 24 * s.prices.food);
    const renters = visitors * 0.2;
    if (this.world.buildings.some(b => b.type === 'rental' && this.isOperational(b))) this.earn('rental', renters * s.prices.rental);
    if (this.world.buildings.some(b => b.type === 'school' && this.isOperational(b))) this.earn('school', Math.min(visitors * 0.08, s.staff.instructor * 8) * s.prices.school);
    // wear pistes
    for (const p of open) p.snow.quality = Math.max(15, p.snow.quality - visitors * 8.5 / Math.max(1, open.length) * 70 / Math.max(300, p.length) * 0.5);
    // injuries (statistical)
    const inj = Math.round(visitors * 8.5 * 0.00011 * (snowQ < 45 ? 1.6 : 1));
    this.dayStats.injuries += inj; s.season.injuries += inj;
    s.rep -= inj * 0.01;
  }

  _avalancheControl(fast) {
    const s = this.s;
    const hq = this.world.buildings.some(b => b.type === 'patrol' && this.isOperational(b));
    if (!hq || s.staff.patrol < 3) return;
    const exposed = this.world.pistes.filter(p => p.avyExp > 0.12 && this.isBuilt(p));
    if (!exposed.length) return;
    const cost = 6000 + exposed.length * 2500 * (s.avy.level - 2);
    this.spend('safety', cost);
    s.avy.controlled = true;
    if (!fast && s.avy.level >= 4) this.notify('info', t('Avalanche danger {l}/5: patrol ran control blasting at dawn ({c}).', { l: s.avy.level, c: money(cost) }), null, '💥');
  }

  _checkBreakdowns() {
    const s = this.s;
    const needed = Math.max(1, this.world.lifts.length / 3);
    const mf = clamp(needed / (s.staff.mechanic + 0.3), 0.35, 3.5) * (s.morale < 40 ? 1.4 : 1);
    const now = s.day * 1440 + s.minute;
    const recovered = this.world.lifts.filter(l => l.status === 'broken' && l.brokenUntil <= now);
    if (recovered.length) {
      this._applyStatuses();
      if (recovered.length > 2) this.notify('good', t('Power is back: all lifts are running again.'), null, '⚡');
      else for (const l of recovered) this.notify('good', t('{n} is running again.', { n: l.name }), l.id, '🔧');
    }
    for (const l of this.world.lifts) {
      if (l.status !== 'open') continue;
      const p = 0.0016 * (1 + (100 - l.condition) / 18) * mf;
      if (this.rng() < p) {
        const dur = Math.round((30 + this.rng() * 120) * Math.sqrt(mf));
        l.brokenUntil = now + dur; l.brokenFrom = now;
        l.condition = Math.max(0, l.condition - 3);
        this._applyStatuses();
        const stuck = l.riders?.length || 0;
        this.s.rep -= 0.4;
        this.notify('bad', t('{n} has broken down! Repair estimate: {d} min.', { n: l.name, d: dur }), l.id, '⚠️');
      }
    }
  }

  injury(a, p, e) {
    const s = this.s;
    this.dayStats.injuries++;
    s.season.injuries++;
    p.stats.injuriesSeason++;
    const posXZ = a.pos ? [a.pos[0], a.pos[2]] : p.pts[0];
    const patrols = this.world.buildings.filter(b => b.type === 'patrol' && this.isOperational(b));
    let resp;
    if (!patrols.length || s.staff.patrol === 0) resp = 50;
    else {
      const d = Math.min(...patrols.map(b => dist(b.x, b.z, posXZ[0], posXZ[1]))) / 1000;
      const km = this.world.pistes.reduce((x, q) => x + q.length, 0) / 1000;
      const ratio = s.staff.patrol / Math.max(1, km / 6);
      resp = (7 + d * 5) * clamp(1 / ratio, 0.6, 4);
    }
    if (this.world.buildings.some(b => b.type === 'helipad' && this.isOperational(b))) resp = Math.min(resp, 12);
    resp = Math.round(resp);
    const serious = this.rng() < 0.1;
    s.rep -= 0.01 + (resp > 30 ? 0.05 : 0) + (serious ? (resp > 30 ? 0.3 : 0.1) : 0);
    a.happy = 5; a.state = 'gone';
    if (serious && (resp > 20 || this.rng() < 0.12)) {
      this.notify(resp > 30 ? 'bad' : 'warn', t('Serious crash on {p}. Ski patrol arrived after {m} min.', { p: p.name, m: resp }), { x: posXZ[0], z: posXZ[1] }, '🚑');
      if (resp > 35 && this.rng() < 0.3) {
        const fine = 150000 + Math.round(this.rng() * 250000);
        this.spend('fines', fine);
        this.notify('bad', t('The injured skier is suing for slow rescue: settlement {c}.', { c: money(fine) }), null, '⚖️');
      }
    }
  }

  endDay(fast = false) {
    const s = this.s, w = this.weatherNow, day = s.day;
    if (!fast) this._flushAgents();
    const visitors = this.dayStats.visitors;
    const inSeasonOps = this.operating;
    const ymd = ymdFromDay(day);
    const summer = this.hemi === 'N' ? ymd.m >= 6 && ymd.m <= 9 : ymd.m >= 12 || ymd.m <= 3;
    // ---- costs
    const wage = s.wageLevel;
    const seasonal = inSeasonOps ? 1 : 0.3;
    let staffCost = 0;
    for (const k of Object.keys(STAFF)) staffCost += s.staff[k] * STAFF[k].wage * wage * seasonal;
    staffCost += s.snowcats * SNOWCAT.wage * wage * seasonal;
    const builtLifts = this.world.lifts.filter(l => this.isBuilt(l));
    const runLifts = inSeasonOps ? builtLifts.filter(l => !['season', 'closed', 'construction'].includes(l.status)) : [];
    staffCost += runLifts.length * 4 * LIFT_OPERATOR_WAGE * wage;
    this.spend('wages', staffCost);
    const energyMult = (this.hasResearch('solar') ? 0.75 : 1) * this._energyMod();
    let energy = 0;
    for (const l of runLifts) if (l.status !== 'wind') energy += LIFTS[l.type].power * 8 * ENERGY_PRICE * energyMult;
    this.spend('energy', energy);
    let upkeep = 0;
    for (const l of builtLifts) upkeep += LIFTS[l.type].upkeep * (inSeasonOps ? 3.2 : 0.5);
    for (const b of this.world.buildings) if (this.isBuilt(b)) upkeep += BUILDINGS[b.type].upkeep * (inSeasonOps || BUILDINGS[b.type].beds ? 1 : 0.5);
    upkeep += s.snowcats * SNOWCAT.upkeep * seasonal;
    upkeep += this.world.pistes.reduce((a, p) => a + p.length, 0) / 1000 * (inSeasonOps ? 70 : 8);
    this.spend('maintenance', upkeep);
    const assets = this.assetValue();
    this.spend('insurance', assets * 0.00008);
    // cost of goods: kitchens, hotel operations, rental fleet wear
    const gross = Object.entries(this.ledger.income).filter(([k]) => !['refunds', 'grants', 'awards'].includes(k)).reduce((a, [, v]) => a + v, 0);
    this.spend('taxes', gross * 0.1);
    this.spend('supplies', (this.ledger.income.food || 0) * 0.55 + (this.ledger.income.lodging || 0) * 0.45 + (this.ledger.income.rental || 0) * 0.25);
    if (s.loan > 0) this.spend('interest', s.loan * 0.045 / 365);
    // ---- lodging revenue (own hotels)
    for (const b of this.world.buildings) {
      const B = BUILDINGS[b.type];
      if (!B.beds || !this.isOperational(b)) continue;
      const occ = inSeasonOps ? clamp((this.occupancy || 0.3) * (b.type === 'chalet' ? 1.25 : b.type === 'hotel5' ? 0.95 : 1.05), 0, 0.98) : (summer ? 0.35 : 0.08);
      const rev = B.beds * occ * B.nightly * s.prices.lodging * (inSeasonOps ? 1 : 0.6);
      this.earn('lodging', rev);
      b.stats.revenueToday = rev;
    }
    // ---- summer operations
    if (!inSeasonOps && summer && s.policy.summerOps) {
      const enclosed = builtLifts.filter(l => ['gondola', 'cablecar', 'tram3s', 'chair6', 'chair4'].includes(l.type));
      if (enclosed.length) {
        const good = w.state === 'sunny' ? 1.3 : w.state === 'partly' ? 1 : 0.4;
        const hikers = enclosed.length * 110 * (0.4 + s.fame / 100) * good;
        this.earn('summer', hikers * 22);
        this.spend('energy', enclosed.length * 300 * 8 * ENERGY_PRICE * 0.6 * energyMult);
        this.spend('wages', enclosed.length * 2 * LIFT_OPERATOR_WAGE * wage);
        this.dayStats.sightseers = Math.round(hikers);
      }
    }
    // ---- heli-skiing for experts on good-weather days
    if (inSeasonOps && (w.state === 'sunny' || w.state === 'partly') && this.world.buildings.some(b => b.type === 'helipad' && this.isOperational(b))) {
      this.earn('heliski', 6 * 480 * (this.freshPowder ? 2 : 1) * (0.5 + s.fame / 100));
      this.spend('energy', 2200);
    }
    // ---- night skiing on lit pistes (Wed/Fri/Sat evenings)
    if (inSeasonOps && [3, 5, 6].includes(ymd.dow)) {
      const litKm = this.world.pistes.filter(p => p.lighting && p.status === 'open').reduce((a, p) => a + p.length, 0) / 1000;
      if (litKm > 0) {
        const night = Math.round(Math.min(litKm * 140, visitors * 0.25) * (this.hasResearch('led') ? 1.25 : 1) * (w.state === 'blizzard' ? 0.2 : 1));
        this.earn('tickets', night * this.s.prices.ticket * 0.45);
        this.spend('energy', litKm * 260 * energyMult);
        this.dayStats.nightSkiers = night;
      }
    }
    // ---- research
    const R = s.research;
    if (R.current) {
      R.progress++;
      const def = RESEARCH.find(r => r.id === R.current);
      if (def && R.progress >= def.days) {
        R.done.push(def.id); R.current = null; R.progress = 0;
        this.notify('good', t('Research complete: {n}!', { n: t(def.name) }), null, '🔬');
        this.emit('research');
      }
    }
    // ---- staff morale
    const targetMorale = clamp(55 + (wage - 1) * 130 - (this.dayStats.rides > 0 && s.staff.patrol < 2 ? 5 : 0), 0, 100);
    s.morale += (targetMorale - s.morale) * 0.08;
    // ---- reputation
    const ds = this.dayStats;
    if (ds.happyN > 0) {
      const dayHappy = ds.happySum / ds.happyN;
      this.dayHappy = dayHappy;
      s.rep += (dayHappy - s.rep) * clamp(0.02 + visitors / 200000, 0.02, 0.09);
      s.season.happySum += dayHappy * visitors; s.season.happyN += visitors;
    }
    if (ds.stranded > visitors * 0.05 && visitors > 0 && !fast) this.notify('bad', t('{n} guests could not get back down to a base station and had to be rescued!', { n: int(ds.stranded) }), null, '🆘');
    s.rep = clamp(s.rep, 0, 100);
    const sum = this.world.summary(day);
    const lux = this.world.buildings.filter(b => b.type === 'hotel5' && this.isOperational(b)).length;
    const targetFame = clamp(0.5 * s.rep + 22 * (1 - Math.exp(-sum.km / 60)) + 4 * s.hosted.worldcup + 10 * s.hosted.worldchamps + 20 * s.hosted.olympics + (this.def.fame || 20) * 0.35 + lux * 2, 0, 100);
    s.fame += (targetFame - s.fame) * 0.004;
    // ---- overnight snow processes
    this._overnight(w, fast);
    // lift wear
    for (const l of runLifts) l.condition = Math.max(10, l.condition - 0.05 * clamp((this.world.lifts.length / 3) / (s.staff.mechanic + 0.3), 0.4, 3));
    // ---- events, history
    this.events.onDayEnd(fast);
    const inc = Object.values(this.ledger.income).reduce((a, b) => a + b, 0);
    const exp = Object.values(this.ledger.expense).reduce((a, b) => a + b, 0);
    const rec = {
      day, visitors, inc: Math.round(inc), exp: Math.round(exp), cash: Math.round(s.cash), rep: Math.round(s.rep * 10) / 10,
      w: w.state, t: Math.round(this.climate.tempAt(w, this.refElev)), snow: Math.round(this.snowAt(2000)), happy: ds.happyN ? Math.round(ds.happySum / ds.happyN) : null,
      inj: ds.injuries, ledger: this.ledger,
    };
    s.history.push(rec);
    if (s.history.length > 420) s.history.shift();
    s.season.visitors += visitors; s.season.revenue += inc; s.season.expenses += exp; s.season.days++;
    if (inSeasonOps) s.season.openDays++;
    s.season.peak = Math.max(s.season.peak, visitors);
    s.stats.totalVisitors += visitors; s.stats.daysPlayed++;
    if (!fast) {
      this._advisor(rec);
      this.emit('dayEnd', rec);
    }
    this._checkGoals(fast);
    if (s.cash < -5e6 && !fast && this.rng() < 0.3) this.notify('bad', t('The bank is worried: you are {c} in the red. Take a loan or cut costs!', { c: money(-s.cash) }), null, '🏦');
  }

  _energyMod() {
    let m = 1;
    for (const x of this.s.mods) if (x.until >= this.s.day && x.energy) m *= x.energy;
    return m;
  }

  _overnight(w, fast) {
    const s = this.s;
    const tNight = h => this.climate.tempAt(w, h, 'min');
    const target = s.policy.snowTarget;
    const inSeason = isSkiSeason(s.day, this.hemi) || isSkiSeason(s.day + 21, this.hemi);
    // melt and settle
    for (const p of this.world.pistes) {
      const sn = p.snow;
      const m = this.melt(w, p.meanH, p.south * (this.hemi === 'N' ? 1 : -1), s.day);
      sn.depth = Math.max(0, sn.depth - m * 0.85);
      sn.depth *= 0.997;
      const tmax = this.climate.tempAt(w, p.meanH, 'max');
      if (tmax > 4 && sn.depth > 0) { sn.surface = 'slush'; sn.quality = Math.min(sn.quality, 50); sn.ice = Math.max(sn.ice, tNight(p.meanH) < -2 ? 1 : 0.3); }
      else if (sn.ice > 0 && tNight(p.meanH) < -1) sn.ice = 1;
    }
    // snowmaking
    const threshold = this.hasResearch('cannons') ? -1 : -2.5;
    const reservoirs = this.world.buildings.filter(b => b.type === 'reservoir' && this.isOperational(b)).length;
    let water = 22000 + reservoirs * 60000; // m3 per night
    let made = 0;
    if (inSeason) {
      const cand = this.world.pistes.filter(p => p.snowmaking && this.isBuilt(p) && p.snow.depth < target && tNight(p.meanH) < threshold)
        .sort((a, b) => (a.raceUntil ? -1 : 0) - (b.raceUntil ? -1 : 0) || a.snow.depth - b.snow.depth);
      for (const p of cand) {
        const T = tNight(p.meanH);
        const cm = clamp((threshold - T) * 2.6, 2, 22);
        const need = Math.min(cm, target - p.snow.depth + 5);
        const m3 = need / 100 * p.length * p.width * 0.45; // water m3 (snow ~2.2x volume)
        const use = Math.min(m3, water);
        if (use <= 0) break;
        const got = need * (use / m3);
        p.snow.depth += got; p.snow.made += got;
        p.snow.quality = Math.max(p.snow.quality, 70);
        water -= use; made += use;
      }
    }
    const cost = made * SNOW_M3_COST * (this.hasResearch('cannons') ? 0.7 : 1) * this._energyMod();
    this.spend('snowmaking', cost);
    this.dayStats.snowmadeM3 = Math.round(made);
    s.season.snowmade += made;
    if (inSeason && water <= 0 && !fast && this.rng() < 0.3) this.notify('warn', t('Snow cannons ran out of water last night: build a Snowmaking Reservoir.'), null, '💧');
    // grooming
    const garages = this.world.buildings.filter(b => b.type === 'garage' && this.isOperational(b)).length;
    const cats = Math.min(s.snowcats, garages * 5 + 1);
    let km = cats * SNOWCAT.kmPerNight * (s.morale < 35 ? 0.7 : 1);
    let groomed = 0;
    if (inSeason) {
      const list = this.world.pistes.filter(p => p.groom && this.isBuilt(p) && p.snow.depth >= 15)
        .sort((a, b) => (b.raceUntil ? 1 : 0) - (a.raceUntil ? 1 : 0) || a.snow.quality - b.snow.quality);
      for (const p of list) {
        const L = p.length / 1000;
        if (km < L) continue;
        km -= L; groomed += L;
        const steep = p.difficulty === 3 && !this.hasResearch('winch');
        p.snow.quality = steep ? 74 : 94;
        p.snow.ice = steep ? p.snow.ice * 0.5 : 0;
        p.snow.surface = 'groomed';
        p.snow.fresh = 0;
      }
    }
    this.spend('grooming', groomed * 130);
    this.dayStats.groomedKm = Math.round(groomed * 10) / 10;
    for (const p of this.world.pistes) {
      if (p.snow.surface !== 'groomed' && p.snow.ice < 0.5 && p.snow.quality > 55 && p.snow.surface !== 'powder') p.snow.quality -= 4;
      this._labelSurface(p);
    }
    this.groomCapacityKm = cats * SNOWCAT.kmPerNight;
  }

  _advisor(rec) {
    const c = this.crowd.complaints;
    const keys = Object.keys(c).sort((a, b) => c[b] - c[a]);
    const quotes = {
      queue: 'Guests: "I spent half the day in lift queues!" Add lift capacity where queues are long.',
      tooHard: 'Guests: "That piste was way too hard for me!" Add easier pistes from the top of your lifts.',
      ice: 'Guests: "It\'s a skating rink out there." More grooming would fix the ice.',
      slush: 'Guests: "Mashed potatoes all afternoon..." Higher pistes keep better snow.',
      thin: 'Guests: "I hit rocks!" Pistes need more snow: think snowmaking.',
      noFood: 'Guests: "Not a single place to eat up there!" Build a mountain hut.',
      foodFull: 'Guests: "The hut was packed, no seats at lunch." Add restaurant capacity.',
      noToilet: 'Guests: "Where are the toilets?!" Build toilets near busy stations.',
      stranded: 'Guests got stuck on the mountain with no way down! Make sure every lift top has an easy way back to a base.',
      crowded: 'Guests: "The pistes are like a motorway." Spread skiers over more terrain.',
      cold: 'Guests: "Frozen on the chairlift!" Bubble chairs or gondolas help on cold days.',
      liftClosed: 'Guests are annoyed that lifts closed while they were waiting.',
      noInstructors: 'The ski school has too few instructors for all the beginners.',
      stuckLift: 'Guests were stuck on a broken lift. Hire more mechanics.',
      boring: 'Expert skiers find your pistes too easy. They want blacks!',
      tbar: 'Snowboarders keep falling off the T-bars.',
      noRental: 'Beginners could not find a ski rental at the base.',
    };
    const top = keys.find(k => quotes[k] && c[k] > Math.max(20, rec.visitors * 0.015));
    if (top) this.notify('advisor', t(quotes[top]), this._complaintFocus(top), '🧓');
    else if (rec.visitors > 0 && rec.happy >= 78 && this.rng() < 0.25) {
      const p = this.crowd.praise;
      const best = Object.keys(p).sort((a, b) => p[b] - p[a])[0];
      const msgs = { powder: 'Guests are raving about the powder today!', hut: 'Everyone loves your mountain huts.', groomed: 'Perfect corduroy this morning: the grooming team did great.', apres: 'The après-ski was legendary tonight.', school: 'Families are thrilled with the ski school.', food: 'Lunch got great reviews.' };
      if (best && msgs[best]) this.notify('advisor', t(msgs[best]), null, '🧓');
    }
    // long queue alert
    const worst = this.world.lifts.filter(l => this.isBuilt(l)).sort((a, b) => b.stats.maxQueue - a.stats.maxQueue)[0];
    if (worst && worst.stats.maxQueue > 600) this.notify('warn', t('Queue of {n} people at {l} today. It needs more capacity.', { n: int(worst.stats.maxQueue), l: worst.name }), worst.id, '⏳');
    for (const l of this.world.lifts) { l.stats.ridersSeason += l.stats.ridersToday; l.stats.lastRiders = l.stats.ridersToday; l.stats.lastMaxQueue = l.stats.maxQueue; l.stats.ridersToday = 0; l.stats.maxQueue = 0; l.stats.waitSum = 0; }
    for (const p of this.world.pistes) { p.stats.runsSeason += p.stats.runsToday; p.stats.lastRuns = p.stats.runsToday; }
    for (const b of this.world.buildings) { b.stats.revenueSeason += b.stats.revenueToday; b.stats.lastVisits = b.stats.visitsToday; b.stats.lastRevenue = b.stats.revenueToday; b.stats.visitsToday = 0; b.stats.revenueToday = 0; }
    this.lastComplaints = { ...c };
  }
  _complaintFocus(k) {
    if (k === 'queue') { const l = this.world.lifts.slice().sort((a, b) => b.stats.maxQueue - a.stats.maxQueue)[0]; return l ? l.id : null; }
    return null;
  }

  endSeason() {
    const s = this.s;
    const se = s.season;
    if (se.openDays > 0) { // a "season" that never opened (e.g. the first summer of a new game) gets no report
      se.happy = se.happyN ? se.happySum / se.happyN : null;
      this.events.seasonAwards(se);
      s.seasons.push({ year: se.year, visitors: se.visitors, revenue: Math.round(se.revenue), expenses: Math.round(se.expenses), profit: Math.round(se.revenue - se.expenses), injuries: se.injuries, peak: se.peak, openDays: se.openDays, happy: se.happy ? Math.round(se.happy) : null, rep: Math.round(s.rep), awards: se.awards, events: se.events });
      this.emit('seasonEnd', s.seasons[s.seasons.length - 1]);
      // summer overhaul of lifts
      let cost = 0;
      for (const l of this.world.lifts) if (l.condition < 90 && this.isBuilt(l)) { cost += (100 - l.condition) * LIFTS[l.type].base * 0.0009; l.condition = Math.min(100, l.condition + 60); }
      if (cost > 0) { this.spend('maintenance', cost); this.notify('info', t('Off-season lift overhaul completed: {c}.', { c: money(cost) }), null, '🔧'); }
    }
    this._newSeason();
  }

  _checkGoals(fast) {
    const sc = this.s.scenario;
    if (!sc || !sc.goals || this.s.won) return;
    const res = this.goalProgress();
    if (res.length && res.every(g => g.done)) {
      this.s.won = true;
      this.notify('good', t('Scenario complete! The board of directors is delighted. Keep playing as long as you like.'), null, '🏆');
      this.emit('won');
    }
  }
  goalProgress() {
    const sc = this.s.scenario;
    if (!sc || !sc.goals) return [];
    const s = this.s;
    const last = s.seasons[s.seasons.length - 1];
    return sc.goals.map(g => {
      let v = 0;
      switch (g.type) {
        case 'rep': v = s.rep; break;
        case 'cash': v = s.cash - s.loan; break;
        case 'visitors': v = Math.max(s.season.visitors, last?.visitors || 0); break;
        case 'km': v = this.world.summary(s.day).km; break;
        case 'worldcup': v = s.hosted.worldcup; break;
        case 'olympics': v = s.hosted.olympics; break;
        case 'value': v = this.assetValue() + s.cash - s.loan; break;
      }
      return { ...g, value: v, done: v >= g.target };
    });
  }

  // ---------- player actions ----------
  canAfford(c) { return this.s.cash - c > -this.creditLimit(); }
  creditLimit() { return 2e6; }
  assetValue() {
    let v = 0;
    for (const e of [...this.world.lifts, ...this.world.pistes, ...this.world.buildings]) v += e.value || 0;
    return v + this.s.snowcats * SNOWCAT.cost;
  }
  maxLoan() { return Math.round(Math.max(10e6, this.assetValue() * 0.6 + this.s.fame * 2e5) / 1e5) * 1e5; }
  takeLoan(a) {
    a = Math.min(a, this.maxLoan() - this.s.loan);
    if (a <= 0) return false;
    this.s.loan += a; this.s.cash += a;
    this.notify('info', t('Loan taken: {c} at 4.5%/year.', { c: money(a) }), null, '🏦');
    this.emit('cash'); return true;
  }
  repayLoan(a) {
    a = Math.min(a, this.s.loan, Math.max(0, this.s.cash));
    if (a <= 0) return false;
    this.s.loan -= a; this.s.cash -= a; this.emit('cash'); return true;
  }

  construct(plan, opts = {}) {
    const rush = !!opts.rush;
    let cost = plan.cost * (rush ? 1.6 : 1);
    const winter = isSkiSeason(this.s.day, this.hemi);
    if (winter && !opts.instant) cost *= 1.15;
    if (!this.canAfford(cost)) { this.notify('bad', t('Not enough money: you need {c}.', { c: money(cost) }), null, '💸'); return null; }
    this.spend('construction', cost);
    const day = this.s.day;
    let e;
    if (plan.kind === 'lift') e = this.world.addLift(plan, { day, rush, name: opts.name });
    else if (plan.kind === 'piste') e = this.world.addPiste(plan, { day, rush, snowmaking: opts.snowmaking, lighting: opts.lighting, name: opts.name, snow: { depth: this.snowAt(plan.meanH), made: 0, quality: 60, surface: 'packed', fresh: 0, ice: 0 } });
    else e = this.world.addBuilding(plan, { day, rush });
    e.value = Math.round(cost);
    if (winter && !rush && !opts.instant) { e.buildUntil = day + Math.ceil((e.buildUntil - day) * 1.4); }
    this.world.rebuildGraph();
    this._applyStatuses();
    this.emit('topology');
    this.emit('cash');
    return e;
  }

  demolish(e) {
    const refund = Math.round((e.value || 0) * (this.isBuilt(e) ? 0.15 : 0.6));
    this.world.remove(e);
    this.earn('refunds', refund);
    this.world.rebuildGraph();
    this._applyStatuses();
    this.emit('topology'); this.emit('cash');
    return refund;
  }

  upgradePiste(p, what, on) {
    if (what === 'snowmaking' && on && !p.snowmaking) {
      const c = PISTE_COST.snowmakingPerM * p.length;
      if (!this.canAfford(c)) return this.notify('bad', t('Not enough money: you need {c}.', { c: money(c) }));
      this.spend('construction', c); p.value += c; p.snowmaking = true;
    } else if (what === 'snowmaking' && !on) p.snowmaking = false;
    if (what === 'lighting' && on && !p.lighting) {
      const c = PISTE_COST.lightingPerM * p.length * (this.hasResearch('led') ? 0.7 : 1);
      if (!this.canAfford(c)) return this.notify('bad', t('Not enough money: you need {c}.', { c: money(c) }));
      this.spend('construction', c); p.value += c; p.lighting = true;
    }
    this.emit('cash'); this.emit('entity', p);
  }

  setOpen(e, open) { e.open = open; this._applyStatuses(); this.emit('entity', e); }

  hire(key, delta) {
    const s = this.s;
    s.staff[key] = Math.max(0, s.staff[key] + delta);
    if (delta > 0) this.spend('wages', STAFF[key].wage * 3 * delta); // hiring cost
    this.emit('cash');
  }
  buySnowcat(delta) {
    const s = this.s;
    if (delta > 0) {
      const garages = this.world.buildings.filter(b => b.type === 'garage' && this.isBuilt(b)).length;
      if (s.snowcats + delta > garages * 5 + 1) { this.notify('warn', t('No room: each Snowcat Garage holds 5 snowcats.')); return; }
      if (!this.canAfford(SNOWCAT.cost)) { this.notify('bad', t('Not enough money: you need {c}.', { c: money(SNOWCAT.cost) })); return; }
      this.spend('equipment', SNOWCAT.cost); s.snowcats += 1;
    } else if (s.snowcats > 0) { s.snowcats -= 1; this.earn('refunds', SNOWCAT.cost * 0.35); }
    this.emit('cash');
  }
  startResearch(id) {
    const r = RESEARCH.find(x => x.id === id);
    if (!r || this.hasResearch(id) || this.s.research.current) return false;
    if (r.requires && !this.hasResearch(r.requires)) return false;
    if (!this.canAfford(r.cost)) { this.notify('bad', t('Not enough money: you need {c}.', { c: money(r.cost) })); return false; }
    this.spend('research', r.cost);
    this.s.research.current = id; this.s.research.progress = 0;
    this.emit('research'); this.emit('cash');
    return true;
  }
  launchCampaign(c) {
    if (!this.canAfford(c.cost)) { this.notify('bad', t('Not enough money: you need {c}.', { c: money(c.cost) })); return false; }
    this.spend('marketing', c.cost);
    this.s.marketing.push({ id: c.id, until: this.s.day + c.days, demand: c.demand });
    if (c.fame) this.s.fame = clamp(this.s.fame + c.fame, 0, 100);
    this.notify('good', t('Campaign launched: {n}.', { n: t(c.name) }), null, '📣');
    this.emit('cash');
    return true;
  }

  forecast(n) {
    const ws = this.world.buildings.some(b => b.type === 'weather' && this.isOperational(b));
    return this.climate.forecast(this.s.day, ws ? 5 : 3, ws ? 2 : 1);
  }

  // ---------- persistence ----------
  serialize() {
    this.s.world = this.world.serialize();
    return JSON.parse(JSON.stringify(this.s));
  }
  publicSnapshot() {
    const sum = this.world.summary(this.s.day);
    return { name: this.s.name, day: this.s.day, rep: this.s.rep, fame: this.s.fame, world: this.world.serialize(), summary: sum, seasons: this.s.seasons.slice(-5) };
  }
  statsForServer() {
    const sum = this.world.summary(this.s.day);
    const last = this.s.seasons[this.s.seasons.length - 1];
    return {
      rating: Math.round(this.s.rep), fame: Math.round(this.s.fame), attract: Math.round((this.attractiveness || 0) * 100) / 100,
      visitorsSeason: Math.max(this.s.season.visitors, last?.visitors || 0), value: Math.round(this.assetValue() + this.s.cash - this.s.loan),
      cash: Math.round(this.s.cash), pisteKm: Math.round(sum.km * 10) / 10, lifts: sum.lifts, top: Math.round(sum.top), day: this.s.day,
      hosted: this.s.hosted,
    };
  }
}

export { WEATHER_INFO, DIFF };
