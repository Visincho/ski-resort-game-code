// Climate + deterministic daily weather. The same (seed, region, day) always yields the same weather,
// so every player of a universe sees the same storm hit the Dolomites.

import { mulberry32, hash32, gauss, clamp } from './util.js';
import { ymdFromDay, dayFromYMD, dayOfYear, seasonYear } from './shared/calendar.js';

export const LAPSE = 0.0058; // degC per metre

export const WEATHER_INFO = {
  sunny: { icon: '☀️', name: 'Sunny' },
  partly: { icon: '⛅', name: 'Partly cloudy' },
  cloudy: { icon: '☁️', name: 'Overcast' },
  fog: { icon: '🌫️', name: 'Fog' },
  snow: { icon: '🌨️', name: 'Snowfall' },
  heavysnow: { icon: '❄️', name: 'Heavy snow' },
  blizzard: { icon: '🌬️', name: 'Snowstorm' },
  rain: { icon: '🌧️', name: 'Rain' },
};

export class Climate {
  constructor({ lat, lon, t1500, snow, seed, refElev }) {
    this.lat = lat; this.lon = lon;
    this.hemi = lat < 0 ? 'S' : 'N';
    this.t1500 = t1500; this.snowiness = snow;
    this.seed = seed >>> 0;
    this.refElev = refElev ?? 1500;
    this.region = `${Math.round(lat * 2) / 2}:${Math.round(lon * 2) / 2}`;
    this._cache = new Map();
  }

  normalTemp(day) {
    let doy = dayOfYear(day);
    if (this.hemi === 'S') doy = (doy + 182) % 365;
    const A = 15.5;
    const warming = Math.max(0, (ymdFromDay(day).y - 2026)) * 0.045; // slow climate warming trend
    return this.t1500 + A * (1 - Math.cos((2 * Math.PI * (doy - 18)) / 365)) / 2 + warming;
  }

  // A weather season runs Jul->Jun (north) or Jan->Dec (south)
  _season(day) {
    const sy = this.hemi === 'S' ? ymdFromDay(day).y : seasonYear(day, 'N');
    const key = `${sy}`;
    if (this._cache.has(key)) return this._cache.get(key);
    const start = this.hemi === 'S' ? dayFromYMD(sy, 1, 1) : dayFromYMD(sy, 7, 1);
    const end = this.hemi === 'S' ? dayFromYMD(sy + 1, 1, 1) : dayFromYMD(sy + 1, 7, 1);
    const rng = mulberry32(hash32(this.seed, this.region, sy));
    // season character: occasionally an epic or a snow-poor winter
    const r = rng();
    const character = r < 0.12 ? 'poor' : r > 0.88 ? 'epic' : 'normal';
    const tBias = character === 'poor' ? 1.6 : character === 'epic' ? -1.0 : (rng() - 0.5) * 1.2;
    const pBias = character === 'poor' ? 0.6 : character === 'epic' ? 1.45 : 0.85 + rng() * 0.3;
    const days = [];
    let anom = 0, storm = -0.5, regime = 'normal', regimeLeft = 0;
    for (let d = start; d < end; d++) {
      anom = 0.72 * anom + gauss(rng) * 2.6;
      storm = 0.55 * storm + gauss(rng) * 0.95;
      if (regimeLeft <= 0) {
        regime = 'normal';
        const q = rng();
        if (q < 0.022) { regime = 'cold'; regimeLeft = 3 + Math.floor(rng() * 5); }
        else if (q < 0.040) { regime = 'foehn'; regimeLeft = 1 + Math.floor(rng() * 3); }
        else if (q < 0.055) { regime = 'warm'; regimeLeft = 3 + Math.floor(rng() * 6); }
      }
      regimeLeft--;
      let t = this.normalTemp(d) + anom + tBias;
      let wind = 12 + Math.abs(gauss(rng)) * 14;
      if (regime === 'cold') { t -= 9; wind += 5; storm -= 0.4; }
      if (regime === 'warm') { t += 7; storm -= 0.5; }
      if (regime === 'foehn') { t += 6; wind += 35; }
      const thr = 0.95 - 0.28 * (this.snowiness - 1);
      let precip = 0;
      if (storm > thr) precip = Math.min(70, (storm - thr) * 13 * this.snowiness * pBias + rng() * 4);
      wind += Math.max(0, storm) * 13;
      const cloud = clamp(0.5 + (storm - thr + 0.6) * 0.55 + gauss(rng) * 0.1, 0, 1);
      let state;
      if (precip > 0.5) {
        const tSnowline = t; // at 1500 m
        if (precip > 22 && wind > 55) state = 'blizzard';
        else if (precip > 14) state = 'heavysnow';
        else state = 'snow';
        if (tSnowline > 3.5) state = 'rain';
      } else if (cloud > 0.78) state = rng() < 0.22 ? 'fog' : 'cloudy';
      else if (cloud > 0.48) state = 'partly';
      else state = 'sunny';
      const clear = state === 'sunny' ? 1 : state === 'partly' ? 0.6 : 0.15;
      days.push({
        day: d, state, regime, character,
        t1500: t, tMin1500: t - 3 - 4 * clear, tMax1500: t + 2 + 5 * clear,
        wind: Math.round(wind), precip, cloud, clear,
        vis: state === 'fog' ? 0.15 : state === 'blizzard' ? 0.25 : state === 'heavysnow' ? 0.45 : state === 'snow' ? 0.7 : 1,
      });
    }
    const out = { start, days, character };
    this._cache.set(key, out);
    if (this._cache.size > 4) this._cache.delete(this._cache.keys().next().value);
    return out;
  }

