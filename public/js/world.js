// The resort's physical layout: lifts, pistes, buildings, and the skier navigation graph derived from them.

import { LIFTS, BUILDINGS, PISTE_COST, MAX_PISTE_GRAD, difficultyFromGrad, SKI_SPEED, DIFF } from './catalog.js';
import { clamp, dist, uid, closestOnPoly, subPoly, polyLength, resample, mulberry32, hash32 } from './util.js';

const SNAP_END = 70;
const SNAP_MID = 42;
const WALK = 130;
const BASE_LINK = 380;

const NAME_PARTS = {
  IT: { a: ['Col', 'Pian', 'Forcella', 'Cima', 'Sass', 'Ra', 'Val', 'Croda', 'Piz', 'Malga', 'Baita', 'Lago', 'Busa', 'Prà'],
    b: ['dei Fiori', 'Bianca', 'Rossa', 'del Sole', 'Alto', 'de Ra Vales', 'dei Camosci', 'delle Aquile', 'Lungo', 'Verde', 'del Lupo', 'Ciadin', 'de Sora', 'Larieto', 'Mondeval', 'Faloria'] },
  DE: { a: ['Hoch', 'Sonnen', 'Gams', 'Adler', 'Steinbock', 'Wolfs', 'Kristall', 'Gletscher', 'Murmel', 'Eis', 'Berg', 'Wald'],
    b: ['alm', 'kogel', 'joch', 'kopf', 'bahn', 'eck', 'hang', 'boden', 'grat', 'spitze', 'tal', 'kar'] },
  FR: { a: ['Col de', 'Pointe de', 'Aiguille de', 'Plan de', 'Combe de', 'Dôme de', 'Lac de', 'Roc de', 'Crêt de'],
    b: ['la Balme', "l'Ours", 'Bellecôte', 'la Grive', 'Chavière', 'Solaise', 'Fréjus', 'la Glière', 'Pramecou', "l'Aigle"] },
  EN: { a: ['Eagle', 'Summit', 'Powder', 'Grizzly', 'Lone Pine', 'Silver', 'Thunder', 'Coyote', 'Cedar', 'Raven', 'Big Horn', 'Glacier'],
    b: [' Express', ' Bowl', ' Ridge', ' Glades', ' Peak', ' Run', ' Chutes', ' Basin', ' Flats', ' Line'] },
};
const LANG = { IT: 'IT', CH: 'DE', AT: 'DE', DE: 'DE', SI: 'DE', FR: 'FR', ES: 'FR', SE: 'DE' };

// runtime-only fields: not serialized, but freely reassignable
function hide(obj, key, value) {
  if (Object.prototype.hasOwnProperty.call(obj, key)) obj[key] = value;
  else Object.defineProperty(obj, key, { value, enumerable: false, writable: true, configurable: true });
}

export class World {
  constructor(terrain, biome, country = 'IT') {
    this.terrain = terrain;
    this.biome = biome;
    this.country = country;
    this.lifts = [];
    this.pistes = [];
    this.buildings = [];
    this.nodes = [];
    this.edges = [];
    this.topoVersion = 0;
    this.statusVersion = 0;
    this._nameRng = mulberry32(hash32('names', terrain.def.lat, terrain.def.lon));
  }

  // ---------- naming ----------
  makeName(kind) {
    const lang = LANG[this.country] || (['US', 'CA', 'NZ', 'AU', 'JP', 'CL'].includes(this.country) ? 'EN' : 'IT');
    const P = NAME_PARTS[lang];
    const used = new Set([...this.lifts, ...this.pistes].map(e => e.name));
    for (let k = 0; k < 40; k++) {
      const a = P.a[Math.floor(this._nameRng() * P.a.length)];
      const b = P.b[Math.floor(this._nameRng() * P.b.length)];
      const name = lang === 'DE' ? a + b : `${a} ${b}`.replace('  ', ' ');
      const full = kind === 'piste' && lang !== 'EN' ? name : name;
      if (!used.has(full)) return full;
    }
    return `${kind === 'lift' ? 'Lift' : 'Piste'} ${this.lifts.length + this.pistes.length + 1}`;
  }

