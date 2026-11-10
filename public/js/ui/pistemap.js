// 2D trail map ("Pistenplan") rendered from the real elevation model: hillshade, forests,
// pistes coloured by difficulty, lifts and names.

import { LIFTS, DIFF, BUILDINGS } from '../catalog.js';
import { pointAt, polyLength } from '../util.js';

const cache = new WeakMap();

function hillshade(game, W, H) {
  const key = `${W}x${H}`;
  const c = cache.get(game.terrain);
  if (c && c.key === key && c.snowline === Math.round(game.snowline / 100)) return c.img;
  const T = game.terrain, B = game.biome;
  const img = new ImageData(W, H);
  const sun = [-0.55, 0.62, -0.55]; // from north-west, classic cartographic lighting
  const sl = game.snowline;
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const x = T.x0 + (i + 0.5) / W * T.width, z = T.z0 + (j + 0.5) / H * T.depth;
      const g = T.gradientAt(x, z);
      const n = [-g.dx, 1, -g.dz];
      const L = Math.hypot(...n);
      const shade = Math.max(0, (n[0] * sun[0] + n[1] * sun[1] + n[2] * sun[2]) / L);
      const h = T.heightAt(x, z);
      const steep = 1 - 1 / L;
      let r, gg, b;
      const forest = B ? B.forest(x, z) : 0;
      if (h > sl && steep < 0.38) { r = 246; gg = 248; b = 252; }
      else if (steep > 0.3) { r = 196; gg = 190; b = 182; }
      else if (forest > 0.45) { r = 120; gg = 150; b = 118; }
      else { r = 222; gg = 226; b = 214; }
      const k = 0.55 + shade * 0.6;
      const p = (j * W + i) * 4;
      img.data[p] = Math.min(255, r * k); img.data[p + 1] = Math.min(255, gg * k); img.data[p + 2] = Math.min(255, b * k * 1.04); img.data[p + 3] = 255;
    }
  }
  cache.set(game.terrain, { key, img, snowline: Math.round(sl / 100) });
  return img;
}

export function drawPisteMap(cv, game) {
  const ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  const T = game.terrain, w = game.world;
  ctx.putImageData(hillshade(game, W, H), 0, 0);
  const sx = x => (x - T.x0) / T.width * W, sz = z => (z - T.z0) / T.depth * H;
  // contour lines every 200 m (cheap: sample grid)
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const p of w.pistes.slice().sort((a, b) => a.difficulty - b.difficulty)) {
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 5.5;
    ctx.beginPath(); p.pts.forEach((q, i) => i ? ctx.lineTo(sx(q[0]), sz(q[1])) : ctx.moveTo(sx(q[0]), sz(q[1]))); ctx.stroke();
    ctx.strokeStyle = DIFF[p.difficulty].color;
    ctx.lineWidth = 3.2;
    if (p.status !== 'open') ctx.setLineDash([5, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  for (const l of w.lifts) {
    ctx.strokeStyle = '#1c1f26'; ctx.lineWidth = LIFTS[l.type].surface ? 1.4 : 2.2;
    ctx.beginPath(); ctx.moveTo(sx(l.a[0]), sz(l.a[1])); ctx.lineTo(sx(l.b[0]), sz(l.b[1])); ctx.stroke();
    ctx.fillStyle = '#1c1f26';
    for (const p of [l.a, l.b]) { ctx.beginPath(); ctx.arc(sx(p[0]), sz(p[1]), 3, 0, Math.PI * 2); ctx.fill(); }
  }
  ctx.font = '600 11px Barlow, sans-serif';
  ctx.textAlign = 'center';
  for (const l of w.lifts) {
    const x = sx((l.a[0] + l.b[0]) / 2), y = sz((l.a[1] + l.b[1]) / 2);
    ctx.save(); ctx.translate(x, y);
    let ang = Math.atan2(sz(l.b[1]) - sz(l.a[1]), sx(l.b[0]) - sx(l.a[0]));
    if (ang > Math.PI / 2 || ang < -Math.PI / 2) ang += Math.PI;
    ctx.rotate(ang);
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.strokeText(l.name, 0, -5);
    ctx.fillStyle = '#1c1f26'; ctx.fillText(l.name, 0, -5);
    ctx.restore();
  }
  ctx.font = 'italic 600 10px Barlow, sans-serif';
  for (const p of w.pistes) {
    const q = pointAt(p.pts, polyLength(p.pts) * 0.45);
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.strokeText(p.name, sx(q[0]) + 6, sz(q[1]));
    ctx.fillStyle = DIFF[p.difficulty].key === 'black' ? '#111' : DIFF[p.difficulty].color; ctx.fillText(p.name, sx(q[0]) + 6, sz(q[1]));
  }
  ctx.font = '13px sans-serif';
  for (const b of w.buildings) {
    if (!['base', 'hut', 'restaurant', 'patrol', 'hotel', 'hotel5', 'terrainpark', 'grandstand', 'viewpoint'].includes(b.type)) continue;
    const icon = { base: '🎫', hut: '🍲', restaurant: '🍽️', patrol: '⛑️', hotel: '🏨', hotel5: '🏰', terrainpark: '🛹', grandstand: '🏟️', viewpoint: '🔭' }[b.type];
    ctx.fillText(icon, sx(b.x), sz(b.z) + 4);
  }
  // title + legend
  ctx.fillStyle = 'rgba(16,22,34,0.82)';
  ctx.fillRect(10, 10, 270, 74);
  ctx.fillStyle = '#fff'; ctx.textAlign = 'left';
  ctx.font = '700 18px "Barlow Condensed", Barlow, sans-serif';
  ctx.fillText(game.s.name.toUpperCase(), 20, 34);
  ctx.font = '11px Barlow, sans-serif';
  const sum = w.summary(game.s.day);
  ctx.fillText(`${sum.km.toFixed(1)} km · ${sum.lifts} lifts · ${Math.round(sum.bottom)}–${Math.round(sum.top)} m`, 20, 52);
  DIFF.forEach((d, i) => { ctx.fillStyle = d.color; ctx.fillRect(20 + i * 64, 62, 12, 12); ctx.fillStyle = '#fff'; ctx.fillText(d.name, 36 + i * 64, 72); });
  // north arrow + scale
  ctx.fillStyle = 'rgba(16,22,34,0.82)'; ctx.fillRect(W - 54, 10, 44, 44);
  ctx.fillStyle = '#fff'; ctx.font = '700 14px Barlow'; ctx.textAlign = 'center'; ctx.fillText('N', W - 32, 28);
  ctx.beginPath(); ctx.moveTo(W - 32, 32); ctx.lineTo(W - 37, 46); ctx.lineTo(W - 27, 46); ctx.fill();
  const kmPx = 1000 / T.width * W;
  ctx.fillStyle = 'rgba(16,22,34,0.82)'; ctx.fillRect(W - kmPx * 2 - 30, H - 34, kmPx * 2 + 20, 24);
  ctx.fillStyle = '#fff'; ctx.fillRect(W - kmPx * 2 - 20, H - 18, kmPx * 2, 3);
  ctx.font = '10px Barlow'; ctx.fillText('2 km', W - kmPx - 20, H - 22);
  ctx.textAlign = 'right'; ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillText('© OpenStreetMap contributors · terrain: AWS Terrain Tiles', W - 10, H - 40);
}
