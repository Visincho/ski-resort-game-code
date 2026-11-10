// Skier agents: each visible skier stands for `k` real guests. They queue for lifts, ride, ski pistes
// that suit their level, get hungry, need toilets, take lessons and go home tired (or annoyed).

import { SKILL_MIX, DIFF_PREF, SKI_SPEED, BUILDINGS, LIFTS } from './catalog.js';
import { clamp, pointAt, dist } from './util.js';

const GOALS = ['home', 'food', 'toilet', 'apres', 'rental', 'school'];
const JACKETS = [0xe63946, 0x1d3557, 0xf1c40f, 0x2ecc71, 0xff7f50, 0x8e44ad, 0x00b4d8, 0xffffff, 0x222222, 0xff4fa3, 0xf77f00, 0x3a86ff];

export class Crowd {
  constructor(game) {
    this.game = game;
    this.agents = [];
    this.k = 1;
    this.routes = {};
    this.routesKey = '';
    this.nextId = 1;
    this.complaints = {};
    this.praise = {};
  }

  reset() {
    for (const l of this.game.world.lifts) { l.queue.length = 0; l.riders.length = 0; l.dispatchAcc = 0; }
    for (const b of this.game.world.buildings) b.occ = 0; // guests still inside go home with everyone else
    this.agents = [];
  }
  newDay() { this.complaints = {}; this.praise = {}; }

  // The navigation graph was rebuilt (something was built or demolished): node and edge ids changed,
  // so put every guest back on the nearest node of the new graph.
  remap() {
    const w = this.game.world;
    for (const l of w.lifts) { if (l.queue) l.queue.length = 0; l.dispatchAcc = 0; }
    if (!w.nodes.length) { this.agents = []; return; }
    for (const a of this.agents) {
      let best = 0, bd = Infinity;
      for (const n of w.nodes) { const d = (n.x - a.pos[0]) ** 2 + (n.z - a.pos[2]) ** 2; if (d < bd) { bd = d; best = n.id; } }
      a.node = best; a.edge = null; a.s = 0; a.prevNode = -1;
      if (a.state === 'service' && a.building && w.buildings.includes(a.building)) continue;
      if (a.building) { a.building.occ = 0; a.building = null; }
      a.state = 'atNode';
    }
  }

  complain(key, n = 1) { this.complaints[key] = (this.complaints[key] || 0) + n * this.k; }
  praiseFor(key, n = 1) { this.praise[key] = (this.praise[key] || 0) + n * this.k; }

  // ---------- routing ----------
  waitOf = lift => {
    const rate = this.liftRate(lift);
    return rate > 0 ? lift.queue.length / rate : 3600;
  };
  liftRate(lift) { // agents per second
    if (lift.status !== 'open') return 0;
    const g = this.game;
    let cap = lift.capacity * (g.hasResearch('rfid') ? 1.08 : 1) * (0.75 + lift.condition / 400);
    return cap / 3600 / this.k;
  }
  route(skill, goal) {
    const w = this.game.world;
    const key = `${w.graphVersion}:${w.statusVersion}:${this._waitEpoch || 0}`;
    if (key !== this.routesKey) { this.routes = {}; this.routesKey = key; }
    const id = `${skill}:${goal}`;
    if (!this.routes[id]) {
      const fn = goal === 'home' ? n => n.kind === 'base'
        : n => !!(n.services[goal] && n.services[goal].some(b => this.game.isOperational(b)));
      this.routes[id] = w.computeRoutes(fn, skill, this.waitOf, goal === 'home');
    }
    return this.routes[id];
  }
  refreshWaits() { this._waitEpoch = (this._waitEpoch || 0) + 1; }

