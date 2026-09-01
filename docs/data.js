/* ------------------------------------------------------------------
   Mock lightning data generator.

   Realism notes:
   - Strikes come from a handful of convective "cells" that migrate
     roughly W->E across the 12h window (front-like), not uniform noise.
   - Each cell fires in Poisson-ish bursts: quiet stretches, then flurries.
   - ~87% intra-cloud (blue), ~13% cloud-to-ground (orange-yellow),
     which is close to the real ratio and keeps CG strikes meaningful.
   - Seeded PRNG so the prototype is identical on every reload.
------------------------------------------------------------------- */

const WINDOW_HOURS = 12;

/* mulberry32 - small deterministic PRNG */
function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* Box-Muller, standard normal */
function gauss(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/*
  Storm cells, positioned over the SE Australia scene from the reference
  imagery: a cluster around Adelaide / Yorke Peninsula, a front trailing
  SW through western Victoria into Bass Strait, cells over Tasmania, and
  scattered inland NSW activity.

  lat/lon are the cell centre at t=0; driftLat/driftLon are degrees moved
  over the full 12h window.
*/
const CELLS = [
  { name: 'Adelaide / Gulf St Vincent', lat: -34.6, lon: 137.9, driftLat: 0.9, driftLon: 4.2, spread: 0.85, weight: 1.0,  cgBias: 1.3 },
  { name: 'Kingston SE / Coorong',      lat: -37.0, lon: 139.0, driftLat: 0.7, driftLon: 3.4, spread: 0.70, weight: 0.85, cgBias: 1.1 },
  { name: 'Western Victoria front',     lat: -38.3, lon: 141.0, driftLat: 0.5, driftLon: 3.0, spread: 0.95, weight: 0.75, cgBias: 0.9 },
  { name: 'Bass Strait',                lat: -40.0, lon: 143.6, driftLat: 0.3, driftLon: 2.4, spread: 0.80, weight: 0.55, cgBias: 0.7 },
  { name: 'Western Tasmania',           lat: -42.2, lon: 145.6, driftLat: 0.2, driftLon: 1.2, spread: 0.55, weight: 0.60, cgBias: 0.8 },
  { name: 'Inland NSW',                 lat: -32.2, lon: 146.5, driftLat: 0.6, driftLon: 2.6, spread: 1.30, weight: 0.45, cgBias: 0.6 },
  { name: 'Northern SA',                lat: -31.6, lon: 134.2, driftLat: 0.8, driftLon: 3.8, spread: 1.00, weight: 0.40, cgBias: 0.7 },
  /* Storms building over the Blue Mountains and running east across the Sydney
     basin out to sea is the classic summer pattern there, and it gives the
     default Sydney view something to show. */
  { name: 'Blue Mountains / Sydney',    lat: -33.72, lon: 149.9, driftLat: 0.25, driftLon: 1.35, spread: 0.45, weight: 0.70, cgBias: 1.2,
    // Pinned rather than randomised: the map opens on Sydney at the newest end
    // of the timeline, so this cell has to still be going when you land. Peaking
    // at 82% through the window leaves it active but past its worst.
    peak: 0.82, width: 0.30 }
];

/*
  Generates strikes for the 12h ending at `endTime` (ms epoch).
  Returns an array sorted ascending by time.
*/
function generateStrikes(endTime, seed = 20260901) {
  const rng = makeRng(seed);
  const startTime = endTime - WINDOW_HOURS * 3600 * 1000;
  const durationMs = endTime - startTime;
  const strikes = [];
  let id = 0;

  CELLS.forEach((cell, ci) => {
    // Each cell has an activity envelope: it ramps up, peaks, then decays.
    // Both draws happen either way so overriding one cell cannot shift the
    // random sequence for the others.
    const rolledPeak = 0.25 + rng() * 0.55;   // fraction through the window
    const rolledWidth = 0.16 + rng() * 0.22;  // how long it stays active
    const peak = cell.peak !== undefined ? cell.peak : rolledPeak;
    const width = cell.width !== undefined ? cell.width : rolledWidth;

    // Walk the window in 1-minute steps, firing Poisson-ish bursts.
    const stepMs = 60 * 1000;
    let burstUntil = 0;
    let burstRate = 0;

    for (let t = startTime; t < endTime; t += stepMs) {
      const p = (t - startTime) / durationMs;
      const envelope = Math.exp(-Math.pow((p - peak) / width, 2));
      const baseRate = envelope * cell.weight * 1.5; // strikes/min at full tilt

      if (t > burstUntil && rng() < 0.06 + envelope * 0.10) {
        // kick off a flurry lasting 3-12 minutes
        burstUntil = t + (3 + rng() * 9) * stepMs;
        burstRate = 1.6 + rng() * 2.4;
      }
      const rate = baseRate * (t < burstUntil ? burstRate : 0.35);
      if (rate <= 0.001) continue;

      // Poisson sample via Knuth for small lambda
      let n = 0, L = Math.exp(-rate), prod = rng();
      while (prod > L && n < 60) { n++; prod *= rng(); }
      if (n === 0) continue;

      // Cell centre at this moment
      const cLat = cell.lat + cell.driftLat * p;
      const cLon = cell.lon + cell.driftLon * p;

      for (let k = 0; k < n; k++) {
        // Elongate scatter along the drift axis so cells read as streaks,
        // the way real squall lines do.
        const along = gauss(rng) * cell.spread * 1.5;
        const across = gauss(rng) * cell.spread * 0.45;
        const lat = cLat + across * 0.9 + along * 0.28;
        const lon = cLon + along * 0.95 - across * 0.3;

        const cgChance = 0.13 * cell.cgBias;
        const type = rng() < cgChance ? 'cg' : 'ic';

        strikes.push({
          id: 'lx' + (id++),
          time: t + Math.floor(rng() * stepMs),
          lat: Math.round(lat * 10000) / 10000,
          lon: Math.round(lon * 10000) / 10000,
          type,                                   // 'cg' = cloud-to-ground, 'ic' = intra-cloud
          amps: type === 'cg'
            ? Math.round(-8 - rng() * 90)         // kA, CG usually negative
            : Math.round(4 + rng() * 22),
          cell: ci
        });
      }
    }
  });

  strikes.sort((a, b) => a.time - b.time);
  return strikes;
}

window.LightningData = { generateStrikes, WINDOW_HOURS, CELLS };
