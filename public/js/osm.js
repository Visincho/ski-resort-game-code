// Imports a real resort layout (lifts, pistes, huts, village buildings) from OpenStreetMap data
// served by /api/osm (cached Overpass proxy), falling back to Overpass directly.

import { simplify, dist, polyLength } from './util.js';
import { LIFTS } from './catalog.js';

const OVERPASS = 'https://overpass-api.de/api/interpreter';

export async function fetchOsm(bbox) {
  const q = `s=${bbox.s.toFixed(4)}&w=${bbox.w.toFixed(4)}&n=${bbox.n.toFixed(4)}&e=${bbox.e.toFixed(4)}`;
  try {
    const r = await fetch(`api/osm?${q}`);
    if (r.ok) return await r.json();
  } catch (e) { /* fall through */ }
  // direct Overpass fallback (static hosting)
  const B = `${bbox.s},${bbox.w},${bbox.n},${bbox.e}`;
  const query = `[out:json][timeout:90];(way["aerialway"](${B});way["piste:type"="downhill"](${B});node["tourism"="alpine_hut"](${B});node["amenity"~"^(restaurant|cafe|bar)$"](${B});node["place"~"^(town|village|hamlet)$"](${B});way["amenity"="parking"](${B}););out geom;`;
  const r = await fetch(OVERPASS, { method: 'POST', body: new URLSearchParams({ data: query }) });
  if (!r.ok) throw new Error('OpenStreetMap unavailable');
  const d = await r.json();
  const out = { lifts: [], pistes: [], huts: [], places: [], parkings: [], buildings: [] };
  for (const el of d.elements) {
    const t = el.tags || {};
    const pts = (el.geometry || []).map(g => [g.lat, g.lon]);
    if (t.aerialway && !['goods', 'station', 'zip_line', 'pylon'].includes(t.aerialway)) out.lifts.push({ id: el.id, name: t.name || '', type: t.aerialway, tags: t, pts });
    else if (t['piste:type'] === 'downhill') out.pistes.push({ id: el.id, name: t['piste:name'] || t.name || '', difficulty: t['piste:difficulty'] || '', area: pts.length > 3 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1], tags: t, pts });
    else if (t.tourism === 'alpine_hut' || t.amenity && el.type === 'node' && ['restaurant', 'cafe', 'bar'].includes(t.amenity)) out.huts.push({ id: el.id, name: t.name || '', kind: t.tourism || t.amenity, lat: el.lat, lon: el.lon });
    else if (t.place) out.places.push({ name: t.name || '', kind: t.place, lat: el.lat, lon: el.lon });
    else if (t.amenity === 'parking' && pts.length) out.parkings.push({ lat: pts[0][0], lon: pts[0][1] });
  }
  return out;
}

function mapLiftType(osm) {
  const t = osm.type;
  const tags = osm.tags || {};
  const occ = parseInt(tags['aerialway:occupancy'] || '0', 10);
  if (t === 'magic_carpet') return 'carpet';
  if (['t-bar', 'j-bar', 'platter', 'drag_lift', 'rope_tow', 'mixed_lift'].includes(t)) return 'tbar';
  if (t === 'cable_car') return occ && occ < 50 ? 'tram3s' : 'cablecar';
  if (t === 'gondola') return /3s/i.test(osm.name) ? 'tram3s' : 'gondola';
  if (t === 'chair_lift') {
    const detach = tags['aerialway:detachable'] === 'yes' || tags['aerialway:bubble'] === 'yes';
    if (occ >= 6 || tags['aerialway:bubble'] === 'yes') return 'chair6';
    if (occ >= 3 || detach) return 'chair4';
    return occ === 1 || occ === 2 ? 'chair2' : 'chair4';
  }
  return 'chair4';
}

const DIFF_MAP = { novice: 0, easy: 1, intermediate: 2, advanced: 3, expert: 3, freeride: 3, extreme: 3 };

