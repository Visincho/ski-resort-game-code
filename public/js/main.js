// Snowline: boot, menus (solo / online universe), game assembly, main loop, saving.

import { Terrain } from './terrain.js';
import { Biome } from './biome.js';
import { World } from './world.js';
import { Game, newState } from './sim.js';
import { fetchOsm, importLayout, villageHouses, findFreeSpot } from './osm.js';
import { Scene3D } from './render/scene.js';
import { Layers } from './render/layers.js';
import { HUD } from './ui/hud.js';
import { Builder } from './build.js';
import { SkiMode } from './skimode.js';
import { UniverseClient } from './net.js';
import { WorldMap } from './ui/worldmap.js';
import { FAMOUS_RESORTS, findResort, defaultClimate } from './shared/resorts.js';
import { dayFromYMD, ymdFromDay, universeDay } from './shared/calendar.js';
import { SNOWCAT, BUILDINGS } from './catalog.js';
import { money, int, escapeHtml, dist, clamp } from './util.js';
import { t, getLang, setLang } from './i18n.js';
import { getProfile, createProfile, adoptProfile, renameProfile, cleanName, listSessions, findSession, readSession, writeSession, deleteSession, newSession, envelope, sessionOf, downloadSession, parseSessionFile, compareImport, forkSession } from './saves.js';

const $ = (s, r = document) => r.querySelector(s);
const FLAGS = { IT: '🇮🇹', CH: '🇨🇭', AT: '🇦🇹', FR: '🇫🇷', DE: '🇩🇪', SI: '🇸🇮', US: '🇺🇸', CA: '🇨🇦', JP: '🇯🇵', SE: '🇸🇪', ES: '🇪🇸', NZ: '🇳🇿', CL: '🇨🇱', AU: '🇦🇺' };
const flag = c => FLAGS[c] || (c && c.length === 2 ? String.fromCodePoint(...[...c.toUpperCase()].map(ch => 127397 + ch.charCodeAt(0))) : '🏔️');
const DOLOMITES = ['cortina', 'valgardena', 'altabadia', 'campiglio'];

const app = {
  game: null, s3: null, layers: null, hud: null, builder: null, ski: null,
  universe: null, quality: localStorage.getItem('snowline.quality') || 'high',
  client: new UniverseClient(),
};
window.snowline = app; // handy for debugging in the console
app.external = new URLSearchParams(location.search).has('record');

// ====================================================================================
// Menus
// ====================================================================================
function menuShow(html) {
  $('#menu').hidden = false;
  $('#menuInner').innerHTML = html;
}

function titleScreen(note) {
  const me = getProfile();
  const saves = listSessions();
  menuShow(`
    <div class="title">
      <div class="logo"><span class="logo-mark">⛰</span><div><h1>SNOWLINE</h1><p>${t('Ski resort tycoon on real mountains')}</p></div></div>
      ${me ? `<div class="profile" id="tProfile"><span class="pf-icon">👤</span><div class="grow"><b>${escapeHtml(me.name)}</b><div class="muted small">${t('Player ID')} ${escapeHtml(me.id)}</div></div><button class="btn ghost sm" id="tRename">✎ ${t('Change name')}</button></div>` : `
      <div class="profile new">
        <h3>${t('Who is playing?')}</h3>
        <p class="small">${t('Pick a player name. It stays in this browser and tags your saved games, so you can share them with friends or move them to another PC.')}</p>
        <div class="row-btns"><input class="input" id="pName" maxlength="24" placeholder="${t('Player name')}" autocomplete="nickname"><button class="btn primary nowrap" id="pGo">${t('Create player')}</button></div>
        <label class="btn ghost sm">📂 ${t('Moving from another PC? Import a save file')}<input type="file" id="pFile" accept=".json,.snowline" hidden></label>
        ${noteHtml(note)}
      </div>`}
      <div class="title-btns">
        ${me && saves.length ? `<button class="btn big primary" id="tContinue">▶ ${t('Continue')} <small>${escapeHtml(saves[0].name)} · ${fmtDay(saves[0].day)}</small></button>` : ''}
        ${me ? `<button class="btn big ${saves.length ? '' : 'primary'}" id="tSolo">⛷️ ${t('New solo game')}</button>` : ''}
        <button class="btn big" id="tUni">🌍 ${t('Online universe')}</button>
        ${me ? `<button class="btn big ghost" id="tLoad">📂 ${t('Load / import')}</button>` : ''}
      </div>
      <div class="title-foot">
        <div class="lang"><button class="chip ${getLang() === 'en' ? 'active' : ''}" data-lang="en">English</button><button class="chip ${getLang() === 'it' ? 'active' : ''}" data-lang="it">Italiano</button></div>
        <p class="muted small">${t('Real elevation data for {n} famous ski areas and any mountain on Earth. Lifts and pistes from OpenStreetMap.', { n: FAMOUS_RESORTS.length })}</p>
      </div>
    </div>`);
  $('#tContinue')?.addEventListener('click', () => loadSave(saves[0].id));
  $('#tSolo')?.addEventListener('click', () => soloScreen());
  $('#tUni').onclick = () => universeScreen();
  $('#tLoad')?.addEventListener('click', () => loadScreen());
  document.querySelectorAll('[data-lang]').forEach(b => b.onclick = () => { setLang(b.dataset.lang); titleScreen(); });
  if (me) $('#tRename').onclick = () => renameForm(me);
  else newPlayerForm(note);
}

