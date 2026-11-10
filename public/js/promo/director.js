// Promo trailer director: drives the real game frame by frame (camera, time of day, weather,
// skiers, construction previews) and draws the social-media overlays. Used by tools/record-trailer.mjs
// on a page opened with ?record so the game's own loop stays idle.

import * as THREE from 'three';
import { LIFTS, DIFF } from '../catalog.js';
import { WorldMap } from '../ui/worldmap.js';
import { FAMOUS_RESORTS, findResort } from '../shared/resorts.js';
import { dayFromYMD } from '../shared/calendar.js';
import { pointAt, polyLength, clamp, smoothstep, lerp, dist, closestOnPoly, money, int, km } from '../util.js';
import { findFreeSpot } from '../osm.js';

export const FPS = 30;
const SIM_DM = 20 / FPS / 60; // game minutes per frame: skiers move ~20x real time

const TEXT = {
  it: {
    s1: ['Ski resort tycoon', 'Montagne <em>vere</em>.', "Cortina d'Ampezzo, ricostruita dai dati altimetrici reali"],
    s2: ['Dati OpenStreetMap', 'Impianti e piste <em>reali</em>', "Gestisci il comprensorio com'è oggi… o ricomincia da zero"],
    s3: ['Costruisci', 'Disegna il tuo <em>comprensorio</em>', 'La pendenza reale decide il colore di ogni pista'],
    s4: ['Simulazione', 'Migliaia di <em>sciatori</em>', 'Code, rifugi, scuole sci: ognuno con i suoi bisogni'],
    s5: ['Meteo dinamico', 'Bufere, ghiaccio, <em>neve fresca</em>', 'Innevamento, battitura, pericolo valanghe'],
    s6: ['Gestione', 'Di giorno <em>e di notte</em>', 'Personale, prezzi, ricerca, marketing'],
    s7: ['Grandi eventi', 'Ospita la <em>Coppa del Mondo</em>', '…e candidati alle Olimpiadi'],
    s8: ['Multiplayer', 'Un universo <em>online</em>', 'Cortina, Zermatt, Whistler… o qualsiasi montagna del pianeta'],
    tag: 'Il tycoon dello sci sulle montagne vere', cta: 'Gioca ora nel browser', bio: 'Link in bio',
    chips: { guests: 'sciatori oggi', rating: 'valutazione', cash: 'incasso giornaliero' },
    storm: 'Bufera · vento 85 km/h · impianti chiusi', powder: 'Powder day! Neve fresca e sole',
    live: 'LIVE', wc: 'Coppa del Mondo', dh: 'Discesa libera', lb: 'Classifica', owner: 'gestore',
    lift: 'Seggiovia 6 posti', piste: 'Nuova pista', pph: 'pers/h', diffs: ['Principianti', 'Facile', 'Media', 'Difficile'],
  },
  en: {
    s1: ['Ski resort tycoon', 'Real <em>mountains</em>.', "Cortina d'Ampezzo, rebuilt from real elevation data"],
    s2: ['OpenStreetMap data', 'Real lifts, real <em>pistes</em>', 'Run the resort as it is today… or start from scratch'],
    s3: ['Build', 'Design your <em>ski area</em>', 'The real gradient sets every piste colour'],
    s4: ['Simulation', 'Thousands of <em>skiers</em>', 'Queues, huts, ski schools: each with their own needs'],
    s5: ['Dynamic weather', 'Storms, ice, <em>fresh powder</em>', 'Snowmaking, grooming, avalanche danger'],
    s6: ['Management', 'Day <em>and night</em>', 'Staff, prices, research, marketing'],
    s7: ['Big events', 'Host the <em>World Cup</em>', '…and bid for the Olympics'],
    s8: ['Multiplayer', 'An online <em>universe</em>', 'Cortina, Zermatt, Whistler… or any mountain on Earth'],
    tag: 'The ski resort tycoon on real mountains', cta: 'Play now in your browser', bio: 'Link in bio',
    chips: { guests: 'skiers today', rating: 'rating', cash: 'daily revenue' },
    storm: 'Snowstorm · wind 85 km/h · lifts closed', powder: 'Powder day! Fresh snow and sunshine',
    live: 'LIVE', wc: 'World Cup', dh: 'Downhill', lb: 'Leaderboard', owner: 'owner',
    lift: '6-seat chairlift', piste: 'New piste', pph: 'pph', diffs: ['Beginner', 'Easy', 'Intermediate', 'Expert'],
  },
};

// timeline (seconds); music is 120 BPM so every cut lands on a bar line (2 s)
const SCENES = [
  { id: 's1', t0: 0, t1: 4 },
  { id: 's2', t0: 4, t1: 8 },
  { id: 's3', t0: 8, t1: 14 },
  { id: 's4', t0: 14, t1: 18 },
  { id: 's5', t0: 18, t1: 22 },
  { id: 's6', t0: 22, t1: 25 },
  { id: 's7', t0: 25, t1: 31 },
  { id: 's8', t0: 31, t1: 35 },
  { id: 'end', t0: 35, t1: 40 },
];
export const DURATION = 40;

const app = window.snowline;
let S = null;
const ease = x => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const out = x => 1 - Math.pow(1 - x, 3);