  // ---------- lifts ----------
  planLift(type, p1, p2) {
    const T = LIFTS[type];
    const t = this.terrain;
    const res = { kind: 'lift', type, ok: true, errors: [], warnings: [] };
    let a = [p1[0], p1[1]], b = [p2[0], p2[1]];
    let ya = t.heightAt(a[0], a[1]), yb = t.heightAt(b[0], b[1]);
    if (yb < ya) { [a, b] = [b, a]; [ya, yb] = [yb, ya]; }
    const horiz = dist(a[0], a[1], b[0], b[1]);
    const vertical = yb - ya;
    const length = Math.hypot(horiz, vertical);
    Object.assign(res, { a, b, ya, yb, horiz, vertical, length });
    if (!t.inBounds(a[0], a[1], 30) || !t.inBounds(b[0], b[1], 30)) res.errors.push('Stations must be inside the map.');
    if (horiz < (T.surface ? 25 : 120)) res.errors.push('Too short.');
    if (horiz > T.maxLen) res.errors.push(`Too long: max ${T.maxLen} m for a ${T.short}.`);
    if (vertical < 4) res.errors.push('A lift must go uphill.');
    const grad = horiz > 0 ? vertical / horiz : 0;
    if (grad > T.maxGrad) res.errors.push(`Too steep for a ${T.short} (${Math.round(grad * 100)}% avg, max ${Math.round(T.maxGrad * 100)}%).`);
    for (const [p, nm] of [[a, 'Bottom'], [b, 'Top']]) {
      const s = t.slopeDeg(p[0], p[1]);
      if (s > (type === 'cablecar' || type === 'tram3s' ? 40 : 33)) res.errors.push(`${nm} station on a slope of ${Math.round(s)}°: find flatter ground.`);
    }
    // supports / pylons
    const N = Math.max(2, Math.ceil(horiz / 8));
    const prof = [];
    for (let i = 0; i <= N; i++) {
      const f = i / N;
      const x = a[0] + (b[0] - a[0]) * f, z = a[1] + (b[1] - a[1]) * f;
      prof.push({ f, x, z, h: t.heightAt(x, z) });
    }
    const pylons = [];
    if (T.surface) {
      // ground-following track; terrain must keep rising and stay within the lift's grade
      let maxG = 0, drop = 0;
      for (let i = 1; i < prof.length; i++) {
        const g = (prof[i].h - prof[i - 1].h) / (horiz / N);
        maxG = Math.max(maxG, g);
        if (g < -0.05) drop += prof[i - 1].h - prof[i].h;
      }
      if (maxG > T.maxGrad * 1.25) res.errors.push(`Terrain too steep along the track (${Math.round(maxG * 100)}%).`);
      if (drop > 12) res.errors.push('Track goes downhill in places: drag lifts need a steady climb.');
      const H = type === 'carpet' ? 0.6 : 7;
      const cable = prof.map(p => [p.x, p.h + H, p.z]);
      if (T.pylonSpan > 0) {
        const n = Math.max(1, Math.round(horiz / T.pylonSpan));
        for (let i = 1; i < n; i++) {
          const f = i / n, x = a[0] + (b[0] - a[0]) * f, z = a[1] + (b[1] - a[1]) * f;
          pylons.push({ x, z, y: t.heightAt(x, z), h: H });
        }
      }
      res.cable = cable;
    } else {
      const clearance = type === 'cablecar' || type === 'tram3s' ? 25 : type === 'gondola' ? 12 : 7;
      const stationH = type === 'cablecar' || type === 'tram3s' ? 12 : 8;
      const maxPylon = type === 'cablecar' ? 140 : type === 'tram3s' ? 110 : 45;
      let nSpan = Math.max(1, Math.round(horiz / T.pylonSpan));
      const supports = [];
      for (let i = 0; i <= nSpan; i++) {
        const f = i / nSpan;
        const x = a[0] + (b[0] - a[0]) * f, z = a[1] + (b[1] - a[1]) * f;
        const g = t.heightAt(x, z);
        supports.push({ f, x, z, g, h: i === 0 || i === nSpan ? stationH : 10 });
      }
      // add supports at prominent ridges: highest terrain point above the chord
      for (let it = 0; it < 6; it++) {
        let changed = false;
        for (let s = 0; s < supports.length - 1; s++) {
          const A = supports[s], B = supports[s + 1];
          const yA = A.g + A.h, yB = B.g + B.h;
          let worst = 0, wf = 0;
          for (const p of prof) {
            if (p.f <= A.f || p.f >= B.f) continue;
            const u = (p.f - A.f) / (B.f - A.f);
            const cy = yA + (yB - yA) * u - 4 * 0.012 * (B.f - A.f) * horiz * u * (1 - u); // sag
            const need = p.h + clearance - cy;
            if (need > worst) { worst = need; wf = u; }
          }
          if (worst > 0.5) {
            changed = true;
            // raise the nearer intermediate support(s), proportionally
            const raiseA = s > 0 ? worst * (1 - wf) * 1.6 : 0;
            const raiseB = s + 1 < supports.length - 1 ? worst * wf * 1.6 : 0;
            if (raiseA + raiseB < worst * 0.5) {
              // both ends are stations: insert a support at the worst point
              const f = A.f + (B.f - A.f) * wf;
              const x = a[0] + (b[0] - a[0]) * f, z = a[1] + (b[1] - a[1]) * f;
              supports.splice(s + 1, 0, { f, x, z, g: t.heightAt(x, z), h: 10 });
              break;
            }
            A.h += raiseA; B.h += raiseB;
          }
        }
        if (!changed) break;
      }
      let tooTall = 0;
      for (let i = 1; i < supports.length - 1; i++) {
        const s = supports[i];
        if (s.h > maxPylon) tooTall = Math.max(tooTall, s.h);
        pylons.push({ x: s.x, z: s.z, y: s.g, h: Math.min(s.h, maxPylon) });
      }
      if (tooTall) res.errors.push(`Terrain too rugged: would need ${Math.round(tooTall)} m towers. Try an aerial tramway or another line.`);
      // cable polyline with sag
      const cable = [];
      for (let s = 0; s < supports.length - 1; s++) {
        const A = supports[s], B = supports[s + 1];
        const yA = A.g + A.h, yB = B.g + B.h;
        const steps = 10;
        for (let k = s === 0 ? 0 : 1; k <= steps; k++) {
          const u = k / steps;
          const x = A.x + (B.x - A.x) * u, z = A.z + (B.z - A.z) * u;
          const cy = yA + (yB - yA) * u - 4 * 0.012 * (B.f - A.f) * horiz * u * (1 - u);
          cable.push([x, cy, z]);
        }
      }
      res.cable = cable;
      res.supports = supports;
    }
    res.pylons = pylons;
    res.capacity = T.capacity;
    res.rideTime = length / T.speed; // seconds
    const towerCost = pylons.reduce((s, p) => s + 20000 + p.h * p.h * 60, 0);
    res.cost = Math.round(T.base + T.perM * length + towerCost);
    res.days = Math.round(T.days + T.perKm * (length / 1000));
    // conflicts with existing stations
    for (const l of this.lifts) {
      for (const p of [l.a, l.b]) for (const q of [a, b]) {
        if (dist(p[0], p[1], q[0], q[1]) < 12) res.warnings.push('Station very close to another lift station.');
      }
    }
    res.ok = res.errors.length === 0;
    return res;
  }