  day(day) {
    const s = this._season(Math.floor(day));
    return s.days[Math.floor(day) - s.start] || s.days[s.days.length - 1];
  }

  tempAt(w, elev, which = 'mean') {
    const base = which === 'min' ? w.tMin1500 : which === 'max' ? w.tMax1500 : w.t1500;
    return base - (elev - 1500) * LAPSE;
  }
  // Temperature during the day (minute 0..1440): min ~06:30, max ~14:30
  tempAtTime(w, elev, minute) {
    const ph = Math.cos(((minute - 870) / 1440) * Math.PI * 2);
    const t = (w.tMin1500 + w.tMax1500) / 2 + ((w.tMax1500 - w.tMin1500) / 2) * ph;
    return t - (elev - 1500) * LAPSE;
  }
  windAt(w, elev) { return w.wind * clamp(0.55 + (elev - 1200) / 2600, 0.5, 1.6); }

  // New snow (cm) at an elevation for the given day
  snowfallAt(w, elev) {
    if (w.precip <= 0.5) return 0;
    const t = this.tempAt(w, elev);
    if (t > 1.5) return 0;
    const ratio = clamp(1.0 + (-t) * 0.06, 0.9, 1.8); // colder = fluffier
    const oro = clamp(0.7 + (elev - 1200) / 2200, 0.55, 1.6);
    const mix = t > 0.3 ? (1.5 - t) / 1.2 : 1;
    return w.precip * ratio * oro * mix;
  }
  rainAt(w, elev) {
    if (w.precip <= 0.5) return 0;
    const t = this.tempAt(w, elev);
    return t > 0.3 ? w.precip * clamp((t - 0.3) / 1.5, 0, 1) : 0;
  }
  snowline(w) { return 1500 + (w.t1500 - 0.8) / LAPSE; }

  // Forecast with error growing with lead time (deterministic per issue day)
  forecast(today, n, accuracy = 1) {
    const out = [];
    for (let k = 1; k <= n; k++) {
      const w = this.day(today + k);
      const rng = mulberry32(hash32(this.seed, 'fc', today, k));
      const err = (k * 0.8) / accuracy;
      const t = w.t1500 + gauss(rng) * err;
      let state = w.state;
      if (rng() < 0.07 * k / accuracy) {
        const states = ['sunny', 'partly', 'cloudy', 'snow'];
        state = states[Math.floor(rng() * states.length)];
      }
      const precip = Math.max(0, w.precip * (1 + gauss(rng) * 0.25 * k / accuracy));
      out.push({ day: today + k, state, t1500: t, tMin1500: t - (w.t1500 - w.tMin1500), tMax1500: t + (w.tMax1500 - w.t1500), wind: Math.max(0, Math.round(w.wind + gauss(rng) * 5 * k / accuracy)), precip, regime: w.regime });
    }
    return out;
  }
}

// Sun position: returns altitude/azimuth (radians). azimuth 0 = north, PI/2 = east.
export function sunPosition(lat, day, minute, lon = 0) {
  const doy = dayOfYear(day);
  const decl = -23.44 * Math.cos(((2 * Math.PI) / 365) * (doy + 10)) * Math.PI / 180;
  // treat minute as local solar time with a ~45 min offset (CET vs solar time in the Alps)
  const solar = (minute - 45) / 60;
  const ha = ((solar - 12) * 15 * Math.PI) / 180;
  const phi = (lat * Math.PI) / 180;
  const sinAlt = Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(ha);
  const alt = Math.asin(clamp(sinAlt, -1, 1));
  const cosAz = (Math.sin(decl) - Math.sin(alt) * Math.sin(phi)) / (Math.cos(alt) * Math.cos(phi) + 1e-9);
  let az = Math.acos(clamp(cosAz, -1, 1));
  if (ha > 0) az = 2 * Math.PI - az;
  return { alt, az };
}
