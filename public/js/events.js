// Random happenings, natural hazards, competitions (World Cup, World Championships, Olympics),
// marketing campaigns and end-of-season awards.

import { clamp, mulberry32, hash32, money, int, dist } from './util.js';
import { competitionsAround, ymdFromDay, isSkiSeason, DISCIPLINES } from './shared/calendar.js';
import { FAMOUS_RESORTS } from './shared/resorts.js';
import { BUILDINGS, DIFF } from './catalog.js';
import { t } from './i18n.js';

// Localised competition title (calendar titles are English with years baked in)
export function compTitle(c) {
  const ys = c.hemi === 'S' ? String(ymdFromDay(c.eventDay).y) : (() => { const y = ymdFromDay(c.eventDay).y; const m = ymdFromDay(c.eventDay).m; const Y = m >= 7 ? y : y - 1; return `${Y}/${String((Y + 1) % 100).padStart(2, '0')}`; })();
  const disc = DISCIPLINES[c.discipline || c.disc] ? t(DISCIPLINES[c.discipline || c.disc].name) : '';
  switch (c.type) {
    case 'olympics': return `${t('Winter Olympic Games')} ${ymdFromDay(c.eventDay ?? c.start).y}`;
    case 'worldchamps': return `${t('Alpine World Ski Championships')} ${ymdFromDay(c.eventDay ?? c.start).y}`;
    case 'freestyle': return `${t('Freestyle World Cup')} – ${disc} ${ys}`;
    default: return c.hemi === 'S' ? `${t('Southern Hemisphere Cup')} – ${disc} ${ys}` : `${t('Alpine World Cup')} – ${disc} ${ys}`;
  }
}

export const CAMPAIGNS = [
  { id: 'social', name: 'Social media campaign', cost: 60000, days: 14, demand: 1.06, desc: '+6% visitors for two weeks.' },
  { id: 'influencer', name: 'Invite ski influencers', cost: 35000, days: 10, demand: 1.04, fame: 0.4, desc: 'A few reels from your best pistes.' },
  { id: 'deal', name: 'Early-bird pass deals', cost: 120000, days: 21, demand: 1.09, desc: '+9% visitors for three weeks.' },
  { id: 'fair', name: 'International ski fairs', cost: 220000, days: 60, demand: 1.05, fame: 1.5, desc: 'Stands in Munich, Milan, London and Warsaw.' },
  { id: 'tv', name: 'TV & billboard campaign', cost: 450000, days: 30, demand: 1.12, fame: 2, desc: '+12% visitors for a month and more fame.' },
];

const CELEBS = ['pop star Lumi Vance', 'actor Dario Kestel', 'tennis legend Mara Okafor', 'F1 driver Niko Halvorsen', 'chef Benedetta Rauch', 'rapper K-Glacier', 'Olympic swimmer Iris Taalberg', 'film director Paolo Sirmione'];
const FIRST = ['M.', 'L.', 'A.', 'F.', 'S.', 'J.', 'K.', 'D.', 'E.', 'R.', 'T.', 'P.'];
const SUR = ['Brunner', 'Kastler', 'Odermatt-Ruiz', 'Feldberg', 'Lindqvist', 'Moretti', 'Haugland', 'Pichler', 'Vasseur', 'Kovač', 'Strand', 'Delacroix', 'Zanin', 'Holzer', 'Nakamura', 'Ellery'];
const NATIONS = ['ITA', 'AUT', 'SUI', 'FRA', 'NOR', 'SLO', 'USA', 'CAN', 'GER', 'SWE', 'CRO', 'JPN'];

export class Events {
  constructor(game) {
    this.g = game;
    this.visitorBoost = 0;
    this.strikeToday = false;
  }
  get s() { return this.g.s; }
  rng() { return this.g.rng(); }