  addLift(plan, { name, day = 0, instant = false, rush = false, imported = false, capacity } = {}) {
    const T = LIFTS[plan.type];
    const lift = {
      id: uid('L'), kind: 'lift', type: plan.type, name: name || this.makeName('lift'),
      a: plan.a, b: plan.b, ya: plan.ya, yb: plan.yb,
      length: plan.length, horiz: plan.horiz, vertical: plan.vertical,
      capacity: capacity || T.capacity, speed: T.speed,
      built: day, buildUntil: instant ? day : day + (rush ? Math.ceil(plan.days / 2) : plan.days),
      condition: 100, open: true, brokenUntil: 0, imported,
      stats: { ridersToday: 0, ridersSeason: 0, waitSum: 0, waitN: 0, maxQueue: 0 },
      value: plan.cost,
    };
    this._liftDerived(lift, plan);
    this.lifts.push(lift);
    this.invalidateTopo();
    return lift;
  }
  _liftDerived(lift, plan) {
    plan = plan || this.planLift(lift.type, lift.a, lift.b);
    hide(lift, 'pylons', plan.pylons);
    hide(lift, 'cable', plan.cable);
    if (!lift.queue) hide(lift, 'queue', []);
    if (!lift.riders) hide(lift, 'riders', []);
    if (lift.dispatchAcc === undefined) hide(lift, 'dispatchAcc', 0);
    if (lift.status === undefined) hide(lift, 'status', 'open');
  }