function newPlayerForm(note) {
  const go = () => {
    const name = cleanName($('#pName').value);
    if (!name) return $('#pName').focus();
    createProfile(name);
    titleScreen();
  };
  $('#pGo').onclick = go;
  $('#pName').onkeydown = e => { if (e.key === 'Enter') go(); };
  $('#pName').focus();
  bindNote(note, titleScreen);
  $('#pFile').onchange = async e => {
    const env = await readSaveFile(e.target.files[0]);
    if (!env) return titleScreen({ kind: 'bad', html: t('Could not read that file.') });
    // your own file from the old PC: keep the same player id here
    const u = env.by || env.owner;
    if (u && confirm(t('This game was last saved by {n}. Is that you? OK keeps the same player ID on this device.', { n: u.name }))) adoptProfile(u);
    const res = importSession(env);
    if (getProfile()) loadScreen(res);
    else titleScreen({ ...res, html: `${res.html} ${t('Now choose your player name.')}` });
  };
}

function renameForm(me) {
  const box = $('#tProfile');
  box.innerHTML = `<span class="pf-icon">👤</span><input class="input" id="tName" maxlength="24" value="${escapeHtml(me.name)}"><button class="btn primary sm" id="tOk">${t('Save')}</button><button class="btn ghost sm" id="tNo">${t('Cancel')}</button>`;
  const ok = () => { if (cleanName($('#tName').value)) renameProfile($('#tName').value); titleScreen(); };
  $('#tOk').onclick = ok;
  $('#tNo').onclick = () => titleScreen();
  $('#tName').onkeydown = e => { if (e.key === 'Enter') ok(); else if (e.key === 'Escape') titleScreen(); };
  $('#tName').select();
}

// notices on the title and Load screens; actions return the next notice
function noteHtml(n) {
  if (!n) return '';
  return `<div class="note ${n.kind}"><p>${n.html}</p>${n.actions?.length ? `<div class="row-btns wrap">${n.actions.map(([label], i) => `<button class="btn sm" data-act="${i}">${label}</button>`).join('')}</div>` : ''}</div>`;
}
function bindNote(n, render) {
  document.querySelectorAll('[data-act]').forEach(b => b.onclick = () => render(n.actions[+b.dataset.act][1]()));
}

function fmtDay(day) { const d = ymdFromDay(day); return `${d.d}/${d.m}/${d.y}`; }

// ---------- solo ----------
let soloSel = 'cortina', soloLayout = 'osm', soloDiff = 'normal', customDef = null;
function soloScreen() {
  const cards = FAMOUS_RESORTS.map(r => `<button class="rcard ${r.id === soloSel ? 'active' : ''}" data-r="${r.id}">
      <span class="rc-flag">${flag(r.country)}</span><span class="rc-name">${escapeHtml(r.name)}</span><span class="rc-reg">${escapeHtml(r.region)}</span>
      <span class="rc-fame" title="${t('Fame')}">${'★'.repeat(Math.round(r.fame / 20))}</span></button>`).join('');
  menuShow(`
    <div class="solo">
      <div class="solo-h"><button class="btn ghost" id="sBack">← ${t('Back')}</button><h2>${t('Choose your mountain')}</h2></div>
      <div class="solo-grid">
        <div class="rcards">${cards}<button class="rcard custom ${soloSel === 'custom' ? 'active' : ''}" data-r="custom"><span class="rc-flag">🌐</span><span class="rc-name">${t('Anywhere on Earth')}</span><span class="rc-reg">${t('Pick any mountain on the world map')}</span></button></div>
        <div class="solo-detail" id="sDetail"></div>
      </div>
    </div>`);
  $('#sBack').onclick = titleScreen;
  document.querySelectorAll('[data-r]').forEach(b => b.onclick = () => { soloSel = b.dataset.r; document.querySelectorAll('.rcard').forEach(c => c.classList.toggle('active', c === b)); soloDetail(); });
  soloDetail();
}

function soloDetail() {
  const el = $('#sDetail');
  if (soloSel === 'custom') return customPicker(el);
  const r = findResort(soloSel);
  const layouts = [['osm', t('Real resort today'), t('Start with the real lifts and pistes from OpenStreetMap and manage them.')], ['empty', t('Empty mountain'), t('Only the village. Design the ski area from scratch.')], ['sandbox', t('Sandbox'), t('Empty mountain, €250M and no goals.')]];
  el.innerHTML = `
    <div class="sd-h"><span class="rc-flag big">${flag(r.country)}</span><div><h3>${escapeHtml(r.name)}</h3><div class="muted">${escapeHtml(r.region)} · ${r.lat.toFixed(2)}°, ${r.lon.toFixed(2)}° · ${r.w}×${r.h} km</div></div></div>
    <p>${escapeHtml(t(r.blurb))}</p>
    <div class="kv inline"><span>${t('Fame')}</span><b>${r.fame}</b><span>${t('Village beds')}</span><b>${int(r.beds)}</b><span>${t('Treeline')}</span><b>${r.treeline} m</b><span>${t('Snowfall')}</span><b>${r.climate.snow >= 1.4 ? t('Very high') : r.climate.snow >= 1 ? t('High') : r.climate.snow >= 0.75 ? t('Average') : t('Low')}</b></div>
    <h4>${t('Start')}</h4>
    <div class="opts">${layouts.map(([id, n, d]) => `<label class="opt ${soloLayout === id ? 'active' : ''}"><input type="radio" name="lay" value="${id}" ${soloLayout === id ? 'checked' : ''}><b>${n}</b><span>${d}</span></label>`).join('')}</div>
    ${soloLayout !== 'sandbox' ? `<h4>${t('Difficulty')}</h4><div class="chips">${[['easy', t('Relaxed')], ['normal', t('Normal')], ['hard', t('Tough')]].map(([id, n]) => `<button class="chip ${soloDiff === id ? 'active' : ''}" data-diff="${id}">${n}</button>`).join('')}</div>` : ''}
    <button class="btn big primary" id="sStart">${t('Start game')} →</button>`;
  el.querySelectorAll('input[name=lay]').forEach(i => i.onchange = () => { soloLayout = i.value; soloDetail(); });
  el.querySelectorAll('[data-diff]').forEach(b => b.onclick = () => { soloDiff = b.dataset.diff; soloDetail(); });
  $('#sStart').onclick = () => startNew({ def: r, layout: soloLayout, difficulty: soloDiff });
}