  onDayStart(fast) {
    const g = this.g, s = this.s, day = s.day;
    this.visitorBoost = 0;
    this.strikeToday = false;
    for (const m of s.mods) if (m.until >= day && m.visitors) this.visitorBoost += m.visitors;
    s.mods = s.mods.filter(m => m.until >= day);
    s.marketing = s.marketing.filter(m => m.until >= day);
    const inSeason = isSkiSeason(day, g.hemi);
    // season start headline
    const ymd = ymdFromDay(day);
    const w = g.weatherNow;
    if (!fast && ((g.hemi === 'N' && ymd.m === 11 && ymd.d === 15) || (g.hemi === 'S' && ymd.m === 5 && ymd.d === 25))) {
      const ch = w.character;
      if (ch === 'epic') g.notify('good', t('Meteorologists expect an exceptionally snowy winter!'), null, '❄️');
      else if (ch === 'poor') g.notify('warn', t('Long-range forecasts point to a dry, mild winter. Snowmaking will be key.'), null, '🌡️');
    }
    this._competitionDay(fast);
    if (!inSeason) return;
    this._avalanches(fast);
    if (fast) { if (s.morale < 25 && this.rng() < 0.03) this.strikeToday = true; return; }
    const r = () => this.rng();
    if (s.morale < 30 && r() < 0.06) {
      this.strikeToday = true;
      g.notify('bad', t('Staff are on strike over low wages! All lifts are closed today.'), null, '✊');
      s.rep -= 1.5;
    }
    if (r() < 0.008) {
      const c = CELEBS[Math.floor(r() * CELEBS.length)];
      s.mods.push({ until: day + 3, visitors: 0.08 });
      s.fame = clamp(s.fame + 0.8, 0, 100);
      g.notify('good', t('Paparazzi alert: {c} is skiing at your resort!', { c }), null, '⭐');
      g.universe?.client?.postNews?.('celebrity', `${c} spotted skiing at ${s.name}`, s.siteId);
    }
    const dow = ymd.dow;
    if (dow >= 1 && dow <= 4 && r() < 0.03) { this.visitorBoost += 0.12; g.notify('info', t('Three coaches of school groups arrived this morning.'), null, '🚌'); }
    if (r() < 0.004) {
      const at = 600 + Math.floor(r() * 300), dur = 40 + Math.floor(r() * 80);
      const now = day * 1440 + s.minute;
      for (const l of g.world.lifts) {
        if ((l.brokenUntil || 0) > now) continue; // already down (repair or maintenance): keep that window
        l.brokenFrom = day * 1440 + at; l.brokenUntil = day * 1440 + at + dur;
      }
      g.notify('warn', t('The grid operator warns of a power cut around {t} today.', { t: `${Math.floor(at / 60)}:${String(at % 60).padStart(2, '0')}` }), null, '⚡');
    }
    if (r() < 0.01) this._inspection();
    const seats = g.world.buildings.filter(b => BUILDINGS[b.type].seats && BUILDINGS[b.type].service === 'food').reduce((a, b) => a + BUILDINGS[b.type].seats, 0);
    if (seats > 0 && s.staff.host < seats / 80 && r() < 0.015) {
      s.rep -= 3;
      g.notify('bad', t('Food poisoning at one of your huts! Understaffed kitchens cut corners. Hire hospitality staff.'), null, '🤢');
    }
    if (r() < 0.006) {
      const ok = s.staff.patrol >= 3 && g.world.buildings.some(b => b.type === 'patrol');
      if (ok) { s.rep += 1; g.notify('good', t('A lost child was found by your ski patrol within 20 minutes. The family is grateful.'), null, '🧒'); }
      else { s.rep -= 2; g.notify('bad', t('A child went missing on the slopes and it took hours to find her. Your patrol is too small.'), null, '🧒'); }
    }
    if (r() < 0.012) {
      const animals = ['A herd of chamois crosses the pistes at dawn.', 'A golden eagle is circling over the top station.', 'Fox tracks all over the fresh corduroy this morning.', 'An ibex is posing for photos near the hut.'];
      g.notify('info', t(animals[Math.floor(r() * animals.length)]), null, '🦌');
    }
    if (r() < 0.003) { s.mods.push({ until: day + 30, energy: 1.7 }); g.notify('warn', t('Energy prices have spiked: lift and snowmaking costs +70% for a month.'), null, '📈'); }
    if (r() < 0.0015) {
      if (r() < 0.5) { s.mods.push({ until: day + 60, demand: 0.88 }); g.notify('warn', t('Economic slowdown: fewer holidays booked this season.'), null, '📉'); }
      else { s.mods.push({ until: day + 60, demand: 1.08 }); g.notify('good', t('Tourism boom: bookings are up everywhere!'), null, '📈'); }
    }
    if (r() < 0.004) {
      const grant = Math.round((200 + r() * 800) * 1000);
      g.earn('grants', grant);
      g.notify('good', t('The regional government awards you a tourism grant of {c}.', { c: money(grant) }), null, '🏛️');
    }
    if (s.rep > 72 && r() < 0.004) { s.fame = clamp(s.fame + 2, 0, 100); g.notify('good', t('A TV documentary about your resort airs tonight across Europe.'), null, '📺'); }
    // weather warnings for tomorrow
    const tm = g.climate.day(day + 1);
    if (tm.state === 'blizzard') g.notify('warn', t('Storm warning for tomorrow: strong wind and heavy snow. Many lifts may close.'), null, '🌬️');
    else if (tm.state === 'heavysnow') g.notify('info', t('Heavy snowfall expected tomorrow: about {cm} cm at 2000 m.', { cm: Math.round(g.climate.snowfallAt(tm, 2000)) }), null, '❄️');
    else if (tm.regime === 'foehn' && w.regime !== 'foehn') g.notify('warn', t('Foehn wind tomorrow: warm, gusty and bad for the snow.'), null, '🌡️');
    else if (tm.regime === 'cold' && w.regime !== 'cold') g.notify('info', t('Arctic air arriving: perfect nights for snowmaking, freezing days for guests.'), null, '🥶');
    else if (tm.state === 'rain' && w.state !== 'rain') g.notify('warn', t('Rain expected tomorrow below {h} m. Expect slush and ice afterwards.', { h: Math.round(g.climate.snowline(tm) / 100) * 100 }), null, '🌧️');
    if (g.freshPowder && (w.state === 'sunny' || w.state === 'partly')) g.notify('good', t('Bluebird powder day! Fresh snow and sunshine: expect crowds.'), null, '🤩');
    // periodic status updates during the day are applied by the sim
  }