export async function setup({ lang = 'it' } = {}) {
  const L = TEXT[lang] || TEXT.it;
  await Promise.all(['800 40px "Barlow Condensed"', '700 20px "Barlow Condensed"', '600 18px Barlow', '700 16px Barlow'].map(f => document.fonts.load(f)));
  await app.startNew({ def: findResort('cortina'), layout: 'osm', difficulty: 'normal' });
  const g = app.game, s3 = app.s3, w = g.world, T = g.terrain, P = T.proj;
  document.getElementById('hud').style.display = 'none';
  const vertical = window.innerHeight > window.innerWidth;
  s3.camera.fov = vertical ? 62 : 42;
  s3.camera.updateProjectionMatrix();
  s3.controls.enabled = false;
  s3.renderer.domElement.style.filter = 'contrast(1.13) saturate(1.2) brightness(0.98)';
  // a busy, snowy January Saturday
  g.catchUp(dayFromYMD(2027, 1, 16));
  g.s.minute = 455;
  g._applyStatuses();
  g.startDay();
  g.s.minute = 455;
  while (g.s.minute < 655) g.advance(0.5);
  const xz = (lat, lon) => P.toXZ(lat, lon);
  const pts = {
    tofana: xz(46.5306, 12.0681), town: g.townXZ, torri: xz(46.5150, 12.048), faloria: xz(46.5263, 12.1608),
  };
  // ---- construction site: a new lift on untouched slopes
  const site = findBuildSite(g);
  // ---- race piste + finish stadium + spectators
  const race = w.pistes.filter(p => /olimpia|stratofana|schuss/i.test(p.name)).sort((a, b) => b.drop - a.drop)[0]
    || w.pistes.filter(p => p.difficulty >= 2).sort((a, b) => b.drop - a.drop)[0];
  const end = race.pts[race.pts.length - 1];
  const gs = findFreeSpot(w, 'grandstand', end[0], end[1], 70);
  if (gs) w.addBuilding(w.planBuilding('grandstand', gs[0], gs[1]), { day: g.s.day, instant: true });
  // lit pistes for the night scene, around the busiest base
  g.crowd.computePositions();
  const busy = busiestSpot(g);
  const crowdSpot = busiestSpot(g, 300, ['queue', 'ski', 'atNode', 'walk']);
  for (const p of w.pistes) if (dist(p.pts[0][0], p.pts[0][1], busy[0], busy[1]) < 3500 && p.difficulty <= 2) p.lighting = true;
  const lit = w.pistes.filter(p => p.lighting);
  const litCenter = lit.length ? [lit.reduce((a, p) => a + p.pts[0][0] + p.pts[p.pts.length - 1][0], 0) / (2 * lit.length), lit.reduce((a, p) => a + p.pts[0][1] + p.pts[p.pts.length - 1][1], 0) / (2 * lit.length)] : busy;
  w.rebuildGraph();
  app.layers.rebuildAll();
  // racer path: start where the piste gets steep
  const L0 = polyLength(race.pts);
  let bestS = 0, bestG = -1;
  for (let s = 0; s < L0 - 320; s += 20) {
    const a = pointAt(race.pts, s), b = pointAt(race.pts, s + 150);
    const gr = (T.heightAt(a[0], a[1]) - T.heightAt(b[0], b[1])) / 150;
    if (gr > bestG) { bestG = gr; bestS = s; }
  }
  const racer = makeRacer();
  s3.scene.add(racer);
  racer.visible = false;
  const crowd = makeCrowd(T, gs || end, race);
  s3.scene.add(crowd);
  crowd.visible = false;
  const gates = makeCourse(T, race, bestS);
  s3.scene.add(gates);
  gates.visible = false;
  // overlay
  const overlay = buildOverlay(vertical, L);
  // fake but plausible universe for the map scene
  const owners = { cortina: 'DolomitiDream', zermatt: 'MatterhornMax', whistler: 'PowderQueen', kitzbuehel: 'StreifKing', valgardena: 'SaslongSara', chamonix: 'AiguilleAce', niseko: 'JapowJunkie', aspen: 'BellsAspen', stanton: 'ArlbergAndi', verbier: 'FreerideFred', altabadia: 'GranRisa', courchevel: 'Altiport', vail: 'BackBowls', soelden: 'Ötzi', livigno: 'PiccoloTibet', bormio: 'StelvioSte', campiglio: 'Canalone', stmoritz: 'EngadinElla', garmisch: 'Kandahar', wengen: 'Lauberhorn', sestriere: 'ViaLattea' };
  const sites = FAMOUS_RESORTS.map(r => ({ ...r, ownerId: owners[r.id] ? 1 : null, ownerName: owners[r.id] || null, mine: r.id === 'cortina' }));
  const map = new WorldMap(overlay.querySelector('.p-map canvas'), { sites });
  const labelled = new Set(['cortina', 'zermatt', 'stmoritz', 'kitzbuehel', 'chamonix', 'stanton', 'livigno', 'courchevel']);
  map.labelFilter = st => labelled.has(st.id);
  S = { g, s3, w, T, L, pts, site, race, bestS, racer, crowd, gates, litCenter, crowdSpot, overlay, map, vertical, busy, built: { lift: false, piste: false }, lastScene: null };
  return { frames: DURATION * FPS, site: !!site, race: race.name };
}

