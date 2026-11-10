// Persistent-universe game API: auth, sites, resort state, news, competitions, alliances,
// messages and leaderboards. Each route handler receives a context object and returns JSON data
// (or throws an HttpError via fail()).
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { competitionsAround, competitionsForSeason, seasonYear, universeDay } from '../public/js/shared/calendar.js';
import { fail, RateLimiter, haversineKm, randomHex, cleanText } from './lib.js';

const scrypt = promisify(crypto.scrypt);

const SMALL_BODY = 64 * 1024;
const STATE_BODY = 10 * 1024 * 1024;
const SESSION_TTL_MS = 30 * 86400000;
const NAME_RE = /^[A-Za-z0-9_ .-]{3,20}$/;
const TAG_RE = /^[A-Z0-9]{2,5}$/;
const MIN_SITE_DISTANCE_KM = 6;
// Highest bid score the client formula can produce (Events.bidScore: every term maxed, heavy lobbying).
const MAX_BID_SCORE = 110;
const MAX_NEWS = 1000;
const MAX_MESSAGES = 20000;
const DUMMY_SALT = '00'.repeat(16);
const DUMMY_HASH = '00'.repeat(64);

// ---- validation helpers ----------------------------------------------------------------------

function reqString(v, field, min, max, keepNewlines = false) {
  if (typeof v !== 'string') fail(400, `"${field}" is required`);
  const s = cleanText(v, keepNewlines);
  if (s.length < min || s.length > max) fail(400, `"${field}" must be ${min}-${max} characters`);
  return s;
}

function reqNumber(v, field, min, max) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < min || n > max) fail(400, `"${field}" must be a number between ${min} and ${max}`);
  return n;
}

const statNum = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && Number.isFinite(Number(v)) ? Number(v) : 0);

function slugify(name) {
  const slug = name
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '');
  return slug || 'site';
}

// ---------------------------------------------------------------------------------------------