function customPicker(el) {
  el.innerHTML = `
    <h3>${t('Anywhere on Earth')}</h3>
    <div class="row-btns"><input class="input" id="cSearch" placeholder="${t('Search a mountain, village or ski area…')}"><button class="btn" id="cGo">🔎</button></div>
    <div id="cResults" class="results"></div>
    <div class="mapbox"><canvas id="cMap"></canvas></div>
    <p class="muted small">${t('Click the map to choose the centre of your 12 × 12 km area. Scroll to zoom.')}</p>
    <div id="cSel"></div>`;
  const map = new WorldMap($('#cMap'), {
    sites: FAMOUS_RESORTS,
    onPick: (lat, lon) => pickCustom({ lat, lon, name: t('My Resort'), country: '' }),
    onSite: s => { soloSel = s.id; soloScreen(); },
  });
  const pickCustom = c => {
    const dc = defaultClimate(c.lat);
    customDef = { id: `custom-${c.lat.toFixed(3)}-${c.lon.toFixed(3)}`, name: c.name, country: c.country || '', region: c.region || '', lat: c.lat, lon: c.lon, w: 12, h: 12, town: [c.lat, c.lon], ...dc, fame: 22, beds: 2500, day: 1500, blurb: '' };
    map.setMarker(c.lat, c.lon);
    $('#cSel').innerHTML = `<div class="kv inline"><span>${t('Centre')}</span><b>${c.lat.toFixed(4)}, ${c.lon.toFixed(4)}</b></div>
      <input class="input" id="cName" value="${escapeHtml(c.name)}">
      <div class="opts">${[['osm', t('Import existing lifts (if any)')], ['empty', t('Empty mountain')], ['sandbox', t('Sandbox')]].map(([id, n]) => `<label class="opt ${soloLayout === id ? 'active' : ''}"><input type="radio" name="lay" value="${id}" ${soloLayout === id ? 'checked' : ''}><b>${n}</b></label>`).join('')}</div>
      <button class="btn big primary" id="cStart">${t('Start game')} →</button>`;
    $('#cSel').querySelectorAll('input[name=lay]').forEach(i => i.onchange = () => { soloLayout = i.value; });
    $('#cStart').onclick = () => { customDef.name = $('#cName').value.trim() || customDef.name; startNew({ def: customDef, layout: soloLayout, difficulty: soloDiff }); };
  };
  const search = async () => {
    const q = $('#cSearch').value.trim();
    if (!q) return;
    $('#cResults').innerHTML = `<span class="muted">${t('Searching…')}</span>`;
    const res = await app.client.geocode(q).catch(() => []);
    $('#cResults').innerHTML = res.map((r, i) => `<button class="row" data-i="${i}">${escapeHtml(r.name)}</button>`).join('') || `<span class="muted">${t('Nothing found.')}</span>`;
    $('#cResults').querySelectorAll('[data-i]').forEach(b => b.onclick = () => {
      const r = res[+b.dataset.i];
      map.center(+r.lat, +r.lon, 60);
      pickCustom({ lat: +r.lat, lon: +r.lon, name: r.name.split(',')[0], country: r.countryCode || '' });
    });
  };
  $('#cGo').onclick = search;
  $('#cSearch').onkeydown = e => { if (e.key === 'Enter') search(); };
}

// ---------- load / import ----------
function loadScreen(note) {
  const me = getProfile();
  const saves = listSessions();
  const who = s => {
    const parts = [];
    if (s.owner && s.owner.id !== me?.id) parts.push(t('from {n}', { n: escapeHtml(s.owner.name) }));
    if (s.by && s.by.id !== me?.id && s.by.id !== s.owner?.id) parts.push(t('last played by {n}', { n: escapeHtml(s.by.name) }));
    return parts.map(p => ` · ${p}`).join('');
  };
  menuShow(`<div class="solo narrow">
    <div class="solo-h"><button class="btn ghost" id="lBack">← ${t('Back')}</button><h2>${t('Saved games')}</h2></div>
    ${noteHtml(note)}
    <div class="saves">${saves.map(s => `<div class="saverow ${note?.id === s.id ? 'hl' : ''}"><div><b>${escapeHtml(s.name)}</b><div class="muted small">${fmtDay(s.day)} · ${money(s.cash || 0)} · ${t('saved')} ${new Date(s.savedAt).toLocaleString()}${who(s)}</div></div>
      <button class="btn primary" data-load="${escapeHtml(s.id)}">${t('Load')}</button><button class="btn ghost" data-exp="${escapeHtml(s.id)}" title="${t('Export save file')}" aria-label="${t('Export save file')}">⬇</button><button class="btn ghost danger" data-del="${escapeHtml(s.id)}" title="${t('Delete')}" aria-label="${t('Delete')}">🗑</button></div>`).join('') || `<p class="muted">${t('No saved games yet.')}</p>`}</div>
    <label class="btn">📂 ${t('Import save file')}<input type="file" id="lFile" accept=".json,.snowline" hidden></label>
    <p class="muted small">${t('A save file carries your player ID and the time it was saved. Send it to a friend or copy it to another PC; importing a game you already have keeps the most recent copy.')}</p>
  </div>`);
  $('#lBack').onclick = () => titleScreen();
  bindNote(note, loadScreen);
  document.querySelectorAll('[data-load]').forEach(b => b.onclick = () => loadSave(b.dataset.load));
  document.querySelectorAll('[data-exp]').forEach(b => b.onclick = () => {
    const env = readSession(findSession(b.dataset.exp));
    if (env) downloadSession(env); else alert(t('Could not load the save.'));
  });
  document.querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
    if (!confirm(t('Delete this save? This cannot be undone.'))) return;
    deleteSession(findSession(b.dataset.del));
    loadScreen();
  });
  $('#lFile').onchange = async e => {
    const env = await readSaveFile(e.target.files[0]);
    loadScreen(env ? importSession(env) : { kind: 'bad', html: t('Could not read that file.') });
  };
}