// ---------- helpers for setup ----------
function findBuildSite(g) {
  const w = g.world, T = g.terrain;
  const cands = [];
  const near = (x, z, r) => w.lifts.some(l => closestOnPoly([l.a, l.b], x, z).d < r) || w.pistes.some(p => closestOnPoly(p.pts, x, z).d < r * 0.5);
  for (let z = T.z0 + 1500; z < -T.z0 - 1500; z += 400) for (let x = T.x0 + 1500; x < -T.x0 - 1500; x += 400) {
    const h = T.heightAt(x, z);
    if (h < 1450 || h > 2100 || T.slopeDeg(x, z) > 18 || near(x, z, 450)) continue;
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      const b = [x + Math.cos(a) * 1300, z + Math.sin(a) * 1300];
      if (near(b[0], b[1], 350)) continue;
      const plan = w.planLift('chair6', [x, z], b);
      const grade = plan.vertical / Math.max(1, plan.horiz);
      if (!plan.ok || plan.vertical < 200 || grade > 0.3) continue;
      const mx = (x + b[0]) / 2, mz = (z + b[1]) / 2;
      const sunny = T.southness(mx, mz);
      if (sunny < 0.1) continue;
      cands.push({ score: plan.vertical + sunny * 250 + (g.biome.forest(mx, mz) > 0.3 ? 60 : 0) - plan.pylons.reduce((s, p) => s + p.h, 0) * 0.5, plan });
    }
  }
  cands.sort((a, b) => b.score - a.score);
  let fallback = null;
  for (const c of cands.slice(0, 40)) {
    const r = pisteFor(w, T, c.plan);
    if (!r) continue;
    const site = { plan: c.plan, pistePts: r.pts, pistePlan: r.plan, mid: [(c.plan.a[0] + c.plan.b[0]) / 2, (c.plan.a[1] + c.plan.b[1]) / 2], dir: Math.atan2(c.plan.a[0] - c.plan.b[0], c.plan.a[1] - c.plan.b[1]) };
    if (r.plan.difficulty === 2) return site; // a red piste reads best on screen
    if (!fallback || r.plan.difficulty < 3) fallback = site;
  }
  return fallback;
}

// a piste from the lift top back to the bottom, gently snaking down the fall line
function pisteFor(w, T, plan) {
  const top = [plan.b[0], plan.b[1]], bot = [plan.a[0], plan.a[1]];
  const dx = bot[0] - top[0], dz = bot[1] - top[1], D = Math.hypot(dx, dz);
  const nx = -dz / D, nz = dx / D;
  let best = null;
  for (const amp of [420, 300, 200, 120, 40, -120, -250, -380]) {
    const side = Math.sign(amp) || 1;
    const raw = [];
    for (let i = 0; i <= 8; i++) {
      const u = i / 8;
      const off = Math.sin(u * Math.PI) * amp + Math.sin(u * Math.PI * 3) * Math.abs(amp) * 0.2;
      raw.push([top[0] + dx * u + nx * off + (i === 0 ? nx * 50 * side : 0), top[1] + dz * u + nz * off + (i === 0 ? nz * 50 * side : 0)]);
    }
    raw[raw.length - 1] = [bot[0] + nx * 45 * side, bot[1] + nz * 45 * side];
    const pp = w.planPiste(raw, {});
    if (!pp.ok) continue;
    if (pp.difficulty === 2) return { pts: raw, plan: pp };
    if (!best || Math.abs(pp.difficulty - 2) < Math.abs(best.plan.difficulty - 2)) best = { pts: raw, plan: pp };
  }
  return best;
}

function busiestSpot(g, cell = 600, states = null) {
  const m = new Map();
  for (const a of g.crowd.agents) { if (states && !states.includes(a.state)) continue; const k = `${Math.floor(a.pos[0] / cell)},${Math.floor(a.pos[2] / cell)}`; m.set(k, (m.get(k) || 0) + 1); }
  let bk = null, bv = -1;
  for (const [k, v] of m) if (v > bv) { bv = v; bk = k; }
  if (!bk) return g.townXZ;
  const [i, j] = bk.split(',').map(Number);
  // centroid of the agents in that cell
  let sx = 0, sz = 0, n = 0;
  for (const a of g.crowd.agents) if ((!states || states.includes(a.state)) && Math.floor(a.pos[0] / cell) === i && Math.floor(a.pos[2] / cell) === j) { sx += a.pos[0]; sz += a.pos[2]; n++; }
  return [sx / n, sz / n];
}

function makeRacer() {
  const grp = new THREE.Group();
  const suit = new THREE.MeshLambertMaterial({ color: 0xe63946 });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.33, 0.7, 3, 8), suit);
  body.position.set(0, 0.85, 0.15); body.rotation.x = 0.9; // tuck
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.24, 12, 10), new THREE.MeshLambertMaterial({ color: 0xffffff }));
  head.position.set(0, 1.15, 0.55);
  const legs = new THREE.Mesh(new THREE.CapsuleGeometry(0.16, 0.55, 3, 6), new THREE.MeshLambertMaterial({ color: 0x1d3557 }));
  legs.position.set(0, 0.45, -0.1); legs.rotation.x = -0.5;
  const skiMat = new THREE.MeshLambertMaterial({ color: 0x111111 });
  for (const sx of [-0.16, 0.16]) { const s = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.04, 2.1), skiMat); s.position.set(sx, 0.03, 0.1); grp.add(s); }
  const bib = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.3, 0.05), new THREE.MeshLambertMaterial({ color: 0xffd166 }));
  bib.position.set(0, 0.95, 0.42); bib.rotation.x = 0.9;
  grp.add(body, head, legs, bib);
  return grp;
}