  onDayEnd(fast) {
    this._resolveCompetitions(fast);
  }

  _inspection() {
    const g = this.g, s = this.s;
    const lifts = g.world.lifts.filter(l => g.isBuilt(l));
    if (!lifts.length) return;
    const cond = lifts.reduce((a, l) => a + l.condition, 0) / lifts.length;
    const mech = s.staff.mechanic / Math.max(1, lifts.length / 3);
    const km = g.world.pistes.reduce((a, p) => a + p.length, 0) / 1000;
    const patrol = s.staff.patrol / Math.max(1, km / 6);
    const score = cond / 100 * 0.5 + Math.min(1, mech) * 0.25 + Math.min(1, patrol) * 0.25;
    if (score > 0.8) { s.rep += 2; g.notify('good', t('Safety inspectors visited today: everything in order. Certificate of excellence awarded!'), null, '📋'); }
    else if (score < 0.55) {
      const fine = Math.round(100000 + (0.55 - score) * 1e6);
      g.spend('fines', fine); s.rep -= 2;
      g.notify('bad', t('Safety inspectors found worn lifts and too few staff. Fine: {c}.', { c: money(fine) }), null, '📋');
    } else g.notify('info', t('Safety inspectors visited: some remarks, no fine.'), null, '📋');
  }