async function readSaveFile(f) {
  if (!f) return null;
  try { return parseSessionFile(await f.text(), f.lastModified); } catch (e) { console.warn('import', e); return null; }
}

// a session you already have keeps the copy saved last; the other outcomes stay one click away
function importSession(env) {
  const { status, local } = compareImport(env);
  const n = escapeHtml(env.state.name);
  const when = (at, day) => `${new Date(at).toLocaleString()}, ${t('game date')} ${fmtDay(day)}`;
  const f = when(env.savedAt, env.state.day), l = local && when(local.savedAt, local.day);
  const store = e => { try { writeSession(e); return true; } catch (err) { return false; } };
  const full = { kind: 'bad', html: t('Browser storage is full: delete an old save and try again.') };
  if (status === 'same') return { kind: 'info', id: env.id, html: t('"{n}" is already up to date.', { n }) };
  if (status === 'older') {
    return { kind: 'warn', id: env.id, html: t('You already have a newer copy of "{n}" (saved {l}). The file is older (saved {f}), so your copy was kept.', { n, l, f }), actions: [
      [t('Replace mine with the file'), () => (store(env) ? { kind: 'good', id: env.id, html: t('Replaced your copy of "{n}" with the file.', { n }) } : full)],
      [t('Keep both'), () => { const copy = forkSession(env); return store(copy) ? { kind: 'good', id: copy.id, html: t('Imported "{n}" as a separate game.', { n }) } : full; }],
    ] };
  }
  const prev = status === 'newer' ? readSession(local) : null;
  if (!store(env)) return full;
  if (!prev) return { kind: 'good', id: env.id, html: t('Imported "{n}" (saved {f}).', { n, f }) };
  return { kind: 'good', id: env.id, html: t('Updated "{n}" with the newer copy from the file (saved {f}). Your copy was saved {l}.', { n, f, l }), actions: [
    [t('Undo'), () => (store(prev) ? { kind: 'info', id: prev.id, html: t('Restored your copy of "{n}".', { n }) } : full)],
  ] };
}

function loadSave(id) {
  const entry = findSession(id);
  const env = entry && readSession(entry);
  if (!env) { alert(t('Could not load the save.')); return titleScreen(); }
  app.session = sessionOf(env);
  startFromState(env.state);
}

// ---------- universe ----------
async function universeScreen() {
  menuShow(`<div class="solo"><div class="solo-h"><button class="btn ghost" id="uBack">← ${t('Back')}</button><h2>🌍 ${t('Online universe')}</h2></div><div id="uBody"><p class="muted">${t('Connecting…')}</p></div></div>`);
  $('#uBack').onclick = titleScreen;
  const cl = app.client;
  let info;
  try { info = await cl.info(); } catch (e) {
    $('#uBody').innerHTML = `<p class="neg">${t('The universe server is not reachable. Start it with "npm start" and open the game from it.')}</p>`;
    return;
  }
  try { await cl.whoami(); } catch (e) { cl.me = null; }
  if (!cl.me) return loginForm(info);
  dashboard(info);
}

function loginForm(info) {
  $('#uBody').innerHTML = `<div class="login">
    <p>${t('{u}: a persistent world where every player runs real ski resorts. Time runs for everyone: one game day lasts {m} real minutes, even when you are offline.', { u: `<b>${escapeHtml(info.name)}</b>`, m: info.dayRealMinutes })}</p>
    <p class="muted">${int(info.players)} ${t('players')} · ${int(info.sites)} ${t('resorts')} · ${t('game date')} ${fmtDay(Math.floor(universeDay(info, Date.now() + info.offset)))}</p>
    <input class="input" id="uName" placeholder="${t('Player name')}" autocomplete="username">
    <input class="input" id="uPass" type="password" placeholder="${t('Password')}" autocomplete="current-password">
    <div class="row-btns"><button class="btn primary" id="uLogin">${t('Log in')}</button><button class="btn" id="uReg">${t('Create account')}</button></div>
    <div id="uErr" class="neg"></div></div>`;
  const go = async reg => {
    const n = $('#uName').value.trim(), p = $('#uPass').value;
    try { reg ? await app.client.register(n, p) : await app.client.login(n, p); await app.client.whoami(); dashboard(info); }
    catch (e) { $('#uErr').textContent = e.message; }
  };
  $('#uLogin').onclick = () => go(false);
  $('#uReg').onclick = () => go(true);
  $('#uPass').onkeydown = e => { if (e.key === 'Enter') go(false); };
}

