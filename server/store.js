// Persistent universe store. The core universe (players, sites, news, ...) lives in memory and is
// written to data/universe.json (throttled, atomic). Resort save blobs live in data/states/.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { dayFromYMD, universeDay } from '../public/js/shared/calendar.js';
import { atomicWrite, atomicWriteSync, readJsonFileSync } from './lib.js';

const SAVE_DELAY_MS = 2000; // a change is on disk at most ~2-3 s later

export class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'universe.json');
    this.statesDir = path.join(dataDir, 'states');
    this.saveTimer = null;
    this.saving = null;
    this.siteLocks = new Map();
    this.db = null;
  }

  // ---- lifecycle ---------------------------------------------------------------------------

  load() {
    fs.mkdirSync(this.statesDir, { recursive: true });
    const db = readJsonFileSync(this.file, null);
    if (db && db.info) {
      this.db = db;
    } else {
      this.db = {
        version: 1,
        info: {
          name: 'Alpine Universe 1',
          seed: Math.floor(Math.random() * 2 ** 31),
          startReal: Date.now(),
          startGameDay: dayFromYMD(2026, 10, 1),
          dayRealMinutes: Number(process.env.DAY_MINUTES || 20),
          maxSitesPerPlayer: 3,
        },
        players: {}, sessions: {}, sites: {}, alliances: {}, competitions: {},
        news: [], messages: [], seq: { news: 1, message: 1 },
      };
      console.log(`[universe] created new universe "${this.db.info.name}" (seed ${this.db.info.seed})`);
    }
    for (const k of ['players', 'sessions', 'sites', 'alliances', 'competitions']) this.db[k] ||= {};
    for (const k of ['news', 'messages']) this.db[k] ||= [];
    this.db.seq ||= { news: 1, message: 1 };
    this.#applyDayMinutesOverride();
    this.reindex();
    this.purgeSessions();
    this.saveNow();
  }

  /** If DAY_MINUTES changed since the universe was created, rebase the clock so game time stays continuous. */
  #applyDayMinutesOverride() {
    const env = Number(process.env.DAY_MINUTES);
    const info = this.db.info;
    if (!process.env.DAY_MINUTES || !(env > 0) || env === info.dayRealMinutes) return;
    const now = Date.now();
    info.startGameDay = universeDay(info, now);
    info.startReal = now;
    info.dayRealMinutes = env;
    console.log(`[universe] DAY_MINUTES changed: clock rebased to ${env} real minutes per game day`);
  }

  reindex() {
    this.playersByName = new Map();
    for (const p of Object.values(this.db.players)) this.playersByName.set(p.name.toLowerCase(), p);
  }

  /** Add famous resorts from public/js/shared/resorts.js that are not yet in the universe. */
  async seedFamousResorts(resortsFile) {
    if (!fs.existsSync(resortsFile)) {
      console.log('[universe] no resorts.js yet - starting without famous seed sites');
      return;
    }
    let list;
    try {
      const mod = await import(pathToFileURL(resortsFile).href);
      list = mod.FAMOUS_RESORTS;
    } catch (err) {
      console.warn(`[universe] could not import resorts.js: ${err.message}`);
      return;
    }
    if (!Array.isArray(list)) return;
    let added = 0;
    const now = Date.now();
    for (const r of list) {
      if (!r || typeof r.id !== 'string' || !r.id || this.db.sites[r.id]) continue;
      const lat = Number(r.lat), lon = Number(r.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      this.db.sites[r.id] = {
        id: r.id,
        name: String(r.name || r.id).slice(0, 60),
        country: String(r.country || '').slice(0, 40),
        lat, lon,
        w: Number(r.w) > 0 ? Number(r.w) : 10,
        h: Number(r.h) > 0 ? Number(r.h) : 10,
        famous: true,
        ownerId: null,
        stats: null,
        createdAt: now,
        updatedAt: now,
      };
      added++;
    }
    if (added) {
      console.log(`[universe] added ${added} famous resort site(s)`);
      this.changed();
    }
  }

  // ---- universe.json persistence -----------------------------------------------------------

  /** Mark the universe dirty; it is written within a few seconds. */
  changed() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.#saveAsync();
    }, SAVE_DELAY_MS);
  }

  async #saveAsync() {
    if (this.saving) { // a write is in progress: write again once it is done
      this.changed();
      return;
    }
    const json = JSON.stringify(this.db);
    this.saving = atomicWrite(this.file, json)
      .catch((err) => console.error(`[universe] save failed: ${err.message}`))
      .finally(() => { this.saving = null; });
    await this.saving;
  }

  /** Synchronous flush (startup, shutdown). */
  saveNow() {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    atomicWriteSync(this.file, JSON.stringify(this.db));
  }

  /** Wait for in-flight state writes, then flush universe.json synchronously. */
  async shutdown(timeoutMs = 5000) {
    const pending = [...this.siteLocks.values()];
    if (this.saving) pending.push(this.saving);
    await Promise.race([Promise.allSettled(pending), new Promise((r) => setTimeout(r, timeoutMs))]);
    this.saveNow();
  }

  // ---- sessions ------------------------------------------------------------------------------

  purgeSessions(maxAgeMs = 30 * 86400000) {
    const cutoff = Date.now() - maxAgeMs;
    let n = 0;
    for (const [token, s] of Object.entries(this.db.sessions)) {
      if (!s || s.created < cutoff || !this.db.players[s.playerId]) { delete this.db.sessions[token]; n++; }
    }
    if (n) this.changed();
  }

  // ---- per-site state files ------------------------------------------------------------------
  // Owner state:  states/{id}.json         -> { state, savedAt }
  // Public state: states/{id}.public.json  -> { publicState, savedAt }  (small, read by visitors)

  #stateFile(siteId, kind) {
    const safe = siteId.replace(/[^A-Za-z0-9_-]/g, '_');
    return path.join(this.statesDir, kind === 'public' ? `${safe}.public.json` : `${safe}.json`);
  }

  /** Serialize all file operations for one site so writes/deletes never interleave. */
  #withSiteLock(siteId, fn) {
    const prev = this.siteLocks.get(siteId) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    const tail = next.catch(() => {});
    this.siteLocks.set(siteId, tail);
    tail.then(() => { if (this.siteLocks.get(siteId) === tail) this.siteLocks.delete(siteId); });
    return next;
  }

  async readState(siteId, kind) {
    const file = this.#stateFile(siteId, kind);
    return this.#withSiteLock(siteId, async () => {
      try {
        return JSON.parse(await fsp.readFile(file, 'utf8'));
      } catch (err) {
        if (err.code !== 'ENOENT') console.warn(`[universe] bad state file ${file}: ${err.message}`);
        return null;
      }
    });
  }

  /** Write owner and/or public state. `undefined` means "leave that part unchanged". */
  async writeState(siteId, { state, publicState }, savedAt) {
    return this.#withSiteLock(siteId, async () => {
      if (state !== undefined) await atomicWrite(this.#stateFile(siteId, 'owner'), JSON.stringify({ state, savedAt }));
      if (publicState !== undefined) await atomicWrite(this.#stateFile(siteId, 'public'), JSON.stringify({ publicState, savedAt }));
    });
  }

  async deleteState(siteId) {
    return this.#withSiteLock(siteId, async () => {
      for (const kind of ['owner', 'public']) await fsp.unlink(this.#stateFile(siteId, kind)).catch(() => {});
    });
  }
}