  // ---------- spawning ----------
  spawn(baseNode, minute, rng, opts = {}) {
    const g = this.game;
    const r = rng();
    let skill = 0, acc = 0;
    for (let i = 0; i < 4; i++) { acc += SKILL_MIX[i]; if (r <= acc) { skill = i; break; } }
    const a = {
      id: this.nextId++, skill, state: 'atNode', node: baseNode.id, edge: null, s: 0,
      hunger: rng() * 0.3, bladder: rng() * 0.3, energy: 0.85 + rng() * 0.15,
      happy: 68 + rng() * 10, goal: null, serviceUntil: 0, lunch: false, apres: false,
      leaveAt: clamp(minute + 180 + rng() * 330 - (skill === 0 ? 60 : 0), minute + 90, g.closeMinute + 30),
      runs: 0, waitT: 0, visited: new Set(), lane: (rng() - 0.5) * 0.9, phase: rng() * 6.28,
      color: JACKETS[Math.floor(rng() * JACKETS.length)], board: rng() < 0.28,
      pos: [baseNode.x, baseNode.y + 2, baseNode.z], lastEdgeKind: null, prevNode: -1, stuck: 0,
      day: opts.dayGuest,
    };
    if (rng() < (skill === 0 ? 0.55 : 0.12)) a.goal = 'rental';
    else if (skill === 0 && rng() < 0.5) a.goal = 'school';
    this.agents.push(a);
    return a;
  }

  // ---------- update ----------
  update(dt, minute, rng) {
    const g = this.game, w = g.world;
    if (!w.nodes.length) return;
    // lift dispatch
    for (const l of w.lifts) {
      if (l.status !== 'open') {
        if (l.queue.length) {
          for (const a of l.queue) { a.state = 'atNode'; a.happy -= 3; }
          this.complain('liftClosed', l.queue.length);
          l.queue.length = 0;
        }
        continue;
      }
      l.dispatchAcc += this.liftRate(l) * dt;
      while (l.dispatchAcc >= 1 && l.queue.length) {
        l.dispatchAcc -= 1;
        const a = l.queue.shift();
        a.state = 'lift'; a.s = 0;
        l.stats.ridersToday += this.k;
        g.dayStats.rides += this.k;
      }
      if (!l.queue.length) l.dispatchAcc = Math.min(l.dispatchAcc, 1);
      l.stats.maxQueue = Math.max(l.stats.maxQueue, l.queue.length * this.k);
    }
    const closing = minute >= g.closeMinute - 25;
    const alive = [];
    for (const a of this.agents) {
      this.step(a, dt, minute, rng, closing);
      if (a.state !== 'gone') alive.push(a);
      else this.depart(a);
    }
    this.agents = alive;
  }

  depart(a) {
    const g = this.game;
    g.dayStats.happySum += clamp(a.happy, 0, 100) * this.k;
    g.dayStats.happyN += this.k;
  }