async function dashboard(info) {
  const cl = app.client;
  const sites = await cl.sites();
  const me = cl.me;
  const mine = sites.filter(s => s.ownerId === me.id);
  sites.forEach(s => { s.mine = s.ownerId === me.id; });
  const free = sites.filter(s => !s.ownerId);
  $('#uBody').innerHTML = `
    <div class="uni-grid">
      <div class="mapbox tall"><canvas id="uMap"></canvas></div>
      <div class="uni-side">
        <div class="row-btns"><b>👤 ${escapeHtml(me.name)}</b>${cl.meFull?.allianceTag ? `<span class="tag">[${escapeHtml(cl.meFull.allianceTag)}]</span>` : ''}<span class="grow"></span><button class="btn sm ghost" id="uOut">${t('Log out')}</button></div>
        <p class="muted small">${t('Game date')} ${fmtDay(Math.floor(universeDay(info, Date.now() + info.offset)))} · ${t('you can run up to {n} resorts', { n: info.maxSitesPerPlayer })}</p>
        <h4>${t('My resorts')}</h4>
        ${mine.map(s => `<div class="saverow"><div><b>${flag(s.country)} ${escapeHtml(s.name)}</b><div class="muted small">${t('Rating')} ${s.stats?.rating ?? '—'} · ${s.stats?.pisteKm ?? 0} km · ${money(s.stats?.value || 0)}</div></div><button class="btn primary" data-play="${s.id}">${t('Play')}</button><button class="btn ghost danger sm" data-ab="${s.id}" title="${t('Abandon')}">✕</button></div>`).join('') || `<p class="muted">${t('Claim a famous resort or found a new one on the map.')}</p>`}
        <div id="uSel"></div>
        <h4>${t('Free famous resorts')}</h4>
        <div class="freelist">${free.map(s => `<button class="row" data-site="${s.id}">${flag(s.country)} ${escapeHtml(s.name)}</button>`).join('') || `<p class="muted small">${t('All taken!')}</p>`}</div>
      </div>
    </div>`;
  const map = new WorldMap($('#uMap'), {
    sites,
    onSite: s => selectSite(s),
    onPick: (lat, lon) => newSiteForm(lat, lon),
  });
  if (mine[0]) map.center(mine[0].lat, mine[0].lon, 8);
  $('#uOut').onclick = async () => { await cl.logout(); universeScreen(); };
  document.querySelectorAll('[data-play]').forEach(b => b.onclick = () => playSite(sites.find(s => s.id === b.dataset.play), info));
  document.querySelectorAll('[data-ab]').forEach(b => b.onclick = async () => {
    if (!confirm(t('Abandon this resort? Your progress there will be deleted for good.'))) return;
    try { await cl.abandon(b.dataset.ab); dashboard(info); } catch (e) { alert(e.message); }
  });
  document.querySelectorAll('[data-site]').forEach(b => b.onclick = () => { const s = sites.find(x => x.id === b.dataset.site); map.center(s.lat, s.lon, 20); selectSite(s); });
  function selectSite(s) {
    const el = $('#uSel');
    const r = findResort(s.id);
    if (s.mine) { el.innerHTML = `<div class="comp mine"><b>${escapeHtml(s.name)}</b> <button class="btn primary sm" id="uPlay">${t('Play')}</button></div>`; $('#uPlay').onclick = () => playSite(s, info); return; }
    if (s.ownerId) {
      el.innerHTML = `<div class="comp"><b>${flag(s.country)} ${escapeHtml(s.name)}</b><div class="muted small">${t('Owned by')} ${escapeHtml(s.ownerName)}${s.allianceTag ? ` [${escapeHtml(s.allianceTag)}]` : ''} · ${t('Rating')} ${s.stats?.rating ?? '—'} · ${s.stats?.pisteKm ?? 0} km</div><button class="btn sm" id="uVisit">👁 ${t('Visit')}</button></div>`;
      $('#uVisit').onclick = () => visitSite(s.id);
      return;
    }
    el.innerHTML = `<div class="comp"><b>${flag(s.country)} ${escapeHtml(s.name)}</b><div class="muted small">${r ? escapeHtml(t(r.blurb)) : ''}</div>
      <div class="opts"><label class="opt active"><input type="radio" name="ulay" value="empty" checked><b>${t('Empty mountain')}</b><span>${t('€35M to build from scratch.')}</span></label>
      <label class="opt"><input type="radio" name="ulay" value="osm"><b>${t('Take over the real resort')}</b><span>${t('All real lifts and pistes, but only €6M cash and a big loan.')}</span></label></div>
      <button class="btn primary" id="uClaim">${t('Claim this resort')}</button></div>`;
    el.querySelectorAll('.opt').forEach(o => o.onclick = () => el.querySelectorAll('.opt').forEach(x => x.classList.toggle('active', x === o)));
    $('#uClaim').onclick = async () => {
      const lay = el.querySelector('input[name=ulay]:checked').value;
      try { await cl.claim(s.id); localStorage.setItem(`snowline.pendingLayout.${s.id}`, lay); playSite({ ...s, ownerId: me.id }, info); }
      catch (e) { alert(e.message); }
    };
  }
  function newSiteForm(lat, lon) {
    map.setMarker(lat, lon);
    const el = $('#uSel');
    el.innerHTML = `<div class="comp"><b>${t('Found a new resort')}</b><div class="muted small">${lat.toFixed(4)}, ${lon.toFixed(4)} · 12 × 12 km</div>
      <input class="input" id="nsName" placeholder="${t('Resort name')}"><input class="input sm" id="nsCountry" placeholder="${t('Country code')}" maxlength="2">
      <div class="row-btns"><input class="input" id="nsSearch" placeholder="${t('…or search a place')}"><button class="btn sm" id="nsGo">🔎</button></div><div id="nsRes" class="results"></div>
      <button class="btn primary" id="nsCreate">${t('Found resort here')}</button></div>`;
    const doSearch = async () => {
      const res = await cl.geocode($('#nsSearch').value).catch(() => []);
      $('#nsRes').innerHTML = res.map((r, i) => `<button class="row" data-i="${i}">${escapeHtml(r.name)}</button>`).join('');
      $('#nsRes').querySelectorAll('[data-i]').forEach(b => b.onclick = () => { const r = res[+b.dataset.i]; map.center(+r.lat, +r.lon, 60); newSiteForm(+r.lat, +r.lon); $('#nsName').value = r.name.split(',')[0]; $('#nsCountry').value = r.countryCode || ''; });
    };
    $('#nsGo').onclick = doSearch;
    $('#nsCreate').onclick = async () => {
      try {
        const s = await cl.createSite({ name: $('#nsName').value.trim() || 'New Resort', country: ($('#nsCountry').value || '').toUpperCase(), lat, lon, w: 12, h: 12 });
        localStorage.setItem(`snowline.pendingLayout.${s.id}`, 'empty');
        playSite({ ...s, ownerId: me.id }, info);
      } catch (e) { alert(e.message); }
    };
  }
}