  // ---------- pistes ----------
  planPiste(points, opts = {}) {
    const t = this.terrain;
    const res = { kind: 'piste', ok: true, errors: [], warnings: [] };
    let pts = points.map(p => [p[0], p[1]]);
    if (pts.length < 2) { res.ok = false; res.errors.push('Click at least two points.'); return res; }
    // make it run downhill
    if (t.heightAt(pts[0][0], pts[0][1]) < t.heightAt(pts[pts.length - 1][0], pts[pts.length - 1][1])) pts.reverse();
    const prof = t.profile(pts, 10);
    res.pts = pts;
    Object.assign(res, {
      length: prof.length, drop: prof.drop, top: prof.maxH, bottom: prof.minH, meanH: prof.meanH,
      steepest: prof.steepest100, avgGrad: prof.avgGrad, maxUp: prof.maxUp, south: prof.south, flatLen: prof.flatLen,
    });
    if (pts.some(p => !t.inBounds(p[0], p[1], 10))) res.errors.push('Piste leaves the map.');
    if (prof.length < 60) res.errors.push('Too short.');
    if (prof.drop < 8) res.errors.push('A piste has to go downhill.');
    if (prof.maxUp > 18 && !opts.imported) res.errors.push(`Uphill section of ${Math.round(prof.maxUp)} m: skiers can't climb that.`);
    if (prof.steepest100 > MAX_PISTE_GRAD && !opts.imported) res.errors.push(`Cliff! ${Math.round(Math.atan(prof.steepest100) * 180 / Math.PI)}° sustained: unskiable.`);
    let diff = difficultyFromGrad(prof.steepest100);
    if (prof.maxCross > 0.5 && diff < 3) { diff++; res.warnings.push('Steep side-slope: rated one level harder.'); }
    if (opts.difficulty != null) diff = opts.difficulty;
    res.difficulty = diff;
    if (prof.flatLen > 250) res.warnings.push(`${Math.round(prof.flatLen)} m of flat sections: snowboarders will have to push.`);
    // forest clearing
    let forestM = 0;
    if (this.biome) for (const s of prof.samples) if (this.biome.isForest(s.x, s.z)) forestM += 10;
    res.forestM = forestM;
    res.avyExp = t.avalancheExposure(pts);
    const snowmaking = !!opts.snowmaking;
    const steepFactor = 1 + Math.min(1.5, prof.steepest100);
    res.cost = Math.round(PISTE_COST.perM * prof.length * steepFactor + PISTE_COST.forestPerM * forestM +
      (snowmaking ? PISTE_COST.snowmakingPerM * prof.length : 0) + (opts.lighting ? PISTE_COST.lightingPerM * prof.length : 0));
    res.days = Math.round(PISTE_COST.days + PISTE_COST.perKm * prof.length / 1000 + forestM / 400);
    res.ok = res.errors.length === 0;
    return res;
  }

  addPiste(plan, { name, day = 0, instant = false, rush = false, snowmaking = false, lighting = false, imported = false, snow } = {}) {
    const p = {
      id: uid('P'), kind: 'piste', name: name || this.makeName('piste'),
      pts: plan.pts.map(q => [Math.round(q[0] * 10) / 10, Math.round(q[1] * 10) / 10]),
      difficulty: plan.difficulty, length: plan.length, drop: plan.drop, top: plan.top, bottom: plan.bottom,
      meanH: plan.meanH, steepest: plan.steepest, south: plan.south, avyExp: plan.avyExp,
      width: PISTE_COST.width, snowmaking, lighting, open: true, groom: true, imported,
      built: day, buildUntil: instant ? day : day + (rush ? Math.ceil(plan.days / 2) : plan.days),
      snow: snow || { depth: 0, made: 0, quality: 60, surface: 'none', fresh: 0, ice: 0 },
      stats: { runsToday: 0, runsSeason: 0, injuriesSeason: 0 },
      value: plan.cost,
    };
    this._pisteDerived(p);
    this.pistes.push(p);
    this.invalidateTopo();
    return p;
  }
  _pisteDerived(p) {
    if (p.status === undefined) hide(p, 'status', 'open');
    if (p.traffic === undefined) hide(p, 'traffic', 0);
  }

