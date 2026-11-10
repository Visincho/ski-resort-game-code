// Client for the persistent online universe (see server/api.js).

import { haversineKm, clamp } from './util.js';

export class UniverseClient {
  constructor() {
    try { this.token = localStorage.getItem('snowline.token') || null; } catch (e) { this.token = null; }
    this.me = null;
    this.comps = [];
    this._newsT = 0;
  }

  async req(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const res = await fetch(`api/${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let data = null;
    try { data = await res.json(); } catch (e) { /* no body */ }
    if (!res.ok) {
      if (res.status === 401 && path !== 'auth/login') this.setToken(null);
      throw new Error((data && data.error) || `HTTP ${res.status}`);
    }
    return data;
  }
  setToken(tk) {
    this.token = tk;
    try { if (tk) localStorage.setItem('snowline.token', tk); else localStorage.removeItem('snowline.token'); } catch (e) { /* ignore */ }
  }

  async info() {
    const t0 = Date.now();
    const i = await this.req('GET', 'universe/info');
    const t1 = Date.now();
    i.offset = i.serverNow - (t0 + t1) / 2;
    this.infoData = i;
    return i;
  }
  async register(name, password) { const r = await this.req('POST', 'auth/register', { name, password }); this.setToken(r.token); this.me = r.player; return r; }
  async login(name, password) { const r = await this.req('POST', 'auth/login', { name, password }); this.setToken(r.token); this.me = r.player; return r; }
  async logout() { try { await this.req('POST', 'auth/logout'); } catch (e) { /* ignore */ } this.setToken(null); this.me = null; }
  async whoami() { if (!this.token) return null; const r = await this.req('GET', 'me'); this.me = r.player; this.mySites = r.sites; this.meFull = r; return r; }

  sites() { return this.req('GET', 'sites').then(s => (this.siteList = s)); }
  createSite(def) { return this.req('POST', 'sites', def); }
  claim(id) { return this.req('POST', `sites/${encodeURIComponent(id)}/claim`, {}); }
  abandon(id) { return this.req('POST', `sites/${encodeURIComponent(id)}/abandon`, {}); }
  getState(id) { return this.req('GET', `sites/${encodeURIComponent(id)}/state`); }
  putState(id, payload) { return this.req('PUT', `sites/${encodeURIComponent(id)}/state`, payload); }

  news() { return this.req('GET', 'news'); }
  postNews(kind, text, siteId) {
    if (Date.now() - this._newsT < 8000) return Promise.resolve();
    this._newsT = Date.now();
    return this.req('POST', 'news', { kind, text: String(text).slice(0, 200), siteId }).catch(() => {});
  }

  async refreshCompetitions() { this.comps = await this.req('GET', 'competitions'); return this.comps; }
  compById(id) { return this.comps.find(c => c.id === id) || null; }
  async bid(compId, siteId, score) { const c = await this.req('POST', `competitions/${encodeURIComponent(compId)}/bid`, { siteId, score }); const i = this.comps.findIndex(x => x.id === compId); if (i >= 0) this.comps[i] = c; else this.comps.push(c); return c; }

  alliances() { return this.req('GET', 'alliances'); }
  createAlliance(name, tag) { return this.req('POST', 'alliances', { name, tag }); }
  joinAlliance(id) { return this.req('POST', `alliances/${encodeURIComponent(id)}/join`, {}); }
  leaveAlliance() { return this.req('POST', 'alliances/leave', {}); }

  messages() { return this.req('GET', 'messages'); }
  sendMessage(toName, subject, text) { return this.req('POST', 'messages', { toName, subject, text }); }
  markRead(id) { return this.req('POST', `messages/${encodeURIComponent(id)}/read`, {}); }
  leaderboard() { return this.req('GET', 'leaderboard'); }

  geocode(q) { return fetch(`api/geocode?q=${encodeURIComponent(q)}`).then(r => r.ok ? r.json() : []); }

  // Market share against nearby player resorts + alliance bonus
  marketShare(site, myAttract) {
    const list = this.siteList || [];
    const meAlly = this.meFull?.allianceTag;
    let rivals = 0, allies = 0;
    for (const s of list) {
      if (s.id === site.id || !s.ownerId || !s.stats) continue;
      const d = haversineKm(site.lat, site.lon, s.lat, s.lon);
      if (d > 60) continue;
      if (meAlly && s.allianceTag === meAlly) { allies++; continue; }
      const A = s.stats.attract ?? (s.stats.rating || 50) / 100;
      rivals += Math.exp(-d / 30) * A / Math.max(0.15, myAttract || 0.5);
    }
    const share = 1 / (1 + rivals * 0.45);
    return clamp(share * (1 + Math.min(0.24, allies * 0.06)), 0.35, 1.3);
  }
}
