// Small shared helpers for the Snowline server: HTTP responses, body parsing,
// rate limiting, concurrency limiting, request de-duplication and atomic file writes.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const USER_AGENT = 'Snowline-Game/0.1 (self-hosted ski tycoon)';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Throw an HttpError (usable inside expressions: `x || fail(404, 'nope')`). */
export function fail(status, message) {
  throw new HttpError(status, message);
}

export function sendJson(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

export function sendBuffer(res, status, buf, headers = {}, headOnly = false) {
  res.writeHead(status, { 'Content-Length': buf.length, ...headers });
  res.end(headOnly ? undefined : buf);
}

export function sendText(res, status, text, headers = {}) {
  sendBuffer(res, status, Buffer.from(text), { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
}

/** Read the request body into a Buffer, rejecting with 413 once `limit` bytes are exceeded. */
export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      reject(new HttpError(413, `Request body too large (max ${limit} bytes)`));
      return;
    }
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        settled = true;
        reject(new HttpError(413, `Request body too large (max ${limit} bytes)`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!settled) { settled = true; resolve(Buffer.concat(chunks)); }
    });
    req.on('error', (err) => {
      if (!settled) { settled = true; reject(err); }
    });
  });
}

/** Read and parse a JSON object body. An empty body yields {}. */
export async function readJson(req, limit) {
  const buf = await readBody(req, limit);
  if (buf.length === 0) return {};
  let data;
  try {
    data = JSON.parse(buf.toString('utf8'));
  } catch {
    fail(400, 'Invalid JSON body');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail(400, 'JSON body must be an object');
  return data;
}

/** Sliding-window rate limiter: at most `max` hits per `windowMs` per key. */
export class RateLimiter {
  constructor(max, windowMs) {
    this.max = max;
    this.windowMs = windowMs;
    this.hits = new Map();
  }

  allow(key) {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    let list = this.hits.get(key);
    if (!list) this.hits.set(key, (list = []));
    while (list.length && list[0] <= cutoff) list.shift();
    if (list.length >= this.max) return false;
    list.push(now);
    return true;
  }

  sweep() {
    const cutoff = Date.now() - this.windowMs;
    for (const [key, list] of this.hits) {
      if (!list.length || list[list.length - 1] <= cutoff) this.hits.delete(key);
    }
  }
}

/** Concurrency limiter: runs at most `n` async tasks at once, FIFO queue for the rest. */
export class Limiter {
  constructor(n) {
    this.n = n;
    this.active = 0;
    this.queue = [];
  }

  run(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this.#next();
    });
  }

  #next() {
    while (this.active < this.n && this.queue.length) {
      const { fn, resolve, reject } = this.queue.shift();
      this.active++;
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => { this.active--; this.#next(); });
    }
  }
}

/** Share one in-flight promise between concurrent callers asking for the same key. */
export function dedupe(inflight, key, fn) {
  const existing = inflight.get(key);
  if (existing) return existing;
  const p = Promise.resolve().then(fn).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tempName(file) {
  return `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
}

/** Write a file atomically (temp file + rename), creating parent directories. */
export async function atomicWrite(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = tempName(file);
  try {
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.unlink(tmp).catch(() => {});
    throw err;
  }
}

export function atomicWriteSync(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = tempName(file);
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

export function readJsonFileSync(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`[warn] could not read ${file}: ${err.message}`);
    return fallback;
  }
}

export const round6 = (v) => Math.round(v * 1e6) / 1e6;

export function haversineKm(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

/** Remove control characters (optionally keeping newlines/tabs) and trim. */
export function cleanText(s, keepNewlines = false) {
  const re = keepNewlines ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g : /[\u0000-\u001F\u007F]/g;
  return s.replace(re, '').trim();
}