  // ---------- buildings ----------
  planBuilding(type, x, z) {
    const B = BUILDINGS[type];
    const t = this.terrain;
    const res = { kind: 'building', type, x, z, ok: true, errors: [], warnings: [], cost: B.cost, days: B.days };
    if (!t.inBounds(x, z, B.size + 10)) res.errors.push('Outside the map.');
    const s = t.slopeDeg(x, z);
    const maxS = type === 'skijump' ? 60 : type === 'nordic' ? 9 : ['terrainpark', 'halfpipe'].includes(type) ? 26 : B.size > 30 ? 16 : 26;
    if (type === 'skijump' && s < B.minSlope) res.errors.push(`Needs a slope of at least ${B.minSlope}° (here ${Math.round(s)}°).`);
    if (s > maxS) res.errors.push(`Too steep here (${Math.round(s)}°, max ${maxS}°).`);
    for (const b of this.buildings) {
      const d = dist(b.x, b.z, x, z);
      if (d < (BUILDINGS[b.type].size + B.size) * 0.8) { res.errors.push(`Overlaps ${BUILDINGS[b.type].name}.`); break; }
    }
    for (const l of this.lifts) for (const p of [l.a, l.b]) {
      if (dist(p[0], p[1], x, z) < B.size * 0.7 + 8) { res.errors.push('Too close to a lift station.'); break; }
    }
    res.y = t.heightAt(x, z);
    res.ok = res.errors.length === 0;
    return res;
  }

  addBuilding(plan, { day = 0, instant = false, rush = false, rot, imported = false, name } = {}) {
    const B = BUILDINGS[plan.type];
    const b = {
      id: uid('B'), kind: 'building', type: plan.type, x: plan.x, z: plan.z, y: this.terrain.heightAt(plan.x, plan.z),
      rot: rot ?? this._autoRot(plan.x, plan.z), open: true, imported, name: name || '',
      built: day, buildUntil: instant ? day : day + (rush ? Math.ceil(B.days / 2) : B.days),
      stats: { visitsToday: 0, revenueToday: 0, revenueSeason: 0 },
      value: B.cost,
    };
    this.buildings.push(b);
    this.invalidateTopo();
    return b;
  }
  _autoRot(x, z) {
    const g = this.terrain.gradientAt(x, z);
    return Math.atan2(g.dx, g.dz);
  }

  remove(ent) {
    const arr = ent.kind === 'lift' ? this.lifts : ent.kind === 'piste' ? this.pistes : this.buildings;
    const i = arr.indexOf(ent);
    if (i >= 0) arr.splice(i, 1);
    this.invalidateTopo();
  }

  find(id) {
    return this.lifts.find(e => e.id === id) || this.pistes.find(e => e.id === id) || this.buildings.find(e => e.id === id) || null;
  }

  invalidateTopo() { this.topoVersion++; this._graphDirty = true; }
  invalidateStatus() { this.statusVersion++; this._routesDirty = true; }

  isBuilt(e, day) { return day >= e.buildUntil; }

