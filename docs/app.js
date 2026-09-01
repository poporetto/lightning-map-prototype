/* ------------------------------------------------------------------
   Lightning map prototype — Australia
   Leaflet + mocked strike feed + live rain-radar tiles.
------------------------------------------------------------------- */

const MINUTE = 60 * 1000;
const WINDOW_MINUTES = LightningData.WINDOW_HOURS * 60;   // 720
const MAX_AGE_MIN = 60;                                   // strikes hide after this

/* Opacity ladder, straight from the spec. Age is measured against the
   currently selected timeline time, not wall-clock now. */
const AGE_STEPS = [
  { maxMin: 5,  opacity: 1.00, fresh: true  },
  { maxMin: 15, opacity: 0.85, fresh: false },
  { maxMin: 30, opacity: 0.65, fresh: false },
  { maxMin: 60, opacity: 0.45, fresh: false }
];

function ageStyle(ageMin) {
  for (const step of AGE_STEPS) if (ageMin < step.maxMin) return step;
  return null; // hidden
}

/* Playback speeds expressed as minutes-of-data per second of wall clock.
   1x walks the full 12 h in about three minutes. */
const SPEED_MIN_PER_SEC = 4;

/* Lightning bolt artwork supplied for this project — see lightning.svg in the
   repo root, which is the source of truth for this path. The export's hardcoded
   fill="#FFD426" is deliberately dropped: the markers take fill, stroke and the
   white-hot arrival flash from CSS custom properties, so a baked-in colour
   would break the three palettes and the arrival animation. */
const BOLT_PATH = 'M18.3193 0H6.95469C6.5366 0 6.16264 0.260099 6.01717 0.652067L0.0632346 16.6952C-0.179191 17.3484 0.303992 18.0431 1.00075 18.0431H10.277L7.94665 29.2503C7.73063 30.2892 9.06821 30.905 9.717 30.0653L22.3178 13.7581C22.8257 13.1008 22.3572 12.1466 21.5265 12.1466H12.9558L19.1824 1.50502C19.5725 0.838366 19.0917 0 18.3193 0Z';
const BOLT_SVG = '<svg viewBox="0 0 23 31" aria-hidden="true"><path d="' + BOLT_PATH + '"/></svg>';
/* The ring sits behind the glyph and expands from the strike point on arrival. */
const RING_SPAN = '<span class="strike-ring"></span>';

/* ---------------- state ---------------- */

const endTime = Date.now();
const startTime = endTime - WINDOW_MINUTES * MINUTE;
const strikes = LightningData.generateStrikes(endTime);

const state = {
  selectedMin: WINDOW_MINUTES,   // slider position, minutes from startTime
  playing: false,
  speed: 1,
  radarOn: true
};

const mounted = new Map();       // strike id -> { marker, inner, opacity }

/* ---------------- map ---------------- */

const map = L.map('map', {
  center: [-37.2, 142.0],
  zoom: 5,
  zoomControl: false,
  preferCanvas: false,
  worldCopyJump: false
});
L.control.zoom({ position: 'bottomleft' }).addTo(map);

const baseLayers = {
  grey: L.tileLayer('https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
    attribution: '&copy; Esri, HERE, Garmin, &copy; OpenStreetMap contributors',
    maxZoom: 16
  }),
  satellite: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics',
    maxZoom: 19
  })
};

/* Place-name labels sit above the radar so the map stays readable, the way
   the BOM viewer does it. */
const labelLayer = L.tileLayer('https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}', {
  maxZoom: 16, pane: 'shadowPane', opacity: 0.95
});

let currentBase = 'grey';
baseLayers.grey.addTo(map);

const radarPane = map.createPane('radarPane');
radarPane.style.zIndex = 350;
radarPane.style.opacity = '0.72';
radarPane.style.pointerEvents = 'none';

const strikeLayer = L.layerGroup().addTo(map);
labelLayer.addTo(map);

/* ---------------- rain radar ----------------

   BOM does not publish a documented, CORS-open tile endpoint for third-party
   use, so the default source is RainViewer (free, CORS-open, covers the BOM
   radar network over Australia). Swap RADAR_SOURCE to point at a BOM endpoint
   if you have one that serves the right headers — the rest of the code only
   needs { frames: [{time, url}] }.
------------------------------------------------------------------------- */