  step(a, dt, minute, rng, closing) {
    const g = this.game, w = g.world;
    // needs
    const hrs = dt / 3600;
    a.hunger += hrs / 3.2;
    a.bladder += hrs / 2.6;
    a.energy -= hrs / (a.skill >= 2 ? 6.5 : 5);
    if (a.state === 'queue') {
      a.waitT += dt;
      const wmin = dt / 60;
      const lift = w.edges[a.edge]?.ref;
      const qlen = lift ? lift.queue.length * this.k : 0;
      if (qlen > 60) a.happy -= wmin * (qlen > 400 ? 0.5 : 0.25) * (g.hasResearch('app') ? 0.7 : 1);
      if (wmin && qlen > 300 && rng() < 0.002 * wmin) this.complain('queue');
      if (lift) { lift.stats.waitSum += dt * this.k; lift.stats.waitN += 0; }
      return;
    }
    if (a.state === 'service') {
      if (minute >= a.serviceUntil) { a.state = 'atNode'; if (a.building) a.building.occ = Math.max(0, (a.building.occ || 0) - 1); a.building = null; }
      return;
    }
    // goal management (only re-evaluated at nodes)
    if (a.state === 'atNode') {
      if (!a.goal || a.goal === 'food' || a.goal === 'apres') {
        if ((closing || minute >= a.leaveAt || a.energy < 0.12)) {
          a.goal = !a.apres && rng() < 0.35 && g.world.buildings.some(b => b.type === 'apres' && g.isOperational(b)) && minute < g.closeMinute + 30 ? 'apres' : 'home';
        } else if (a.bladder > 0.85) a.goal = 'toilet';
        else if (!a.lunch && a.hunger > 0.72 && minute > 690 && minute < 900) a.goal = 'food';
      }
      if (a.goal === 'toilet' && a.bladder > 1.05) { a.happy -= 0.04 * dt / 60; }
      this.decide(a, minute, rng, closing);
      return;
    }
    // moving along an edge
    const e = w.edges[a.edge];
    if (!e) { a.state = 'atNode'; return; }
    let speed;
    if (a.state === 'lift' || a.state === 'liftDown') {
      speed = e.ref.speed;
      if (e.ref.status !== 'open' && e.ref.status !== 'broken') speed = e.ref.speed; // finish ride
      if (e.ref.status === 'broken') { speed = 0; a.happy -= dt / 60 * 0.4; if (rng() < 0.0005 * dt) this.complain('stuckLift'); }
      a.s += speed * dt;
      const L = e.ref.length;
      if (a.s >= L) {
        a.node = a.state === 'lift' ? e.to : e.from;
        a.state = 'atNode'; a.s = 0; a.lastEdgeKind = 'lift';
        if (g.weatherNow && g.weatherNow.t1500 < -14 && ['chair2', 'chair4', 'tbar'].includes(e.ref.type) && !g.hasResearch('heated')) { a.happy -= 1.5; if (rng() < 0.08) this.complain('cold'); }
        if (e.ref.type === 'tbar' && a.board && rng() < 0.4) { a.happy -= 1; if (rng() < 0.1) this.complain('tbar'); }
      }
      return;
    }
    if (a.state === 'walk') {
      a.s += 1.15 * dt;
      if (a.s >= e.len) { a.node = e.to; a.state = 'atNode'; a.s = 0; a.lastEdgeKind = 'walk'; }
      return;
    }
    if (a.state === 'ski') {
      const p = e.ref;
      const over = p.difficulty - a.skill;
      const q = p.snow.quality;
      speed = SKI_SPEED[a.skill] * (over > 0 ? 0.6 : 1) * (0.7 + q / 330) * (g.weatherNow?.vis < 0.4 ? 0.7 : 1);
      a.s += speed * dt;
      if (a.s >= e.len) {
        a.node = e.to; a.state = 'atNode'; a.s = 0; a.lastEdgeKind = 'piste';
        this.finishRun(a, p, e, rng);
      }
    }
  }