// downhill course dressing: blue gates and red safety nets along the race section
function makeCourse(T, race, s0) {
  const grp = new THREE.Group();
  const L0 = polyLength(race.pts);
  const pole = new THREE.CylinderGeometry(0.06, 0.06, 2.2, 5); pole.translate(0, 1.1, 0);
  const flag = new THREE.BoxGeometry(0.03, 0.9, 1.1); flag.translate(0, 1.6, 0.55);
  const poleMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const blue = new THREE.MeshLambertMaterial({ color: 0x1f5fd6 });
  const netMat = new THREE.MeshLambertMaterial({ color: 0xe8332a, transparent: true, opacity: 0.85, side: THREE.DoubleSide });
  for (let s = Math.max(0, s0 - 40); s < Math.min(L0, s0 + 400); s += 30) {
    const p = pointAt(race.pts, s), q = pointAt(race.pts, s + 4);
    const hd = Math.atan2(q[0] - p[0], q[1] - p[1]);
    const nx = Math.cos(hd), nz = -Math.sin(hd);
    const side = Math.round(s / 30) % 2 ? 1 : -1;
    for (const off of [side * 6, side * 12]) {
      const x = p[0] + nx * off, z = p[1] + nz * off, y = T.surfaceAt(x, z);
      const m = new THREE.Mesh(pole, poleMat); m.position.set(x, y, z); grp.add(m);
      const f = new THREE.Mesh(flag, blue); f.position.set(x, y, z); f.rotation.y = hd + Math.PI / 2; grp.add(f);
    }
  }
  // nets: thin vertical ribbons along both edges
  for (const off of [-19, 19]) {
    const pos = [];
    for (let s = Math.max(0, s0 - 60); s < Math.min(L0, s0 + 420); s += 6) {
      const p = pointAt(race.pts, s), q = pointAt(race.pts, s + 3);
      const hd = Math.atan2(q[0] - p[0], q[1] - p[1]);
      const x = p[0] + Math.cos(hd) * off, z = p[1] - Math.sin(hd) * off, y = T.surfaceAt(x, z);
      pos.push([x, y, z]);
    }
    const v = [];
    for (let i = 1; i < pos.length; i++) {
      const [a, b] = [pos[i - 1], pos[i]];
      v.push(a[0], a[1], a[2], a[0], a[1] + 2.2, a[2], b[0], b[1], b[2], b[0], b[1], b[2], a[0], a[1] + 2.2, a[2], b[0], b[1] + 2.2, b[2]);
    }
    const g2 = new THREE.BufferGeometry(); g2.setAttribute('position', new THREE.Float32BufferAttribute(v, 3)); g2.computeVertexNormals();
    grp.add(new THREE.Mesh(g2, netMat));
  }
  return grp;
}

function makeCrowd(T, at, race) {
  const n = 520;
  const geo = new THREE.CapsuleGeometry(0.45, 1.0, 2, 6); geo.translate(0, 1, 0);
  const mesh = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ color: 0xffffff }), n);
  const cols = [0xe63946, 0x1d3557, 0xf1c40f, 0x2ecc71, 0xff7f50, 0x8e44ad, 0x00b4d8, 0xffffff, 0xff4fa3, 0xf77f00];
  const m = new THREE.Matrix4(), c = new THREE.Color();
  let k = 0;
  for (let i = 0; i < n * 4 && k < n; i++) {
    const a = Math.random() * Math.PI * 2, r = 25 + Math.random() * 70;
    const x = at[0] + Math.cos(a) * r, z = at[1] + Math.sin(a) * r;
    if (closestOnPoly(race.pts, x, z).d < 28) continue;
    m.makeTranslation(x, T.surfaceAt(x, z), z);
    m.scale(new THREE.Vector3(1.5, 1.5, 1.5));
    mesh.setMatrixAt(k, m);
    mesh.setColorAt(k, c.setHex(cols[k % cols.length]));
    k++;
  }
  mesh.count = k;
  return mesh;
}

