// Management windows: finances, staff, weather, events, research, marketing, resort report,
// piste map, message log, online universe and the pause menu.

import { STAFF, SNOWCAT, RESEARCH, BUILDINGS, LIFTS, DIFF, LIFT_OPERATOR_WAGE } from '../catalog.js';
import { money, int, km, hhmm, escapeHtml, clamp } from '../util.js';
import { WEATHER_INFO } from '../weather.js';
import { ymdFromDay } from '../shared/calendar.js';
import { CAMPAIGNS, compTitle } from '../events.js';
import { t, getLang, setLang } from '../i18n.js';
import { drawPisteMap } from './pistemap.js';

const $ = (sel, root = document) => root.querySelector(sel);
const CAT_NAMES = {
  tickets: 'Lift tickets', food: 'Food & drink', rental: 'Rentals', school: 'Ski school', lodging: 'Hotels', events: 'Events & TV', summer: 'Summer season', grants: 'Grants', awards: 'Awards', refunds: 'Sales & refunds',
  wages: 'Wages', supplies: 'Supplies & cost of goods', taxes: 'VAT & fees', heliski: 'Heli-skiing', energy: 'Energy', maintenance: 'Maintenance', insurance: 'Insurance', interest: 'Loan interest', snowmaking: 'Snowmaking', grooming: 'Grooming', marketing: 'Marketing', construction: 'Construction', research: 'Research', equipment: 'Equipment', safety: 'Avalanche control', fines: 'Fines & lawsuits',
};
function dstr(day) { const d = ymdFromDay(day); return `${d.d}/${d.m}/${d.y}`; }

export class Windows {
  constructor(app, hud) {
    this.app = app; this.hud = hud; this.g = app.game;
    this.layer = $('#winlayer');
    this.current = null;
    this.tab = {};
    this._onKey = e => { if (e.key === 'Escape' && this.current) { this.close(); e.stopPropagation(); } };
    window.addEventListener('keydown', this._onKey, true);
  }

  destroy() { window.removeEventListener('keydown', this._onKey, true); }