  finishRun(a, p, e, rng) {
    const g = this.game;
    const frac = e.len / Math.max(1, p.length);
    if (e.s0 < 1) { a.runs++; p.stats.runsToday += this.k; }
    // snow wear
    p.snow.quality = Math.max(12, p.snow.quality - (70 / Math.max(300, p.length)) * this.k * frac * (40 / p.width));
    p.traffic += this.k * frac;
    // happiness
    const over = p.difficulty - a.skill;
    let dh = 0;
    if (over >= 2) { dh -= 8; this.complain('tooHard'); }
    else if (over === 1) dh -= a.skill === 0 ? 4 : 1.5;
    else if (over <= -2) { dh -= 0.6; if (a.skill === 3) this.complain('boring', 0.2); }
    else dh += 1.6;
    const surf = p.snow.surface;
    if (surf === 'icy') { dh -= a.skill >= 2 ? 1.5 : 4; if (rng() < 0.15) this.complain('ice'); }
    else if (surf === 'slush') { dh -= 1.2; if (rng() < 0.08) this.complain('slush'); }
    else if (surf === 'thin') { dh -= 3; if (rng() < 0.2) this.complain('thin'); }
    else if (surf === 'choppy') dh -= a.skill === 0 ? 2 : 0.6;
    else if (surf === 'powder') { dh += a.skill >= 2 ? 4 : -1.5; if (a.skill >= 2) this.praiseFor('powder'); }
    else if (surf === 'groomed') { dh += 1.4; this.praiseFor('groomed', 0.2); }
    if (!a.visited.has(p.id)) { a.visited.add(p.id); dh += 1.2; }
    const crowd = p.traffic / Math.max(0.3, p.length / 1000) / Math.max(1, (g.minute - g.openMinute) / 60);
    if (crowd > 900) { dh -= 1.5; if (rng() < 0.05) this.complain('crowded'); }
    const W = g.weatherNow;
    if (W) {
      if (W.state === 'sunny') dh += 0.8;
      else if (W.state === 'blizzard' || W.state === 'fog') dh -= 1.2;
      if (W.state === 'sunny' && g.freshPowder) dh += a.skill >= 1 ? 1.5 : 0;
    }
    a.happy = clamp(a.happy + dh * frac, 0, 100);
    a.energy -= 0.012 * frac * (1 + Math.max(0, over));
    // injuries: probability per real person-run
    let pr = 0.0001 * (1 + Math.max(0, over) * 2) * (surf === 'icy' ? 2 : 1) * (surf === 'thin' ? 2.2 : 1) * (crowd > 900 ? 1.4 : 1) * (W && W.vis < 0.4 ? 1.5 : 1) * (a.skill === 3 ? 1.25 : 1);
    if (rng() < pr * this.k * frac) g.injury(a, p, e);
  }

  decide(a, minute, rng, closing) {
    const g = this.game, w = g.world;
    const node = w.nodes[a.node];
    if (!node) { a.state = 'gone'; return; }
    // reached a goal at this node?
    if (a.goal === 'home' && node.kind === 'base') { a.state = 'gone'; return; }
    if (a.goal && a.goal !== 'home') {
      const list = (node.services[a.goal] || []).filter(b => g.isOperational(b));
      if (list.length) {
        const b = list.sort((x, y) => (x.occ || 0) / BUILDINGS[x.type].seats - (y.occ || 0) / BUILDINGS[y.type].seats)[0];
        const B = BUILDINGS[b.type];
        const seats = B.seats / this.k;
        if ((b.occ || 0) < seats) {
          this.useService(a, b, B, minute, rng);
          return;
        } else {
          a.happy -= 2; this.complain(a.goal === 'food' ? 'foodFull' : 'serviceFull');
          if (a.goal === 'food') { a.lunch = true; a.goal = null; }
          else if (a.goal === 'toilet') { a.bladder = 0.5; a.goal = null; }
          else a.goal = a.goal === 'apres' ? 'home' : null;
        }
      }
    }
    // follow route to goal
    if (a.goal) {
      const R = this.route(a.skill, a.goal);
      const eid = R.next[a.node];
      if (eid >= 0) { this.takeEdge(a, w.edges[eid], rng); return; }
      // unreachable goal
      if (a.goal === 'home') {
        a.stuck++;
        if (a.stuck > 3 || closing) {
          a.happy -= 15; this.complain('stranded');
          g.dayStats.stranded += this.k;
          a.state = 'gone';
          return;
        }
      } else {
        if (a.goal === 'food') { a.lunch = true; a.happy -= 5; this.complain('noFood'); }
        if (a.goal === 'toilet') { a.bladder = 0.3; a.happy -= 6; this.complain('noToilet'); }
        if (a.goal === 'rental' || a.goal === 'school') this.complain(a.goal === 'rental' ? 'noRental' : 'noSchool', 0.5);
        a.goal = a.goal === 'apres' ? 'home' : null;
      }
      if (a.goal) return;
    }
    // free roaming: choose among outgoing edges that keep a way home
    const home = this.route(a.skill, 'home');
    let total = 0;
    const cand = [];
    for (const eid of node.out) {
      const e = w.edges[eid];
      if (e.kind === 'liftDown') continue;
      if (!w.edgeUsable(e, a.skill)) continue;
      if (!isFinite(home.dist[e.to])) continue;
      let sc;
      if (e.kind === 'lift') {
        const wait = this.waitOf(e.ref);
        const top = w.nodes[e.to];
        let topVal = 0.1;
        for (const oid of top.out) { const oe = w.edges[oid]; if (oe.kind === 'piste' && w.edgeUsable(oe, a.skill)) topVal = Math.max(topVal, DIFF_PREF[a.skill][oe.ref.difficulty]); }
        sc = (0.7 + topVal) * Math.exp(-wait / 900) * (e.ref.type === 'carpet' ? (a.skill === 0 ? 1.5 : 0.02) : 1);
      } else if (e.kind === 'piste') {
        const p = e.ref;
        sc = DIFF_PREF[a.skill][p.difficulty] * (0.55 + p.snow.quality / 120) * (a.visited.has(p.id) ? 0.85 : 1.2) * 1.2;
        if (p.snow.surface === 'powder' && a.skill >= 2) sc *= 1.6;
      } else {
        sc = a.lastEdgeKind === 'walk' && e.to === a.prevNode ? 0.01 : 0.22;
      }
      if (sc > 0.005) { cand.push([e, sc]); total += sc; }
    }
    if (!cand.length) {
      // nothing to do here: head home
      a.goal = 'home';
      a.stuck++;
      if (a.stuck > 4) { a.state = 'gone'; }
      return;
    }
    let r = rng() * total;
    for (const [e, sc] of cand) { r -= sc; if (r <= 0) { this.takeEdge(a, e, rng); return; } }
    this.takeEdge(a, cand[cand.length - 1][0], rng);
  }

