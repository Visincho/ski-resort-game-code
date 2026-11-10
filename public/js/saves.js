// Solo persistence: a local player profile, solo sessions in localStorage, and session files
// to share a game with friends or move it to another PC. A session keeps its id on every
// device, so importing a copy you already have keeps whichever was saved last (savedAt).

import { ymdFromDay } from './shared/calendar.js';

const PROFILE = 'snowline.profile', INDEX = 'snowline.saves', PREFIX = 'snowline.save.';
export const FORMAT = 'snowline-session';
const ID_RE = /^[\w.-]{1,80}$/;

// getRandomValues also works on plain-http LAN hosts, where crypto.randomUUID is missing
function hex(bytes) { const b = new Uint8Array(bytes); crypto.getRandomValues(b); return [...b].map(x => x.toString(16).padStart(2, '0')).join(''); }
function slug(s, max) { return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max); }
function read(key) { try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; } }
function cleanUser(u) { return u && typeof u.id === 'string' && ID_RE.test(u.id) ? { id: u.id, name: String(u.name || '').slice(0, 24) } : null; }

// ---------- profile ----------
export function cleanName(name) { return String(name || '').replace(/\s+/g, ' ').trim().slice(0, 24); }
export function getProfile() { const p = read(PROFILE); return p && cleanUser(p) ? p : null; }
export function profileUser() { const p = getProfile(); return p ? { id: p.id, name: p.name } : null; }

// the id is the name's slug plus 40 random bits: readable in a save file, unique among friends
export function createProfile(name) {
  name = cleanName(name);
  return storeProfile({ id: `${slug(name, 16) || 'player'}-${hex(5)}`, name, created: Date.now() });
}
// moving to another PC: keep the player id found in your own session file
export function adoptProfile(user) { const u = cleanUser(user); return u ? storeProfile({ ...u, created: Date.now() }) : null; }
export function renameProfile(name) {
  const p = getProfile();
  if (!p) return null;
  p.name = cleanName(name) || p.name;
  setIndex(index().map(e => ({ ...e, owner: e.owner?.id === p.id ? { id: p.id, name: p.name } : e.owner, by: e.by?.id === p.id ? { id: p.id, name: p.name } : e.by })));
  return storeProfile(p);
}
function storeProfile(p) {
  localStorage.setItem(PROFILE, JSON.stringify(p));
  // saves made before profiles existed belong to whoever plays in this browser
  const me = { id: p.id, name: p.name };
  setIndex(index().map(e => (e.owner ? e : { ...e, owner: me, by: e.by || me })));
  return p;
}

// ---------- local sessions ----------
// index entries: { key, id, name, resortId, day, cash, savedAt, owner, by }
function index() {
  const list = read(INDEX);
  if (!Array.isArray(list)) return [];
  // pre-profile entries were keyed snowline.save.<resort>.<time>: give them a session id
  return list.filter(e => e && typeof e.key === 'string').map(e => (e.id ? e : { ...e, id: e.key.slice(PREFIX.length).replace(/[^\w-]/g, '-') }));
}
function setIndex(list) { try { localStorage.setItem(INDEX, JSON.stringify(list)); } catch (e) { /* ignore */ } }

export function listSessions() { return index().sort((a, b) => b.savedAt - a.savedAt); }
export function findSession(id) { return index().find(e => e.id === id) || null; }

export function newSession(owner = profileUser()) {
  return { id: `${Date.now().toString(36)}-${hex(4)}`, owner, created: Date.now() };
}

// the stored item and the exported file share this shape; metadata first so the file reads well
export function envelope(session, state, by = profileUser()) {
  const owner = session.owner && by && session.owner.id === by.id ? by : session.owner || by;
  return { format: FORMAT, v: 1, id: session.id, owner, by, created: session.created, savedAt: Date.now(), ...(session.copyOf ? { copyOf: session.copyOf } : {}), state };
}
export function sessionOf(env) { return { id: env.id, owner: env.owner, created: env.created, copyOf: env.copyOf }; }

// throws when the browser storage is full
export function writeSession(env) {
  const list = index();
  const old = list.find(e => e.id === env.id);
  const key = old?.key || PREFIX + env.id;
  localStorage.setItem(key, JSON.stringify(env));
  const s = env.state;
  const entry = { key, id: env.id, name: s.name, resortId: s.resortId, day: s.day, cash: Math.round(s.cash || 0), savedAt: env.savedAt, owner: env.owner || null, by: env.by || null };
  setIndex([...list.filter(e => e.id !== env.id), entry]);
  return entry;
}

// older saves hold the bare game state: wrap it with the index metadata
export function readSession(entry) {
  const o = read(entry.key);
  if (!o) return null;
  if (o.format === FORMAT) return o;
  return { format: FORMAT, v: 1, id: entry.id, owner: entry.owner || null, by: entry.by || entry.owner || null, created: entry.savedAt, savedAt: entry.savedAt, state: o };
}

export function deleteSession(entry) {
  localStorage.removeItem(entry.key);
  setIndex(index().filter(e => e.id !== entry.id));
}

// ---------- files ----------
export function downloadSession(env) {
  const { state, ...meta } = env;
  const out = { ...meta, exportedAt: Date.now(), state };
  const d = ymdFromDay(env.state.day);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(out)], { type: 'application/json' }));
  a.download = `${slug(env.state.name || 'resort', 40) || 'resort'}_${d.y}-${d.m}-${d.d}_${env.id.slice(-8)}.snowline.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// accepts session files and the bare-state exports of older versions (timed by the file date)
export function parseSessionFile(text, lastModified = Date.now()) {
  const o = JSON.parse(text);
  const isState = s => s && typeof s === 'object' && s.world && typeof s.resortId === 'string' && Number.isFinite(s.day);
  let env;
  if (o?.format === FORMAT) {
    if (!ID_RE.test(o.id || '') || !Number.isFinite(o.savedAt) || !isState(o.state)) throw new Error('bad session file');
    env = { format: FORMAT, v: 1, id: o.id, owner: cleanUser(o.owner), by: cleanUser(o.by), created: Number.isFinite(o.created) ? o.created : o.savedAt, savedAt: o.savedAt, ...(ID_RE.test(o.copyOf || '') ? { copyOf: o.copyOf } : {}), state: o.state };
  } else if (isState(o)) {
    env = { format: FORMAT, v: 1, ...newSession(null), by: null, savedAt: lastModified, state: o };
  } else throw new Error('not a Snowline save');
  if ((env.state.mode || 'solo') !== 'solo') throw new Error('not a solo game');
  return env;
}

// 'new' | 'newer' (the file wins) | 'older' (your copy wins) | 'same', plus the local entry
export function compareImport(env) {
  const local = findSession(env.id);
  if (!local) return { status: 'new', local };
  return { status: env.savedAt > local.savedAt ? 'newer' : env.savedAt < local.savedAt ? 'older' : 'same', local };
}

// keep both: the file becomes a separate session that remembers where it came from
export function forkSession(env) {
  return { ...env, id: newSession().id, copyOf: env.id };
}