  _avalanches(fast) {
    const g = this.g, s = this.s, A = s.avy;
    if (A.level < 3) return;
    const towers = g.world.buildings.filter(b => b.type === 'gazex' && g.isOperational(b));
    const patrolOK = g.world.buildings.some(b => b.type === 'patrol' && g.isOperational(b)) && s.staff.patrol >= 2;
    for (const p of g.world.pistes) {
      if (!g.isBuilt(p) || p.avyExp < 0.08) continue;
      const mid = p.pts[Math.floor(p.pts.length / 2)];
      const protectedByTower = towers.some(b => dist(b.x, b.z, mid[0], mid[1]) < BUILDINGS.gazex.radius);
      let risk = (A.level - 2) * 0.012 * Math.min(1, p.avyExp * 3) * (A.controlled ? 0.2 : 1) * (protectedByTower ? 0.2 : 1);
      // patrol closes the most exposed pistes on high danger days
      if (A.level >= 4 && p.avyExp > 0.25 && patrolOK && !protectedByTower && p.status !== 'avalanche') {
        p.avalancheUntil = s.day;
        if (!fast && this.rng() < 0.5) g.notify('info', t('Patrol closed {p} today: avalanche danger {l}/5.', { p: p.name, l: A.level }), p.id, '🚧');
        continue;
      }
      if (this.rng() < risk) {
        p.avalancheUntil = s.day + 1 + Math.floor(this.rng() * 3);
        const caught = p.open && !A.controlled ? Math.floor(this.rng() * 3) : 0;
        s.rep -= caught ? 5 : 1;
        if (caught) { s.season.injuries += caught; g.spend('fines', caught * 120000); }
        if (!fast) g.notify('bad', caught ? t('Avalanche on {p}! {n} skiers were caught and dug out by the patrol. Piste closed.', { p: p.name, n: caught }) : t('An avalanche came down across {p}. Nobody hurt, piste closed for clearing.', { p: p.name }), p.id, '🏔️');
        g.universe?.client?.postNews?.('avalanche', `Avalanche at ${s.name} (${p.name})`, s.siteId);
      }
    }
  }

  // ---------- competitions ----------
  list() {
    const g = this.g;
    return competitionsAround(this.s.day).filter(c => c.hemi === g.hemi);
  }
  minBedsHave() { return (this.g.def.beds || 2000) + this.g.ownBeds(); }

  eligibility(comp, eventDayOverride) {
    const g = this.g, s = this.s, req = comp.req;
    const evDay = eventDayOverride ?? comp.eventDay;
    const reasons = [];
    const ready = e => e.buildUntil <= evDay;
    if (s.rep < req.minRating) reasons.push(t('Rating {a} (needs {b})', { a: Math.round(s.rep), b: req.minRating }));
    const beds = this.minBedsHave();
    if (beds < req.minBeds) reasons.push(t('{a} beds (needs {b})', { a: int(beds), b: int(req.minBeds) }));
    if (req.hostedWorldCup && s.hosted.worldcup < req.hostedWorldCup) reasons.push(t('Must have hosted {n} World Cup races', { n: req.hostedWorldCup }));
    for (const [type, n] of Object.entries(req.buildings || {})) {
      const have = g.world.buildings.filter(b => b.type === type && ready(b)).length;
      if (have < n) reasons.push(t('{n}× {b} required', { n, b: t(BUILDINGS[type].name) }));
    }
    let pistes = [];
    if (comp.discipline !== 'BA') {
      const minV = req.minVertical;
      const grand = g.world.buildings.filter(b => b.type === 'grandstand' && ready(b));
      pistes = g.world.pistes.filter(p => ready(p) && p.drop >= (comp.discipline === 'DH+SL' ? DISCIPLINES.SL.minVertical : minV) && p.difficulty >= Math.min(req.minDiff, 3) - (comp.discipline === 'DH+SL' ? 1 : 0) && (!req.snowmaking || p.snowmaking));
      const withStand = pistes.filter(p => { const e = p.pts[p.pts.length - 1]; return grand.some(b => dist(b.x, b.z, e[0], e[1]) < 600); });
      if (comp.discipline === 'DH+SL') {
        const dh = withStand.filter(p => p.drop >= minV && p.difficulty >= 2);
        if (!dh.length) reasons.push(t('A speed piste with {v} m vertical, snowmaking and a Finish Stadium', { v: minV }));
        pistes = dh.length ? dh : withStand;
      } else {
        if (!pistes.length) reasons.push(t('A piste rated {d} or harder with {v} m vertical drop{s}', { d: t(DIFF[Math.min(req.minDiff, 3)].name), v: minV, s: req.snowmaking ? t(' and snowmaking') : '' }));
        else if (!withStand.length) reasons.push(t('A Finish Stadium within 600 m of the piste finish'));
        pistes = withStand;
      }
    }
    return { ok: reasons.length === 0, reasons, pistes };
  }