function siteDef(site) {
  const famous = findResort(site.id);
  if (famous) return famous;
  const dc = defaultClimate(site.lat);
  return { id: site.id, name: site.name, country: site.country, region: '', lat: site.lat, lon: site.lon, w: site.w || 12, h: site.h || 12, town: [site.lat, site.lon], ...dc, fame: 22, beds: 2500, day: 1500 };
}

async function playSite(site, info) {
  const cl = app.client;
  let res;
  try { res = await cl.getState(site.id); } catch (e) { alert(e.message); return; }
  const def = siteDef(site);
  const uni = { info, client: cl, site, share: 1, offset: info.offset };
  if (res.state) return startFromState(res.state, uni);
  const layout = localStorage.getItem(`snowline.pendingLayout.${site.id}`) || 'empty';
  startNew({ def, layout, difficulty: 'normal', universe: uni });
}

async function visitSite(siteId) {
  const cl = app.client;
  try {
    const sites = cl.siteList || await cl.sites();
    const site = sites.find(s => s.id === siteId);
    const res = await cl.getState(siteId);
    if (!res.publicState) { alert(t('This resort has not been published yet.')); return; }
    if (app.game) { await app.save(false); teardown(); }
    const def = siteDef(site);
    const st = newState({ def, mode: 'visit', startDay: res.publicState.day || dayFromYMD(2026, 12, 15) });
    st.world = res.publicState.world;
    st.name = `${site.name} (${site.ownerName})`;
    st.rep = res.publicState.rep || 50;
    await boot({ def, state: st, layout: 'saved', visit: { site } });
  } catch (e) { alert(e.message); }
}
app.visitSite = visitSite;
app.startNew = (...a) => startNew(...a);

// ====================================================================================
// Game assembly
// ====================================================================================
function difficultyCash(layout, diff) {
  if (layout === 'sandbox') return 250e6;
  if (layout === 'osm') return { easy: 45e6, normal: 25e6, hard: 10e6 }[diff];
  return { easy: 60e6, normal: 35e6, hard: 18e6 }[diff];
}
function scenarioFor(def, layout, diff) {
  if (layout === 'sandbox') return { title: 'Sandbox', goals: [] };
  if (layout === 'osm') {
    const big = (def.beds || 5000) * 85;
    return { title: 'Run the resort', goals: [
      { type: 'rep', target: 88, label: 'Reach a rating of 88' },
      { type: 'visitors', target: Math.round(big / 10000) * 10000, label: 'Guests in one season' },
      { type: 'worldcup', target: 2, label: 'Host 2 World Cup races' },
    ] };
  }
  return { title: 'Build from scratch', goals: [
    { type: 'rep', target: 70, label: 'Reach a rating of 70' },
    { type: 'visitors', target: 250000, label: 'Guests in one season' },
    { type: 'km', target: 40, label: 'Build 40 km of pistes' },
    { type: 'worldcup', target: 1, label: 'Host a World Cup race' },
  ] };
}

async function startNew({ def, layout, difficulty, universe = null }) {
  if (!universe) app.session = newSession();
  let startDay, minute = 420;
  if (universe) {
    const ud = universeDay(universe.info, Date.now() + universe.offset);
    startDay = Math.floor(ud); minute = (ud - startDay) * 1440;
  } else {
    const south = def.lat < 0;
    startDay = layout === 'osm' ? (south ? dayFromYMD(2027, 5, 20) : dayFromYMD(2026, 11, 14)) : (south ? dayFromYMD(2026, 11, 1) : dayFromYMD(2026, 5, 2));
  }
  const cash = universe ? (layout === 'osm' ? 6e6 : 35e6) : difficultyCash(layout, difficulty);
  const state = newState({ def, mode: universe ? 'universe' : 'solo', startDay, cash, scenario: universe ? null : scenarioFor(def, layout, difficulty), siteId: universe?.site?.id || null });
  state.minute = minute;
  if (layout === 'osm') state.rep = 66;
  else { state.rep = 50; state.fame = Math.round((def.fame || 25) * 0.55); }
  if (universe) state.seed = universe.info.seed;
  await boot({ def, state, layout, fresh: true, universe });
}

async function startFromState(state, universe = null) {
  const def = state.def || findResort(state.resortId);
  await boot({ def, state, layout: 'saved', universe });
}

function setLoading(title, step, p) {
  const l = $('#loading');
  l.hidden = false;
  $('#ldTitle').textContent = title;
  if (step != null) $('#ldStep').textContent = step;
  if (p != null) $('#ldBar').style.transform = `scaleX(${clamp(p, 0, 1).toFixed(3)})`;
}