// ---------- overlay ----------
function buildOverlay(vertical, L) {
  const css = `
  #promo { position: fixed; inset: 0; z-index: 50; pointer-events: none; font-family: 'Barlow', sans-serif; color: #fff; overflow: hidden; }
  #promo .p-bug { position: absolute; top: ${vertical ? '5.5%' : '5%'}; left: ${vertical ? '6%' : '3.5%'}; display: flex; align-items: center; gap: 8px; padding: 6px 12px 6px 10px; border-radius: 999px; background: rgba(10,16,28,.55); backdrop-filter: blur(8px); font: 800 ${vertical ? 15 : 17}px 'Barlow Condensed'; letter-spacing: .14em; }
  #promo .p-bug i { font-style: normal; font-size: 1.15em; }
  #promo .p-cap { position: absolute; left: ${vertical ? '7%' : '4.5%'}; right: ${vertical ? '7%' : '40%'}; ${vertical ? 'top: 56%;' : 'bottom: 12%;'} }
  #promo .p-kicker { display: inline-block; padding: 4px 10px; border-radius: 6px; background: #ffd166; color: #1b1608; font: 800 ${vertical ? 13 : 14}px 'Barlow Condensed'; letter-spacing: .16em; text-transform: uppercase; margin-bottom: 10px; }
  #promo .p-title { font: 800 ${vertical ? 52 : 64}px/0.95 'Barlow Condensed'; text-transform: uppercase; letter-spacing: .01em; text-shadow: 0 4px 24px rgba(0,0,0,.45), 0 1px 3px rgba(0,0,0,.4); }
  #promo .p-title em { font-style: normal; color: #ffd166; }
  #promo .p-sub { margin-top: 10px; font: 600 ${vertical ? 18 : 20}px/1.3 'Barlow'; text-shadow: 0 2px 10px rgba(0,0,0,.6); max-width: 560px; }
  #promo .p-shade { position: absolute; inset: 0; background: ${vertical ? 'linear-gradient(180deg, rgba(0,0,0,.28) 0%, rgba(0,0,0,0) 22%, rgba(0,0,0,0) 45%, rgba(0,0,0,.5) 78%, rgba(0,0,0,.25) 100%)' : 'linear-gradient(90deg, rgba(0,0,0,.45) 0%, rgba(0,0,0,0) 55%), linear-gradient(0deg, rgba(0,0,0,.35) 0%, rgba(0,0,0,0) 40%)'}; }
  #promo .p-chips { position: absolute; ${vertical ? 'left: 7%; right: 7%; top: 15%;' : 'right: 3.5%; top: 9%; width: 300px;'} display: flex; flex-direction: column; gap: 10px; align-items: ${vertical ? 'flex-start' : 'stretch'}; }
  #promo .chip { display: flex; align-items: center; gap: 12px; padding: 10px 16px; border-radius: 14px; background: rgba(12,20,34,.78); backdrop-filter: blur(10px); border: 1px solid rgba(255,255,255,.14); box-shadow: 0 10px 30px rgba(0,0,0,.3); }
  #promo .chip b { font: 800 ${vertical ? 26 : 28}px 'Barlow Condensed'; letter-spacing: .02em; }
  #promo .chip span { font-size: 14px; color: #c9d6e6; }
  #promo .chip .ic { font-size: 24px; }
  #promo .p-card { position: absolute; ${vertical ? 'left: 7%; right: 7%; top: 14%;' : 'right: 3.5%; top: 10%; width: 360px;'} padding: 14px 18px; border-radius: 16px; background: rgba(14,22,36,.86); border: 1px solid rgba(255,255,255,.14); box-shadow: 0 20px 50px rgba(0,0,0,.35); }
  #promo .p-card h4 { margin: 0 0 6px; font: 700 22px 'Barlow Condensed'; letter-spacing: .03em; display: flex; align-items: center; gap: 8px; }
  #promo .p-card .row { font-size: 15px; color: #dbe6f3; line-height: 1.5; }
  #promo .p-card .cost { margin-top: 6px; font: 800 24px 'Barlow Condensed'; color: #ffd166; }
  #promo .sw { width: 14px; height: 14px; border-radius: 4px; display: inline-block; }
  #promo .p-tv { position: absolute; ${vertical ? 'left: 6%; right: 6%; top: 12%;' : 'left: 3.5%; top: 13%;'} display: flex; flex-direction: column; gap: 6px; align-items: flex-start; }
  #promo .tv1 { display: flex; align-items: stretch; border-radius: 6px; overflow: hidden; font: 800 18px 'Barlow Condensed'; letter-spacing: .08em; text-transform: uppercase; box-shadow: 0 8px 24px rgba(0,0,0,.35); }
  #promo .tv1 .live { background: #e63946; padding: 6px 10px; }
  #promo .tv1 .ev { background: rgba(10,16,28,.88); padding: 6px 12px; }
  #promo .tv2 { display: flex; gap: 0; border-radius: 6px; overflow: hidden; font: 800 30px 'Barlow Condensed'; font-variant-numeric: tabular-nums; box-shadow: 0 8px 24px rgba(0,0,0,.35); }
  #promo .tv2 .bib { background: #ffd166; color: #1b1608; padding: 4px 12px; }
  #promo .tv2 .time { background: rgba(10,16,28,.88); padding: 4px 14px; min-width: 150px; }
  #promo .tv2 .spd { background: #2a6fdb; padding: 4px 12px; }
  #promo .p-map { position: absolute; inset: 0; background: #0d2238; }
  #promo .p-map canvas { position: absolute; inset: 0; }
  #promo .p-board { position: absolute; ${vertical ? 'left: 7%; right: 7%; top: 10%;' : 'right: 4%; top: 12%; width: 380px;'} padding: 14px 16px; border-radius: 16px; background: rgba(14,22,36,.9); border: 1px solid rgba(255,255,255,.14); box-shadow: 0 20px 50px rgba(0,0,0,.4); }
  #promo .p-board h4 { margin: 0 0 8px; font: 700 18px 'Barlow Condensed'; letter-spacing: .1em; text-transform: uppercase; color: #9fb0c6; }
  #promo .p-board .r { display: grid; grid-template-columns: 22px 1fr auto; gap: 8px; padding: 6px 0; border-top: 1px solid rgba(255,255,255,.07); font-size: 15px; }
  #promo .p-board .r b { color: #ffd166; } #promo .p-board .r small { color: #9fb0c6; }
  #promo .p-end { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; background: radial-gradient(ellipse at center, rgba(8,14,26,.35) 0%, rgba(8,14,26,.8) 75%); }
  #promo .p-logo { display: flex; align-items: center; gap: 14px; }
  #promo .p-logo i { font-style: normal; font-size: ${vertical ? 64 : 72}px; filter: drop-shadow(0 8px 24px rgba(0,0,0,.4)); }
  #promo .p-logo b { font: 800 ${vertical ? 76 : 96}px/0.9 'Barlow Condensed'; letter-spacing: .1em; text-shadow: 0 8px 40px rgba(0,0,0,.5); }
  #promo .p-tag { margin-top: 14px; font: 600 ${vertical ? 22 : 26}px 'Barlow'; color: #e3ecf7; max-width: 80%; }
  #promo .p-cta { margin-top: 30px; padding: 14px 26px; border-radius: 14px; background: #ffd166; color: #1b1608; font: 800 ${vertical ? 26 : 28}px 'Barlow Condensed'; letter-spacing: .06em; text-transform: uppercase; box-shadow: 0 16px 40px rgba(0,0,0,.35); }
  #promo .p-bio { margin-top: 14px; font: 700 16px 'Barlow'; letter-spacing: .12em; text-transform: uppercase; color: #c9d6e6; }
  #promo .p-credit { position: absolute; bottom: ${vertical ? '6%' : '4%'}; left: 0; right: 0; text-align: center; font-size: 12px; color: rgba(255,255,255,.55); }
  #promo .p-flash { position: absolute; inset: 0; background: #fff; opacity: 0; }
  #promo .p-fade { position: absolute; inset: 0; background: #000; opacity: 0; }
  `;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  const el = document.createElement('div');
  el.id = 'promo';
  el.innerHTML = `
    <div class="p-shade"></div>
    <div class="p-map" hidden><canvas></canvas><div class="p-board"></div></div>
    <div class="p-chips"></div>
    <div class="p-card" hidden></div>
    <div class="p-tv" hidden><div class="tv1"><span class="live">● ${L.live}</span><span class="ev">${L.wc} · ${L.dh} · Cortina</span></div><div class="tv2"><span class="bib">7</span><span class="time">0:00.00</span><span class="spd">0 km/h</span></div></div>
    <div class="p-cap"><div class="p-kicker"></div><div class="p-title"></div><div class="p-sub"></div></div>
    <div class="p-bug"><i>⛰</i>SNOWLINE</div>
    <div class="p-end" hidden><div class="p-logo"><i>⛰</i><b>SNOWLINE</b></div><div class="p-tag">${L.tag}</div><div class="p-cta">${L.cta}</div><div class="p-bio">${L.bio}</div>
      <div class="p-credit">Terrain: AWS Terrain Tiles · Lifts &amp; pistes © OpenStreetMap contributors</div></div>
    <div class="p-flash"></div><div class="p-fade"></div>`;
  document.body.appendChild(el);
  return el;
}