  // ---------- navigation graph ----------
  rebuildGraph() {
    this._graphDirty = false;
    const nodes = [], edges = [];
    const addNode = (x, z, kind, ref) => {
      const n = { id: nodes.length, x, z, y: this.terrain.heightAt(x, z), kind, ref, out: [], inn: [], services: {} };
      nodes.push(n);
      return n;
    };
    const addEdge = (kind, from, to, ref, extra = {}) => {
      const e = { id: edges.length, kind, from: from.id, to: to.id, ref, ...extra };
      edges.push(e);
      from.out.push(e.id); to.inn.push(e.id);
      return e;
    };
    for (const l of this.lifts) {
      l.nBottom = addNode(l.a[0], l.a[1], 'liftBottom', l);
      l.nTop = addNode(l.b[0], l.b[1], 'liftTop', l);
    }
    const bases = this.buildings.filter(b => b.type === 'base');
    for (const b of bases) b.node = addNode(b.x, b.z, 'base', b);
    const nearestNode = (x, z, maxD, exclude) => {
      let best = null, bd = maxD;
      for (const n of nodes) {
        if (exclude && exclude.has(n.id)) continue;
        const d = dist(n.x, n.z, x, z);
        if (d < bd) { bd = d; best = n; }
      }
      return best;
    };
    for (const p of this.pistes) {
      const s = p.pts[0], e = p.pts[p.pts.length - 1];
      p.nStart = nearestNode(s[0], s[1], SNAP_END) || addNode(s[0], s[1], 'junction', p);
      p.nEnd = nearestNode(e[0], e[1], SNAP_END, new Set([p.nStart.id])) || addNode(e[0], e[1], 'junction', p);
    }
    for (const p of this.pistes) {
      const L = polyLength(p.pts);
      const splits = [{ s: 0, n: p.nStart }, { s: L, n: p.nEnd }];
      for (const n of nodes) {
        if (n === p.nStart || n === p.nEnd) continue;
        const c = closestOnPoly(p.pts, n.x, n.z);
        if (c.d < SNAP_MID && c.s > 25 && c.s < L - 25) splits.push({ s: c.s, n });
      }
      splits.sort((a, b) => a.s - b.s);
      const uniq = [];
      for (const sp of splits) if (!uniq.some(u => u.n === sp.n)) uniq.push(sp);
      p.segments = [];
      for (let i = 0; i < uniq.length - 1; i++) {
        const A = uniq[i], B = uniq[i + 1];
        if (B.s - A.s < 5) continue;
        const pts = subPoly(p.pts, A.s, B.s);
        const ed = addEdge('piste', A.n, B.n, p, { pts, len: B.s - A.s, s0: A.s, s1: B.s });
        p.segments.push(ed.id);
      }
    }
    for (const l of this.lifts) {
      addEdge('lift', l.nBottom, l.nTop, l, { len: l.length });
      // enclosed lifts also carry guests back down
      if (['gondola', 'cablecar', 'tram3s'].includes(l.type)) addEdge('liftDown', l.nTop, l.nBottom, l, { len: l.length });
    }
    // walking links between nearby nodes (station transfers), and from bases
    const linked = new Set(edges.map(e => `${e.from}>${e.to}`));
    for (let i = 0; i < nodes.length; i++) for (let j = 0; j < nodes.length; j++) {
      if (i === j) continue;
      const A = nodes[i], B = nodes[j];
      const lim = A.kind === 'base' || B.kind === 'base' ? BASE_LINK : WALK;
      const d = dist(A.x, A.z, B.x, B.z);
      if (d > lim) continue;
      const dy = B.y - A.y;
      if (dy > (A.kind === 'base' || B.kind === 'base' ? 70 : 35)) continue; // too much climbing
      if (linked.has(`${i}>${j}`)) continue;
      addEdge('walk', A, B, null, { len: d + Math.max(0, dy) * 8, pts: [[A.x, A.z], [B.x, B.z]] });
      linked.add(`${i}>${j}`);
    }
    // attach service buildings to nearest node
    for (const b of this.buildings) {
      if (b.type === 'base') continue;
      const n = nearestNode(b.x, b.z, 260);
      b.node = n || null;
      const svc = BUILDINGS[b.type].service;
      if (n && svc) (n.services[svc] ||= []).push(b);
      // restaurants and huts have restrooms too
      if (n && (svc === 'food' || svc === 'apres') && b.type !== 'cafe') (n.services.toilet ||= []).push(b);
    }
    // base stations offer rentals/school nearby too
    this.nodes = nodes; this.edges = edges;
    this._routesDirty = true;
    this.graphVersion = (this.graphVersion || 0) + 1;
    if (this.onRebuild) this.onRebuild();
  }

