// Pannable/zoomable 2D world map (Natural Earth 110m land) used to pick resorts and new sites.

let LAND = null;
async function loadLand() {
  if (LAND) return LAND;
  const topo = await fetch('data/land-110m.json').then(r => r.json());
  const { scale, translate } = topo.transform;
  const arcs = topo.arcs.map(arc => { let x = 0, y = 0; return arc.map(([dx, dy]) => { x += dx; y += dy; return [x * scale[0] + translate[0], y * scale[1] + translate[1]]; }); });
  const ring = idxs => { const pts = []; for (const i of idxs) { const a = i < 0 ? arcs[~i].slice().reverse() : arcs[i]; pts.push(...(pts.length ? a.slice(1) : a)); } return pts; };
  const rings = [];
  const obj = topo.objects.land;
  for (const g of obj.geometries || [obj]) {
    if (g.type === 'Polygon') g.arcs.forEach(r => rings.push(ring(r)));
    if (g.type === 'MultiPolygon') g.arcs.forEach(p => p.forEach(r => rings.push(ring(r))));
  }
  LAND = rings;
  return rings;
}

export class WorldMap {
  constructor(canvas, { onPick, onSite, sites = [] } = {}) {
    this.cv = canvas; this.ctx = canvas.getContext('2d');
    this.onPick = onPick; this.onSite = onSite;
    this.sites = sites;
    this.view = { lon: 10, lat: 46, zoom: 3.2 };
    this.marker = null;
    this.hover = null;
    this._bind();
    loadLand().then(() => this.draw());
    this.resize();
    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(canvas.parentElement);
  }
  destroy() { this._ro.disconnect(); }
  resize() {
    const r = this.cv.parentElement.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.cv.width = Math.max(200, r.width) * dpr; this.cv.height = Math.max(160, r.height) * dpr;
    this.cv.style.width = `${Math.max(200, r.width)}px`; this.cv.style.height = `${Math.max(160, r.height)}px`;
    this.dpr = dpr;
    this.draw();
  }
  // Mercator-ish (equirectangular with lat stretch) projection
  px(lon, lat) {
    const s = this.view.zoom * 4 * this.dpr;
    const y = Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) * 180 / Math.PI;
    const y0 = Math.log(Math.tan(Math.PI / 4 + this.view.lat * Math.PI / 360)) * 180 / Math.PI;
    return [this.cv.width / 2 + (lon - this.view.lon) * s, this.cv.height / 2 - (y - y0) * s];
  }
  unpx(x, y) {
    const s = this.view.zoom * 4 * this.dpr;
    const y0 = Math.log(Math.tan(Math.PI / 4 + this.view.lat * Math.PI / 360)) * 180 / Math.PI;
    const lon = this.view.lon + (x - this.cv.width / 2) / s;
    const my = y0 - (y - this.cv.height / 2) / s;
    const lat = (Math.atan(Math.exp(my * Math.PI / 180)) - Math.PI / 4) * 360 / Math.PI;
    return [lon, lat];
  }
  setSites(s) { this.sites = s; this.draw(); }
  center(lat, lon, zoom) { this.view.lat = lat; this.view.lon = lon; if (zoom) this.view.zoom = zoom; this.draw(); }
  setMarker(lat, lon) { this.marker = lat == null ? null : [lat, lon]; this.draw(); }

  _bind() {
    const cv = this.cv;
    let drag = null;
    cv.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY, lon: this.view.lon, lat: this.view.lat, moved: 0 }; cv.setPointerCapture(e.pointerId); });
    cv.addEventListener('pointermove', e => {
      const r = cv.getBoundingClientRect();
      const mx = (e.clientX - r.left) * this.dpr, my = (e.clientY - r.top) * this.dpr;
      if (drag) {
        const dx = (e.clientX - drag.x) * this.dpr, dy = (e.clientY - drag.y) * this.dpr;
        drag.moved = Math.max(drag.moved, Math.abs(dx) + Math.abs(dy));
        const s = this.view.zoom * 4 * this.dpr;
        this.view.lon = drag.lon - dx / s;
        const [, lat] = this.unpx(this.cv.width / 2, this.cv.height / 2 - dy);
        this.view.lat = Math.max(-75, Math.min(78, drag.lat + (lat - this.view.lat)));
        this.draw();
      } else {
        const h = this.siteAt(mx, my);
        if (h !== this.hover) { this.hover = h; this.draw(); cv.style.cursor = h ? 'pointer' : 'crosshair'; }
      }
    });
    cv.addEventListener('pointerup', e => {
      const r = cv.getBoundingClientRect();
      const mx = (e.clientX - r.left) * this.dpr, my = (e.clientY - r.top) * this.dpr;
      if (drag && drag.moved < 6) {
        const s = this.siteAt(mx, my);
        if (s && this.onSite) this.onSite(s);
        else if (this.onPick) { const [lon, lat] = this.unpx(mx, my); this.onPick(lat, lon); }
      }
      drag = null;
    });
    cv.addEventListener('wheel', e => {
      e.preventDefault();
      const r = cv.getBoundingClientRect();
      const mx = (e.clientX - r.left) * this.dpr, my = (e.clientY - r.top) * this.dpr;
      const [lon, lat] = this.unpx(mx, my);
      this.view.zoom = Math.max(1, Math.min(160, this.view.zoom * (e.deltaY < 0 ? 1.25 : 0.8)));
      const [lon2, lat2] = this.unpx(mx, my);
      this.view.lon += lon - lon2; this.view.lat += lat - lat2;
      this.draw();
    }, { passive: false });
  }
  siteAt(mx, my) {
    let best = null, bd = 12 * this.dpr;
    for (const s of this.sites) {
      const [x, y] = this.px(s.lon, s.lat);
      const d = Math.hypot(x - mx, y - my);
      if (d < bd) { bd = d; best = s; }
    }
    return best;
  }
  draw() {
    const { ctx, cv } = this;
    ctx.fillStyle = '#0d2238';
    ctx.fillRect(0, 0, cv.width, cv.height);
    // graticule
    ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.lineWidth = 1;
    for (let lon = -180; lon <= 180; lon += 15) { const [x1, y1] = this.px(lon, -80), [x2, y2] = this.px(lon, 80); ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); }
    for (let lat = -75; lat <= 75; lat += 15) { const [x1, y1] = this.px(-180, lat), [x2, y2] = this.px(180, lat); ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); }
    if (LAND) {
      ctx.fillStyle = '#29425a'; ctx.strokeStyle = '#4c6a86'; ctx.lineWidth = 1;
      for (const r of LAND) {
        ctx.beginPath();
        let prev = null;
        r.forEach(([lon, lat], i) => {
          const [x, y] = this.px(lon, Math.max(-85, Math.min(85, lat)));
          if (i === 0 || (prev !== null && Math.abs(lon - prev) > 180)) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          prev = lon;
        });
        ctx.closePath(); ctx.fill(); ctx.stroke();
      }
    }
    ctx.font = `${12 * this.dpr}px Barlow, sans-serif`;
    for (const s of this.sites) {
      const [x, y] = this.px(s.lon, s.lat);
      if (x < -20 || y < -20 || x > cv.width + 20 || y > cv.height + 20) continue;
      const col = s.mine ? '#ffd166' : s.ownerId ? '#ff6b6b' : '#e8f1ff';
      ctx.beginPath(); ctx.arc(x, y, (s === this.hover ? 7 : 5) * this.dpr, 0, Math.PI * 2);
      ctx.fillStyle = col; ctx.fill();
      ctx.lineWidth = 2 * this.dpr; ctx.strokeStyle = '#0d2238'; ctx.stroke();
      if (this.labelFilter ? this.labelFilter(s) : (this.view.zoom > 9 || s === this.hover || s.mine)) {
        ctx.fillStyle = 'rgba(255,255,255,0.92)';
        ctx.fillText(s.name + (s.ownerName ? ` · ${s.ownerName}` : ''), x + 9 * this.dpr, y + 4 * this.dpr);
      }
    }
    if (this.marker) {
      const [x, y] = this.px(this.marker[1], this.marker[0]);
      ctx.strokeStyle = '#2ee59d'; ctx.lineWidth = 3 * this.dpr;
      ctx.beginPath(); ctx.arc(x, y, 9 * this.dpr, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x - 14 * this.dpr, y); ctx.lineTo(x + 14 * this.dpr, y); ctx.moveTo(x, y - 14 * this.dpr); ctx.lineTo(x, y + 14 * this.dpr); ctx.stroke();
    }
  }
}