  bidCost(comp) { return { worldcup: 150000, freestyle: 90000, worldchamps: 1500000, olympics: 8000000 }[comp.type] || 100000; }

  bidScore(comp, lobby = 0) {
    const g = this.g, s = this.s;
    const el = this.eligibility(comp);
    const p = el.pistes.sort((a, b) => b.drop - a.drop)[0];
    const vert = p ? clamp(p.drop / Math.max(140, comp.req.minVertical) / 1.4, 0, 1) : (comp.discipline === 'BA' ? 0.8 : 0);
    const top = Math.max(0, ...g.world.lifts.map(l => l.yb));
    const snowRel = clamp((top - 1400) / 1400, 0, 1);
    const beds = clamp(this.minBedsHave() / comp.req.minBeds / 2, 0, 1);
    const hist = Math.min(20, s.hosted.worldcup * 1.5 + s.hosted.worldchamps * 5 + s.hosted.olympics * 10);
    const score = 30 * s.rep / 100 + 20 * s.fame / 100 + 15 * vert + 10 * snowRel + 10 * beds + hist + lobby * 2.5;
    return Math.round(score * 100) / 100;
  }

  placeBid(comp, lobby = 0) {
    const g = this.g, s = this.s;
    const el = this.eligibility(comp);
    if (!el.ok) return { ok: false, error: el.reasons.join('; ') };
    const cost = this.bidCost(comp) * (1 + lobby * 1.5);
    if (!g.canAfford(cost)) return { ok: false, error: t('Not enough money: you need {c}.', { c: money(cost) }) };
    g.spend('events', cost);
    const score = this.bidScore(comp, lobby);
    const piste = el.pistes.sort((a, b) => b.drop - a.drop)[0];
    s.comps[comp.id] = { status: 'bid', score, pisteId: piste?.id || null, lobby, title: compTitle(comp) };
    g.notify('info', t('Bid submitted for {c} (score {s}).', { c: compTitle(comp), s: score }), null, '📨');
    if (g.universe?.client) g.universe.client.bid(comp.id, s.siteId, score).catch(e => g.notify('bad', `Bid failed on server: ${e.message}`));
    g.emit('cash'); g.emit('comps');
    return { ok: true, score };
  }

  rivals(comp) {
    const rng = mulberry32(hash32('rivals', comp.id, this.s.seed));
    const pool = FAMOUS_RESORTS.filter(r => r.id !== this.g.def.id && (comp.hemi === 'S' ? r.lat < 0 : r.lat > 0));
    const n = comp.type === 'olympics' ? 4 : comp.type === 'worldchamps' ? 3 : 2 + Math.floor(rng() * 2);
    const base = { worldcup: 52, freestyle: 48, worldchamps: 62, olympics: 70 }[comp.type] || 50;
    const out = [];
    for (let i = 0; i < n && pool.length; i++) {
      const r = pool.splice(Math.floor(rng() * pool.length), 1)[0];
      out.push({ name: r.name, score: Math.round((base + (r.fame - 75) * 0.25 + (rng() - 0.5) * 18) * 100) / 100 });
    }
    return out.sort((a, b) => b.score - a.score);
  }