// Builds lifts, pistes and huts into the world (instantly, as an existing resort).
export function importLayout(world, osm, proj, { day = 0, log = () => {} } = {}) {
  const t = world.terrain;
  const stats = { lifts: 0, pistes: 0, huts: 0, skipped: 0 };
  const inMap = (x, z) => t.inBounds(x, z, 15);
  // ---- lifts
  for (const L of osm.lifts || []) {
    if (!L.pts || L.pts.length < 2) continue;
    const a = proj.toXZ(L.pts[0][0], L.pts[0][1]);
    const b = proj.toXZ(L.pts[L.pts.length - 1][0], L.pts[L.pts.length - 1][1]);
    if (!inMap(a[0], a[1]) || !inMap(b[0], b[1])) { stats.skipped++; continue; }
    const type = mapLiftType(L);
    const plan = world.planLift(type, a, b);
    // real lifts exist: accept them even if our simplified checks complain (except degenerate)
    if (plan.horiz < 15 || plan.vertical < 2) { stats.skipped++; continue; }
    const capTag = parseInt((L.tags || {})['aerialway:capacity'] || '0', 10);
    world.addLift(plan, { name: L.name || undefined, day, instant: true, imported: true, capacity: capTag > 100 && capTag < 6000 ? capTag : undefined });
    stats.lifts++;
  }
  // ---- pistes: orient every way downhill, then chain consecutive ways of the same named piste
  const ways = [];
  for (const P of osm.pistes || []) {
    if (!P.pts || P.pts.length < 2) continue;
    if (P.area) { stats.skipped++; continue; }
    let pts = P.pts.map(q => proj.toXZ(q[0], q[1])).filter(p => inMap(p[0], p[1]));
    if (pts.length < 2) { stats.skipped++; continue; }
    if (t.heightAt(pts[0][0], pts[0][1]) < t.heightAt(pts[pts.length - 1][0], pts[pts.length - 1][1])) pts.reverse();
    ways.push({ name: P.name || '', diff: P.difficulty || '', pts, used: false });
  }
  const chains = [];
  for (const w0 of ways) {
    if (w0.used) continue;
    w0.used = true;
    let pts = w0.pts.slice();
    if (w0.name) {
      // extend downhill, then uphill, with unused ways of the same name whose ends touch
      for (let grow = true; grow;) {
        grow = false;
        for (const w1 of ways) {
          if (w1.used || w1.name !== w0.name) continue;
          const tail = pts[pts.length - 1], head = pts[0];
          if (dist(tail[0], tail[1], w1.pts[0][0], w1.pts[0][1]) < 25) { pts = pts.concat(w1.pts.slice(1)); w1.used = true; grow = true; }
          else if (dist(head[0], head[1], w1.pts[w1.pts.length - 1][0], w1.pts[w1.pts.length - 1][1]) < 25) { pts = w1.pts.slice(0, -1).concat(pts); w1.used = true; grow = true; }
        }
      }
    }
    chains.push({ name: w0.name, diff: w0.diff, pts });
  }
  for (const C of chains) {
    const pts = simplify(C.pts, 6);
    if (polyLength(pts) < 80) { stats.skipped++; continue; }
    const plan = world.planPiste(pts, { imported: true, difficulty: DIFF_MAP[C.diff] });
    if (plan.drop < 5) { stats.skipped++; continue; }
    world.addPiste(plan, { name: C.name || undefined, day, instant: true, imported: true, snowmaking: true });
    stats.pistes++;
  }
  // ---- huts (mountain restaurants near the ski network)
  const near = (x, z, r) => world.lifts.some(l => dist(l.a[0], l.a[1], x, z) < r || dist(l.b[0], l.b[1], x, z) < r) ||
    world.pistes.some(p => p.pts.some(q => dist(q[0], q[1], x, z) < r * 0.6));
  const town = (osm.places || []).find(p => p.kind === 'town') || (osm.places || [])[0];
  const townH = town ? t.heightAt(...proj.toXZ(town.lat, town.lon)) : t.minH;
  for (const H of osm.huts || []) {
    const [x, z] = proj.toXZ(H.lat, H.lon);
    if (!inMap(x, z)) continue;
    const h = t.heightAt(x, z);
    if (h < townH + 150) continue;
    if (!near(x, z, 300)) continue;
    const type = H.kind === 'alpine_hut' ? 'hut' : H.kind === 'restaurant' ? (stats.huts % 3 === 2 ? 'restaurant' : 'hut') : 'cafe';
    const plan = world.planBuilding(type, x, z);
    if (plan.errors.some(e => e.startsWith('Overlaps') || e.startsWith('Outside'))) continue;
    world.addBuilding(plan, { day, instant: true, imported: true, name: H.name });
    stats.huts++;
  }
  // ---- bases: lift bottoms near parking or villages, plus the lowest station of each cluster
  const parkings = (osm.parkings || []).map(p => proj.toXZ(p.lat, p.lon));
  const villages = (osm.places || []).map(p => proj.toXZ(p.lat, p.lon));
  const bottoms = world.lifts.map(l => ({ l, x: l.a[0], z: l.a[1], y: l.ya }));
  const isTopNear = (x, z) => world.lifts.some(l => dist(l.b[0], l.b[1], x, z) < 250);
  const chosen = [];
  for (const B of bottoms.sort((a, b) => a.y - b.y)) {
    const byPark = parkings.some(p => dist(p[0], p[1], B.x, B.z) < 260);
    const byVillage = villages.some(p => dist(p[0], p[1], B.x, B.z) < 700);
    if (!(byPark || byVillage)) continue;
    if (isTopNear(B.x, B.z) && !byVillage) continue;
    if (chosen.some(c => dist(c[0], c[1], B.x, B.z) < 600)) continue;
    // offset base a little from the station
    const off = findFreeSpot(world, 'base', B.x, B.z);
    if (!off) continue;
    world.addBuilding(world.planBuilding('base', off[0], off[1]), { day, instant: true, imported: true });
    chosen.push([B.x, B.z]);
  }
  if (!chosen.length && bottoms.length) {
    const B = bottoms[0];
    const off = findFreeSpot(world, 'base', B.x, B.z);
    if (off) world.addBuilding(world.planBuilding('base', off[0], off[1]), { day, instant: true, imported: true });
  }
  stats.bases = world.buildings.filter(b => b.type === 'base').length;
  // every base area gets a first-aid post and toilets
  for (const b of world.buildings.filter(x => x.type === 'base')) {
    for (const type of ['patrol', 'toilet', 'rental']) {
      const spot = findFreeSpot(world, type, b.x, b.z, 50);
      if (spot) world.addBuilding(world.planBuilding(type, spot[0], spot[1]), { day, instant: true, imported: true });
    }
  }
  // a rental + school at the largest base
  const firstBase = world.buildings.find(b => b.type === 'base');
  if (firstBase) {
    for (const type of ['school', 'garage']) {
      const spot = findFreeSpot(world, type, firstBase.x, firstBase.z, 60);
      if (spot) world.addBuilding(world.planBuilding(type, spot[0], spot[1]), { day, instant: true, imported: true });
    }
  }
  world.rebuildGraph();
  log(stats);
  return stats;
}

export function findFreeSpot(world, type, x, z, r0 = 45) {
  for (let r = r0; r < 400; r += 25) {
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2 + r * 0.01;
      const px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
      const plan = world.planBuilding(type, px, pz);
      if (plan.ok) return [px, pz];
    }
  }
  return null;
}

export function villageHouses(osm, proj, terrain, limit = 9000) {
  const out = [];
  for (const b of osm.buildings || []) {
    const [x, z] = proj.toXZ(b[0], b[1]);
    if (!terrain.inBounds(x, z, 5)) continue;
    out.push([x, z]);
    if (out.length >= limit) break;
  }
  return out;
}

export { LIFTS };