  open(name, opts = {}) {
    if (this.current === name && !opts.force) { this.close(); return; }
    this.current = name;
    this.opts = opts;
    this.layer.innerHTML = `<div class="win-backdrop"></div><div class="win ${name}"><div class="win-h"><h2 id="winTitle"></h2><button class="x" id="winClose">✕</button></div><div class="win-b" id="winBody"></div></div>`;
    $('#winClose', this.layer).onclick = () => this.close();
    $('.win-backdrop', this.layer).onclick = () => this.close();
    this.render();
    if (['menu', 'season'].includes(name) && !this.app.universe && !this.g.paused) { this._resume = this.g.speed; this.g.setSpeed(0); }
  }
  close() {
    // resume what the menu paused; the HUD clears _resume if the player picks a speed meanwhile
    if (this._resume) this.g.setSpeed(this._resume);
    this._resume = 0;
    this.current = null;
    this.layer.innerHTML = '';
  }
  tick() {
    if (!this.current) return;
    if (['finance', 'staff', 'weather', 'resort', 'research', 'marketing', 'events'].includes(this.current)) {
      const b = $('#winBody', this.layer);
      if (b && !b.contains(document.activeElement) && !this._dragging) {
        this._tickN = (this._tickN || 0) + 1;
        if (this._tickN % 8 === 0) this.render(true);
      }
    }
  }
  render(soft) {
    const fn = this['w_' + this.current];
    if (!fn) return;
    const body = $('#winBody', this.layer);
    const sc = body.scrollTop;
    const res = fn.call(this, body);
    if (res && res.title) $('#winTitle', this.layer).innerHTML = res.title;
    if (soft) body.scrollTop = sc;
  }
  tabs(name, list) {
    const cur = this.tab[name] || list[0][0];
    return { cur, html: `<div class="tabs">${list.map(([id, label]) => `<button class="tab ${id === cur ? 'active' : ''}" data-tab="${name}:${id}">${label}</button>`).join('')}</div>` };
  }
  bindTabs(body) {
    body.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { const [n, id] = b.dataset.tab.split(':'); this.tab[n] = id; this.render(); });
  }

  // ---------- finance ----------
  w_finance(body) {
    const g = this.g, s = g.s;
    const L = g.ledger;
    const hist = s.history.slice(-60);
    const last = s.history[s.history.length - 1];
    const sumObj = o => Object.values(o || {}).reduce((a, b) => a + b, 0);
    const rows = (obj, sign) => Object.entries(obj || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<tr><td>${t(CAT_NAMES[k] || k)}</td><td class="num ${sign < 0 ? 'neg' : 'pos'}">${sign < 0 ? '-' : ''}${money(v)}</td></tr>`).join('') || `<tr><td class="muted">—</td><td></td></tr>`;
    const se = s.season;
    const fair = Math.round(20 + 70 * (g.attractiveness || 0.5));
    body.innerHTML = `
      <div class="grid2">
        <section><h3>${t('Today')}</h3>
          <table class="tbl"><tbody>${rows(L.income, 1)}<tr class="sep"><td colspan=2></td></tr>${rows(L.expense, -1)}</tbody>
          <tfoot><tr><td>${t('Net')}</td><td class="num ${sumObj(L.income) - sumObj(L.expense) < 0 ? 'neg' : 'pos'}">${money(sumObj(L.income) - sumObj(L.expense))}</td></tr></tfoot></table>
          ${last ? `<p class="muted small">${t('Yesterday')}: ${t('income')} ${money(last.inc)}, ${t('costs')} ${money(last.exp)}, ${int(last.visitors)} ${t('guests')}</p>` : ''}
        </section>
        <section><h3>${t('Season')} ${se.year}/${(se.year + 1) % 100}</h3>
          <div class="kv"><span>${t('Revenue')}</span><b class="pos">${money(se.revenue)}</b><span>${t('Expenses')}</span><b class="neg">${money(se.expenses)}</b>
          <span>${t('Profit')}</span><b class="${se.revenue - se.expenses < 0 ? 'neg' : 'pos'}">${money(se.revenue - se.expenses)}</b><span>${t('Guests')}</span><b>${int(se.visitors)}</b>
          <span>${t('Asset value')}</span><b>${money(g.assetValue())}</b><span>${t('Loan')}</span><b class="${s.loan ? 'neg' : ''}">${money(s.loan)}</b></div>
          <canvas id="finChart" width="520" height="170"></canvas>
          <div class="legend"><span><i style="background:#62b0ff"></i>${t('Cash')}</span><span><i style="background:#3fcf8e"></i>${t('Daily profit')}</span><span><i style="background:#ef5350"></i>${t('Daily loss')}</span></div>
        </section>
      </div>
      <section><h3>${t('Prices')}</h3>
        <div class="sliders">
          ${this.slider('ticket', t('Day pass'), s.prices.ticket, 20, 140, 1, v => `€${v}`, t('Fair price for your resort: about €{f}', { f: fair }))}
          ${this.slider('food', t('Food & drink'), s.prices.food, 0.6, 1.8, 0.05, v => `${Math.round(v * 100)}%`)}
          ${this.slider('rental', t('Ski rental'), s.prices.rental, 15, 90, 1, v => `€${v}`)}
          ${this.slider('school', t('Ski lesson'), s.prices.school, 30, 160, 1, v => `€${v}`)}
          ${this.slider('lodging', t('Hotel rates'), s.prices.lodging, 0.6, 1.8, 0.05, v => `${Math.round(v * 100)}%`)}
        </div>
      </section>
      <section><h3>${t('Bank')}</h3>
        <p>${t('Loan')}: <b>${money(s.loan)}</b> / ${t('max')} ${money(g.maxLoan())} · 4.5% ${t('per year')}</p>
        <div class="row-btns wrap">${[2e6, 10e6, 25e6].map(v => `<button class="btn" data-loan="${v}">+ ${money(v)}</button>`).join('')}
        ${[2e6, 10e6].map(v => `<button class="btn ghost" data-repay="${v}">${t('Repay')} ${money(v)}</button>`).join('')}<button class="btn ghost" data-repay="1e12">${t('Repay all')}</button></div>
      </section>`;
    this.bindSliders(body, (k, v) => { s.prices[k] = v; });
    body.querySelectorAll('[data-loan]').forEach(b => b.onclick = () => { g.takeLoan(+b.dataset.loan); this.render(true); });
    body.querySelectorAll('[data-repay]').forEach(b => b.onclick = () => { g.repayLoan(+b.dataset.repay); this.render(true); });
    this.chart($('#finChart', body), hist);
    return { title: `💰 ${t('Finances')}` };
  }
  slider(key, label, val, min, max, step, fmt, note = '') {
    return `<label class="sl"><span>${label}</span><input type="range" data-sl="${key}" min="${min}" max="${max}" step="${step}" value="${val}"><b data-slv="${key}">${fmt(val)}</b>${note ? `<small class="muted">${note}</small>` : ''}</label>`;
  }
  bindSliders(body, set, fmts = {}) {
    body.querySelectorAll('[data-sl]').forEach(inp => {
      const k = inp.dataset.sl;
      const out = body.querySelector(`[data-slv="${k}"]`);
      const fmt0 = out.textContent;
      inp.oninput = () => {
        const v = +inp.value;
        set(k, v);
        out.textContent = fmt0.includes('%') ? `${Math.round(v * 100)}%` : fmt0.startsWith('€') ? `€${v}` : (fmts[k] ? fmts[k](v) : String(v));
      };
      inp.onpointerdown = () => { this._dragging = true; };
      inp.onpointerup = () => { this._dragging = false; };
    });
  }
  chart(cv, hist) {
    if (!cv || !hist.length) return;
    const ctx = cv.getContext('2d');
    const W = cv.width, H = cv.height, pad = 30;
    ctx.clearRect(0, 0, W, H);
    const cash = hist.map(h => h.cash), prof = hist.map(h => h.inc - h.exp);
    const cmin = Math.min(...cash, 0), cmax = Math.max(...cash, 1);
    const pmax = Math.max(1, ...prof.map(Math.abs));
    ctx.font = '11px Barlow, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.beginPath(); ctx.moveTo(pad, H / 2); ctx.lineTo(W, H / 2); ctx.stroke();
    const bw = (W - pad) / hist.length;
    prof.forEach((p, i) => {
      const h = (p / pmax) * (H / 2 - 12);
      ctx.fillStyle = p >= 0 ? 'rgba(63,207,142,0.75)' : 'rgba(239,83,80,0.8)';
      ctx.fillRect(pad + i * bw + 1, H / 2 - Math.max(0, h), Math.max(1, bw - 2), Math.abs(h));
    });
    ctx.strokeStyle = '#62b0ff'; ctx.lineWidth = 2;
    ctx.beginPath();
    cash.forEach((c, i) => { const x = pad + i * bw + bw / 2, y = H - 8 - ((c - cmin) / (cmax - cmin || 1)) * (H - 20); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.fillText(money(cmax), 2, 12); ctx.fillText(money(cmin), 2, H - 4);
  }

  // ---------- staff ----------
  w_staff(body) {
    const g = this.g, s = g.s;
    const sum = g.world.summary(s.day);
    const seats = g.world.buildings.filter(b => BUILDINGS[b.type].seats && g.isBuilt(b)).reduce((a, b) => a + BUILDINGS[b.type].seats, 0);
    const rec = { patrol: Math.ceil(sum.km / 6) + 1, mechanic: Math.ceil(sum.lifts / 3), instructor: g.world.buildings.some(b => b.type === 'school') ? Math.max(4, Math.round((g.dayStats.visitors || 2000) * 0.06 / 8)) : 0, host: Math.ceil(seats / 40) };
    const garages = g.world.buildings.filter(b => b.type === 'garage' && g.isBuilt(b)).length;
    const groomKm = s.snowcats * SNOWCAT.kmPerNight;
    const opCost = sum.lifts * 4 * LIFT_OPERATOR_WAGE * s.wageLevel;
    body.innerHTML = `
      <table class="tbl staff"><thead><tr><th>${t('Team')}</th><th>${t('Staff')}</th><th>${t('Suggested')}</th><th>${t('Wage/day')}</th><th></th></tr></thead><tbody>
      ${Object.entries(STAFF).map(([k, S]) => `<tr><td><b>${t(S.name)}</b><div class="muted small">${t(S.desc)}</div></td><td class="num big">${s.staff[k]}</td>
        <td class="num ${s.staff[k] < rec[k] ? 'neg' : 'pos'}">${rec[k]}</td><td class="num">${money(S.wage * s.wageLevel)}</td>
        <td class="nowrap"><button class="btn sm" data-hire="${k}:-5">−5</button><button class="btn sm" data-hire="${k}:-1">−</button><button class="btn sm" data-hire="${k}:1">+</button><button class="btn sm" data-hire="${k}:5">+5</button></td></tr>`).join('')}
      <tr><td><b>${t('Snowcats & drivers')}</b><div class="muted small">${t('Grooming capacity {g} km/night for {p} km of pistes. Garages hold {c}.', { g: groomKm, p: Math.round(sum.km), c: garages * 5 + 1 })}</div></td><td class="num big">${s.snowcats}</td>
        <td class="num ${groomKm < sum.km * 0.7 ? 'neg' : 'pos'}">${Math.ceil(sum.km * 0.8 / SNOWCAT.kmPerNight)}</td><td class="num">${money(SNOWCAT.wage * s.wageLevel)}</td>
        <td class="nowrap"><button class="btn sm" data-cat="-1">${t('Sell')}</button><button class="btn sm" data-cat="1">${t('Buy')} ${money(SNOWCAT.cost)}</button></td></tr>
      <tr><td><b>${t('Lift operators')}</b><div class="muted small">${t('Four per open lift (two shifts, top and bottom), hired automatically.')}</div></td><td class="num big">${sum.lifts * 4}</td><td></td><td class="num">${money(LIFT_OPERATOR_WAGE * s.wageLevel)}</td><td class="muted small">${money(opCost)}/${t('day')}</td></tr>
      </tbody></table>
      <section><h3>${t('Pay & morale')}</h3>
        ${this.slider('wage', t('Wage level'), s.wageLevel, 0.8, 1.5, 0.05, v => `${Math.round(v * 100)}%`)}
        <p>${t('Morale')}: <span class="bar wide"><i style="width:${s.morale}%;background:${s.morale > 60 ? '#3fcf8e' : s.morale > 35 ? '#f2b84b' : '#ef5350'}"></i></span> ${Math.round(s.morale)}%
        ${s.morale < 35 ? `<span class="neg"> · ${t('Strike risk!')}</span>` : ''}</p>
      </section>`;
    body.querySelectorAll('[data-hire]').forEach(b => b.onclick = () => { const [k, d] = b.dataset.hire.split(':'); g.hire(k, +d); this.render(true); });
    body.querySelectorAll('[data-cat]').forEach(b => b.onclick = () => { g.buySnowcat(+b.dataset.cat); this.render(true); });
    this.bindSliders(body, (k, v) => { s.wageLevel = v; });
    return { title: `👷 ${t('Staff')}` };
  }

  // ---------- weather ----------
  w_weather(body) {
    const g = this.g, s = g.s, w = g.weatherNow;
    const top = Math.max(g.refElev + 600, ...g.world.lifts.map(l => l.yb));
    const fc = g.forecast();
    const card = (d, w2, label) => {
      const info = WEATHER_INFO[w2.state];
      const sn = g.climate.snowfallAt(w2, 2000);
      return `<div class="fc"><div class="fc-d">${label}</div><div class="fc-i">${info.icon}</div><div>${t(info.name)}</div>
        <div><b>${Math.round(g.climate.tempAt(w2, g.refElev, 'max'))}°</b> / ${Math.round(g.climate.tempAt(w2, g.refElev, 'min'))}° <small>${Math.round(g.refElev)} m</small></div>
        <div>${Math.round(g.climate.tempAt(w2, top))}° <small>${Math.round(top)} m</small></div>
        <div>💨 ${w2.wind} km/h</div><div>${sn > 0.5 ? `❄️ ${Math.round(sn)} cm` : w2.state === 'rain' ? '🌧️' : '&nbsp;'}</div>
        ${w2.regime && w2.regime !== 'normal' ? `<div class="tag">${t({ cold: 'Cold snap', warm: 'Warm spell', foehn: 'Foehn' }[w2.regime])}</div>` : ''}</div>`;
    };
    const sp = s.snowpack.filter(L => L.h >= g.terrain.minH - 250 && L.h <= g.terrain.maxH + 250);
    const maxD = Math.max(50, ...sp.map(L => L.d));
    const avyTxt = ['', 'Low', 'Moderate', 'Considerable', 'High', 'Very high'][s.avy.level];
    body.innerHTML = `
      <div class="fcs">${card(s.day, w, t('Today'))}${fc.map((f, i) => card(f.day, f, `${t('Day')} +${i + 1}`)).join('')}</div>
      <div class="grid2">
        <section><h3>${t('Snowpack by altitude')}</h3>
          <div class="snowbars">${sp.slice().reverse().map(L => `<div class="sb"><span>${L.h} m</span><i style="width:${Math.min(100, L.d / maxD * 100)}%"></i><b>${Math.round(L.d)} cm</b></div>`).join('')}</div>
          <p class="muted small">${t('Snowline about {h} m. Season outlook: {c}.', { h: Math.round(g.snowline / 50) * 50, c: t({ epic: 'very snowy', poor: 'dry and mild', normal: 'average' }[w.character]) })}</p>
        </section>
        <section><h3>${t('Avalanche danger')}</h3>
          <div class="avy l${s.avy.level}"><b>${s.avy.level}</b> ${t(avyTxt)}</div>
          <p class="small">${t('New snow last 3 days at 2000 m')}: ${s.avy.recent.map(v => Math.round(v)).join(' / ')} cm ${s.avy.controlled ? `· <span class="pos">${t('controlled today')}</span>` : ''}</p>
          <label class="check"><input type="checkbox" id="pAvy" ${s.policy.avyControl ? 'checked' : ''}> ${t('Patrol blasts avalanche slopes at dawn when danger ≥ 3 (needs a patrol base and 3+ patrollers)')}</label>
          <h3>${t('Snow policy')}</h3>
          ${this.slider('target', t('Snowmaking target depth'), s.policy.snowTarget, 30, 150, 5, v => `${v} cm`)}
          <label class="check"><input type="checkbox" id="pEarly" ${s.policy.earlyOpen ? 'checked' : ''}> ${t('Open early/late in the shoulder months if there is snow')}</label>
          <label class="check"><input type="checkbox" id="pSummer" ${s.policy.summerOps ? 'checked' : ''}> ${t('Run gondolas and chairlifts for summer hikers')}</label>
          <label class="check"><input type="checkbox" id="pNight" ${s.policy.autoNight ? 'checked' : ''}> ${t('Fast-forward through the night')}</label>
        </section>
      </div>`;
    $('#pAvy', body).onchange = e => { s.policy.avyControl = e.target.checked; };
    $('#pEarly', body).onchange = e => { s.policy.earlyOpen = e.target.checked; g._applyStatuses(); };
    $('#pSummer', body).onchange = e => { s.policy.summerOps = e.target.checked; };
    $('#pNight', body).onchange = e => { s.policy.autoNight = e.target.checked; };
    this.bindSliders(body, (k, v) => { s.policy.snowTarget = v; }, { target: v => `${v} cm` });
    return { title: `🌦️ ${t('Weather & snow')}` };
  }

  // ---------- events ----------
  w_events(body) {
    const g = this.g, s = g.s, ev = g.events;
    const list = ev.list().filter(c => c.eventDay + c.durationDays >= s.day).sort((a, b) => a.eventDay - b.eventDay);
    const srv = id => g.universe?.client?.compById?.(id);
    const items = list.map(c => {
      const st = s.comps[c.id];
      const open = s.day < c.bidDeadlineDay && (!g.universe || !srv(c.id) || srv(c.id).status === 'open');
      const el = ev.eligibility(c);
      const score = ev.bidScore(c);
      const sched = s.scheduled.find(x => x.id === c.id);
      let status;
      if (sched) status = `<span class="badge ok">${t('You are hosting')} · ${dstr(c.eventDay)}</span>`;
      else if (st?.status === 'bid') status = `<span class="badge mid">${t('Bid placed')} (${st.score})</span>`;
      else if (st?.status === 'lost') status = `<span class="badge bad">${t('Lost to {w}', { w: escapeHtml(st.winner || '?') })}</span>`;
      else if (!open) status = `<span class="badge">${t('Bidding closed')}${srv(c.id)?.winnerName ? ` · ${escapeHtml(srv(c.id).winnerName)}` : ''}</span>`;
      else status = `<span class="badge">${t('Bids until {d}', { d: dstr(c.bidDeadlineDay) })}</span>`;
      const others = srv(c.id)?.bids?.filter(b => b.siteId !== s.siteId).map(b => `${escapeHtml(b.siteName)} ${b.score}`).join(', ');
      return `<div class="comp ${c.type}">
        <div class="comp-h"><b>${escapeHtml(compTitle(c))}</b>${status}</div>
        <div class="muted small">${dstr(c.eventDay)} · ${c.durationDays} ${t('days')} · ${t('prize')} ${money(c.prize)} · ${t('fame')} +${c.fame} · ${t('bid fee')} ${money(ev.bidCost(c))}</div>
        ${open && !st ? (el.ok ? `<div class="pos small">✔ ${t('You meet the requirements. Your bid score: {s}', { s: score })}</div>
          <div class="row-btns"><button class="btn primary sm" data-bid="${c.id}:0">${t('Submit bid')}</button><button class="btn sm" data-bid="${c.id}:1">${t('Bid + lobbying')} (${money(ev.bidCost(c) * 2.5)})</button><button class="btn sm" data-bid="${c.id}:2">${t('Bid + heavy lobbying')} (${money(ev.bidCost(c) * 4)})</button></div>`
          : `<div class="small neg">✘ ${el.reasons.join(' · ')}</div>`) : ''}
        ${others ? `<div class="small muted">${t('Rival bids')}: ${others}</div>` : ''}
      </div>`;
    }).join('');
    const sched = s.scheduled.filter(x => !x.done);
    body.innerHTML = `
      <p class="muted">${t('Host races to boost fame and earn TV money. You need the right piste (vertical drop, difficulty, snowmaking), a Finish Stadium near its finish, enough beds and a good rating. Venues still under construction count if they are ready in time.')}</p>
      <div class="kv inline"><span>${t('Hosted')}</span><b>${t('World Cup')} ${s.hosted.worldcup} · ${t('World Championships')} ${s.hosted.worldchamps} · ${t('Olympics')} ${s.hosted.olympics}</b></div>
      ${sched.length ? `<h3>${t('Upcoming at your resort')}</h3>${sched.map(e => `<div class="comp mine"><b>${escapeHtml(t(e.title))}</b> · ${dstr(e.start)}–${dstr(e.end)}</div>`).join('')}` : ''}
      <h3>${t('Calendar')}</h3><div class="comps">${items || `<p class="muted">${t('No competitions right now.')}</p>`}</div>`;
    body.querySelectorAll('[data-bid]').forEach(b => b.onclick = () => {
      const [id, lobby] = b.dataset.bid.split(':');
      const c = list.find(x => x.id === id);
      const r = ev.placeBid(c, +lobby);
      if (!r.ok) this.hud.toast('bad', r.error);
      this.render(true);
    });
    if (g.universe?.client) g.universe.client.refreshCompetitions?.().then(() => { if (this.current === 'events') this.render(true); }).catch(() => {});
    return { title: `🏆 ${t('Competitions & events')}` };
  }

  // ---------- research ----------
  w_research(body) {
    const g = this.g, R = g.s.research;
    body.innerHTML = `<div class="cards wide">${RESEARCH.map(r => {
      const done = g.hasResearch(r.id), cur = R.current === r.id;
      const locked = r.requires && !g.hasResearch(r.requires);
      return `<div class="card ${done ? 'done' : ''} ${locked ? 'locked' : ''}">
        <div class="card-h">${done ? '✅' : cur ? '🔬' : locked ? '🔒' : '💡'} ${t(r.name)}</div>
        <div class="card-d">${t(r.desc)}</div>
        <div class="card-s">${money(r.cost)} · ${r.days} ${t('days')}${r.requires ? ` · ${t('needs')} ${t(RESEARCH.find(x => x.id === r.requires).name)}` : ''}</div>
        ${cur ? `<div class="bar wide"><i style="width:${R.progress / r.days * 100}%"></i></div>` : ''}
        ${!done && !cur && !locked && !R.current ? `<button class="btn sm primary" data-res="${r.id}">${t('Start')}</button>` : ''}
      </div>`;
    }).join('')}</div>`;
    body.querySelectorAll('[data-res]').forEach(b => b.onclick = () => { g.startResearch(b.dataset.res); this.render(true); });
    return { title: `🔬 ${t('Research & technology')}` };
  }

  // ---------- marketing ----------
  w_marketing(body) {
    const g = this.g, s = g.s;
    const active = s.marketing.filter(m => m.until >= s.day);
    body.innerHTML = `
      <div class="kv inline"><span>${t('Rating')}</span><b>${Math.round(s.rep)}/100</b><span>${t('Fame')}</span><b>${Math.round(s.fame)}/100</b><span>${t('Hotel occupancy')}</span><b>${Math.round((g.occupancy || 0) * 100)}%</b></div>
      <div class="cards wide">${CAMPAIGNS.map(c => {
        const on = active.find(a => a.id === c.id);
        return `<div class="card"><div class="card-h">📣 ${t(c.name)}</div><div class="card-d">${t(c.desc)}</div>
          <div class="card-s">${money(c.cost)} · ${c.days} ${t('days')}</div>
          ${on ? `<span class="badge ok">${t('Running until {d}', { d: dstr(on.until) })}</span>` : `<button class="btn sm primary" data-camp="${c.id}">${t('Launch')}</button>`}</div>`;
      }).join('')}</div>`;
    body.querySelectorAll('[data-camp]').forEach(b => b.onclick = () => { g.launchCampaign(CAMPAIGNS.find(c => c.id === b.dataset.camp)); this.render(true); });
    return { title: `📣 ${t('Marketing')}` };
  }

  // ---------- resort ----------
  w_resort(body) {
    const g = this.g, s = g.s;
    const sum = g.world.summary(s.day);
    const goals = g.goalProgress();
    const comp = g.lastComplaints || {};
    const ck = Object.entries(comp).sort((a, b) => b[1] - a[1]).slice(0, 6);
    const CN = { queue: 'Lift queues', tooHard: 'Pistes too hard', ice: 'Icy pistes', slush: 'Slush', thin: 'Thin snow', noFood: 'No food', foodFull: 'Restaurants full', noToilet: 'No toilets', stranded: 'Stranded on the mountain', crowded: 'Crowded pistes', cold: 'Cold chairlifts', liftClosed: 'Lift closures', noInstructors: 'Not enough instructors', stuckLift: 'Stuck on lifts', boring: 'Too easy for experts', tbar: 'T-bar troubles', noRental: 'No rental', noSchool: 'No ski school', serviceFull: 'Services full' };
    body.innerHTML = `
      <div class="grid2">
        <section><h3>${escapeHtml(s.name)}</h3>
          <div class="kv">
            <span>${t('Pistes')}</span><b>${sum.pistes} · ${km(sum.km * 1000)}</b>
            <span>${t('By difficulty')}</span><b>${DIFF.map((d, i) => `<span class="dot" style="background:${d.color}"></span>${sum.byDiff[i].toFixed(1)}`).join(' ')} km</b>
            <span>${t('Lifts')}</span><b>${sum.lifts} · ${int(sum.capacity)} ${t('pph')}</b>
            <span>${t('Altitude')}</span><b>${Math.round(sum.bottom)} – ${Math.round(sum.top)} m (${Math.round(sum.top - sum.bottom)} m)</b>
            <span>${t('Beds')}</span><b>${int((g.def.beds || 0) + g.ownBeds())} (${int(g.ownBeds())} ${t('yours')})</b>
            <span>${t('Rating')}</span><b>${Math.round(s.rep)}/100</b>
            <span>${t('Fame')}</span><b>${Math.round(s.fame)}/100</b>
            <span>${t('Guest happiness yesterday')}</span><b>${g.dayHappy != null ? Math.round(g.dayHappy) + '%' : '—'}</b>
            <span>${t('Total guests')}</span><b>${int(s.stats.totalVisitors)}</b>
          </div>
        </section>
        <section><h3>${t('Goals')}</h3>
          ${goals.length ? goals.map(gl => `<div class="goal ${gl.done ? 'done' : ''}">${gl.done ? '✅' : '⬜'} ${t(gl.label)} <small class="muted">${gl.type === 'cash' || gl.type === 'value' ? money(gl.value) : int(gl.value)} / ${gl.type === 'cash' || gl.type === 'value' ? money(gl.target) : int(gl.target)}</small></div>`).join('') : `<p class="muted">${t('Sandbox: no goals. Build the resort of your dreams.')}</p>`}
          ${s.won ? `<p class="pos"><b>🏆 ${t('Scenario complete!')}</b></p>` : ''}
          <h3>${t('What guests talk about')}</h3>
          ${ck.length ? ck.map(([k, v]) => `<div class="small">💬 ${t(CN[k] || k)} <span class="muted">(${int(v)})</span></div>`).join('') : `<p class="muted small">${t('Nothing yet.')}</p>`}
        </section>
      </div>
      <section><h3>${t('Seasons')}</h3>
        <table class="tbl"><thead><tr><th>${t('Season')}</th><th>${t('Guests')}</th><th>${t('Revenue')}</th><th>${t('Profit')}</th><th>${t('Open days')}</th><th>${t('Happiness')}</th><th>${t('Awards & events')}</th></tr></thead>
        <tbody>${s.seasons.slice().reverse().map(se => `<tr><td>${se.year}/${(se.year + 1) % 100}</td><td class="num">${int(se.visitors)}</td><td class="num">${money(se.revenue)}</td><td class="num ${se.profit < 0 ? 'neg' : 'pos'}">${money(se.profit)}</td><td class="num">${se.openDays}</td><td class="num">${se.happy ?? '—'}</td><td class="small">${[...(se.awards || []), ...(se.events || [])].map(a => escapeHtml(t(a))).join(' · ')}</td></tr>`).join('') || `<tr><td colspan=7 class="muted">${t('Your first season is under way.')}</td></tr>`}</tbody></table>
      </section>`;
    return { title: `📊 ${t('Resort overview')}` };
  }

  // ---------- piste map ----------
  w_map(body) {
    body.innerHTML = `<canvas id="pmap"></canvas><div class="row-btns"><button class="btn" id="pmDl">⬇ ${t('Download PNG')}</button><span class="muted small">${t('Click on the map to fly there.')}</span></div>`;
    const cv = $('#pmap', body);
    const g = this.g;
    const T = g.terrain;
    const W = Math.min(1500, window.innerWidth - 120);
    cv.width = W; cv.height = Math.round(W * T.depth / T.width);
    if (cv.height > window.innerHeight - 220) { cv.height = window.innerHeight - 220; cv.width = Math.round(cv.height * T.width / T.depth); }
    drawPisteMap(cv, g);
    $('#pmDl', body).onclick = () => { const a = document.createElement('a'); a.download = `${g.s.name.replace(/\W+/g, '_')}_piste_map.png`; a.href = cv.toDataURL('image/png'); a.click(); };
    cv.onclick = e => {
      const r = cv.getBoundingClientRect();
      const x = T.x0 + (e.clientX - r.left) / r.width * T.width, z = T.z0 + (e.clientY - r.top) / r.height * T.depth;
      this.close();
      this.app.s3.flyTo(x, z, 3000);
    };
    return { title: `🗺️ ${t('Piste map')} · ${escapeHtml(g.s.name)}` };
  }

  // ---------- log ----------
  w_log(body) {
    const log = this.g.s.log;
    body.innerHTML = `<div class="log">${log.map(m => `<div class="logrow ${m.kind}" ${m.focus ? `data-f='${JSON.stringify(m.focus)}'` : ''}><span class="muted">${dstr(m.day)} ${hhmm(m.minute)}</span> ${m.icon || ''} ${escapeHtml(m.text)}</div>`).join('') || t('No messages yet.')}</div>`;
    body.querySelectorAll('[data-f]').forEach(r => r.onclick = () => { this.close(); this.hud.focusOn(JSON.parse(r.dataset.f)); });
    return { title: `📜 ${t('Messages')}` };
  }

  // ---------- season report ----------
  seasonReport(se) {
    this.open('season', { se, force: true });
  }
  w_season(body) {
    const se = this.opts.se;
    body.innerHTML = `<div class="report">
      <div class="big-stats"><div><b>${int(se.visitors)}</b><span>${t('skier days')}</span></div><div><b class="${se.profit < 0 ? 'neg' : 'pos'}">${money(se.profit)}</b><span>${t('profit')}</span></div><div><b>${se.openDays}</b><span>${t('days open')}</span></div><div><b>${se.happy ?? '—'}%</b><span>${t('happiness')}</span></div></div>
      ${se.awards?.length ? `<h3>🏆 ${t('Awards')}</h3>${se.awards.map(a => `<div class="award">${escapeHtml(t(a))}</div>`).join('')}` : ''}
      ${se.events?.length ? `<h3>🏁 ${t('Events hosted')}</h3>${se.events.map(a => `<div>${escapeHtml(t(a))}</div>`).join('')}` : ''}
      <p class="muted">${t('Summer is construction time: lifts and pistes built now will be ready for next winter.')}</p>
      <div class="row-btns"><button class="btn primary" id="sOk">${t('Continue')}</button></div></div>`;
    $('#sOk', body).onclick = () => this.close();
    return { title: `❄️ ${t('Season {y} report', { y: `${se.year}/${(se.year + 1) % 100}` })}` };
  }

  // ---------- menu ----------
  w_menu(body) {
    const app = this.app;
    body.innerHTML = `<div class="menu-list">
      <button class="btn big" id="mResume">▶ ${t('Resume')}</button>
      <button class="btn big" id="mSave">💾 ${app.universe ? t('Save to server') : t('Save game')}</button>
      ${!app.universe ? `<button class="btn big" id="mExport">⬇ ${t('Export save file')}</button>` : ''}
      ${!app.universe ? `<button class="btn big" id="mSkip">⏭ ${t('Skip to next ski season')}</button>` : ''}
      <div class="lang">${t('Language')}: <button class="chip ${getLang() === 'en' ? 'active' : ''}" data-lang="en">English</button><button class="chip ${getLang() === 'it' ? 'active' : ''}" data-lang="it">Italiano</button></div>
      <label class="check"><input type="checkbox" id="mQuality" ${app.quality === 'low' ? 'checked' : ''}> ${t('Low graphics (fewer trees and skiers)')}</label>
      <details class="help"><summary>❓ ${t('How to play')}</summary>
        <ul>
          <li>${t('Camera: left-drag or WASD to pan, right-drag or Q/E to rotate, wheel to zoom.')}</li>
          <li>${t('Lifts: pick a type, click the bottom station, then the top station. Towers follow the real terrain.')}</li>
          <li>${t('Pistes: click from the top down, near a lift top station, and finish next to a lift bottom or base. The real gradient decides the colour.')}</li>
          <li>${t('Every lift top needs an easy way down, or guests get stranded. Gondolas and cable cars can also carry guests down.')}</li>
          <li>${t('Guests need a Base Station, food, toilets, rentals and a ski school. Huts must be near a lift station or piste junction.')}</li>
          <li>${t('Winter: snowmaking needs cold nights and water; snowcats groom at night. Summer: build for next season.')}</li>
          <li>${t('Host World Cup races and the Olympics from the Events window once your resort qualifies.')}</li>
          <li>${t('Space pauses, 1-4 set the speed, L toggles names, Esc cancels.')}</li>
        </ul>
      </details>
      <button class="btn big danger ghost" id="mQuit">⏏ ${t('Quit to main menu')}</button>
      <p class="muted small">${t('Elevation: AWS Terrain Tiles (Mapzen, SRTM, EU-DEM and others). Lifts, pistes and buildings: © OpenStreetMap contributors (ODbL).')}</p>
    </div>`;
    $('#mResume', body).onclick = () => this.close();
    $('#mSave', body).onclick = async () => { await app.save(true); };
    $('#mExport', body)?.addEventListener('click', () => app.exportSave());
    $('#mSkip', body)?.addEventListener('click', () => { this.close(); this.g.skipToSeason(); app.layers.rebuildAll(); });
    $('#mQuit', body).onclick = async () => { await app.save(false); this.close(); app.quit(); };
    $('#mQuality', body).onchange = e => app.setQuality(e.target.checked ? 'low' : 'high');
    body.querySelectorAll('[data-lang]').forEach(b => b.onclick = () => { setLang(b.dataset.lang); location.reload(); });
    return { title: `☰ ${t('Menu')}` };
  }

  // ---------- universe ----------
  w_universe(body) {
    const app = this.app, cl = app.universe.client;
    const { cur, html } = this.tabs('uni', [['board', `🏆 ${t('Leaderboard')}`], ['news', `📰 ${t('News')}`], ['ally', `🤝 ${t('Alliances')}`], ['msg', `✉️ ${t('Messages')}`], ['nearby', `📍 ${t('Neighbours')}`]]);
    body.innerHTML = `${html}<div id="uniBody"><p class="muted">${t('Loading…')}</p></div>`;
    this.bindTabs(body);
    const ub = $('#uniBody', body);
    const fail = e => { ub.innerHTML = `<p class="neg">${escapeHtml(e.message)}</p>`; };
    if (cur === 'board') cl.leaderboard().then(lb => {
      ub.innerHTML = `<table class="tbl"><thead><tr><th>#</th><th>${t('Resort')}</th><th>${t('Owner')}</th><th>${t('Rating')}</th><th>${t('Guests/season')}</th><th>${t('km')}</th><th>${t('Value')}</th></tr></thead><tbody>
        ${lb.resorts.map((r, i) => `<tr class="${r.siteId === app.game.s.siteId ? 'me' : ''}"><td>${i + 1}</td><td>${escapeHtml(r.name)} <span class="muted">${escapeHtml(r.country || '')}</span></td><td>${escapeHtml(r.ownerName || '—')}${r.allianceTag ? ` <span class="tag">[${escapeHtml(r.allianceTag)}]</span>` : ''}</td><td class="num">${int(r.rating)}</td><td class="num">${int(r.visitorsSeason)}</td><td class="num">${r.pisteKm}</td><td class="num">${money(r.value)}</td></tr>`).join('')}</tbody></table>
        ${lb.alliances?.length ? `<h3>${t('Alliances')}</h3><table class="tbl"><tbody>${lb.alliances.map(a => `<tr><td>[${escapeHtml(a.tag)}] ${escapeHtml(a.name)}</td><td class="num">${a.members} ${t('members')}</td><td class="num">${money(a.totalValue)}</td></tr>`).join('')}</tbody></table>` : ''}`;
    }).catch(fail);
    if (cur === 'news') cl.news().then(list => {
      ub.innerHTML = `<div class="log">${list.map(n => `<div class="logrow"><span class="muted">${new Date(n.time).toLocaleString()}</span> ${escapeHtml(n.text)}</div>`).join('') || t('No news yet.')}</div>`;
    }).catch(fail);
    if (cur === 'ally') cl.alliances().then(list => {
      const me = cl.me;
      const mine = list.find(a => a.members.some(m => m.id === me?.id));
      ub.innerHTML = `<p class="muted">${t('Alliances work like a shared ski pass: allied resorts in the same region attract more guests together (+6% per allied neighbour within 60 km, up to +24%).')}</p>
        ${mine ? `<div class="comp mine"><b>[${escapeHtml(mine.tag)}] ${escapeHtml(mine.name)}</b> · ${mine.members.map(m => escapeHtml(m.name)).join(', ')} <button class="btn sm ghost" id="aLeave">${t('Leave')}</button></div>` :
          `<div class="row-btns"><input class="input" id="aName" placeholder="${t('Alliance name')}"><input class="input sm" id="aTag" placeholder="TAG" maxlength="5"><button class="btn primary" id="aCreate">${t('Found alliance')}</button></div>`}
        <table class="tbl"><tbody>${list.map(a => `<tr><td>[${escapeHtml(a.tag)}] ${escapeHtml(a.name)}</td><td>${a.members.map(m => escapeHtml(m.name)).join(', ')}</td><td>${!mine ? `<button class="btn sm" data-join="${a.id}">${t('Join')}</button>` : ''}</td></tr>`).join('')}</tbody></table>`;
      $('#aLeave', ub)?.addEventListener('click', () => cl.leaveAlliance().then(() => this.render()).catch(e => this.hud.toast('bad', e.message)));
      $('#aCreate', ub)?.addEventListener('click', () => cl.createAlliance($('#aName', ub).value, $('#aTag', ub).value).then(() => this.render()).catch(e => this.hud.toast('bad', e.message)));
      ub.querySelectorAll('[data-join]').forEach(b => b.onclick = () => cl.joinAlliance(b.dataset.join).then(() => this.render()).catch(e => this.hud.toast('bad', e.message)));
    }).catch(fail);
    if (cur === 'msg') cl.messages().then(m => {
      ub.innerHTML = `<div class="grid2"><section><h3>${t('Inbox')}</h3><div class="log">${m.inbox.map(x => `<div class="logrow ${x.read ? '' : 'unread'}" data-read="${x.id}"><b>${escapeHtml(x.fromName)}</b>: <i>${escapeHtml(x.subject)}</i><br>${escapeHtml(x.text)}<div class="muted small">${new Date(x.time).toLocaleString()}</div></div>`).join('') || t('Empty.')}</div></section>
        <section><h3>${t('Write')}</h3><input class="input" id="mTo" placeholder="${t('To (player name)')}"><input class="input" id="mSubj" placeholder="${t('Subject')}"><textarea class="input" id="mText" rows="5" placeholder="${t('Message')}"></textarea><button class="btn primary" id="mSend">${t('Send')}</button></section></div>`;
      $('#mSend', ub).onclick = () => cl.sendMessage($('#mTo', ub).value, $('#mSubj', ub).value, $('#mText', ub).value).then(() => { this.hud.toast('good', t('Message sent.')); this.render(); }).catch(e => this.hud.toast('bad', e.message));
      ub.querySelectorAll('[data-read]').forEach(r => r.onclick = () => cl.markRead(r.dataset.read).catch(() => {}));
    }).catch(fail);
    if (cur === 'nearby') cl.sites().then(sites => {
      const s = app.game.s;
      const near = sites.filter(x => x.id !== s.siteId).map(x => ({ ...x, d: Math.round(haversine(s.def.lat, s.def.lon, x.lat, x.lon)) })).sort((a, b) => a.d - b.d).slice(0, 15);
      ub.innerHTML = `<p class="muted">${t('Resorts within 60 km compete with you for day visitors. Your market share today: {p}%.', { p: Math.round((app.universe.share ?? 1) * 100) })}</p>
        <table class="tbl"><tbody>${near.map(x => `<tr><td>${escapeHtml(x.name)}</td><td>${x.d} km</td><td>${x.ownerName ? escapeHtml(x.ownerName) : `<span class="muted">${t('free')}</span>`}</td><td class="num">${x.stats?.rating ?? '—'}</td><td>${x.ownerId ? `<button class="btn sm" data-visit="${x.id}">👁 ${t('Visit')}</button>` : ''}</td></tr>`).join('')}</tbody></table>`;
      ub.querySelectorAll('[data-visit]').forEach(b => b.onclick = () => { this.close(); app.visitSite?.(b.dataset.visit); });
    }).catch(fail);
    return { title: `🌍 ${escapeHtml(app.universe.info.name)}` };
  }
}

function haversine(a, b, c, d) {
  const R = 6371, r = Math.PI / 180;
  const x = Math.sin((c - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