  ensureGraph() { if (this._graphDirty || !this.nodes) this.rebuildGraph(); }

  // ---------- routing ----------
  // edge usable for a skill when moving freely or when heading somewhere
  edgeUsable(e, skill, home = false) {
    if (e.kind === 'walk') return true;
    if (e.kind === 'lift') return e.ref.status === 'open';
    // the last descents run until the evening, after uphill operations stop
    if (e.kind === 'liftDown') return home && (e.ref.status === 'open' || e.ref.status === 'night');
    const p = e.ref;
    if (p.status !== 'open') return false;
    // heading home, guests will side-slip down one level harder than they would choose
    const lim = home ? [2, 3, 3, 3][skill] : [1, 2, 3, 3][skill];
    return p.difficulty <= lim;
  }
  edgeTime(e, skill, waitOf) {
    if (e.kind === 'walk') return e.len / 1.1;
    if (e.kind === 'lift') return (waitOf ? waitOf(e.ref) : 0) + e.ref.length / e.ref.speed + 20;
    if (e.kind === 'liftDown') return e.ref.length / e.ref.speed + 240;
    const p = e.ref;
    const over = Math.max(0, p.difficulty - [0, 1, 2, 3][skill]);
    return (e.len / SKI_SPEED[skill]) * (1 + over * 1.5);
  }

  // Reverse Dijkstra: per (skill, goal) next-hop edge for every node.
  computeRoutes(goalFn, skill, waitOf, home = false) {
    const n = this.nodes.length;
    const distArr = new Float64Array(n).fill(Infinity);
    const next = new Int32Array(n).fill(-1);
    const heap = [];
    const push = (d, id) => { heap.push([d, id]); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
    const pop = () => { const top = heap[0]; const last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
    for (const nd of this.nodes) if (goalFn(nd)) { distArr[nd.id] = 0; push(0, nd.id); }
    while (heap.length) {
      const [d, id] = pop();
      if (d > distArr[id]) continue;
      for (const eid of this.nodes[id].inn) {
        const e = this.edges[eid];
        if (!this.edgeUsable(e, skill, home)) continue;
        const nd = d + this.edgeTime(e, skill, waitOf);
        if (nd < distArr[e.from]) { distArr[e.from] = nd; next[e.from] = eid; push(nd, e.from); }
      }
    }
    return { dist: distArr, next };
  }

  // ---------- persistence ----------
  serialize() {
    const strip = o => JSON.parse(JSON.stringify(o, (k, v) => (['nBottom', 'nTop', 'nStart', 'nEnd', 'node', 'segments'].includes(k) ? undefined : v)));
    return { lifts: this.lifts.map(strip), pistes: this.pistes.map(strip), buildings: this.buildings.map(strip) };
  }
  load(data) {
    this.lifts = (data.lifts || []).map(l => { this._liftDerived(l); return l; });
    this.pistes = (data.pistes || []).map(p => { this._pisteDerived(p); return p; });
    this.buildings = data.buildings || [];
    this.invalidateTopo();
    this.rebuildGraph();
  }

  // ---------- aggregate stats ----------
  summary(day) {
    const built = e => day >= e.buildUntil;
    const lifts = this.lifts.filter(built), pistes = this.pistes.filter(built);
    const km = pistes.reduce((s, p) => s + p.length, 0) / 1000;
    const byDiff = [0, 0, 0, 0];
    for (const p of pistes) byDiff[p.difficulty] += p.length / 1000;
    const cap = lifts.reduce((s, l) => s + l.capacity, 0);
    const top = Math.max(0, ...lifts.map(l => l.yb), ...pistes.map(p => p.top || 0));
    const bottom = Math.min(...lifts.map(l => l.ya), ...pistes.map(p => p.bottom || 99999));
    const blds = {};
    for (const b of this.buildings) if (built(b)) blds[b.type] = (blds[b.type] || 0) + 1;
    return { lifts: lifts.length, pistes: pistes.length, km, byDiff, capacity: cap, top, bottom: isFinite(bottom) ? bottom : 0, buildings: blds };
  }
}

export function diffColor(d) { return DIFF[d]?.color || '#888'; }
export { clamp, resample };
