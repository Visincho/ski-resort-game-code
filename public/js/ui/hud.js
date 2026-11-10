// In-game HUD: top bar, toolbars, inspector, toasts, confirmation cards, labels.

import { LIFTS, BUILDINGS, BUILD_CATS, DIFF, RESEARCH } from '../catalog.js';
import { money, int, km, hhmm, escapeHtml, clamp, pointAt, polyLength } from '../util.js';
import { WEATHER_INFO } from '../weather.js';
import { ymdFromDay, isSkiSeason } from '../shared/calendar.js';
import { t, getLang } from '../i18n.js';
import { Windows } from './windows.js';

const $ = (sel, root = document) => root.querySelector(sel);
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fmtDate(day) { const d = ymdFromDay(day); return `${t(DOW[d.dow])} ${d.d} ${t(MON[d.m - 1])} ${d.y}`; }
const SURF = { powder: 'Powder', groomed: 'Groomed', packed: 'Packed', choppy: 'Choppy', icy: 'Icy', slush: 'Slushy', thin: 'Thin cover', none: 'No snow' };

const ICON = {
  select: '<svg viewBox="0 0 24 24"><path d="M5 3l12 8-5 1 3 7-2 1-3-7-4 4z"/></svg>',
  lift: '<svg viewBox="0 0 24 24"><path d="M2 5l20-3M12 3.5v6M7 10h10v6a3 3 0 01-3 3h-4a3 3 0 01-3-3z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  piste: '<svg viewBox="0 0 24 24"><path d="M4 3c6 3-2 7 4 10s-2 6 4 8M14 3c6 3-2 7 4 10" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
  building: '<svg viewBox="0 0 24 24"><path d="M3 11l9-7 9 7v10H3z M9 21v-6h6v6" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
  demolish: '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
  layers: '<svg viewBox="0 0 24 24"><path d="M12 3l9 5-9 5-9-5zM3 13l9 5 9-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
  labels: '<svg viewBox="0 0 24 24"><path d="M3 12l8-8h9v9l-8 8z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="15.5" cy="8.5" r="1.6"/></svg>',
  home: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4" stroke="currentColor" stroke-width="2"/></svg>',
  ski: '<svg viewBox="0 0 24 24"><circle cx="14" cy="4" r="2"/><path d="M4 20l16-6M8 11l4-3 3 3-3 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

export class HUD {
  constructor(app) {
    this.app = app;
    this.g = app.game;
    this.root = $('#hud');
    this.root.innerHTML = this.template();
    this.root.hidden = false;
    this.selected = null;
    this.labels = getPref('labels', true);
    this.toastsEl = $('#toasts', this.root);
    this.labelsEl = $('#labels');
    this.windows = new Windows(app, this);
    this._bind();
    this._t = 0;
    this.g.on('message', m => this.onMessage(m));
    this.g.on('topology', () => this.refreshInspector(true));
    this.g.on('dayEnd', rec => this.onDayEnd(rec));
    this.g.on('seasonEnd', se => this.windows.seasonReport(se));
    this.g.on('won', () => this.windows.open('resort'));
    this.refreshTop(true);
  }

  template() {
    return `
    <header id="topbar">
      <button class="tb-btn" id="btnMenu" title="${t('Menu')}">☰</button>
      <div class="tb-resort"><div id="tbName"></div><div id="tbMode" class="muted"></div></div>
      <div class="tb-sep"></div>
      <div class="tb-clock"><div id="tbDate"></div><div id="tbTime" class="big"></div></div>
      <div class="speed" id="speed">
        <button data-speed="0" title="${t('Pause')} (Space)">⏸</button><button data-speed="1" title="1×">▶</button><button data-speed="2" title="2×">▶▶</button><button data-speed="3" title="3×">⏩</button><button data-speed="4" title="4×">⏭</button>
      </div>
      <button class="tb-skip" id="btnSkip" hidden title="${t('Skip to the next ski season')}">❄️ ${t('To winter')}</button>
      <div class="tb-sep"></div>
      <div class="tb-weather" id="tbWeather" title="${t('Weather')}"></div>
      <div class="tb-sep"></div>
      <div class="tb-stat" title="${t('Guests today')}"><span>👥</span><b id="tbGuests">0</b></div>
      <div class="tb-stat" title="${t('Resort rating')}"><span id="tbStars">★★★☆☆</span></div>
      <div class="tb-stat cash" title="${t('Cash')}"><span>💶</span><b id="tbCash"></b></div>
    </header>
    <nav id="toolbar">
      <button data-tool="select" class="active" title="${t('Select / inspect')}">${ICON.select}</button>
      <button data-panel="lifts" title="${t('Build lifts')}">${ICON.lift}</button>
      <button data-tool="piste" title="${t('Draw a piste')}">${ICON.piste}</button>
      <button data-panel="buildings" title="${t('Buildings')}">${ICON.building}</button>
      <button data-tool="demolish" title="${t('Demolish')}">${ICON.demolish}</button>
      <div class="sep"></div>
      <button data-panel="overlays" title="${t('Map overlays')}">${ICON.layers}</button>
      <button id="btnLabels" title="${t('Names on map')}">${ICON.labels}</button>
      <button id="btnHome" title="${t('Back to the village')}">${ICON.home}</button>
      <button id="btnSki" title="${t('Ski it yourself')}">${ICON.ski}</button>
    </nav>
    <div id="toolpanel" class="panel" hidden></div>
    <aside id="inspector" class="panel" hidden></aside>
    <div id="dock">
      <button data-win="finance">💰<span>${t('Finances')}</span></button>
      <button data-win="staff">👷<span>${t('Staff')}</span></button>
      <button data-win="weather">🌦️<span>${t('Weather')}</span></button>
      <button data-win="events">🏆<span>${t('Events')}</span></button>
      <button data-win="research">🔬<span>${t('Research')}</span></button>
      <button data-win="marketing">📣<span>${t('Marketing')}</span></button>
      <button data-win="resort">📊<span>${t('Resort')}</span></button>
      <button data-win="map">🗺️<span>${t('Piste map')}</span></button>
      <button data-win="log">📜<span>${t('Messages')}</span></button>
      ${this.app.universe ? `<button data-win="universe" class="uni">🌍<span>${t('Universe')}</span></button>` : ''}
    </div>
    <div id="toasts"></div>
    <div id="hint" hidden></div>
    <div id="plantip" hidden></div>
    <div id="confirm" class="panel" hidden></div>
    <div id="winlayer"></div>
    <div id="advisor" hidden><div class="adv-face">🧓</div><div class="adv-text"></div></div>
    `;
  }

  _bind() {
    const r = this.root;
    this._onClick = e => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.speed != null) this.setSpeed(+b.dataset.speed);
      if (b.dataset.tool) { this.closeMenus(); this.app.builder.setTool(b.dataset.tool); }
      if (b.dataset.panel) this.togglePanel(b.dataset.panel, b);
      if (b.dataset.win) this.windows.open(b.dataset.win);
    };
    r.addEventListener('click', this._onClick);
    $('#btnMenu', r).onclick = () => this.windows.open('menu');
    $('#btnLabels', r).onclick = () => { this.labels = !this.labels; setPref('labels', this.labels); $('#btnLabels', r).classList.toggle('active', this.labels); };
    $('#btnLabels', r).classList.toggle('active', this.labels);
    $('#btnHome', r).onclick = () => { const [x, z] = this.g.townXZ; this.app.s3.flyTo(x, z, 6500); };
    $('#btnSki', r).onclick = () => this.app.startSkiMode?.();
    $('#tbWeather', r).onclick = () => this.windows.open('weather');
    $('#btnSkip', r).onclick = () => { this.g.skipToSeason(); this.app.layers.rebuildAll(); this.refreshTop(true); };
    this._onKey = e => {
      // sliders (prices, wages) keep focus after a drag: let Space and 1-4 through, but not while typing
      if (['TEXTAREA', 'SELECT'].includes(e.target.tagName) || (e.target.tagName === 'INPUT' && e.target.type !== 'range')) return;
      if (e.code === 'Space') { e.preventDefault(); this.setSpeed(this.g.paused ? (this._lastSpeed || 1) : (this._lastSpeed = this.g.speed, 0)); }
      if (e.key >= '1' && e.key <= '4' && !e.ctrlKey && !e.metaKey) this.setSpeed(+e.key);
      if (e.key === 'l' || e.key === 'L') { $('#btnLabels', r).click(); }
      if (e.key === 'Delete' && this.selected && !this.app.visit) this.confirmDemolish(this.selected);
      if (e.key === 'h' || e.key === 'H') $('#btnHome', r).click();
      if (e.key === 'm' || e.key === 'M') this.windows.open('map');
    };
    window.addEventListener('keydown', this._onKey);
  }

  // player-chosen speed (the universe clock is shared and cannot be paused)
  setSpeed(n) {
    if (this.app.universe) return;
    this.windows._resume = 0;
    this.g.setSpeed(n);
    this.refreshTop(true);
  }

  onToolChanged(tool, arg) {
    for (const b of this.root.querySelectorAll('#toolbar [data-tool]')) b.classList.toggle('active', b.dataset.tool === tool);
    for (const b of this.root.querySelectorAll('#toolbar [data-panel]')) b.classList.toggle('active', (b.dataset.panel === 'lifts' && tool === 'lift') || (b.dataset.panel === 'buildings' && tool === 'building'));
    if (tool === 'piste') this.showPisteOptions(); else if (tool !== 'lift' && tool !== 'building') this.closeMenus();
    if (tool !== 'select') this.hidePlanTip();
  }

  // ---------- tool panels ----------
  togglePanel(kind, btn) {
    const p = $('#toolpanel', this.root);
    if (!p.hidden && p.dataset.kind === kind) { this.closeMenus(); return; }
    p.dataset.kind = kind;
    p.hidden = false;
    const top = btn.getBoundingClientRect().top;
    p.style.top = `${Math.max(64, Math.min(top - 10, window.innerHeight - 520))}px`;
    if (kind === 'lifts') p.innerHTML = this.liftsPanel();
    if (kind === 'buildings') p.innerHTML = this.buildingsPanel(this._bcat || 'base');
    if (kind === 'overlays') p.innerHTML = this.overlaysPanel();
    p.onclick = e => {
      const b = e.target.closest('[data-lift],[data-bld],[data-bcat],[data-ov],[data-contours]');
      if (!b) return;
      if (b.dataset.lift) { if (b.classList.contains('locked')) { this.toast('warn', t('Research needed: {r}', { r: t(RESEARCH.find(r => r.id === LIFTS[b.dataset.lift].research).name) })); return; } this.app.builder.setTool('lift', b.dataset.lift); this.closeMenus(); }
      if (b.dataset.bld) { if (b.classList.contains('locked')) { this.toast('warn', t('Research needed first.')); return; } this.app.builder.setTool('building', b.dataset.bld); this.closeMenus(); }
      if (b.dataset.bcat) { this._bcat = b.dataset.bcat; p.innerHTML = this.buildingsPanel(this._bcat); }
      if (b.dataset.ov != null) { this.app.s3.setOverlay(+b.dataset.ov); p.innerHTML = this.overlaysPanel(); }
      if (b.dataset.contours != null) { this.app.s3.setContours(!this.app.s3.contours); p.innerHTML = this.overlaysPanel(); }
    };
  }
  closeMenus() {
    const p = $('#toolpanel', this.root);
    if (p.dataset.kind === 'piste' && this.app.builder.tool === 'piste') return;
    p.hidden = true; p.dataset.kind = '';
  }
  liftsPanel() {
    const g = this.g;
    return `<h4>${t('Lifts')}</h4><div class="cards">` + Object.entries(LIFTS).map(([id, L]) => {
      const locked = L.research && !g.hasResearch(L.research);
      return `<div class="card ${locked ? 'locked' : ''}" data-lift="${id}">
        <div class="card-h"><span class="swatch" style="background:${L.color}"></span>${t(L.name)}${locked ? ' 🔒' : ''}</div>
        <div class="card-s">${int(L.capacity)} ${t('pph')} · ${L.speed} m/s · ${t('max')} ${km(L.maxLen)}</div>
        <div class="card-s">${money(L.base)} + ${money(L.perM)}/m · ${t('wind')} ${L.wind < 900 ? L.wind : '∞'} km/h</div>
        <div class="card-d">${t(L.desc)}</div></div>`;
    }).join('') + '</div>';
  }
  buildingsPanel(cat) {
    const g = this.g;
    const tabs = BUILD_CATS.map(c => `<button class="chip ${c.id === cat ? 'active' : ''}" data-bcat="${c.id}">${t(c.name)}</button>`).join('');
    const items = Object.entries(BUILDINGS).filter(([, B]) => B.cat === cat).map(([id, B]) => {
      const locked = B.research && !g.hasResearch(B.research);
      return `<div class="card ${locked ? 'locked' : ''}" data-bld="${id}">
        <div class="card-h"><span class="swatch" style="background:${B.color}"></span>${t(B.name)}${locked ? ' 🔒' : ''}</div>
        <div class="card-s">${money(B.cost)} · ${B.days} ${t('days')} · ${money(B.upkeep)}/${t('day')}</div>
        <div class="card-d">${t(B.desc)}</div></div>`;
    }).join('');
    return `<h4>${t('Buildings')}</h4><div class="chips">${tabs}</div><div class="cards">${items}</div>`;
  }
  overlaysPanel() {
    const s3 = this.app.s3;
    const ov = [[0, 'None'], [1, 'Slope steepness'], [2, 'Elevation'], [3, 'Avalanche terrain']];
    return `<h4>${t('Map overlays')}</h4><div class="list">${ov.map(([i, n]) => `<button class="row ${s3.overlay === i ? 'active' : ''}" data-ov="${i}">${t(n)}</button>`).join('')}
      <button class="row ${s3.contours ? 'active' : ''}" data-contours="1">${t('Contour lines (100 m)')}</button></div>
      ${s3.overlay === 1 ? `<div class="legend">${DIFF.map(d => `<span><i style="background:${d.color}"></i>${t(d.name)} ≤${Math.round(d.maxGrad * 100)}%</span>`).join('')}<span><i style="background:#8c1a8c"></i>${t('Extreme')}</span><span><i style="background:#f2d933"></i>${t('Cliff')}</span></div>` : ''}`;
  }
  showPisteOptions() {
    const p = $('#toolpanel', this.root);
    const b = this.app.builder;
    p.dataset.kind = 'piste';
    p.hidden = false;
    p.style.top = '140px';
    p.innerHTML = `<h4>${t('New piste')}</h4>
      <p class="muted small">${t('Difficulty is set by the real terrain: the steepest 100 m decides the colour.')}</p>
      <div class="legend">${DIFF.map(d => `<span><i style="background:${d.color}"></i>${t(d.name)} ≤${Math.round(d.maxGrad * 100)}%</span>`).join('')}</div>
      <label class="check"><input type="checkbox" id="optSnow" ${b.opts.snowmaking ? 'checked' : ''}> ${t('Snowmaking')} <small>(€520/m)</small></label>
      <label class="check"><input type="checkbox" id="optLight" ${b.opts.lighting ? 'checked' : ''}> ${t('Night lighting')} <small>(€210/m)</small></label>
      <p class="muted small">${t('Tip: turn on the slope overlay to see the gradient.')}</p>
      <div class="row-btns"><button class="btn" id="pisteFinish">${t('Finish piste')} ⏎</button><button class="btn ghost" id="pisteCancel">${t('Cancel')}</button></div>`;
    $('#optSnow', p).onchange = e => { b.opts.snowmaking = e.target.checked; };
    $('#optLight', p).onchange = e => { b.opts.lighting = e.target.checked; };
    $('#pisteFinish', p).onclick = () => { if (b.points.length >= 2) b.finishPiste(); else this.toast('warn', t('Click at least two points.')); };
    $('#pisteCancel', p).onclick = () => { b.setTool('select'); p.hidden = true; p.dataset.kind = ''; };
  }

  // ---------- hints / tips ----------
  setToolHint(text) { const h = $('#hint', this.root); h.hidden = !text; h.innerHTML = text || ''; }
  showPlanTip(x, y, html) {
    const tip = $('#plantip', this.root);
    tip.hidden = false; tip.innerHTML = html;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = `${Math.min(window.innerWidth - w - 10, x + 18)}px`;
    tip.style.top = `${Math.min(window.innerHeight - h - 10, y + 18)}px`;
  }
  hidePlanTip() { $('#plantip', this.root).hidden = true; }

  confirmOpen() { return !$('#confirm', this.root).hidden; }
  hideConfirm() { $('#confirm', this.root).hidden = true; }
  confirmBuild(plan, html, onOk, onCancel, extra = {}) {
    const c = $('#confirm', this.root);
    const b = this.app.builder;
    c.hidden = false;
    c.innerHTML = `${html}
      ${extra.piste ? `<label class="check"><input type="checkbox" id="cSnow" ${b.opts.snowmaking ? 'checked' : ''}> ${t('Snowmaking')} (+${money(520 * plan.length)})</label>
      <label class="check"><input type="checkbox" id="cLight" ${b.opts.lighting ? 'checked' : ''}> ${t('Night lighting')} (+${money(210 * plan.length)})</label>` : ''}
      <label class="check"><input type="checkbox" id="cRush"> ${t('Rush job: half the time, +60% cost')}</label>
      <input id="cName" class="input" placeholder="${t('Name (optional)')}" ${plan.kind === 'building' ? 'hidden' : ''}>
      <div class="row-btns"><button class="btn primary" id="cOk">${t('Build')}</button><button class="btn ghost" id="cNo">${t('Cancel')}</button></div>`;
    this.hidePlanTip();
    const done = ok => {
      c.hidden = true;
      if (ok) onOk({ rush: $('#cRush', c).checked, snowmaking: extra.piste ? $('#cSnow', c).checked : undefined, lighting: extra.piste ? $('#cLight', c).checked : undefined, name: $('#cName', c).value.trim() || undefined });
      else onCancel && onCancel();
    };
    $('#cOk', c).onclick = () => done(true);
    $('#cNo', c).onclick = () => done(false);
    c.onkeydown = e => { if (e.key === 'Enter') done(true); };
    setTimeout(() => $('#cOk', c)?.focus(), 30);
  }
  confirmDemolish(ent) {
    const c = $('#confirm', this.root);
    const refund = Math.round((ent.value || 0) * (this.g.isBuilt(ent) ? 0.15 : 0.6));
    c.hidden = false;
    c.innerHTML = `<h3>${t('Demolish')} ${escapeHtml(ent.name || t(BUILDINGS[ent.type]?.name))}?</h3><p>${t('You get back {c}.', { c: money(refund) })}</p>
      <div class="row-btns"><button class="btn danger" id="cOk">${t('Demolish')}</button><button class="btn ghost" id="cNo">${t('Cancel')}</button></div>`;
    $('#cOk', c).onclick = () => { c.hidden = true; this.g.demolish(ent); this.app.layers.rebuildAll(); this.select(null); this.toast('info', t('Demolished. Refund {c}.', { c: money(refund) })); };
    $('#cNo', c).onclick = () => { c.hidden = true; };
  }

  // ---------- toasts / advisor ----------
  toast(kind, text, focus, icon) {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.innerHTML = `<span class="ti">${icon || { good: '✅', bad: '⛔', warn: '⚠️', info: 'ℹ️', advisor: '🧓' }[kind] || 'ℹ️'}</span><span>${text}</span>`;
    if (focus) { el.classList.add('link'); el.onclick = () => this.focusOn(focus); }
    this.toastsEl.prepend(el);
    while (this.toastsEl.children.length > 6) this.toastsEl.lastChild.remove();
    setTimeout(() => { el.classList.add('fade'); setTimeout(() => el.remove(), 600); }, kind === 'bad' ? 11000 : 7000);
  }
  onMessage(m) {
    if (m.kind === 'advisor') { this.advisor(escapeHtml(m.text)); return; }
    this.toast(m.kind, escapeHtml(m.text), m.focus, m.icon);
  }
  advisor(text) {
    const a = $('#advisor', this.root);
    a.hidden = false;
    $('.adv-text', a).innerHTML = text;
    clearTimeout(this._advT);
    this._advT = setTimeout(() => { a.hidden = true; }, 12000);
    a.onclick = () => { a.hidden = true; };
  }
  focusOn(f) {
    let x, z, ent = null;
    if (typeof f === 'string') { ent = this.g.world.find(f); if (!ent) return; }
    else { x = f.x; z = f.z; }
    if (ent) {
      if (ent.kind === 'lift') { x = (ent.a[0] + ent.b[0]) / 2; z = (ent.a[1] + ent.b[1]) / 2; }
      else if (ent.kind === 'piste') { const p = pointAt(ent.pts, polyLength(ent.pts) / 2); x = p[0]; z = p[1]; }
      else { x = ent.x; z = ent.z; }
      this.select(ent);
    }
    this.app.s3.flyTo(x, z, 2600);
  }

  onDayEnd(rec) {
    this.lastDay = rec;
  }

  // ---------- selection / inspector ----------
  select(ent) {
    this.selected = ent;
    this.app.layers.setSelected(ent);
    this.refreshInspector(true);
  }
  refreshInspector(force) {
    const el = $('#inspector', this.root);
    const e = this.selected;
    if (!e || !this.g.world.find(e.id)) { el.hidden = true; this.selected = null; return; }
    el.hidden = false;
    // keep inputs stable while typing
    if (!force && el.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
    if (e.kind === 'lift') el.innerHTML = this.liftInspector(e);
    else if (e.kind === 'piste') el.innerHTML = this.pisteInspector(e);
    else el.innerHTML = this.buildingInspector(e);
    el.onclick = ev => {
      const b = ev.target.closest('[data-act]');
      if (!b) return;
      const act = b.dataset.act;
      if (act === 'close') this.select(null);
      if (act === 'toggle') { this.g.setOpen(e, !e.open); this.app.layers.refreshStatus(); }
      if (act === 'demolish') this.confirmDemolish(e);
      if (act === 'snow') this.g.upgradePiste(e, 'snowmaking', !e.snowmaking);
      if (act === 'light') this.g.upgradePiste(e, 'lighting', !e.lighting);
      if (act === 'groom') e.groom = !e.groom;
      if (act === 'overhaul') {
        const cost = Math.round(LIFTS[e.type].base * 0.06);
        if (!this.g.canAfford(cost)) return this.toast('bad', t('Not enough money: you need {c}.', { c: money(cost) }));
        this.g.spend('maintenance', cost); e.condition = 100;
        e.brokenFrom = this.g.s.day * 1440 + this.g.s.minute; e.brokenUntil = e.brokenFrom + 240; this.g._applyStatuses();
        this.toast('info', t('{n} is closed for 4 hours of maintenance.', { n: escapeHtml(e.name) }));
      }
      if (act === 'upgrade') this.upgradeLift(e, el.querySelector('[data-upg]').value);
      if (act === 'focus') this.focusOn(e.id);
      if (act === 'ride') this.app.startSkiMode?.(e);
      this.refreshInspector(true);
    };
    const nameIn = el.querySelector('input[data-name]');
    if (nameIn) nameIn.onchange = () => { e.name = nameIn.value.trim() || e.name; };
  }
  // replace a lift on the same line with another type (trade-in 25% of the old value)
  upgradeLift(l, type) {
    const g = this.g;
    const plan = g.world.planLift(type, l.a, l.b);
    if (!plan.ok) { this.toast('bad', plan.errors[0]); return; }
    const cost = Math.max(0, Math.round(plan.cost - (l.value || 0) * 0.25));
    const c = $('#confirm', this.root);
    c.hidden = false;
    c.innerHTML = `<h3>${t('Replace {n}', { n: escapeHtml(l.name) })}</h3><p>${t(LIFTS[l.type].name)} → <b>${t(LIFTS[type].name)}</b></p>
      <div class="stats">${int(LIFTS[l.type].capacity)} → ${int(LIFTS[type].capacity)} ${t('pph')} · ${plan.pylons.length} ${t('towers')}</div>
      <div class="costline"><span>💶 ${money(cost)} <small>(${t('trade-in included')})</small></span><span>🏗️ ${plan.days} ${t('days')}</span></div>
      <div class="row-btns"><button class="btn primary" id="cOk">${t('Build')}</button><button class="btn ghost" id="cNo">${t('Cancel')}</button></div>`;
    $('#cNo', c).onclick = () => { c.hidden = true; };
    $('#cOk', c).onclick = () => {
      c.hidden = true;
      if (!g.canAfford(cost)) { this.toast('bad', t('Not enough money: you need {c}.', { c: money(cost) })); return; }
      g.spend('construction', cost);
      for (const a of l.queue) a.state = 'atNode';
      l.queue.length = 0;
      Object.assign(l, { type, capacity: LIFTS[type].capacity, speed: LIFTS[type].speed, built: g.s.day, buildUntil: g.s.day + plan.days, condition: 100, value: Math.round((l.value || 0) * 0.25 + cost), imported: false });
      g.world._liftDerived(l, plan);
      g.world.invalidateTopo(); g.world.rebuildGraph(); g._applyStatuses();
      this.app.layers.rebuildAll();
      this.toast('good', t('Construction started: {n} ({c}).', { n: escapeHtml(l.name), c: money(cost) }));
      this.refreshInspector(true);
    };
  }
  _statusBadge(status, text) {
    const cls = status === 'open' ? 'ok' : ['construction', 'night', 'season'].includes(status) ? 'mid' : 'bad';
    return `<span class="badge ${cls}">${text}</span>`;
  }
  _liftWarnings(l) {
    const w = this.g.world;
    w.ensureGraph();
    const top = l.nTop;
    if (!top) return '';
    const downs = top.out.map(id => w.edges[id]).filter(e => e.kind === 'piste' || e.kind === 'liftDown' || (e.kind === 'walk' && w.nodes[e.to].out.some(o => w.edges[o].kind === 'piste')));
    if (!downs.length) return `<div class="warnbox">⚠️ ${t('No piste leaves the top station: guests will be stranded up there. Draw a piste starting next to it.')}</div>`;
    if (!this.g.world.buildings.some(b => b.type === 'base')) return `<div class="warnbox">⚠️ ${t('Build a Base Station near the bottom so guests can buy tickets.')}</div>`;
    return '';
  }
  _pisteWarnings(p) {
    const w = this.g.world;
    w.ensureGraph();
    if (!p.nStart) return '';
    const out = [];
    if (!p.nStart.inn.length) out.push(t('Nothing leads to the start of this piste: connect it to a lift top station.'));
    if (!p.nEnd.out.length) out.push(t('Dead end: the finish is not near a lift, base or another piste.'));
    return out.map(x => `<div class="warnbox">⚠️ ${x}</div>`).join('');
  }
  liftInspector(l) {
    const T = LIFTS[l.type];
    const g = this.g;
    const q = l.queue.length * g.crowd.k;
    const wait = g.crowd.liftRate(l) > 0 ? l.queue.length / g.crowd.liftRate(l) / 60 : 0;
    const top = Math.round(g.climate.tempAtTime(g.weatherNow, l.yb, g.s.minute));
    const wind = Math.round(g.climate.windAt(g.weatherNow, l.yb));
    return `<div class="insp-h"><span class="swatch" style="background:${T.color}"></span><input data-name value="${escapeHtml(l.name)}"><button class="x" data-act="close">✕</button></div>
      <div class="muted">${t(T.name)}${l.imported ? ` · ${t('real lift (OSM)')}` : ''}</div>
      ${this._statusBadge(l.status, t(g.liftStatusText(l)))}
      ${this._liftWarnings(l)}
      <div class="kv">
        <span>${t('Length')}</span><b>${km(l.length)}</b>
        <span>${t('Vertical')}</span><b>${Math.round(l.vertical)} m (${Math.round(l.ya)} → ${Math.round(l.yb)})</b>
        <span>${t('Capacity')}</span><b>${int(l.capacity)} ${t('pph')}</b>
        <span>${t('Ride time')}</span><b>${(l.length / l.speed / 60).toFixed(1)} min</b>
        <span>${t('Queue now')}</span><b class="${wait > 15 ? 'neg' : ''}">${int(q)} · ${wait.toFixed(0)} min</b>
        <span>${t('Riders today')}</span><b>${int(l.stats.ridersToday)}</b>
        <span>${t('Yesterday')}</span><b>${int(l.stats.lastRiders || 0)} · ${t('max queue')} ${int(l.stats.lastMaxQueue || 0)}</b>
        <span>${t('Top station')}</span><b>${top}°C · ${wind} km/h ${wind > T.wind ? '⚠️' : ''}</b>
        <span>${t('Condition')}</span><b><span class="bar"><i style="width:${l.condition}%;background:${l.condition > 60 ? '#3fcf8e' : l.condition > 35 ? '#f2b84b' : '#ef5350'}"></i></span></b>
      </div>
      ${g.isBuilt(l) ? `<div class="row-btns"><select class="input" data-upg>${Object.entries(LIFTS).filter(([id, L]) => id !== l.type && (!L.research || g.hasResearch(L.research))).map(([id, L]) => `<option value="${id}">${t(L.short)} · ${int(L.capacity)} ${t('pph')}</option>`).join('')}</select><button class="btn" data-act="upgrade">⬆ ${t('Replace')}</button></div>` : ''}
      <div class="row-btns wrap">
        <button class="btn" data-act="toggle">${l.open ? t('Close lift') : t('Open lift')}</button>
        <button class="btn" data-act="overhaul" title="${money(LIFTS[l.type].base * 0.06)}">🔧 ${t('Service')}</button>
        <button class="btn" data-act="ride">🎥 ${t('Ride')}</button>
        <button class="btn danger ghost" data-act="demolish">${t('Demolish')}</button>
      </div>`;
  }
  pisteInspector(p) {
    const D = DIFF[p.difficulty];
    const g = this.g;
    const sn = p.snow;
    const tNow = Math.round(g.climate.tempAtTime(g.weatherNow, p.meanH, g.s.minute));
    return `<div class="insp-h"><span class="swatch" style="background:${D.color}"></span><input data-name value="${escapeHtml(p.name)}"><button class="x" data-act="close">✕</button></div>
      <div class="muted">${t('{d} piste', { d: t(D.name) })}${p.imported ? ` · ${t('real piste (OSM)')}` : ''}</div>
      ${this._statusBadge(p.status, t(g.pisteStatusText(p)))}
      ${this._pisteWarnings(p)}
      <div class="kv">
        <span>${t('Length')}</span><b>${km(p.length)}</b>
        <span>${t('Vertical drop')}</span><b>${Math.round(p.drop)} m (${Math.round(p.top)} → ${Math.round(p.bottom)})</b>
        <span>${t('Steepest')}</span><b>${Math.round(p.steepest * 100)}% · ${Math.round(Math.atan(p.steepest) * 180 / Math.PI)}°</b>
        <span>${t('Exposure')}</span><b>${p.south > 0.2 ? t('South-facing ☀️') : p.south < -0.2 ? t('North-facing ❄️') : t('East/West')}</b>
        <span>${t('Snow depth')}</span><b>${Math.round(sn.depth)} cm${sn.made > 1 ? ` (${Math.round(sn.made)} ${t('made')})` : ''}</b>
        <span>${t('Surface')}</span><b>${t(SURF[sn.surface] || sn.surface)} · ${Math.round(sn.quality)}%</b>
        <span>${t('Temperature')}</span><b>${tNow}°C</b>
        <span>${t('Runs today')}</span><b>${int(p.stats.runsToday)} (${t('yesterday')} ${int(p.stats.lastRuns || 0)})</b>
        <span>${t('Injuries')}</span><b>${p.stats.injuriesSeason} ${t('this season')}</b>
        ${p.avyExp > 0.12 ? `<span>${t('Avalanche')}</span><b class="neg">${t('exposed terrain')} (${Math.round(p.avyExp * 100)}%)</b>` : ''}
      </div>
      <div class="toggles">
        <button class="tgl ${p.snowmaking ? 'on' : ''}" data-act="snow">❄️ ${t('Snowmaking')}${p.snowmaking ? '' : ` <small>${money(520 * p.length)}</small>`}</button>
        <button class="tgl ${p.groom ? 'on' : ''}" data-act="groom">🚜 ${t('Groom nightly')}</button>
        <button class="tgl ${p.lighting ? 'on' : ''}" data-act="light">💡 ${t('Lighting')}${p.lighting ? '' : ` <small>${money(210 * p.length)}</small>`}</button>
      </div>
      <div class="row-btns wrap">
        <button class="btn" data-act="toggle">${p.open ? t('Close piste') : t('Open piste')}</button>
        <button class="btn" data-act="ride">⛷️ ${t('Ski it')}</button>
        <button class="btn danger ghost" data-act="demolish">${t('Demolish')}</button>
      </div>`;
  }
  buildingInspector(b) {
    const B = BUILDINGS[b.type];
    const g = this.g;
    const built = g.isBuilt(b);
    const occ = b.occ ? Math.round(b.occ * g.crowd.k) : 0;
    return `<div class="insp-h"><span class="swatch" style="background:${B.color}"></span><b class="grow">${escapeHtml(b.name || t(B.name))}</b><button class="x" data-act="close">✕</button></div>
      <div class="muted">${t(B.name)} · ${Math.round(b.y)} m</div>
      ${this._statusBadge(built ? (b.open ? 'open' : 'closed') : 'construction', built ? (b.open ? t('Open') : t('Closed')) : t('Under construction ({d} days)', { d: b.buildUntil - g.s.day }))}
      <p class="small">${t(B.desc)}</p>
      <div class="kv">
        ${B.seats ? `<span>${t('Seats')}</span><b>${occ} / ${B.seats}</b>` : ''}
        ${B.beds ? `<span>${t('Beds')}</span><b>${B.beds} · ${money(B.nightly * g.s.prices.lodging)}/${t('night')}</b>` : ''}
        ${B.parking ? `<span>${t('Parking')}</span><b>${int(B.parking)} ${t('guests')}</b>` : ''}
        <span>${t('Guests today')}</span><b>${int(b.stats.visitsToday)} (${t('yesterday')} ${int(b.stats.lastVisits || 0)})</b>
        <span>${t('Revenue today')}</span><b>${money(b.stats.revenueToday)}</b>
        <span>${t('Season revenue')}</span><b>${money(b.stats.revenueSeason)}</b>
        <span>${t('Upkeep')}</span><b>${money(B.upkeep)}/${t('day')}</b>
        ${B.service && !b.node && b.type !== 'base' ? `<span>⚠️</span><b class="neg">${t('Not connected: build it near a lift station or piste junction.')}</b>` : ''}
      </div>
      <div class="row-btns wrap">
        <button class="btn" data-act="toggle">${b.open ? t('Close building') : t('Open building')}</button>
        <button class="btn danger ghost" data-act="demolish">${t('Demolish')}</button>
      </div>`;
  }

  // ---------- top bar ----------
  refreshTop(force) {
    const g = this.g, s = g.s;
    $('#tbName', this.root).textContent = s.name;
    $('#tbMode', this.root).textContent = this.app.universe ? `🌍 ${this.app.universe.info.name}` : (s.scenario?.title ? t(s.scenario.title) : t('Solo'));
    $('#tbDate', this.root).textContent = fmtDate(s.day);
    $('#tbTime', this.root).textContent = hhmm(s.minute);
    const w = g.weatherNow;
    const tBase = Math.round(g.climate.tempAtTime(w, g.refElev, s.minute));
    const topH = Math.max(g.refElev + 600, ...g.world.lifts.map(l => l.yb));
    const tTop = Math.round(g.climate.tempAtTime(w, topH, s.minute));
    const snow = Math.round(g.snowAt(2000));
    $('#tbWeather', this.root).innerHTML = `<span class="wi">${WEATHER_INFO[w.state].icon}</span><div><b>${tBase}° / ${tTop}°</b><small>${t(WEATHER_INFO[w.state].name)} · 💨${w.wind} · ❄️${snow} cm · ⚠️${s.avy.level}</small></div>`;
    $('#tbGuests', this.root).textContent = int(g.dayStats.visitors || 0);
    const stars = Math.round(s.rep / 20 * 2) / 2;
    $('#tbStars', this.root).innerHTML = '★'.repeat(Math.floor(stars)) + (stars % 1 ? '⯪' : '') + '<span class="dim">' + '★'.repeat(5 - Math.ceil(stars)) + '</span>';
    $('#tbStars', this.root).parentElement.title = `${t('Resort rating')}: ${Math.round(s.rep)}/100 · ${t('Fame')} ${Math.round(s.fame)}`;
    const cash = $('#tbCash', this.root);
    cash.textContent = money(s.cash);
    cash.classList.toggle('neg', s.cash < 0);
    $('#btnSkip', this.root).hidden = !!this.app.universe || g.operating || isSkiSeason(s.day, g.hemi);
    const sp = $('#speed', this.root);
    if (this.app.universe) sp.classList.add('locked');
    for (const b of sp.querySelectorAll('button')) b.classList.toggle('active', (+b.dataset.speed === (g.paused ? 0 : g.speed)));
  }

  update(dt) {
    this._t += dt;
    if (this._t > 0.25) { this._t = 0; this.refreshTop(); this._inspT = (this._inspT || 0) + 1; if (this._inspT % 3 === 0 && this.selected) this.refreshInspector(); this.windows.tick(); }
    if (this.labels) this.updateLabels(); else if (this.labelsEl.childElementCount) this.labelsEl.innerHTML = '';
  }

  updateLabels() {
    const s3 = this.app.s3, w = this.g.world;
    const d = s3.cameraDistance();
    const items = [];
    if (d < 9000) {
      for (const l of w.lifts) {
        const u = 0.5, x = l.a[0] + (l.b[0] - l.a[0]) * u, z = l.a[1] + (l.b[1] - l.a[1]) * u, y = (l.ya + l.yb) / 2 + 30;
        items.push({ id: l.id, x, y, z, text: l.name, cls: `lift ${l.status !== 'open' ? 'off' : ''}`, color: LIFTS[l.type].color });
      }
    }
    if (d < 3800) {
      for (const p of w.pistes) {
        const q = pointAt(p.pts, polyLength(p.pts) * 0.4);
        items.push({ id: p.id, x: q[0], y: this.g.terrain.heightAt(q[0], q[1]) + 8, z: q[1], text: p.name, cls: `piste ${p.status !== 'open' ? 'off' : ''}`, color: DIFF[p.difficulty].color });
      }
    }
    const el = this.labelsEl;
    const pool = this._labelPool || (this._labelPool = new Map());
    const seen = new Set();
    const W = window.innerWidth, H = window.innerHeight;
    const occupied = [];
    for (const it of items) {
      const p = s3.project(it.x, it.y, it.z);
      if (p.behind || p.x < -50 || p.y < -20 || p.x > W + 50 || p.y > H + 20) continue;
      // crude overlap avoidance
      if (occupied.some(o => Math.abs(o[0] - p.x) < 70 && Math.abs(o[1] - p.y) < 14)) continue;
      occupied.push([p.x, p.y]);
      let node = pool.get(it.id);
      if (!node) { node = document.createElement('div'); pool.set(it.id, node); el.appendChild(node); }
      if (node._text !== it.text || node._cls !== it.cls) { node.textContent = it.text; node.className = `lbl ${it.cls}`; node.style.setProperty('--c', it.color); node._text = it.text; node._cls = it.cls; }
      node.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px) translate(-50%, -100%)`;
      node.style.display = '';
      seen.add(it.id);
    }
    for (const [id, node] of pool) if (!seen.has(id)) { if (!w.find(id)) { node.remove(); pool.delete(id); } else node.style.display = 'none'; }
  }

  destroy() {
    this.root.removeEventListener('click', this._onClick);
    window.removeEventListener('keydown', this._onKey);
    this.windows.destroy();
    this.root.innerHTML = '';
    this.root.hidden = true;
    this.labelsEl.innerHTML = '';
    this._labelPool = null;
  }
}

export function getPref(k, def) { try { const v = localStorage.getItem('snowline.pref.' + k); return v == null ? def : JSON.parse(v); } catch (e) { return def; } }
export function setPref(k, v) { try { localStorage.setItem('snowline.pref.' + k, JSON.stringify(v)); } catch (e) { /* ignore */ } }
export { SURF };