// a failed start (no WebGL, broken save, odd OSM data) must not leave the loading screen up forever
async function boot(opts) {
  try {
    await bootGame(opts);
  } catch (e) {
    console.error(e);
    teardown();
    app.session = null;
    $('#loading').hidden = true;
    alert(t('Could not start the game: {e}', { e: e.message }));
    if (opts.universe || opts.visit) universeScreen(); else titleScreen();
  }
}

async function bootGame({ def, state, layout, fresh = false, universe = null, visit = null }) {
  $('#menu').hidden = true;
  setLoading(def.name, t('Downloading real elevation data…'), 0.02);
  const terrain = new Terrain(def);
  await terrain.load(p => setLoading(def.name, t('Downloading real elevation data…'), 0.05 + p * 0.45));
  const townXZ = def.town ? terrain.proj.toXZ(def.town[0], def.town[1]) : [0, 0];
  const biome = new Biome(terrain, def.treeline ?? defaultClimate(def.lat).treeline, townXZ);
  const world = new World(terrain, biome, def.country);
  // OpenStreetMap: village houses (+ real layout). The first download of an area can be slow.
  setLoading(def.name, t('Fetching OpenStreetMap data (lifts, pistes, village)… the first time can take a minute or two.'), 0.55);
  const osm = await withSkip(fetchOsm(terrain.bbox).catch(e => { console.warn(e); return null; }), 240000);
  setLoading(def.name, t('Building the world…'), 0.8);
  await new Promise(r => setTimeout(r, 20));
  if (layout === 'saved') world.load(state.world);
  else if (layout === 'osm' && osm) {
    const st = importLayout(world, osm, terrain.proj, { day: state.day });
    // size staff and fleet to the imported resort
    const sum = world.summary(state.day);
    state.staff = { patrol: Math.ceil(sum.km / 6) + 1, mechanic: Math.ceil(sum.lifts / 3), instructor: Math.max(6, Math.round(sum.km * 0.6)), host: Math.max(3, Math.ceil(world.buildings.filter(b => BUILDINGS[b.type].seats).reduce((a, b) => a + BUILDINGS[b.type].seats, 0) / 40)) };
    state.snowcats = Math.ceil(sum.km * 0.85 / SNOWCAT.kmPerNight);
    const base = world.buildings.find(b => b.type === 'base');
    const garagesNeeded = Math.ceil((state.snowcats - 1) / 5);
    for (let i = world.buildings.filter(b => b.type === 'garage').length; i < garagesNeeded && base; i++) {
      const spot = findFreeSpot(world, 'garage', base.x, base.z, 120 + i * 30);
      if (spot) world.addBuilding(world.planBuilding('garage', spot[0], spot[1]), { day: state.day, instant: true, imported: true });
    }
    world.rebuildGraph();
    if (universe) state.loan = Math.round(world.lifts.reduce((a, l) => a + l.value, 0) * 0.3 / 1e5) * 1e5;
    console.info('OSM import', st);
  } else if (layout !== 'saved') {
    // a free starter base station in the village
    const spot = findFreeSpot(world, 'base', townXZ[0], townXZ[1], 30);
    if (spot) world.addBuilding(world.planBuilding('base', spot[0], spot[1]), { day: state.day, instant: true });
    world.rebuildGraph();
  }
  if (!osm && layout === 'osm') state.log.unshift({ kind: 'warn', text: t('OpenStreetMap was unreachable: starting with an empty mountain.'), day: state.day, minute: state.minute });
  const game = new Game({ terrain, biome, world, state, universe });
  if (fresh || visit) game.startDay();
  else game.resumeDay();
  game.maxAgents = app.quality === 'low' ? 450 : 1000;
  // renderer
  const s3 = new Scene3D($('#viewport'), terrain, biome, { rockColor: DOLOMITES.includes(def.id) ? 0xa0968a : 0x7f7b76, pixelRatio: app.quality === 'low' ? 1 : 2, preserve: app.external });
  const layers = new Layers(s3, game);
  if (osm) layers.buildVillage(villageHouses(osm, terrain.proj, terrain, app.quality === 'low' ? 2500 : 9000));
  if (app.quality !== 'low') layers.buildTrees(); else { layers.buildTrees(); }
  layers.rebuildAll();
  Object.assign(app, { game, s3, layers, universe, visit, osm });
  app.hud = new HUD(app);
  app.builder = new Builder(game, s3, layers, app.hud);
  app.ski = new SkiMode(app);
  if (visit) document.getElementById('hud').classList.add('visit');
  // camera: frame the ski area or the village
  const sum = world.summary(game.s.day);
  let cx = townXZ[0], cz = townXZ[1];
  if (world.lifts.length) { cx = world.lifts.reduce((a, l) => a + l.b[0], 0) / world.lifts.length; cz = world.lifts.reduce((a, l) => a + l.b[1], 0) / world.lifts.length; }
  s3.lookAt(cx, cz, Math.min(terrain.width, terrain.depth) * 0.75, { azimuth: 0.35, polar: 0.92 });
  $('#loading').hidden = true;
  if (fresh) welcome(def, layout);
  if (visit) app.hud.toast('info', t('Visiting {n}. Use the menu to go back.', { n: escapeHtml(game.s.name) }));
  app.lastSave = performance.now();
  app.envT = 1e9;
  app.syncT = 0;
  if (universe) syncUniverse(true);
  requestAnimationFrame(loop);
}

function withSkip(promise, timeout) {
  const btn = $('#ldSkip');
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (done) return; done = true; btn.hidden = true; clearInterval(iv); resolve(v); };
    const t0 = Date.now();
    const iv = setInterval(() => { if (Date.now() - t0 > 6000) { btn.hidden = false; btn.textContent = t('Skip (no village, no real lifts)'); } }, 500);
    btn.onclick = () => finish(null);
    promise.then(finish, () => finish(null));
    setTimeout(() => finish(null), timeout);
  });
}