function setCaption(o, txt, u, dur) {
  const cap = o.querySelector('.p-cap');
  if (!txt) { cap.style.opacity = 0; return; }
  if (cap.dataset.k !== txt[1]) {
    cap.dataset.k = txt[1];
    cap.querySelector('.p-kicker').textContent = txt[0];
    cap.querySelector('.p-title').innerHTML = txt[1];
    cap.querySelector('.p-sub').innerHTML = txt[2];
  }
  const a = out(clamp((u - 0.12) / 0.4, 0, 1));
  const fadeOut = 1 - smoothstep(dur - 0.3, dur - 0.02, u);
  cap.style.opacity = a * fadeOut;
  cap.style.transform = `translateY(${(1 - a) * 30}px)`;
  const sub = cap.querySelector('.p-sub');
  const b = out(clamp((u - 0.35) / 0.4, 0, 1));
  sub.style.opacity = b; sub.style.transform = `translateY(${(1 - b) * 16}px)`;
}

function pop(el, u, start, len = 0.3) {
  const a = out(clamp((u - start) / len, 0, 1));
  el.style.opacity = a;
  el.style.transform = `translateY(${(1 - a) * 18}px) scale(${0.94 + 0.06 * a})`;
}

// ---------- per-frame ----------
export function frame(f) {
  const t = f / FPS;
  const sc = SCENES.find(s => t >= s.t0 && t < s.t1) || SCENES[SCENES.length - 1];
  const u = t - sc.t0, dur = sc.t1 - sc.t0, k = clamp(u / dur, 0, 1);
  const { g, s3, w, T, L, pts, overlay: o } = S;
  const changed = S.lastScene !== sc.id;
  S.lastScene = sc.id;
  // defaults
  let env = { minute: 690, state: 'sunny' };
  let agents = true, labels = false, simulate = true, camD = 3000, flash = 0, icons = true, ribbons = true, agentScale = 1;
  S.gates.visible = false;
  o.querySelector('.p-map').hidden = sc.id !== 's8';
  o.querySelector('.p-end').hidden = sc.id !== 'end';
  o.querySelector('.p-tv').hidden = sc.id !== 's7';
  o.querySelector('.p-card').hidden = sc.id !== 's3';
  const chips = o.querySelector('.p-chips');
  if (changed) chips.innerHTML = '';
  S.racer.visible = false; S.crowd.visible = false;
  if (changed) app.layers.clearPreview();
  const cam = (x, z, d, az, pol) => { s3.lookAt(x, z, d, { azimuth: az, polar: pol }); camD = d; };

  switch (sc.id) {
    case 's1': { // morning light over Cortina, Tofana glowing
      const tx = lerp(pts.tofana[0], pts.town[0], 0.42), tz = lerp(pts.tofana[1], pts.town[1], 0.42) + 600;
      cam(tx, tz, lerp(10500, 7600, ease(k)), Math.PI / 2 + lerp(0.22, 0.06, k), lerp(1.2, 1.25, k));
      env = { minute: 544 + u * 3, state: 'sunny' };
      icons = false;
      agents = false; simulate = false;
      break;
    }
    case 's2': { // real lifts and pistes on Tofana, with names
      const l = w.lifts.find(x => /duca d'aosta/i.test(x.name)) || w.lifts[0];
      const mx = (l.a[0] + l.b[0]) / 2, mz = (l.a[1] + l.b[1]) / 2;
      cam(mx + 300, mz + 200, lerp(3400, 2600, ease(k)), lerp(0.75, 1.15, k), 0.98);
      env = { minute: 640, state: 'sunny' };
      labels = true;
      break;
    }
    case 's3': { // build a lift + draw a piste
      const site = S.site;
      env = { minute: 700, state: 'sunny' };
      if (!site) break;
      const plan = site.plan;
      // look at the sunny slope from the south-east, perpendicular-ish to the lift line
      const az = lerp(0.35, 0.6, k);
      cam(site.mid[0], site.mid[1], lerp(3000, 2400, ease(k)), az, 0.84);
      const card = o.querySelector('.p-card');
      if (u < 2.6) {
        const p = clamp((u - 0.2) / 2.0, 0.03, 1);
        const b = [lerp(plan.a[0], plan.b[0], ease(p)), lerp(plan.a[1], plan.b[1], ease(p))];
        const part = w.planLift('chair6', plan.a, b);
        part.ok = true;
        app.layers.previewLift(part);
        card.innerHTML = `<h4><span class="sw" style="background:${LIFTS.chair6.color}"></span>${L.lift}</h4><div class="row">${km(part.horiz)} · ↑ ${Math.round(part.vertical)} m · ${int(LIFTS.chair6.capacity)} ${L.pph} · ${part.pylons.length} 🗼</div><div class="cost">${money(part.cost)}</div>`;
        pop(card, u, 0.3);
      } else {
        if (!S.built.lift) { S.built.lift = true; w.addLift(plan, { day: g.s.day, instant: true, name: 'Col dei Fiori' }); w.rebuildGraph(); g._applyStatuses(); app.layers.rebuildAll(); }
        const pp = site.pistePts;
        if (pp && u < 5.4) {
          const p = clamp((u - 2.7) / 2.2, 0, 1);
          const total = polyLength(pp);
          const shown = [];
          let acc = 0;
          shown.push(pp[0]);
          for (let i = 1; i < pp.length; i++) {
            const seg = dist(pp[i - 1][0], pp[i - 1][1], pp[i][0], pp[i][1]);
            if (acc + seg <= total * p) { shown.push(pp[i]); acc += seg; }
            else { const r = (total * p - acc) / seg; if (r > 0) shown.push([lerp(pp[i - 1][0], pp[i][0], r), lerp(pp[i - 1][1], pp[i][1], r)]); break; }
          }
          const partPlan = shown.length >= 2 && polyLength(shown) > 70 ? w.planPiste(shown, {}) : null;
          if (partPlan) partPlan.ok = true;
          app.layers.previewPiste(partPlan, shown.length >= 2 ? shown.filter((_, i) => i % 2 === 0) : shown);
          const pl = partPlan || site.pistePlan;
          card.innerHTML = `<h4><span class="sw" style="background:${DIFF[pl.difficulty].color}"></span>${L.piste} · ${L.diffs[pl.difficulty]}</h4><div class="row">${km(pl.length)} · ↓ ${Math.round(pl.drop)} m · max ${Math.round(pl.steepest * 100)}%</div><div class="cost">${money(pl.cost)}</div>`;
          card.style.opacity = 1; card.style.transform = 'none';
        } else if (pp) {
          if (!S.built.piste) { S.built.piste = true; app.layers.clearPreview(); w.addPiste(site.pistePlan, { day: g.s.day, instant: true, snowmaking: true, name: 'Pista dei Fiori', snow: { depth: 120, made: 40, quality: 95, surface: 'groomed', fresh: 0, ice: 0 } }); w.rebuildGraph(); g._applyStatuses(); app.layers.rebuildAll(); }
          card.style.opacity = 1 - smoothstep(5.6, 5.95, u);
        }
      }
      break;
    }
    case 's4': { // the crowd at a busy base
      const [bx, bz] = S.crowdSpot;
      const d4 = lerp(620, 470, ease(k)), az4 = lerp(2.4, 2.85, k), sh = S.vertical ? 0.24 : 0.05;
      cam(bx + Math.sin(az4) * d4 * sh, bz + Math.cos(az4) * d4 * sh, d4, az4, 0.95);
      agentScale = 2.2;
      env = { minute: 680, state: 'sunny' };
      if (changed) {
        const st = g.dayStats;
        chips.innerHTML = `<div class="chip"><span class="ic">👥</span><div><b>${int(Math.max(st.visitors, 12840))}</b><br><span>${L.chips.guests}</span></div></div>
          <div class="chip"><span class="ic">⭐</span><div><b>4,6 / 5</b><br><span>${L.chips.rating}</span></div></div>
          <div class="chip"><span class="ic">💶</span><div><b>${money(1180000)}</b><br><span>${L.chips.cash}</span></div></div>`;
      }
      [...chips.children].forEach((c, i) => pop(c, u, 0.45 + i * 0.22));
      break;
    }
    case 's5': { // storm, then bluebird powder
      const storm = u < 2;
      const [fx, fz] = pts.faloria;
      if (storm) { cam(fx - 900, fz + 300, 1900, 3.5 + u * 0.05, 1.08); env = { minute: 700, state: 'blizzard' }; }
      else { const [tx, tz] = pts.tofana; cam(tx + 1800, tz + 900, lerp(5600, 4800, (u - 2) / 2), 0.15 + (u - 2) * 0.04, 1.17); env = { minute: 640, state: 'sunny' }; icons = false; }
      if (changed || (u >= 2 && chips.dataset.p !== 'powder')) {
        chips.dataset.p = storm ? 'storm' : 'powder';
        chips.innerHTML = `<div class="chip"><span class="ic">${storm ? '🌬️' : '🤩'}</span><div><b style="font-size:20px">${storm ? L.storm : L.powder}</b></div></div>`;
      }
      pop(chips.children[0], storm ? u : u - 2, 0.2);
      if (u >= 1.92 && u < 2.12) flash = 0.9 * (1 - (u - 1.92) / 0.2);
      break;
    }
    case 's6': { // night skiing
      const [bx, bz] = S.litCenter;
      cam(bx, bz, lerp(3200, 2600, ease(k)), lerp(0.2, 0.5, k), 1.05);
      env = { minute: 1140, state: 'sunny' };
      agents = false; simulate = false;
      break;
    }
    case 's7': { // World Cup downhill
      const race = S.race;
      const tv = o.querySelector('.p-tv');
      env = { minute: 690, state: 'sunny' };
      agents = false; simulate = false; ribbons = false;
      S.gates.visible = true;
      if (u < 3.8) {
        const s = S.bestS + u * 31;
        const p = pointAt(race.pts, s), q = pointAt(race.pts, s + 6);
        const hd = Math.atan2(q[0] - p[0], q[1] - p[1]);
        const lat = Math.sin(s / 28) * 7;
        const x = p[0] + Math.cos(hd) * lat, z = p[1] - Math.sin(hd) * lat;
        const y = T.surfaceAt(x, z);
        const r = S.racer; r.visible = true;
        r.position.set(x, y, z);
        r.rotation.set(0, hd, 0);
        r.rotateZ(Math.cos(s / 28) * 0.45);
        const bx = x - Math.sin(hd) * 13, bz = z - Math.cos(hd) * 13;
        s3.camera.position.set(bx, Math.max(T.surfaceAt(bx, bz) + 3.5, y + 4.5), bz);
        s3.camera.lookAt(x + Math.sin(hd) * 3, y - 2.2, z + Math.cos(hd) * 3);
        s3.controls.target.set(x, y, z);
        camD = 20;
        const time = 71.4 + u;
        tv.querySelector('.time').textContent = `${Math.floor(time / 60)}:${(time % 60).toFixed(2).padStart(5, '0')}`;
        tv.querySelector('.spd').textContent = `${Math.round(108 + Math.sin(u * 2) * 6 + u * 2)} km/h`;
      } else {
        // finish area: stadium and crowd
        const L0 = polyLength(race.pts);
        const uu = (u - 3.8) / 2.2;
        const s = L0 - 160 + uu * 170;
        const p = pointAt(race.pts, Math.min(s, L0)), q = pointAt(race.pts, Math.min(s + 6, L0 + 6));
        const hd = Math.atan2(q[0] - p[0], q[1] - p[1]);
        const r = S.racer; r.visible = s < L0 - 2;
        r.position.set(p[0], T.surfaceAt(p[0], p[1]), p[1]);
        r.rotation.set(0, hd, 0);
        S.crowd.visible = true;
        const e = race.pts[race.pts.length - 1];
        cam(e[0], e[1], lerp(260, 200, uu), hd + Math.PI * 0.75, 1.15);
        const time = 75.2 + Math.min(uu * 2.2, 1.6);
        tv.querySelector('.time').textContent = `${Math.floor(time / 60)}:${(time % 60).toFixed(2).padStart(5, '0')}`;
        tv.querySelector('.spd').textContent = uu > 0.75 ? '🏆 1°' : `${Math.round(96 - uu * 20)} km/h`;
      }
      pop(tv, u, 0.1);
      if (u >= 3.78 && u < 3.95) flash = 0.7 * (1 - (u - 3.78) / 0.17);
      break;
    }
    case 's8': { // online universe map
      simulate = false;
      const m = S.map;
      const e = ease(clamp(u / 3.0, 0, 1));
      m.view.zoom = Math.exp(lerp(Math.log(1.6), Math.log(S.vertical ? 15 : 17), e));
      m.view.lat = lerp(30, S.vertical ? 45.75 : 46.0, e);
      m.view.lon = lerp(-5, S.vertical ? 10.2 : 11.6, e);
      m.hover = null;
      m.draw();
      const board = o.querySelector('.p-board');
      if (changed) {
        const rows = [['Zermatt', 'MatterhornMax', 94], ["Cortina d'Ampezzo", 'DolomitiDream', 92], ['Whistler Blackcomb', 'PowderQueen', 91]];
        board.innerHTML = `<h4>🏆 ${L.lb}</h4>${rows.map((r, i) => `<div class="r"><b>${i + 1}</b><div>${r[0]}<br><small>${L.owner}: ${r[1]}</small></div><b>${r[2]}</b></div>`).join('')}`;
      }
      pop(board, u, 1.4, 0.4);
      break;
    }
    case 'end': {
      const tx = lerp(pts.tofana[0], pts.town[0], 0.45), tz = lerp(pts.tofana[1], pts.town[1], 0.45);
      cam(tx, tz, lerp(8200, 9600, k), Math.PI / 2 + 0.5 - k * 0.35, 1.12);
      env = { minute: 960, state: 'sunny' };
      agents = false; simulate = false; icons = false;
      const endEl = o.querySelector('.p-end');
      endEl.style.opacity = out(clamp(u / 0.5, 0, 1));
      const logo = endEl.querySelector('.p-logo');
      const a = out(clamp((u - 0.15) / 0.5, 0, 1));
      logo.style.transform = `scale(${0.85 + 0.15 * a})`; logo.style.opacity = a;
      pop(endEl.querySelector('.p-tag'), u, 0.55, 0.4);
      pop(endEl.querySelector('.p-cta'), u, 0.9, 0.35);
      pop(endEl.querySelector('.p-bio'), u, 1.2, 0.35);
      if (u < 0.15) flash = 0.9 * (1 - u / 0.15);
      break;
    }
  }
  // flash on hard cuts (drum hits)
  if (sc.id === 's3' && u < 0.15) flash = 0.85 * (1 - u / 0.15);
  o.querySelector('.p-flash').style.opacity = flash;
  // fade in from black at the very start
  o.querySelector('.p-fade').style.opacity = t < 0.6 ? 1 - t / 0.6 : 0;
  // captions
  const txt = L[sc.id];
  setCaption(o, sc.id === 'end' ? null : txt, u, dur);
  o.querySelector('.p-bug').style.opacity = sc.id === 'end' ? 0 : 1;
  o.querySelector('.p-shade').style.opacity = sc.id === 'end' ? 0 : 1;
  // world state
  if (simulate) for (let i = 0; i < 1; i++) g.advance(SIM_DM);
  const weather = { ...g.weatherNow, state: env.state, vis: env.state === 'blizzard' ? 0.3 : 1, clear: env.state === 'sunny' ? 1 : 0.1 };
  s3.setEnvironment({ day: g.s.day, minute: env.minute, weather, snowline: g.snowline, summer: 0 });
  s3._updateParticles(1 / FPS);
  g.crowd.computePositions();
  app.layers.agentMesh.visible = agents;
  app.layers.updateAgents(camD * agentScale);
  app.layers.updateCarriers(1 / FPS, camD / 900);
  app.layers._iconsNear = null;
  app.layers.updateIcons(camD);
  app.layers.groups.icons.visible = icons;
  app.layers.groups.pistes.visible = ribbons;
  s3.particleMat.size *= 2.3;
  app.layers.updateTreeColors(g.snowline, 0);
  app.layers.updateNightLights(s3.dayFactor ?? 1);
  const lab = document.getElementById('labels');
  lab.style.display = labels ? '' : 'none';
  if (labels) app.hud.updateLabels();
  s3.render();
  return { scene: sc.id };
}