  useService(a, b, B, minute, rng) {
    const g = this.game;
    b.occ = (b.occ || 0) + 1;
    a.building = b;
    a.state = 'service';
    const dwell = B.dwell * (0.7 + rng() * 0.6);
    a.serviceUntil = minute + dwell;
    let spend = 0;
    const svc = a.goal === 'toilet' ? 'toilet' : B.service;
    switch (svc) {
      case 'food':
        spend = B.spend * g.s.prices.food; a.hunger = 0; a.lunch = true; a.energy = Math.min(1, a.energy + 0.25);
        a.happy += 4 * (B.charm || 1) - Math.max(0, g.s.prices.food - 1.1) * 8;
        this.praiseFor(b.type === 'hut' ? 'hut' : 'food');
        if (a.bladder > 0.5) a.bladder = 0.35; // restaurants have toilets
        g.earn('food', spend * this.k); break;
      case 'toilet': a.bladder = 0; a.happy += 1; if (B.service !== 'toilet') a.serviceUntil = minute + 5; break;
      case 'apres': spend = B.spend * g.s.prices.food; a.apres = true; a.happy += 5; a.goal = 'home'; g.earn('food', spend * this.k); this.praiseFor('apres'); break;
      case 'rental': spend = g.s.prices.rental; a.happy += 2 - Math.max(0, (g.s.prices.rental - 40) / 10); g.earn('rental', spend * this.k); break;
      case 'school': {
        const pupils = g.crowd.agents.filter(x => x.state === 'service' && x.building?.type === 'school').length * this.k;
        if (pupils > g.s.staff.instructor * 8) { a.happy -= 3; this.complain('noInstructors'); a.serviceUntil = minute + 5; break; }
        spend = g.s.prices.school; a.happy += 7 - Math.max(0, (g.s.prices.school - 70) / 10); g.earn('school', spend * this.k); this.praiseFor('school');
        break;
      }
    }
    b.stats.visitsToday += this.k;
    b.stats.revenueToday += spend * this.k;
    if (a.goal === svc || (svc === 'apres' && a.goal === 'home')) a.goal = svc === 'apres' ? 'home' : null;
  }

