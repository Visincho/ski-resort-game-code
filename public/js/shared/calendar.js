// Shared calendar + competition schedule. Imported by both the browser client and the Node server,
// so it must stay dependency-free and deterministic.

export const DAY_MS = 86400000;

// "Game day" = integer-ish number of days since 1970-01-01 (UTC). Fractional part = time of day.
export function dayFromYMD(y, m, d) {
  return Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);
}

export function ymdFromDay(day) {
  const dt = new Date(Math.floor(day) * DAY_MS);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate(), dow: dt.getUTCDay() };
}

export function dayOfYear(day) {
  const { y } = ymdFromDay(day);
  return Math.floor(day) - dayFromYMD(y, 1, 1);
}

// Winter season year. Northern: the season that starts in Nov of year Y belongs to Y (Dec Y - Apr Y+1).
// Southern: season of year Y is Jun - Oct Y.
export function seasonYear(day, hemi = 'N') {
  const { y, m } = ymdFromDay(day);
  if (hemi === 'S') return y;
  return m >= 7 ? y : y - 1;
}

// Default lift operating window (the resort can still be closed for lack of snow).
export function seasonWindow(year, hemi = 'N') {
  if (hemi === 'S') return { open: dayFromYMD(year, 6, 14), close: dayFromYMD(year, 10, 5) };
  return { open: dayFromYMD(year, 11, 29), close: dayFromYMD(year + 1, 4, 19) };
}

export function isSkiSeason(day, hemi = 'N') {
  const w = seasonWindow(seasonYear(day, hemi), hemi);
  const d = Math.floor(day);
  return d >= w.open && d <= w.close;
}

// Persistent universe clock: real time maps linearly to game time.
export function universeDay(info, nowMs = Date.now()) {
  return info.startGameDay + (nowMs - info.startReal) / (info.dayRealMinutes * 60000);
}

export const DISCIPLINES = {
  DH: { name: 'Downhill', minVertical: 750, minDiff: 2, days: 3 },
  SG: { name: 'Super-G', minVertical: 400, minDiff: 2, days: 2 },
  GS: { name: 'Giant Slalom', minVertical: 300, minDiff: 2, days: 2 },
  SL: { name: 'Slalom', minVertical: 140, minDiff: 2, days: 1 },
  BA: { name: 'Big Air', minVertical: 0, minDiff: 0, days: 2, needs: { terrainpark: 1 } },
};

// Difficulty codes: 0 green, 1 blue, 2 red, 3 black.

// Deterministic list of competitions whose event falls in the given season year.
export function competitionsForSeason(Y) {
  const out = [];
  const wc = [
    [12, 6, 'SG'], [12, 13, 'GS'], [12, 20, 'DH'], [12, 22, 'SL'],
    [1, 11, 'SL'], [1, 18, 'DH'], [1, 25, 'SG'], [2, 1, 'GS'],
    [2, 22, 'DH'], [3, 8, 'SL'], [1, 30, 'BA'],
  ];
  wc.forEach(([m, d, disc], i) => {
    const year = m >= 7 ? Y : Y + 1;
    const ev = dayFromYMD(year, m, d);
    const D = DISCIPLINES[disc];
    out.push({
      id: `wc-${Y}-${i + 1}`,
      type: disc === 'BA' ? 'freestyle' : 'worldcup',
      hemi: 'N',
      discipline: disc,
      title: disc === 'BA' ? `Freestyle World Cup - Big Air ${Y}/${(Y + 1) % 100}` : `Alpine World Cup - ${D.name} ${Y}/${(Y + 1) % 100}`,
      eventDay: ev,
      durationDays: D.days,
      bidDeadlineDay: ev - 45,
      req: {
        minRating: 55, minBeds: 1500, discipline: disc,
        minVertical: D.minVertical, minDiff: D.minDiff,
        snowmaking: disc !== 'BA',
        buildings: Object.assign({ grandstand: 1 }, D.needs || {}),
      },
      prize: disc === 'BA' ? 900000 : 1500000,
      fame: 6,
    });
  });
  // World Championships: Feb of odd years
  if ((Y + 1) % 2 === 1) {
    const ev = dayFromYMD(Y + 1, 2, 4);
    out.push({
      id: `wch-${Y + 1}`, type: 'worldchamps', hemi: 'N', discipline: 'ALL',
      title: `Alpine World Ski Championships ${Y + 1}`,
      eventDay: ev, durationDays: 14, bidDeadlineDay: ev - 365,
      req: {
        minRating: 68, minBeds: 4000, discipline: 'DH+SL', minVertical: 750, minDiff: 2,
        snowmaking: true, hostedWorldCup: 1, buildings: { grandstand: 2 },
      },
      prize: 9000000, fame: 18,
    });
  }
  // Winter Olympics: Feb of years where (year % 4 === 2)
  if ((Y + 1) % 4 === 2) {
    const ev = dayFromYMD(Y + 1, 2, 6);
    out.push({
      id: `oly-${Y + 1}`, type: 'olympics', hemi: 'N', discipline: 'ALL',
      title: `Winter Olympic Games ${Y + 1}`,
      eventDay: ev, durationDays: 17, bidDeadlineDay: ev - 730,
      req: {
        minRating: 78, minBeds: 9000, discipline: 'DH+SL', minVertical: 750, minDiff: 2,
        snowmaking: true, hostedWorldCup: 2,
        buildings: { grandstand: 2, icearena: 1, slidingcenter: 1, skijump: 1, nordic: 1, terrainpark: 1, halfpipe: 1 },
      },
      prize: 60000000, fame: 45,
    });
  }
  // Southern hemisphere cup
  [[8, 16, 'GS'], [9, 6, 'SL']].forEach(([m, d, disc], i) => {
    const ev = dayFromYMD(Y, m, d);
    out.push({
      id: `sh-${Y}-${i + 1}`, type: 'worldcup', hemi: 'S', discipline: disc,
      title: `Southern Hemisphere Cup - ${DISCIPLINES[disc].name} ${Y}`,
      eventDay: ev, durationDays: 2, bidDeadlineDay: ev - 45,
      req: { minRating: 50, minBeds: 800, discipline: disc, minVertical: DISCIPLINES[disc].minVertical, minDiff: 2, snowmaking: true, buildings: { grandstand: 1 } },
      prize: 800000, fame: 4,
    });
  });
  return out;
}

// Competitions visible around a given day: events from this season and the next few (for long bids).
export function competitionsAround(day) {
  const Y = seasonYear(day, 'N');
  const list = [];
  for (let y = Y - 1; y <= Y + 3; y++) list.push(...competitionsForSeason(y));
  return list.filter(c => c.eventDay + c.durationDays >= day - 30 && c.bidDeadlineDay - day < 800);
}