function welcome(def, layout) {
  const h = app.hud;
  const g = app.game;
  if (layout === 'osm') h.advisor(t('Welcome to {n}! These are the real lifts and pistes as mapped on OpenStreetMap. The season opens at the end of November: check snow, staff and prices, then make it the best resort in the world.', { n: escapeHtml(def.name) }));
  else if (layout === 'sandbox') h.advisor(t('Sandbox mode: €250M and a real mountain. Build whatever you like!'));
  else h.advisor(t('Welcome to {n}! It is spring: you have the summer to build. Start with a lift from the base station in the village, then draw pistes from its top station back down. Use the slope overlay to read the terrain.', { n: escapeHtml(def.name) }));
}

// ====================================================================================
// Main loop
// ====================================================================================
let lastT = performance.now();
function loop(now) {
  if (!app.game) return;
  if (app.external) { requestAnimationFrame(loop); return; } // a recorder drives the frames
  const dt = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;
  const { game, s3, layers, hud } = app;
  try {
    if (!app.visit) game.update(dt);
    if (app.ski?.active) app.ski.update(dt);
    s3.update(dt);
    game.crowd.computePositions();
    const camD = app.ski?.active ? 200 : s3.cameraDistance();
    layers.updateAgents(camD);
    layers.updateIcons(camD);
    layers.updateCarriers(dt * (game.paused ? 0 : 1), camD / 900);
    app.envT += dt;
    if (app.envT > 0.5) {
      app.envT = 0;
      const ymd = ymdFromDay(game.s.day);
      const m = game.hemi === 'N' ? ymd.m : ((ymd.m + 5) % 12) + 1;
      const summer = m >= 6 && m <= 9 ? 1 : m === 5 || m === 10 ? 0.5 : 0;
      s3.setEnvironment({ day: game.s.day, minute: game.s.minute, weather: game.weatherNow, snowline: game.snowline, summer });
      layers.updateTreeColors(game.snowline, summer > 0.6 ? 1 : 0);
      layers.updateNightLights(s3.dayFactor ?? 1);
      if (app._statusV !== game.world.statusVersion || app._dayV !== game.s.day) { app._statusV = game.world.statusVersion; app._dayV = game.s.day; layers.refreshStatus(); }
    }
    hud.update(dt);
    s3.render();
    // autosave
    if (!app.visit && now - app.lastSave > 60000) { app.lastSave = now; app.save(false); }
    if (app.universe) { app.syncT += dt; if (app.syncT > 120) { app.syncT = 0; syncUniverse(); } }
  } catch (e) {
    console.error(e);
    if (!app._errShown) { app._errShown = true; hud?.toast('bad', `Error: ${escapeHtml(e.message)}`); }
  }
  requestAnimationFrame(loop);
}

async function syncUniverse(first) {
  const u = app.universe, cl = u.client;
  try {
    await cl.whoami();
    await cl.sites();
    u.share = cl.marketShare(u.site, app.game.attractiveness || 0.5);
    await cl.refreshCompetitions();
  } catch (e) { console.warn('sync', e); }
}

app.save = async function (manual) {
  const g = app.game;
  if (!g || app.visit) return;
  if (app.universe) {
    try {
      await app.universe.client.putState(g.s.siteId, { state: g.serialize(), publicState: g.publicSnapshot(), stats: g.statsForServer() });
      if (manual) app.hud.toast('good', t('Saved to the universe server.'));
    } catch (e) { app.hud.toast('bad', t('Save failed: {e}', { e: escapeHtml(e.message) })); }
    return;
  }
  saveSolo(manual);
};

// synchronous, so it also completes while the page is closing
function saveSolo(manual) {
  const g = app.game;
  if (!g || app.visit || app.universe) return null;
  const env = envelope(app.session || (app.session = newSession()), g.serialize());
  try {
    writeSession(env);
    if (manual) app.hud.toast('good', t('Game saved.'));
  } catch (e) {
    app.hud?.toast('bad', t('Browser storage is full: use "Export save file" from the menu.'));
  }
  return env;
}

// save first, so the file and the local copy carry the same timestamp
app.exportSave = function () {
  const env = saveSolo(false);
  if (env) downloadSession(env);
};

app.setQuality = function (q) {
  app.quality = q;
  try { localStorage.setItem('snowline.quality', q); } catch (e) { /* ignore */ }
  if (app.game) app.game.maxAgents = q === 'low' ? 450 : 1000;
  app.hud?.toast('info', t('Graphics setting applies fully after reloading the resort.'));
};

app.startSkiMode = function (target) {
  if (!app.ski) return;
  app.builder.setTool('select');
  app.ski.start(target || app.hud.selected);
};

function teardown() {
  app.ski?.stop();
  app.builder?.destroy();
  app.hud?.destroy();
  app.s3?.dispose();
  app.game = null; app.s3 = null; app.layers = null; app.hud = null; app.builder = null; app.ski = null; app.visit = null; app.universe = null;
}

app.quit = function () {
  const wasUni = !!app.universe || !!app.visit;
  teardown();
  app.session = null;
  if (wasUni) universeScreen(); else titleScreen();
};

window.addEventListener('beforeunload', () => {
  saveSolo(false);
  if (app.game && app.universe) {
    const g = app.game;
    try {
      fetch(`api/sites/${encodeURIComponent(g.s.siteId)}/state`, { method: 'PUT', keepalive: true, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${app.client.token}` }, body: JSON.stringify({ stats: g.statsForServer() }) });
    } catch (e) { /* ignore */ }
  }
});

// a hidden tab may be discarded or closed without beforeunload (mobile, OS shutdown)
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveSolo(false); });

titleScreen();