  takeEdge(a, e, rng) {
    const w = this.game.world;
    a.prevNode = a.node;
    a.edge = e.id; a.s = 0;
    if (e.kind === 'lift') {
      if (e.ref.status !== 'open') { a.happy -= 1; return; }
      a.state = 'queue';
      e.ref.queue.push(a);
    } else if (e.kind === 'liftDown') {
      a.state = 'liftDown'; a.s = 0;
    } else if (e.kind === 'piste') {
      a.state = 'ski';
    } else {
      a.state = 'walk';
    }
  }

  // ---------- rendering positions ----------
  computePositions() {
    const w = this.game.world, t = this.game.terrain;
    for (const a of this.agents) {
      const e = a.edge != null ? w.edges[a.edge] : null;
      if (a.state === 'atNode' || a.state === 'service' || !e) {
        const n = w.nodes[a.node];
        if (n) {
          if (a.state === 'service' && a.building) {
            a.pos[0] = a.building.x; a.pos[1] = -9999; a.pos[2] = a.building.z;
          } else {
            a.pos[0] = n.x + a.lane * 18; a.pos[2] = n.z + Math.sin(a.phase) * 10; a.pos[1] = t.surfaceAt(a.pos[0], a.pos[2]) + 1.2;
          }
        }
        continue;
      }
      if (a.state === 'queue') {
        const l = e.ref;
        const qi = l.queue.indexOf(a);
        const dx = l.b[0] - l.a[0], dz = l.b[1] - l.a[1], L = Math.hypot(dx, dz) || 1;
        const back = 8 + (qi % 60) * 1.4, side = ((qi * 7) % 9 - 4) * 1.6;
        a.pos[0] = l.a[0] - (dx / L) * back + (-dz / L) * side;
        a.pos[2] = l.a[1] - (dz / L) * back + (dx / L) * side;
        a.pos[1] = t.surfaceAt(a.pos[0], a.pos[2]) + 1.2;
        continue;
      }
      if (a.state === 'lift' || a.state === 'liftDown') {
        const l = e.ref;
        let f = clamp(a.s / l.length, 0, 1);
        if (a.state === 'liftDown') f = 1 - f;
        const c = l.cable;
        const idx = f * (c.length - 1);
        const i0 = Math.floor(idx), i1 = Math.min(c.length - 1, i0 + 1), u = idx - i0;
        a.pos[0] = c[i0][0] + (c[i1][0] - c[i0][0]) * u;
        a.pos[1] = c[i0][1] + (c[i1][1] - c[i0][1]) * u - (LIFTS[l.type].surface ? 5.5 : 3.5);
        a.pos[2] = c[i0][2] + (c[i1][2] - c[i0][2]) * u;
        if (LIFTS[l.type].surface) a.pos[1] = t.surfaceAt(a.pos[0], a.pos[2]) + 1.2;
        continue;
      }
      if (a.state === 'walk') {
        const f = clamp(a.s / e.len, 0, 1);
        const A = w.nodes[e.from], B = w.nodes[e.to];
        a.pos[0] = A.x + (B.x - A.x) * f; a.pos[2] = A.z + (B.z - A.z) * f;
        a.pos[1] = t.surfaceAt(a.pos[0], a.pos[2]) + 1.2;
        continue;
      }
      // skiing: S-turns across the piste
      const p0 = pointAt(e.pts, a.s), p1 = pointAt(e.pts, a.s + 4);
      const dx = p1[0] - p0[0], dz = p1[1] - p0[1], L = Math.hypot(dx, dz) || 1;
      const off = (a.lane * 0.6 + Math.sin(a.s / (a.skill >= 2 ? 22 : 14) + a.phase) * 0.35) * (e.ref.width / 2);
      a.pos[0] = p0[0] + (-dz / L) * off; a.pos[2] = p0[1] + (dx / L) * off;
      a.pos[1] = t.surfaceAt(a.pos[0], a.pos[2]) + 1.2;
      a.heading = Math.atan2(dx, dz);
    }
  }
}

export { GOALS, dist };