  _resolveCompetitions(fast) {
    const g = this.g, s = this.s, day = s.day;
    for (const comp of this.list()) {
      const st = s.comps[comp.id];
      if (!st || st.status !== 'bid') continue;
      if (g.universe) {
        const srv = g.universe.client?.compById?.(comp.id);
        if (!srv || srv.status === 'open') continue;
        if (srv.status === 'awarded') this._award(comp, srv.winnerSiteId === s.siteId, srv.winnerName || '?', fast);
        else { st.status = 'lost'; }
        continue;
      }
      if (day < comp.bidDeadlineDay) continue;
      const rv = this.rivals(comp);
      st.rivals = rv;
      const win = !rv.length || st.score > rv[0].score;
      this._award(comp, win, win ? s.name : rv[0].name, fast);
    }
  }

  _award(comp, win, winnerName, fast) {
    const g = this.g, s = this.s;
    const st = s.comps[comp.id];
    st.status = win ? 'won' : 'lost';
    st.winner = winnerName;
    if (win) {
      s.scheduled.push({ id: comp.id, title: compTitle(comp), type: comp.type, hemi: comp.hemi, eventDay: comp.eventDay, disc: comp.discipline, start: comp.eventDay, end: comp.eventDay + comp.durationDays - 1, pisteId: st.pisteId, prize: comp.prize, fame: comp.fame, raced: 0, failed: 0 });
      const d = ymdFromDay(comp.eventDay);
      g.notify('good', t('You won the bid! {c} will be held here on {d}.', { c: compTitle(comp), d: `${d.d}/${d.m}/${d.y}` }), null, '🏅');
      s.rep += comp.type === 'olympics' ? 5 : 1;
    } else if (!fast) g.notify('info', t('{w} was chosen to host {c}.', { w: winnerName, c: compTitle(comp) }), null, '📨');
    g.emit('comps');
  }

