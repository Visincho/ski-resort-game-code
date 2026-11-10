// Mouse interaction: selecting things, placing lifts (bottom -> top), drawing pistes waypoint by
// waypoint, placing buildings and demolishing.

import { LIFTS, BUILDINGS, DIFF } from './catalog.js';
import { dist, closestOnPoly, money, km, escapeHtml } from './util.js';
import { t } from './i18n.js';

export class Builder {
  constructor(game, s3, layers, ui) {
    this.g = game; this.s3 = s3; this.layers = layers; this.ui = ui;
    this.tool = 'select';
    this.arg = null;
    this.points = [];
    this.plan = null;
    this.cursor = null;
    this.down = null;
    this.opts = { rush: false, snowmaking: true, lighting: false };
    const el = s3.renderer.domElement;
    el.addEventListener('pointerdown', e => { this.down = { x: e.clientX, y: e.clientY, b: e.button, t: performance.now() }; });
    el.addEventListener('pointerup', e => {
      if (!this.down) return;
      const moved = Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y);
      const b = this.down.b;
      this.down = null;
      if (moved > 6) return;
      if (b === 0) this.click(e);
      else if (b === 2) this.rightClick(e);
    });
    el.addEventListener('pointermove', e => this.move(e));
    el.addEventListener('dblclick', e => { if (this.tool === 'piste' && this.points.length >= 2) this.finishPiste(); });
    el.addEventListener('contextmenu', e => e.preventDefault());
    this._onKey = e => this.key(e);
    window.addEventListener('keydown', this._onKey);
  }
  destroy() { window.removeEventListener('keydown', this._onKey); } // canvas listeners go with the canvas

  setTool(tool, arg = null) {
    this.tool = tool; this.arg = arg;
    this.points = []; this.plan = null;
    this.layers.clearPreview();
    this.ui.hideConfirm();
    this.s3.renderer.domElement.style.cursor = tool === 'select' ? 'default' : 'crosshair';
    this.ui.setToolHint(this.hintText());
    this.ui.onToolChanged(tool, arg);
  }

  hintText() {
    switch (this.tool) {
      case 'lift': return this.points.length ? t('Click the TOP station. Right-click or Esc to cancel.') : t('{n}: click the BOTTOM station.', { n: t(LIFTS[this.arg].name) });
      case 'piste': return this.points.length < 2 ? t('Click from the top down to draw the piste. Start near a lift top station.') : t('Keep clicking to add turns. Double-click or Enter to finish, Backspace to undo, Esc to cancel.');
      case 'building': return t('{n}: click to place.', { n: t(BUILDINGS[this.arg].name) });
      case 'demolish': return t('Click a lift, piste or building to demolish it.');
      default: return '';
    }
  }

  ground(e) { return this.s3.pickGround(e.clientX, e.clientY); }

  // snap to stations / piste ends / bases
  snap(x, z, prefer) {
    const w = this.g.world;
    let best = null, bd = 70;
    const consider = (px, pz, kind) => { const d = dist(px, pz, x, z); if (d < bd) { bd = d; best = [px, pz, kind]; } };
    for (const l of w.lifts) { consider(l.a[0], l.a[1], 'bottom'); consider(l.b[0], l.b[1], 'top'); }
    for (const p of w.pistes) { const s = p.pts[0], e2 = p.pts[p.pts.length - 1]; consider(s[0], s[1], 'pisteStart'); consider(e2[0], e2[1], 'pisteEnd'); }
    for (const b of w.buildings) if (b.type === 'base') consider(b.x, b.z, 'base');
    return best;
  }

  move(e) {
    if (this.tool === 'select') { this.hover(e); return; }
    const p = this.ground(e);
    if (!p) return;
    let x = p.x, z = p.z;
    const sn = (this.tool === 'lift' || this.tool === 'piste') ? this.snap(x, z) : null;
    if (sn) { x = sn[0]; z = sn[1]; }
    this.cursor = [x, z];
    const w = this.g.world;
    if (this.tool === 'lift') {
      if (this.points.length === 1) {
        this.plan = w.planLift(this.arg, this.points[0], [x, z]);
        this.layers.previewLift(this.plan);
        this.ui.showPlanTip(e.clientX, e.clientY, this.liftTip(this.plan));
      } else {
        this.layers.clearPreview();
        this.layers._previewDot([x, z], sn ? 0xffd400 : 0x2ee59d);
        this.ui.showPlanTip(e.clientX, e.clientY, `<b>${t(LIFTS[this.arg].name)}</b><br>${Math.round(this.g.terrain.heightAt(x, z))} m · ${Math.round(this.g.terrain.slopeDeg(x, z))}°`);
      }
    } else if (this.tool === 'piste') {
      const pts = [...this.points, [x, z]];
      this.plan = pts.length >= 2 ? w.planPiste(pts, { snowmaking: this.opts.snowmaking, lighting: this.opts.lighting }) : null;
      this.layers.previewPiste(this.plan, pts);
      this.ui.showPlanTip(e.clientX, e.clientY, this.plan ? this.pisteTip(this.plan) : `${Math.round(this.g.terrain.heightAt(x, z))} m`);
    } else if (this.tool === 'building') {
      this.plan = w.planBuilding(this.arg, x, z);
      this.layers.previewBuilding(this.plan);
      const B = BUILDINGS[this.arg];
      if (B.radius) this.layers.previewRadius(x, z, B.radius);
      this.ui.showPlanTip(e.clientX, e.clientY, `<b>${t(B.name)}</b> · ${money(B.cost)}<br>${Math.round(this.g.terrain.heightAt(x, z))} m · ${Math.round(this.g.terrain.slopeDeg(x, z))}°${this.plan.errors.length ? `<div class="err">${this.plan.errors.join('<br>')}</div>` : ''}`);
    } else if (this.tool === 'demolish') {
      const ent = this.pick(e);
      this.layers.setSelected(ent);
      this.ui.showPlanTip(e.clientX, e.clientY, ent ? `${t('Demolish')} <b>${escapeHtml(ent.name || t(BUILDINGS[ent.type]?.name || ''))}</b>?` : t('Nothing here'));
    }
  }

  hover(e) {
    if (this._hoverT && performance.now() - this._hoverT < 60) return;
    this._hoverT = performance.now();
    const ent = this.pick(e);
    if (ent) {
      const name = ent.kind === 'building' ? (ent.name || t(BUILDINGS[ent.type].name)) : ent.name;
      const sub = ent.kind === 'lift' ? t(LIFTS[ent.type].short) : ent.kind === 'piste' ? t(DIFF[ent.difficulty].name) : '';
      this.ui.showPlanTip(e.clientX, e.clientY, `<b>${escapeHtml(name)}</b>${sub ? ` · ${sub}` : ''}`);
      this.s3.renderer.domElement.style.cursor = 'pointer';
    } else {
      this.ui.hidePlanTip();
      this.s3.renderer.domElement.style.cursor = 'default';
    }
  }

  pick(e) {
    const p = this.ground(e);
    if (!p) return null;
    const w = this.g.world;
    const tol = this.s3.cameraDistance() * 0.012;
    let best = null, bd = Infinity;
    for (const b of w.buildings) { const d = dist(b.x, b.z, p.x, p.z) - BUILDINGS[b.type].size - tol; if (d < 0 && d < bd) { bd = d; best = b; } }
    if (best) return best;
    bd = Infinity;
    for (const l of w.lifts) {
      const d = closestOnPoly([l.a, l.b], p.x, p.z).d - 14 - tol;
      if (d < 0 && d < bd) { bd = d; best = l; }
    }
    for (const q of w.pistes) {
      const d = closestOnPoly(q.pts, p.x, p.z).d - q.width / 2 - tol * 0.6;
      if (d < 0 && d + 6 < bd) { bd = d + 6; best = q; }
    }
    return best;
  }

  click(e) {
    this.ui.closeMenus();
    if (this.tool === 'select') {
      const ent = this.pick(e);
      this.ui.select(ent);
      return;
    }
    if (this.tool === 'demolish') {
      const ent = this.pick(e);
      if (ent) this.ui.confirmDemolish(ent);
      return;
    }
    this.move(e); // make sure cursor/snap reflect this exact click position
    if (!this.cursor) return;
    const [x, z] = this.cursor;
    if (this.tool === 'lift') {
      if (!this.points.length) { this.points.push([x, z]); this.ui.setToolHint(this.hintText()); return; }
      const plan = this.g.world.planLift(this.arg, this.points[0], [x, z]);
      if (!plan.ok) { this.ui.toast('bad', plan.errors[0]); return; }
      this.plan = plan;
      this.ui.confirmBuild(plan, this.liftTip(plan, true), opts => this.commit(plan, opts), () => this.setTool('lift', this.arg));
    } else if (this.tool === 'piste') {
      const last = this.points[this.points.length - 1];
      if (last && dist(last[0], last[1], x, z) < 15) return;
      this.points.push([x, z]);
      this.ui.setToolHint(this.hintText());
      if (this.points.length >= 2) {
        const sn = this.snap(x, z);
        if (sn && ['bottom', 'base', 'pisteStart', 'pisteEnd'].includes(sn[2]) && this.points.length >= 2 && dist(sn[0], sn[1], x, z) < 1) this.finishPiste();
      }
    } else if (this.tool === 'building') {
      const plan = this.g.world.planBuilding(this.arg, x, z);
      if (!plan.ok) { this.ui.toast('bad', plan.errors[0]); return; }
      const B = BUILDINGS[this.arg];
      this.ui.confirmBuild(plan, `<h3>${t(B.name)}</h3><p>${t(B.desc)}</p>${this.costLine(plan.cost, plan.days)}`, opts => this.commit(plan, opts), () => this.layers.clearPreview());
    }
  }

  finishPiste() {
    const plan = this.g.world.planPiste(this.points, { snowmaking: this.opts.snowmaking, lighting: this.opts.lighting });
    if (!plan.ok) { this.ui.toast('bad', plan.errors[0]); return; }
    this.plan = plan;
    this.ui.confirmBuild(plan, this.pisteTip(plan, true), opts => {
      const p2 = this.g.world.planPiste(this.points, { snowmaking: opts.snowmaking, lighting: opts.lighting });
      this.commit(p2, opts);
    }, () => {}, { piste: true });
  }

  commit(plan, opts) {
    const e = this.g.construct(plan, { ...this.opts, ...opts });
    if (e) {
      this.ui.toast('good', t('Construction started: {n} ({c}).', { n: escapeHtml(e.name || t(BUILDINGS[e.type]?.name || '')), c: money(e.value) }));
      this.layers.rebuildAll();
      this.ui.select(e);
    }
    const tool = this.tool, arg = this.arg;
    this.setTool(tool, arg);
  }

  rightClick() {
    if (this.tool === 'piste' && this.points.length) { this.points.pop(); this.layers.previewPiste(null, this.points); this.ui.setToolHint(this.hintText()); return; }
    if (this.tool !== 'select') { if (this.points.length) this.setTool(this.tool, this.arg); else this.setTool('select'); }
  }

  key(e) {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
    if (e.key === 'Escape') {
      if (this.ui.confirmOpen()) { this.ui.hideConfirm(); this.setTool(this.tool, this.arg); return; }
      if (this.tool !== 'select') this.setTool('select'); else this.ui.select(null);
    }
    if (e.key === 'Enter' && this.tool === 'piste' && this.points.length >= 2 && !this.ui.confirmOpen()) this.finishPiste();
    if (e.key === 'Backspace' && this.tool === 'piste' && this.points.length) { this.points.pop(); this.layers.previewPiste(null, this.points); e.preventDefault(); }
  }

  costLine(cost, days) {
    const winter = this.g.operating;
    return `<div class="costline"><span>💶 ${money(cost)}${winter ? ` <small>(+15% ${t('winter works')})</small>` : ''}</span><span>🏗️ ${days} ${t('days')}</span></div>`;
  }

  liftTip(p, full) {
    const T = LIFTS[p.type];
    const rows = `${km(p.horiz)} · ↑ ${Math.round(p.vertical)} m · ${Math.round(p.capacity)} ${t('pph')} · ${Math.round(p.rideTime / 60 * 10) / 10} min`;
    const err = p.errors.length ? `<div class="err">${p.errors.join('<br>')}</div>` : '';
    const warn = p.warnings.length ? `<div class="warn">${p.warnings.join('<br>')}</div>` : '';
    if (!full) return `<b>${t(T.name)}</b><br>${rows}<br>${money(p.cost)} · ${p.pylons.length} ${t('towers')}${err}${warn}`;
    return `<h3>${t(T.name)}</h3><p>${t(T.desc)}</p><div class="stats">${rows}<br>${Math.round(p.ya)} m → ${Math.round(p.yb)} m · ${p.pylons.length} ${t('towers')} · ${t('wind limit')} ${T.wind < 900 ? T.wind + ' km/h' : '—'}</div>${this.costLine(p.cost, p.days)}${warn}`;
  }
  pisteTip(p, full) {
    const D = DIFF[p.difficulty];
    const deg = Math.round(Math.atan(p.steepest || 0) * 180 / Math.PI);
    const rows = `<span class="dot" style="background:${D.color}"></span>${t(D.name)} · ${km(p.length)} · ↓ ${Math.round(p.drop)} m · ${t('max')} ${Math.round((p.steepest || 0) * 100)}% (${deg}°)`;
    const err = p.errors.length ? `<div class="err">${p.errors.join('<br>')}</div>` : '';
    const warn = p.warnings.length ? `<div class="warn">${p.warnings.join('<br>')}</div>` : '';
    if (!full) return `${rows}<br>${money(p.cost)}${p.forestM > 0 ? ` · 🌲 ${km(p.forestM)}` : ''}${err}${warn}`;
    return `<h3>${t('New piste')}</h3><div class="stats">${rows}<br>${Math.round(p.top)} m → ${Math.round(p.bottom)} m${p.forestM > 0 ? ` · ${t('forest clearing')} ${km(p.forestM)}` : ''}${p.avyExp > 0.15 ? ` · ⚠️ ${t('avalanche terrain')}` : ''}</div>${this.costLine(p.cost, p.days)}${warn}`;
  }
}