export function createApi(store) {
  const D = () => store.db;
  const authLimiter = new RateLimiter(20, 60000);
  const newsLimiter = new RateLimiter(10, 60000);
  const messageLimiter = new RateLimiter(20, 60000);

  const gameDay = (t = Date.now()) => universeDay(D().info, t);

  // ---- shared helpers ------------------------------------------------------------------------

  function addNews(kind, text, { siteId = null, playerName = null } = {}) {
    const db = D();
    const time = Date.now();
    const item = { id: db.seq.news++, time, gameDay: Math.round(gameDay(time) * 1000) / 1000, kind, text, siteId, playerName };
    db.news.push(item);
    if (db.news.length > MAX_NEWS) db.news.splice(0, db.news.length - MAX_NEWS);
    store.changed();
    return item;
  }

  const allianceOf = (player) => (player?.allianceId ? D().alliances[player.allianceId] || null : null);
  const sitesOf = (playerId) => Object.values(D().sites).filter((s) => s.ownerId === playerId);
  const playerRef = (p) => ({ id: p.id, name: p.name });

  function publicSite(s) {
    const owner = s.ownerId ? D().players[s.ownerId] : null;
    return {
      id: s.id, name: s.name, country: s.country, lat: s.lat, lon: s.lon, w: s.w, h: s.h,
      famous: !!s.famous,
      ownerId: owner ? owner.id : null,
      ownerName: owner ? owner.name : null,
      allianceTag: allianceOf(owner)?.tag || null,
      stats: s.stats || null,
      updatedAt: s.updatedAt, createdAt: s.createdAt,
    };
  }

  function getSite(id) {
    return D().sites[id] || fail(404, 'Site not found');
  }

  function getOwnedSite(id, player) {
    const site = getSite(id);
    if (site.ownerId !== player.id) fail(403, 'You do not own this site');
    return site;
  }

  function checkSiteLimit(player) {
    const max = D().info.maxSitesPerPlayer;
    if (sitesOf(player.id).length >= max) fail(403, `You already own the maximum of ${max} sites`);
  }

  function newSession(player) {
    const token = randomHex(32);
    D().sessions[token] = { playerId: player.id, created: Date.now() };
    store.changed();
    return token;
  }

  const hashPassword = async (password, saltHex) => (await scrypt(password, Buffer.from(saltHex, 'hex'), 64)).toString('hex');

  /** Resolve the Bearer token of a request to { player, token }, or null. */
  function authenticate(req) {
    const m = /^Bearer\s+([0-9a-fA-F]{64})$/.exec((req.headers.authorization || '').trim());
    if (!m) return null;
    const token = m[1].toLowerCase();
    const session = D().sessions[token];
    if (!session) return null;
    if (Date.now() - session.created > SESSION_TTL_MS) {
      delete D().sessions[token];
      store.changed();
      return null;
    }
    const player = D().players[session.playerId];
    return player ? { player, token } : null;
  }

  // ---- universe & auth -----------------------------------------------------------------------

  function universeInfo() {
    const i = D().info;
    return {
      name: i.name, seed: i.seed, startReal: i.startReal, startGameDay: i.startGameDay,
      dayRealMinutes: i.dayRealMinutes, maxSitesPerPlayer: i.maxSitesPerPlayer,
      serverNow: Date.now(), gameDay: universeDay(i),
      players: Object.keys(D().players).length, sites: Object.keys(D().sites).length,
    };
  }

  function authRateLimit(ip) {
    if (!authLimiter.allow(ip)) fail(429, 'Too many login attempts, please wait a minute');
  }

  async function register({ body, ip }) {
    authRateLimit(ip);
    const name = typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : '';
    if (!NAME_RE.test(name)) fail(400, 'Name must be 3-20 characters (letters, digits, space, _ . -)');
    const { password } = body;
    if (typeof password !== 'string' || password.length < 4) fail(400, 'Password must be at least 4 characters');
    if (password.length > 256) fail(400, 'Password too long');
    const key = name.toLowerCase();
    if (store.playersByName.has(key)) fail(409, 'That name is already taken');
    const salt = randomHex(16);
    const hash = await hashPassword(password, salt);
    if (store.playersByName.has(key)) fail(409, 'That name is already taken'); // lost a race during hashing
    const player = { id: 'p' + randomHex(6), name, salt, hash, createdAt: Date.now(), allianceId: null };
    D().players[player.id] = player;
    store.playersByName.set(key, player);
    addNews('player', `${name} founded a ski company and joined the universe.`, { playerName: name });
    return { token: newSession(player), player: playerRef(player) };
  }

  async function login({ body, ip }) {
    authRateLimit(ip);
    const name = typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : '';
    const password = typeof body.password === 'string' ? body.password.slice(0, 256) : '';
    const player = store.playersByName.get(name.toLowerCase());
    // Always run scrypt so unknown names and wrong passwords take the same time.
    const actual = Buffer.from(await hashPassword(password, player ? player.salt : DUMMY_SALT), 'hex');
    const expected = Buffer.from(player ? player.hash : DUMMY_HASH, 'hex');
    const ok = player && actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
    if (!ok) fail(401, 'Wrong name or password');
    return { token: newSession(player), player: playerRef(player) };
  }

  function logout({ token }) {
    delete D().sessions[token];
    store.changed();
    return { ok: true };
  }

  function me({ player }) {
    const unreadMessages = D().messages.reduce((n, m) => n + (m.to === player.id && !m.read ? 1 : 0), 0);
    return {
      player: { id: player.id, name: player.name, createdAt: player.createdAt, allianceId: player.allianceId || null },
      sites: sitesOf(player.id).map((s) => s.id),
      allianceTag: allianceOf(player)?.tag || null,
      unreadMessages,
    };
  }

  // ---- sites ---------------------------------------------------------------------------------

  function listSites() {
    return Object.values(D().sites).map(publicSite);
  }

  function createSite({ body, player }) {
    const name = reqString(body.name, 'name', 2, 40);
    const country = typeof body.country === 'string' ? cleanText(body.country).slice(0, 40) : '';
    const lat = reqNumber(body.lat, 'lat', -70, 72);
    const lon = reqNumber(body.lon, 'lon', -180, 180);
    const w = reqNumber(body.w, 'w', 4, 20);
    const h = reqNumber(body.h, 'h', 4, 20);
    checkSiteLimit(player);

    let nearest = null, nearestKm = Infinity;
    for (const s of Object.values(D().sites)) {
      const km = haversineKm(lat, lon, s.lat, s.lon);
      if (km < nearestKm) { nearest = s; nearestKm = km; }
    }
    if (nearest && nearestKm < MIN_SITE_DISTANCE_KM) {
      fail(409, `Too close to "${nearest.name}" (${nearestKm.toFixed(1)} km away, minimum is ${MIN_SITE_DISTANCE_KM} km)`);
    }

    let id;
    do id = `${slugify(name)}-${randomHex(2)}`; while (D().sites[id]);
    const now = Date.now();
    const site = { id, name, country, lat, lon, w, h, famous: false, ownerId: player.id, stats: null, createdAt: now, updatedAt: now, claimedAt: now };
    D().sites[id] = site;
    addNews('site', `${player.name} founded a new resort: ${name}${country ? ` (${country})` : ''}.`, { siteId: id, playerName: player.name });
    return publicSite(site);
  }

  function claimSite({ params, player }) {
    const site = getSite(params.id);
    if (site.ownerId === player.id) return publicSite(site);
    if (site.ownerId) fail(409, `${site.name} is already owned by ${D().players[site.ownerId]?.name || 'another player'}`);
    checkSiteLimit(player);
    const now = Date.now();
    Object.assign(site, { ownerId: player.id, stats: null, claimedAt: now, updatedAt: now });
    addNews('site', `${player.name} took over ${site.name}.`, { siteId: site.id, playerName: player.name });
    return publicSite(site);
  }

  async function abandonSite({ params, player }) {
    const site = getOwnedSite(params.id, player);
    Object.assign(site, { ownerId: null, stats: null, claimedAt: null, updatedAt: Date.now() });
    // Withdraw this site's bids on competitions that are still open.
    for (const rec of Object.values(D().competitions)) {
      if (rec.status === 'open' && rec.bids) rec.bids = rec.bids.filter((b) => b.siteId !== site.id);
    }
    addNews('site', `${player.name} abandoned ${site.name}.`, { siteId: site.id, playerName: player.name });
    await store.deleteState(site.id);
    return { ok: true, site: publicSite(site) };
  }

  async function getState({ params, player }) {
    const site = getSite(params.id);
    if (player && site.ownerId === player.id) {
      const f = await store.readState(site.id, 'owner');
      return { owner: true, state: f?.state ?? null, savedAt: f?.savedAt ?? null };
    }
    const f = await store.readState(site.id, 'public');
    return { owner: false, publicState: f?.publicState ?? null, savedAt: f?.savedAt ?? null };
  }

  async function putState({ params, body, player }) {
    const site = getOwnedSite(params.id, player);
    const hasState = 'state' in body;
    const hasPublic = 'publicState' in body;
    const hasStats = 'stats' in body;
    if (hasStats) {
      const { stats } = body;
      if (stats !== null && (typeof stats !== 'object' || Array.isArray(stats))) fail(400, '"stats" must be an object');
      if (JSON.stringify(stats).length > 4096) fail(400, '"stats" too large (max 4 KB of JSON)');
    }
    if (!hasState && !hasPublic && !hasStats) fail(400, 'Nothing to save (expected state, publicState and/or stats)');
    const savedAt = Date.now();
    if (hasStats) site.stats = body.stats;
    site.updatedAt = savedAt;
    store.changed();
    await store.writeState(site.id, {
      state: hasState ? body.state : undefined,
      publicState: hasPublic ? body.publicState : undefined,
    }, savedAt);
    return { ok: true, savedAt };
  }

  // ---- news ----------------------------------------------------------------------------------

  function listNews({ query }) {
    const since = Number(query.get('since')) || 0;
    const news = D().news;
    const out = [];
    for (let i = news.length - 1; i >= 0 && out.length < 100; i--) {
      if (news[i].time <= since) break;
      out.push(news[i]);
    }
    return out;
  }

  function postNews({ body, player }) {
    if (!newsLimiter.allow(player.id)) fail(429, 'Too many news posts, please wait a minute');
    const text = reqString(body.text, 'text', 1, 200);
    const kind = typeof body.kind === 'string' && /^[A-Za-z0-9_-]{1,24}$/.test(body.kind) ? body.kind.toLowerCase() : 'player';
    let siteId = null;
    if (body.siteId != null && body.siteId !== '') {
      siteId = String(body.siteId);
      if (!D().sites[siteId]) fail(404, 'Unknown siteId');
    }
    return addNews(kind, text, { siteId, playerName: player.name });
  }

  // ---- competitions --------------------------------------------------------------------------

  /** All competition definitions for a few seasons around `day`, by id (to resolve stored records). */
  function competitionIndex(day) {
    const Y = seasonYear(day, 'N');
    const index = new Map();
    for (let y = Y - 4; y <= Y + 4; y++) for (const c of competitionsForSeason(y)) index.set(c.id, c);
    return index;
  }

  /** Close bidding on every competition whose deadline has passed: highest score wins. */
  function resolveCompetitions() {
    const db = D();
    const day = gameDay();
    const index = competitionIndex(day);
    const ids = new Set([...competitionsAround(day).map((c) => c.id), ...Object.keys(db.competitions)]);
    let changed = false;
    for (const id of ids) {
      const comp = index.get(id);
      if (!comp || day < comp.bidDeadlineDay) continue;
      const rec = (db.competitions[id] ||= { status: 'open', bids: [] });
      if (rec.status !== 'open') continue;
      // Only bids from sites still owned by the bidding player count.
      const valid = (rec.bids || []).filter((b) => db.sites[b.siteId]?.ownerId === b.playerId);
      valid.sort((a, b) => b.score - a.score || a.time - b.time);
      const win = valid[0];
      rec.resolvedAt = Date.now();
      changed = true;
      if (!win) {
        rec.status = 'closed';
        continue;
      }
      const site = db.sites[win.siteId];
      const owner = db.players[win.playerId];
      Object.assign(rec, { status: 'awarded', winnerSiteId: site.id, winnerName: site.name, winnerPlayer: owner?.name || win.playerName });
      addNews('competition', `${site.name} (${rec.winnerPlayer}) will host the ${comp.title}!`, { siteId: site.id, playerName: rec.winnerPlayer });
    }
    if (changed) store.changed();
  }

  function mergeCompetition(comp, day) {
    const rec = D().competitions[comp.id];
    const status = rec && rec.status !== 'open' ? rec.status : day < comp.bidDeadlineDay ? 'open' : 'closed';
    const bids = (rec?.bids || [])
      .map((b) => ({ siteId: b.siteId, siteName: b.siteName, playerName: b.playerName, score: b.score, time: b.time }))
      .sort((a, b) => b.score - a.score || a.time - b.time);
    return {
      ...comp, status, bids,
      winnerSiteId: rec?.winnerSiteId || null,
      winnerName: rec?.winnerName || null,
      winnerPlayer: rec?.winnerPlayer || null,
    };
  }

  function listCompetitions() {
    resolveCompetitions();
    const day = gameDay();
    return competitionsAround(day).map((c) => mergeCompetition(c, day));
  }

  function bid({ params, body, player }) {
    resolveCompetitions();
    const day = gameDay();
    const comp = competitionsAround(day).find((c) => c.id === params.id) || fail(404, 'Unknown competition');
    if (day >= comp.bidDeadlineDay || (D().competitions[comp.id]?.status ?? 'open') !== 'open') {
      fail(409, 'Bidding for this competition is closed');
    }
    const siteId = body.siteId == null ? '' : String(body.siteId);
    const site = getOwnedSite(siteId, player);
    const score = reqNumber(body.score, 'score', 0, MAX_BID_SCORE);
    const rec = (D().competitions[comp.id] ||= { status: 'open', bids: [] });
    rec.bids = rec.bids.filter((b) => b.siteId !== site.id);
    rec.bids.push({ siteId: site.id, siteName: site.name, playerId: player.id, playerName: player.name, score, time: Date.now() });
    store.changed();
    return mergeCompetition(comp, day);
  }

  // ---- alliances -----------------------------------------------------------------------------

  const allianceMembers = (allianceId) => Object.values(D().players).filter((p) => p.allianceId === allianceId);

  function publicAlliance(a) {
    return {
      id: a.id, name: a.name, tag: a.tag,
      founderId: a.founderId, founderName: D().players[a.founderId]?.name || null,
      members: allianceMembers(a.id).map(playerRef),
      createdAt: a.createdAt,
    };
  }

  /** Remove a player from their alliance; delete it when empty, hand over leadership if the founder leaves. */
  function leaveCurrentAlliance(player) {
    const a = allianceOf(player);
    player.allianceId = null;
    store.changed();
    if (!a) return;
    const rest = allianceMembers(a.id);
    if (!rest.length) delete D().alliances[a.id];
    else if (a.founderId === player.id) a.founderId = rest[0].id;
  }

  function listAlliances() {
    return Object.values(D().alliances).map(publicAlliance);
  }

  function createAlliance({ body, player }) {
    const name = reqString(body.name, 'name', 3, 30);
    const tag = typeof body.tag === 'string' ? body.tag.trim().toUpperCase() : '';
    if (!TAG_RE.test(tag)) fail(400, '"tag" must be 2-5 letters or digits');
    for (const a of Object.values(D().alliances)) {
      if (a.tag === tag) fail(409, `Tag [${tag}] is already in use`);
      if (a.name.toLowerCase() === name.toLowerCase()) fail(409, `An alliance named "${name}" already exists`);
    }
    leaveCurrentAlliance(player);
    const alliance = { id: 'a' + randomHex(6), name, tag, founderId: player.id, createdAt: Date.now() };
    D().alliances[alliance.id] = alliance;
    player.allianceId = alliance.id;
    addNews('alliance', `${player.name} founded the alliance ${name} [${tag}].`, { playerName: player.name });
    return publicAlliance(alliance);
  }

  function joinAlliance({ params, player }) {
    const alliance = D().alliances[params.id] || fail(404, 'Alliance not found');
    if (player.allianceId !== alliance.id) {
      leaveCurrentAlliance(player);
      player.allianceId = alliance.id;
      store.changed();
    }
    return publicAlliance(alliance);
  }

  function leaveAlliance({ player }) {
    leaveCurrentAlliance(player);
    return { ok: true };
  }

  // ---- messages ------------------------------------------------------------------------------

  function publicMessage(m) {
    const players = D().players;
    return {
      id: m.id, from: m.from, fromName: players[m.from]?.name || '?', to: m.to, toName: players[m.to]?.name || '?',
      subject: m.subject, text: m.text, time: m.time, read: !!m.read,
    };
  }

  function listMessages({ player }) {
    const msgs = D().messages;
    const inbox = [], sent = [];
    for (let i = msgs.length - 1; i >= 0 && (inbox.length < 100 || sent.length < 100); i--) {
      const m = msgs[i];
      if (m.to === player.id && inbox.length < 100) inbox.push(publicMessage(m));
      if (m.from === player.id && sent.length < 100) sent.push(publicMessage(m));
    }
    return { inbox, sent };
  }

  function sendMessage({ body, player }) {
    if (!messageLimiter.allow(player.id)) fail(429, 'Too many messages, please wait a minute');
    const toName = typeof body.toName === 'string' ? body.toName.trim().replace(/\s+/g, ' ') : '';
    const recipient = store.playersByName.get(toName.toLowerCase()) || fail(404, `No player named "${toName}"`);
    const subject = typeof body.subject === 'string' ? cleanText(body.subject) : '';
    if (subject.length > 80) fail(400, '"subject" must be at most 80 characters');
    const text = reqString(body.text, 'text', 1, 2000, true);
    const db = D();
    const msg = { id: db.seq.message++, from: player.id, to: recipient.id, subject: subject || '(no subject)', text, time: Date.now(), read: false };
    db.messages.push(msg);
    if (db.messages.length > MAX_MESSAGES) db.messages.splice(0, db.messages.length - MAX_MESSAGES);
    store.changed();
    return publicMessage(msg);
  }

  function markRead({ params, player }) {
    const id = Number(params.id);
    const msg = D().messages.find((m) => m.id === id) || fail(404, 'Message not found');
    if (msg.to !== player.id) fail(403, 'Not your message');
    if (!msg.read) { msg.read = true; store.changed(); }
    return { ok: true };
  }

  // ---- leaderboard ---------------------------------------------------------------------------

  function leaderboard() {
    const db = D();
    const owned = Object.values(db.sites).filter((s) => s.ownerId && db.players[s.ownerId]);
    const resorts = owned.map((s) => {
      const owner = db.players[s.ownerId];
      const st = s.stats || {};
      return {
        siteId: s.id, name: s.name, country: s.country, ownerName: owner.name, allianceTag: allianceOf(owner)?.tag || null,
        rating: statNum(st.rating), visitorsSeason: statNum(st.visitorsSeason), value: statNum(st.value),
        fame: statNum(st.fame), pisteKm: statNum(st.pisteKm), lifts: statNum(st.lifts),
      };
    }).sort((a, b) => b.value - a.value);

    const valueByPlayer = new Map();
    const sitesByPlayer = new Map();
    for (const r of resorts) {
      const id = db.sites[r.siteId].ownerId;
      valueByPlayer.set(id, (valueByPlayer.get(id) || 0) + r.value);
      sitesByPlayer.set(id, (sitesByPlayer.get(id) || 0) + 1);
    }
    const players = Object.values(db.players).map((p) => ({
      name: p.name, sites: sitesByPlayer.get(p.id) || 0, totalValue: valueByPlayer.get(p.id) || 0, allianceTag: allianceOf(p)?.tag || null,
    })).sort((a, b) => b.totalValue - a.totalValue || b.sites - a.sites);

    const alliances = Object.values(db.alliances).map((a) => {
      const members = allianceMembers(a.id);
      return { tag: a.tag, name: a.name, members: members.length, totalValue: members.reduce((n, p) => n + (valueByPlayer.get(p.id) || 0), 0) };
    }).sort((a, b) => b.totalValue - a.totalValue);

    return { resorts: resorts.slice(0, 100), players: players.slice(0, 100), alliances: alliances.slice(0, 100) };
  }

  // ---- route table ---------------------------------------------------------------------------
  // auth: 'required' | 'optional' (default: none). body: max request body in bytes (JSON object).

  const routes = [
    { method: 'GET', path: '/api/universe/info', handler: universeInfo },
    { method: 'POST', path: '/api/auth/register', handler: register, body: SMALL_BODY },
    { method: 'POST', path: '/api/auth/login', handler: login, body: SMALL_BODY },
    { method: 'POST', path: '/api/auth/logout', handler: logout, auth: 'required', body: SMALL_BODY },
    { method: 'GET', path: '/api/me', handler: me, auth: 'required' },

    { method: 'GET', path: '/api/sites', handler: listSites },
    { method: 'POST', path: '/api/sites', handler: createSite, auth: 'required', body: SMALL_BODY },
    { method: 'POST', path: '/api/sites/:id/claim', handler: claimSite, auth: 'required', body: SMALL_BODY },
    { method: 'POST', path: '/api/sites/:id/abandon', handler: abandonSite, auth: 'required', body: SMALL_BODY },
    { method: 'GET', path: '/api/sites/:id/state', handler: getState, auth: 'optional' },
    { method: 'PUT', path: '/api/sites/:id/state', handler: putState, auth: 'required', body: STATE_BODY },

    { method: 'GET', path: '/api/news', handler: listNews },
    { method: 'POST', path: '/api/news', handler: postNews, auth: 'required', body: SMALL_BODY },

    { method: 'GET', path: '/api/competitions', handler: listCompetitions },
    { method: 'POST', path: '/api/competitions/:id/bid', handler: bid, auth: 'required', body: SMALL_BODY },

    { method: 'GET', path: '/api/alliances', handler: listAlliances },
    { method: 'POST', path: '/api/alliances', handler: createAlliance, auth: 'required', body: SMALL_BODY },
    { method: 'POST', path: '/api/alliances/leave', handler: leaveAlliance, auth: 'required', body: SMALL_BODY },
    { method: 'POST', path: '/api/alliances/:id/join', handler: joinAlliance, auth: 'required', body: SMALL_BODY },

    { method: 'GET', path: '/api/messages', handler: listMessages, auth: 'required' },
    { method: 'POST', path: '/api/messages', handler: sendMessage, auth: 'required', body: SMALL_BODY },
    { method: 'POST', path: '/api/messages/:id/read', handler: markRead, auth: 'required', body: SMALL_BODY },

    { method: 'GET', path: '/api/leaderboard', handler: leaderboard },
  ];

  function sweepLimiters() {
    authLimiter.sweep();
    newsLimiter.sweep();
    messageLimiter.sweep();
  }

  return { routes, authenticate, resolveCompetitions, sweepLimiters };
}