  _competitionDay(fast) {
    const g = this.g, s = this.s, day = s.day, w = g.weatherNow;
    for (const ev of s.scheduled) {
      if (ev.done) continue;
      const piste = ev.pisteId ? g.world.find(ev.pisteId) : null;
      if (piste && day >= ev.start - 2 && day <= ev.end) piste.raceUntil = ev.end;
      if (day === ev.start - 7 && !fast) g.notify('info', t('{c} starts in one week. Make sure {p} has deep, groomed snow.', { c: ev.title, p: piste?.name || t('the venue') }), piste?.id, '🏁');
      if (day < ev.start || day > ev.end) continue;
      // race day
      const bad = ['blizzard', 'heavysnow', 'rain'].includes(w.state) || (w.state === 'fog' && this.rng() < 0.6) || (piste && g.climate.windAt(w, piste.top) > 75);
      const snowBad = piste && (piste.snow.depth < 35 || piste.snow.quality < 55);
      const scale = { worldcup: 1, freestyle: 0.7, worldchamps: 2.2, olympics: 5 }[ev.type] || 1;
      const spectators = Math.round(9000 * scale * (0.5 + s.fame / 100));
      if (bad || snowBad) {
        ev.failed++;
        if (!fast) g.notify('warn', snowBad ? t('{c}: the jury rejected the piste, snow too poor. Postponed.', { c: ev.title }) : t('{c}: postponed due to weather.', { c: ev.title }), piste?.id, '🏁');
      } else {
        ev.raced++;
        this.visitorBoost += 0.15 * scale;
        const tix = spectators * (ev.type === 'olympics' ? 60 : 30);
        g.earn('events', tix + spectators * 18 * s.prices.food);
        g.dayStats.spectators = spectators;
        if (!fast) {
          const winner = `${FIRST[Math.floor(this.rng() * FIRST.length)]} ${SUR[Math.floor(this.rng() * SUR.length)]} (${NATIONS[Math.floor(this.rng() * NATIONS.length)]})`;
          const time = ev.disc === 'BA' ? `${(85 + this.rng() * 12).toFixed(2)} pts` : `${1 + Math.floor(this.rng() * 1.2)}:${String(Math.floor(10 + this.rng() * 49)).padStart(2, '0')}.${String(Math.floor(this.rng() * 100)).padStart(2, '0')}`;
          g.notify('good', t('{c}: {n} spectators watched {w} win in {t}.', { c: ev.title, n: int(spectators), w: winner, t: time }), piste?.id, '🏆');
        }
      }
      if (day === ev.end || (ev.raced >= Math.min(2, ev.end - ev.start + 1))) {
        if (day < ev.end && ev.raced < ev.end - ev.start + 1 && ev.type !== 'worldcup' && ev.type !== 'freestyle') continue;
        ev.done = true;
        if (piste) piste.raceUntil = 0;
        if (ev.raced > 0) {
          const net = ev.prize * 0.65;
          g.earn('events', net);
          s.fame = clamp(s.fame + ev.fame, 0, 100);
          s.rep = clamp(s.rep + (ev.type === 'olympics' ? 8 : ev.type === 'worldchamps' ? 4 : 2), 0, 100);
          s.hosted[ev.type === 'freestyle' ? 'freestyle' : ev.type] = (s.hosted[ev.type === 'freestyle' ? 'freestyle' : ev.type] || 0) + 1;
          if (ev.type === 'freestyle') s.hosted.worldcup = s.hosted.worldcup; // freestyle doesn't count as alpine WC
          s.season.events.push(ev.title);
          g.notify('good', t('{c} was a success! TV rights and sponsors: {m}. Fame +{f}.', { c: ev.title, m: money(net), f: ev.fame }), null, '🎉');
          g.universe?.client?.postNews?.('event', `${s.name} hosted ${ev.title}`, s.siteId); // news feed stays in the poster's language
        } else {
          g.earn('events', ev.prize * 0.2);
          s.fame = clamp(s.fame - 2, 0, 100);
          g.notify('bad', t('{c} had to be cancelled. Insurance covers only part of the losses.', { c: ev.title }), null, '❌');
        }
      }
    }
    s.scheduled = s.scheduled.filter(e => !e.done || e.end > day - 30);
  }

  seasonAwards(se) {
    const g = this.g, s = this.s;
    if (se.visitors < 5000) return;
    const awards = [];
    const happy = se.happy ?? 60;
    if (happy >= 80) awards.push({ name: 'Golden Gondola: best guest experience', cash: 500000, rep: 2 });
    if (se.visitors > 30000 && se.injuries / se.visitors * 10000 < 1.1) awards.push({ name: 'Safest Resort of the Year', cash: 200000, rep: 1 });
    if (se.openDays >= 125) awards.push({ name: 'Snow King: longest season', cash: 250000, rep: 1 });
    if (se.visitors > 1000000) awards.push({ name: 'Crowd Puller: one million skier days', cash: 400000, rep: 1 });
    if (se.revenue - se.expenses > 20e6) awards.push({ name: 'Golden Ski Pass: most profitable', cash: 0, rep: 1, fame: 1 });
    if (g.hasResearch('solar') && se.snowmade < 600000) awards.push({ name: 'Green Mountain: eco award', cash: 150000, rep: 1 });
    if (happy < 45) awards.push({ name: 'Wooden Spoon: worst resort of the season', cash: 0, rep: -3 });
    for (const a of awards) {
      if (a.cash) g.earn('awards', a.cash);
      s.rep = clamp(s.rep + a.rep, 0, 100);
      if (a.fame) s.fame = clamp(s.fame + a.fame, 0, 100);
    }
    se.awards = awards.map(a => a.name);
    if (awards.length) g.notify(awards.some(a => a.rep < 0) ? 'bad' : 'good', t('Season awards: {a}', { a: awards.map(a => t(a.name)).join(' · ') }), null, '🏆');
  }
}
