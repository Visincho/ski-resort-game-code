// Pre-downloads elevation tiles and OpenStreetMap data for every famous resort through the running
// game server, so the first visit to each resort loads instantly.  Usage: npm run warm [-- cortina zermatt]
import { FAMOUS_RESORTS } from '../public/js/shared/resorts.js';
import { GeoProjection } from '../public/js/util.js';

const BASE = process.env.SNOWLINE_URL || 'http://localhost:8787';
const only = process.argv.slice(2);
const lonToX = (lon, z) => ((lon + 180) / 360) * 2 ** z;
const latToY = (lat, z) => { const r = lat * Math.PI / 180; return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z; };

for (const r of FAMOUS_RESORTS) {
  if (only.length && !only.includes(r.id)) continue;
  const p = new GeoProjection(r.lat, r.lon);
  const W = r.w * 1000, H = r.h * 1000;
  const [n] = p.toLatLon(0, -H / 2), [s] = p.toLatLon(0, H / 2), [, w] = p.toLatLon(-W / 2, 0), [, e] = p.toLatLon(W / 2, 0);
  // same zoom choice as the client (terrain.js)
  let z = 13;
  const count = zz => (Math.floor(lonToX(e, zz)) - Math.floor(lonToX(w, zz)) + 1) * (Math.floor(latToY(s, zz)) - Math.floor(latToY(n, zz)) + 1);
  while (z > 10 && count(z) > 42) z--;
  const jobs = [];
  for (let ty = Math.floor(latToY(n, z)); ty <= Math.floor(latToY(s, z)); ty++)
    for (let tx = Math.floor(lonToX(w, z)); tx <= Math.floor(lonToX(e, z)); tx++)
      jobs.push(fetch(`${BASE}/tiles/${z}/${tx}/${ty}.png`).then(res => res.ok).catch(() => false));
  const ok = (await Promise.all(jobs)).filter(Boolean).length;
  const t0 = Date.now();
  const q = `s=${s.toFixed(4)}&w=${w.toFixed(4)}&n=${n.toFixed(4)}&e=${e.toFixed(4)}`;
  let osm = 'failed';
  try {
    const res = await fetch(`${BASE}/api/osm?${q}`);
    if (res.ok) { const d = await res.json(); osm = `${d.lifts.length} lifts, ${d.pistes.length} pistes`; }
  } catch (err) { osm = err.message; }
  console.log(`${r.name.padEnd(26)} tiles ${ok}/${jobs.length}  osm: ${osm} (${Math.round((Date.now() - t0) / 1000)} s)`);
}