const RADAR_SOURCE = {
  name: 'RainViewer composite',
  index: 'https://api.rainviewer.com/public/weather-maps.json'
};

let radarFrames = [];        // [{ time (ms), url }]
let radarLayer = null;
let radarFrameIndex = -1;
let lastRadarSwap = 0;
const RADAR_SWAP_MIN_MS = 400;   // fast playback would otherwise refetch tiles constantly
const radarStatusEl = document.getElementById('radar-status');

async function loadRadar() {
  try {
    const res = await fetch(RADAR_SOURCE.index, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const host = data.host;
    const past = (data.radar && data.radar.past) || [];
    radarFrames = past.map(f => ({
      time: f.time * 1000,
      // {size}/{z}/{x}/{y}/{colorScheme}/{smooth}_{snow}.png
      url: host + f.path + '/512/{z}/{x}/{y}/2/1_1.png'
    }));
    if (!radarFrames.length) throw new Error('no frames');

    const oldest = new Date(radarFrames[0].time);
    radarStatusEl.classList.remove('is-error');
    radarStatusEl.innerHTML =
      RADAR_SOURCE.name + ' &middot; ' + radarFrames.length + ' frames back to ' +
      fmtTime(oldest) + '.<br>Not BOM &mdash; BOM\u2019s own tiles need an API key. ' +
      'Radar history is shorter than the 12&#8239;h strike timeline, so it holds ' +
      'on the oldest frame before then.';
    applyRadar();
  } catch (err) {
    radarFrames = [];
    radarStatusEl.classList.add('is-error');
    radarStatusEl.textContent = 'Radar unavailable (' + err.message + ').';
  }
}

/* Picks the radar frame nearest the selected time and swaps the tile layer
   only when the frame actually changes. */
function applyRadar() {
  if (!state.radarOn || !radarFrames.length) {
    if (radarLayer) { map.removeLayer(radarLayer); radarLayer = null; radarFrameIndex = -1; }
    return;
  }
  const t = selectedTime();
  let best = 0;
  for (let i = 1; i < radarFrames.length; i++) {
    if (Math.abs(radarFrames[i].time - t) < Math.abs(radarFrames[best].time - t)) best = i;
  }
  if (best === radarFrameIndex && radarLayer) return;
  const now = performance.now();
  if (radarLayer && now - lastRadarSwap < RADAR_SWAP_MIN_MS) return;
  lastRadarSwap = now;
  radarFrameIndex = best;

  const next = L.tileLayer(radarFrames[best].url, {
    pane: 'radarPane', maxZoom: 19, maxNativeZoom: 10, tileSize: 512, zoomOffset: -1,
    attribution: 'Radar &copy; RainViewer'
  });
  const prev = radarLayer;
  next.on('load', () => { if (prev) map.removeLayer(prev); });
  next.addTo(map);
  radarLayer = next;
  // Safety net in case 'load' never fires (all tiles cached / errored).
  setTimeout(() => { if (prev && prev !== radarLayer) map.removeLayer(prev); }, 1200);
}

/* ---------------- strike rendering ---------------- */

function selectedTime() { return startTime + state.selectedMin * MINUTE; }

/* First index with time >= t */
function lowerBound(t) {
  let lo = 0, hi = strikes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (strikes[mid].time < t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function makeIcon(strike, fresh, arrive) {
  const cls = ['strike-marker', strike.type === 'cg' ? 'strike-cg' : 'strike-ic'];
  if (fresh) cls.push('strike-fresh');
  if (arrive) cls.push('strike-arrive');
  const size = strike.type === 'cg' ? [18, 24] : [14, 19];
  return L.divIcon({
    className: 'strike-icon',
    html: '<div class="' + cls.join(' ') + '">' + (arrive ? RING_SPAN : '') + BOLT_SVG + '</div>',
    iconSize: size,
    // CG bolts point at the ground, so anchor them at the tip.
    iconAnchor: strike.type === 'cg' ? [size[0] / 2, size[1]] : [size[0] / 2, size[1] / 2]
  });
}

function popupHtml(s) {
  const d = new Date(s.time);
  return '<b>' + (s.type === 'cg' ? 'Cloud-to-ground' : 'Intra-cloud') + ' strike</b>' +
    '<span class="k">Time</span> ' + fmtTime(d) + '<br>' +
    '<span class="k">Position</span> ' + s.lat.toFixed(3) + ', ' + s.lon.toFixed(3) + '<br>' +
    '<span class="k">Peak current</span> ' + s.amps + ' kA';
}

let lastRenderTime = null;

function renderStrikes() {
  const t = selectedTime();
  // Jumping the slider mounts a whole fresh band at once; firing hundreds of
  // arrival rings for that is noise, not information. Only strikes that arrive
  // while time is running forward normally get the moment.
  const jumped = lastRenderTime === null || Math.abs(t - lastRenderTime) > 5 * MINUTE;
  lastRenderTime = t;
  const from = lowerBound(t - MAX_AGE_MIN * MINUTE);
  const to = lowerBound(t + 1);     // strikes in the future are not shown

  const seen = new Set();
  let cg = 0, ic = 0;

  for (let i = from; i < to; i++) {
    const s = strikes[i];
    const ageMin = (t - s.time) / MINUTE;
    const style = ageStyle(ageMin);
    if (!style) continue;

    seen.add(s.id);
    if (s.type === 'cg') cg++; else ic++;

    let entry = mounted.get(s.id);
    if (!entry) {
      const marker = L.marker([s.lat, s.lon], {
        icon: makeIcon(s, style.fresh, style.fresh && !jumped),
        keyboard: false,
        riseOnHover: true,
        interactive: true
      });
      marker.bindPopup(popupHtml(s), { className: 'strike-popup', closeButton: false, offset: [0, -8] });
      marker.addTo(strikeLayer);

      // The arrival animation is longer than the 5-minute fresh band is at
      // normal playback speed, so it has to end on its own terms rather than be
      // cut off mid-flash when the strike ages out. Its last keyframe is the
      // static halo that .strike-fresh paints, so dropping the class is
      // invisible either way.
      if (style.fresh && !jumped) {
        const el = marker.getElement();
        const inner = el && el.firstElementChild;
        if (inner) inner.addEventListener('animationend', ev => {
          if (ev.animationName === 'strike-bloom') inner.classList.remove('strike-arrive');
        });
      }
      entry = { marker, opacity: -1, fresh: style.fresh };
      mounted.set(s.id, entry);
    } else if (entry.fresh && !style.fresh) {
      // Aged out of the "fresh" band — drop the halo without rebuilding. Any
      // arrival still in flight is left alone; it removes its own class.
      const inner = entry.marker.getElement() && entry.marker.getElement().firstElementChild;
      if (inner) {
        inner.classList.remove('strike-fresh');
        entry.fresh = false;
      }
    }

    if (entry.opacity !== style.opacity) {
      entry.marker.setOpacity(style.opacity);
      entry.opacity = style.opacity;
    }
  }

  for (const [id, entry] of mounted) {
    if (!seen.has(id)) { strikeLayer.removeLayer(entry.marker); mounted.delete(id); }
  }

  document.getElementById('count-cg').textContent = cg.toLocaleString();
  document.getElementById('count-ic').textContent = ic.toLocaleString();
}

/* ---------------- time formatting ---------------- */

function pad(n) { return n < 10 ? '0' + n : '' + n; }
function fmtTime(d) { return pad(d.getHours()) + ':' + pad(d.getMinutes()); }

function fmtPill(d) {
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const yesterday = new Date(today.getTime() - 86400000);
  const label = sameDay ? 'Today'
    : (d.toDateString() === yesterday.toDateString() ? 'Yesterday'
      : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }));
  return label + ' ' + fmtTime(d);
}

/* ---------------- UI wiring ---------------- */

const slider = document.getElementById('slider');
const pill = document.getElementById('time-pill');
const playBtn = document.getElementById('play');

slider.max = String(WINDOW_MINUTES);
slider.value = String(state.selectedMin);
document.getElementById('range-start').textContent = fmtPill(new Date(startTime));
document.getElementById('range-end').textContent = fmtPill(new Date(endTime));

function update() {
  slider.value = String(Math.round(state.selectedMin));
  slider.style.backgroundSize = (state.selectedMin / WINDOW_MINUTES * 100) + '% 100%';
  pill.textContent = fmtPill(new Date(selectedTime()));
  renderStrikes();
  applyRadar();
}

slider.addEventListener('input', () => {
  state.selectedMin = Number(slider.value);
  setPlaying(false);
  update();
});

playBtn.addEventListener('click', () => setPlaying(!state.playing));

document.getElementById('speed-select').addEventListener('change', e => {
  state.speed = Number(e.target.value);
});

document.getElementById('scheme-select').addEventListener('change', e => {
  // Markers read their colours from CSS vars, so switching the palette repaints
  // every strike already on the map without re-rendering anything.
  document.body.dataset.scheme = e.target.value;
});

document.getElementById('radar-toggle').addEventListener('change', e => {
  state.radarOn = e.target.checked;
  applyRadar();
});

document.getElementById('basemap-toggle').addEventListener('click', e => {
  const btn = e.target.closest('button[data-basemap]');
  if (!btn) return;
  const next = btn.dataset.basemap;
  if (next === currentBase) return;
  map.removeLayer(baseLayers[currentBase]);
  baseLayers[next].addTo(map);
  baseLayers[next].bringToBack();
  currentBase = next;
  // Dark labels read badly over satellite imagery; the grey map needs them.
  labelLayer.setOpacity(next === 'satellite' ? 0 : 0.9);
  [...e.currentTarget.querySelectorAll('button')].forEach(b =>
    b.classList.toggle('is-active', b === btn));
});

/* Space bar toggles playback; arrows nudge the timeline a minute at a time. */
document.addEventListener('keydown', e => {
  if (e.target.matches('input, select, textarea')) return;
  if (e.code === 'Space') { e.preventDefault(); setPlaying(!state.playing); }
  if (e.code === 'ArrowLeft') { state.selectedMin = Math.max(0, state.selectedMin - 1); setPlaying(false); update(); }
  if (e.code === 'ArrowRight') { state.selectedMin = Math.min(WINDOW_MINUTES, state.selectedMin + 1); setPlaying(false); update(); }
});

/* ---------------- playback ---------------- */

let rafId = null;
let lastFrameTs = 0;

function setPlaying(on) {
  if (state.playing === on) return;
  state.playing = on;
  playBtn.classList.toggle('is-playing', on);
  playBtn.setAttribute('aria-label', on ? 'Pause timeline' : 'Play timeline');
  if (on) {
    // Pressing play while parked at the end replays the whole window.
    if (state.selectedMin >= WINDOW_MINUTES) state.selectedMin = 0;
    lastFrameTs = performance.now();
    rafId = requestAnimationFrame(tick);
  } else if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

function tick(ts) {
  // Clamp so a throttled/backgrounded tab doesn't jump the timeline forward
  // by minutes the moment it wakes up.
  const dt = Math.min(ts - lastFrameTs, 1000) / 1000;
  lastFrameTs = ts;
  state.selectedMin += dt * SPEED_MIN_PER_SEC * state.speed;
  if (state.selectedMin >= WINDOW_MINUTES) {
    // Show the final frame, then loop back to the start of the 12 h window.
    state.selectedMin = WINDOW_MINUTES;
    update();
    state.selectedMin = 0;
  } else {
    update();
  }
  rafId = requestAnimationFrame(tick);
}

// A backgrounded tab throttles requestAnimationFrame; resync the clock on
// return so playback picks up where it left off instead of leaping ahead.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) lastFrameTs = performance.now();
});

/* ---------------- boot ---------------- */

// Legend swatches reuse the marker markup so they always match the map.
document.getElementById('legend-cg').innerHTML = '<span class="strike-marker strike-cg">' + BOLT_SVG + '</span>';
document.getElementById('legend-ic').innerHTML = '<span class="strike-marker strike-ic">' + BOLT_SVG + '</span>';

update();
loadRadar();

console.log('[lightning] generated', strikes.length, 'strikes over',
  LightningData.WINDOW_HOURS, 'h;',
  strikes.filter(s => s.type === 'cg').length, 'cloud-to-ground.');
