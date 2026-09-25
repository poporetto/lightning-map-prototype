/* ------------------------------------------------------------------
   Strike-density surface.

   A kernel-density estimate of the last 60 minutes of strikes, drawn as a
   light-to-dark surface under the strike markers: light where few strikes
   have landed, dark where many. Over the colour sits a fine pattern of small
   bolts, Windy-style, whose strength follows the density - so the layer reads
   as lightning rather than as generic heat.

   Several decisions here were made against measurements, because the obvious
   version of each looks wrong:

   1. The grid is fixed in GEOGRAPHY, not in screen pixels. A screen-pixel grid
      is not zoom-invariant: zoom in far enough and almost every occupied cell
      holds exactly one strike while its area keeps shrinking by 4x a level, so
      the same data reads an order of magnitude denser. Measured on this
      generator, the median rate climbed from 6e-4 at z6 to 8e-2 at z10. Density
      here is strikes per km2, so it is a property of the data at every zoom.

   2. Strikes are smoothed with a Gaussian kernel (sigma ~12 km) rather than
      hard-binned. Hard bins are too sparse to shade: at 14 km cells three
      quarters of occupied cells held exactly one strike.

   3. Colour is continuous, not banded. An earlier version snapped the field to
      five flat bands and jumped alpha from 0 to 0.44 at the floor; upscaled,
      both showed as stair-stepped contours and a hard pixelated rim. The field
      now maps through a 256-entry interpolated ramp, alpha fades in over a
      range rather than at a threshold, and the grid is fine enough on screen
      (3-6 px a cell) that bilinear upscaling leaves nothing to see.
------------------------------------------------------------------- */

(function () {
  'use strict';

  const MINUTE = 60 * 1000;

  /* Density looks back further than the markers do. Strikes fade out of the map
     at 30 minutes; the surface holds a full hour, so it still shows where a
     storm has been after its individual strikes have gone. */
  const WINDOW_MIN = 60;

  const REF_ZOOM = 8;
  const METRES_PER_PX_EQ = 156543.03392 / Math.pow(2, REF_ZOOM);

  /* Smoothing radius, in world pixels at REF_ZOOM (~12 km at these latitudes,
     about the scale of a single convective cell). It is fixed in geography;
     only the grid it is sampled on changes with zoom. */
  const SIGMA_REF_PX = 24;

  /* The grid's cell size is picked per zoom, in powers of two of this base, so
     a cell stays roughly GRID_TARGET_PX on screen. Too coarse and bilinear
     upscaling shows diamonds; too fine and zoomed-out views cost a million
     cells for no visible gain. Coarser cells change nothing about the values,
     since the field is per km2 and the kernel is sized in km. */
  const BASE_CELL_REF_PX = 8;
  const GRID_TARGET_PX = 4;
  const MIN_LEVEL = -1, MAX_LEVEL = 5;

  /* ---- the value scale ----
     All in strikes per km2 per hour. A single strike peaks at 1.07e-3 at the
     centre of its own kernel, so FADE_START sits just above that: a lone strike
     paints nothing, it takes at least two close together to shade the map, and
     the surface means "repeated activity" rather than "something happened here
     once". Alpha then fades in up to FADE_FULL instead of switching on at a
     threshold, which is what removes the hard rim. Colour runs on a log scale
     from RAMP_LO to RAMP_HI; the stop positions below are where the old band
     thresholds (p20, p45, p70, p88, p97 of the painted field) fall on it. */
  const FADE_START = 1.1e-3;
  const FADE_FULL  = 1.9e-3;
  const RAMP_LO    = 1.3e-3;
  const RAMP_HI    = 7.3e-3;
  const STOP_POS   = [0, 0.22, 0.45, 0.72, 1];

  /* ---- colour ramps ----
     Each one is solved against composited luminance over the grey basemap, to
     the same five targets (L = .168 .130 .099 .073 .050, steps of 23/24/27/31%),
     along its own hue path. That keeps them directly comparable: they differ in
     hue only, not in how strongly they read. Three constraints shaped them:

     - Alpha must not climb steeply with density, or over a dark basemap the pale
       end is dragged back toward the background and the first steps vanish.
     - The dark end stops short of black, which would sink into the basemap.
     - The pale end cannot be truly pale: that either fogs the map or collides
       with the white arrival flash drawn on top of it.

     Hue clearance from the strike colours (CIELAB hue angle, deep stops only):
       rose     74 deg from CG orange, 75 from IC blue
       teal    115 / 51  - closest to IC blue of the four; the Windy look
       emerald  74 / 111 - widest clearance overall, but reads as vegetation
                           on the satellite basemap
       crimson  52 / 107 - closest to CG orange; storm-warning red
     Indigo was also solved and dropped: 29 deg from IC blue.

     `bolt` is the pattern tint - near-white with a trace of the ramp's hue, so
     the bolts belong to the surface and never read as CG-yellow markers. */
  const ALPHAS = [0.44, 0.56, 0.66, 0.75, 0.84];
  const RAMPS = {
    rose: {
      label: 'Rose',
      stops: [[224, 192, 198], [203, 120, 143], [198, 63, 114], [163, 38, 101], [128, 23, 88]],
      bolt: [255, 236, 244]
    },
    teal: {
      label: 'Teal',
      stops: [[170, 207, 202], [71, 157, 152], [41, 122, 123], [24, 96, 104], [14, 73, 84]],
      bolt: [226, 255, 249]
    },
    emerald: {
      label: 'Emerald',
      stops: [[180, 207, 185], [82, 159, 105], [51, 124, 81], [31, 99, 65], [18, 77, 53]],
      bolt: [232, 255, 238]
    },
    crimson: {
      label: 'Crimson',
      stops: [[225, 192, 193], [208, 121, 127], [207, 62, 77], [176, 31, 53], [140, 17, 42]],
      bolt: [255, 236, 236]
    }
  };
  const DEFAULT_RAMP = 'rose';

  /* ---- the bolt pattern ----
     Small bolts on a fixed on-screen lattice, alternate rows offset by half a
     step, the way Windy draws it. Kept at a constant screen size at every zoom
     so it always reads as texture, never as individual icons - and well under
     the 10.5x14 strike markers, which also carry a dark edge these do not.
     The lattice is anchored to world pixels, so it rides with the map on a pan
     rather than sliding across the surface. */
  const BOLT_H = 8;
  const BOLT_STEP_X = 16;
  const BOLT_STEP_Y = 12;           // row pitch; the tile is two rows tall
  /* How strongly the bolts show: faint at the edge, firmer in the core, so the
     pattern thickens where the strikes do. Multiplied by the edge fade. */
  const BOLT_ALPHA_LO = 0.15;
  const BOLT_ALPHA_HI = 0.31;

  const BOLT_VIEWBOX = [23, 31];
  const BOLT_PATH = 'M18.3193 0H6.95469C6.5366 0 6.16264 0.260099 6.01717 0.652067L0.0632346 16.6952C-0.179191 17.3484 0.303992 18.0431 1.00075 18.0431H10.277L7.94665 29.2503C7.73063 30.2892 9.06821 30.905 9.717 30.0653L22.3178 13.7581C22.8257 13.1008 22.3572 12.1466 21.5265 12.1466H12.9558L19.1824 1.50502C19.5725 0.838366 19.0917 0 18.3193 0Z';

  /* The canvas is drawn larger than the viewport on every side, the way
     Leaflet's own L.Canvas renderer does it. During a drag the map pane carries
     the canvas along and nothing redraws until moveend, so a viewport-sized
     canvas would run out of paint at the leading edge. */
  const PAD = 0.5;

  /* Rebuild cadence. The surface only changes as strikes enter or leave the
     hour, so it is rebuilt at most every half timeline-minute, and at most
     every MIN_REDRAW_MS of wall clock so 4x playback does not rebuild it 30
     times a second. A trailing redraw catches the final state when playback
     or a scrub stops between the two. */
  const MIN_TIMELINE_STEP = 0.5 * MINUTE;
  const MIN_REDRAW_MS = 120;

  /* ---------------------------------------------------------------- */

  const smoothstep = (a, b, x) => {
    const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };

  function lerpStops(stops, t) {
    for (let i = 1; i < STOP_POS.length; i++) {
      if (t <= STOP_POS[i]) {
        const u = (t - STOP_POS[i - 1]) / (STOP_POS[i] - STOP_POS[i - 1]);
        const a = stops[i - 1], b = stops[i];
        return a.map((v, k) => v + (b[k] - v) * u);
      }
    }
    return stops[stops.length - 1].slice();
  }

  /* 256-entry lookup from log(density) to premultiplied-ready RGBA plus the
     bolt mask alpha, so the per-cell loop is an index and four stores. */
  const LUT_SIZE = 256;
  const LOG_LO = Math.log(FADE_START);
  const LOG_HI = Math.log(RAMP_HI);

  function buildLut(ramp) {
    const rgba = new Uint8ClampedArray(LUT_SIZE * 4);
    const bolt = new Uint8ClampedArray(LUT_SIZE);
    const alphaStops = ALPHAS.map(a => [a]);
    for (let i = 0; i < LUT_SIZE; i++) {
      const v = Math.exp(LOG_LO + (LOG_HI - LOG_LO) * i / (LUT_SIZE - 1));
      const t = Math.max(0, Math.min(1, Math.log(v / RAMP_LO) / Math.log(RAMP_HI / RAMP_LO)));
      const fade = smoothstep(FADE_START, FADE_FULL, v);
      const c = lerpStops(ramp.stops, t);
      const a = lerpStops(alphaStops, t)[0] * fade;
      rgba[i * 4] = c[0]; rgba[i * 4 + 1] = c[1]; rgba[i * 4 + 2] = c[2];
      rgba[i * 4 + 3] = Math.round(a * 255);
      bolt[i] = Math.round((BOLT_ALPHA_LO + (BOLT_ALPHA_HI - BOLT_ALPHA_LO) * t) * fade * 255);
    }
    return { rgba, bolt };
  }

  function lutIndex(v) {
    if (v < FADE_START) return -1;
    const i = Math.round((Math.log(v) - LOG_LO) / (LOG_HI - LOG_LO) * (LUT_SIZE - 1));
    return i > LUT_SIZE - 1 ? LUT_SIZE - 1 : i;
  }

  /* Kernels per grid level, normalised to sum to 1 so the field stays in real
     units: one strike contributes exactly one strike's worth, spread out. */
  const kernelCache = new Map();
  function kernelFor(cellRef) {
    let k = kernelCache.get(cellRef);
    if (k) return k;
    const sigma = SIGMA_REF_PX / cellRef;
    const r = Math.max(1, Math.ceil(sigma * 2.7));
    const dx = [], dy = [], w = [];
    let sum = 0;
    for (let y = -r; y <= r; y++) {
      for (let x = -r; x <= r; x++) {
        const v = Math.exp(-(x * x + y * y) / (2 * sigma * sigma));
        if (v < 1e-4) continue;
        dx.push(x); dy.push(y); w.push(v); sum += v;
      }
    }
    k = { r, dx: Int16Array.from(dx), dy: Int16Array.from(dy),
          w: Float32Array.from(w.map(v => v / sum)) };
    kernelCache.set(cellRef, k);
    return k;
  }

  function cssGradient(name) {
    const ramp = RAMPS[name] || RAMPS[DEFAULT_RAMP];
    return 'linear-gradient(90deg, ' + ramp.stops.map((c, i) =>
      'rgba(' + c.join(',') + ',' + ALPHAS[i] + ') ' + Math.round(STOP_POS[i] * 100) + '%').join(', ') + ')';
  }

  /* ---------------------------------------------------------------- */

  function create(map, strikes) {
    const pane = map.createPane('densityPane');
    /* Above the radar (350) and the default overlay pane (400), below the
       place-name labels (shadowPane, 500) and the markers (600). */
    pane.style.zIndex = 450;
    pane.style.pointerEvents = 'none';

    const canvas = L.DomUtil.create('canvas', 'density-canvas', pane);
    const ctx = canvas.getContext('2d');

    /* Colour and bolt-mask fields, one pixel per cell, upscaled with smoothing. */
    const field = document.createElement('canvas');
    const fieldCtx = field.getContext('2d');
    const mask = document.createElement('canvas');
    const maskCtx = mask.getContext('2d');
    /* The bolt pattern is painted here, cut to the mask, then laid on top. */
    const boltLayer = document.createElement('canvas');
    const boltCtx = boltLayer.getContext('2d');

    let rampName = DEFAULT_RAMP;
    let lut = buildLut(RAMPS[rampName]);
    let pattern = null;

    let enabled = true;
    let size = null, padded = null, dpr = 1;
    let lastTime = null, lastDrawAt = 0, pendingTime = null, trailing = null;

    function buildPattern() {
      pattern = null;
      if (typeof Path2D !== 'function') return;
      const path = new Path2D(BOLT_PATH);
      const tw = BOLT_STEP_X, th = BOLT_STEP_Y * 2;
      const tile = document.createElement('canvas');
      tile.width = Math.round(tw * dpr);
      tile.height = Math.round(th * dpr);
      const tc = tile.getContext('2d');
      tc.scale(dpr, dpr);
      tc.fillStyle = 'rgb(' + RAMPS[rampName].bolt.join(',') + ')';
      const bw = BOLT_H * BOLT_VIEWBOX[0] / BOLT_VIEWBOX[1];
      /* Two bolts per tile, the second half a step across and a row down, so
         the repeat is the staggered lattice. Wrapping copies keep the one that
         straddles the tile's right edge whole. */
      const place = (cx, cy) => {
        tc.save();
        tc.translate(cx - bw / 2, cy - BOLT_H / 2);
        tc.scale(bw / BOLT_VIEWBOX[0], BOLT_H / BOLT_VIEWBOX[1]);
        tc.fill(path);
        tc.restore();
      };
      place(tw * 0.25, th * 0.25);
      place(tw * 0.75, th * 0.75);
      pattern = ctx.createPattern(tile, 'repeat');
    }

    function resize() {
      size = map.getSize();
      padded = size.multiplyBy(1 + 2 * PAD).round();
      dpr = window.devicePixelRatio || 1;
      for (const c of [canvas, boltLayer]) {
        c.width = Math.round(padded.x * dpr);
        c.height = Math.round(padded.y * dpr);
      }
      canvas.style.width = padded.x + 'px';
      canvas.style.height = padded.y + 'px';
      buildPattern();
    }

    /* First index with time >= t. */
    function lowerBound(t) {
      let lo = 0, hi = strikes.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (strikes[mid].time < t) lo = mid + 1; else hi = mid;
      }
      return lo;
    }

    function draw(t) {
      if (!size) resize();
      const topLeft = map.containerPointToLayerPoint([-PAD * size.x, -PAD * size.y]);
      L.DomUtil.setPosition(canvas, topLeft);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (!enabled) return;

      const zoom = map.getZoom();
      const scale = Math.pow(2, zoom - REF_ZOOM);          // ref-zoom px -> current px
      const level = Math.max(MIN_LEVEL, Math.min(MAX_LEVEL,
        Math.round(Math.log2(GRID_TARGET_PX / (BASE_CELL_REF_PX * scale)))));
      const cellRef = BASE_CELL_REF_PX * Math.pow(2, level);
      const cellNow = cellRef * scale;
      const K = kernelFor(cellRef);

      /* Everything below is in padded-canvas coordinates: offX/offY are the
         world-pixel position (current zoom) of the canvas's top-left corner. */
      const origin = map.getPixelOrigin();
      const offX = origin.x + topLeft.x;
      const offY = origin.y + topLeft.y;
      const gx0 = Math.floor(offX / cellNow) - 1;
      const gy0 = Math.floor(offY / cellNow) - 1;
      const gw = Math.ceil(padded.x / cellNow) + 3;
      const gh = Math.ceil(padded.y / cellNow) + 3;
      if (gw <= 0 || gh <= 0 || gw * gh > 4e6) return;

      const acc = new Float32Array(gw * gh);
      const from = lowerBound(t - WINDOW_MIN * MINUTE);
      const to = lowerBound(t + 1);
      let any = false;

      for (let i = from; i < to; i++) {
        const s = strikes[i];
        const p = map.project([s.lat, s.lon], REF_ZOOM);
        const cx = Math.floor(p.x / cellRef) - gx0;
        const cy = Math.floor(p.y / cellRef) - gy0;
        if (cx < -K.r || cy < -K.r || cx >= gw + K.r || cy >= gh + K.r) continue;

        /* Mercator stretches with latitude, so a fixed-pixel cell covers less
           ground further from the equator; cos(lat) converts it back to km. */
        const km = cellRef * METRES_PER_PX_EQ * Math.cos(s.lat * Math.PI / 180) / 1000;
        const perKm2 = 1 / (km * km);
        for (let k = 0; k < K.w.length; k++) {
          const x = cx + K.dx[k], y = cy + K.dy[k];
          if (x < 0 || y < 0 || x >= gw || y >= gh) continue;
          acc[y * gw + x] += K.w[k] * perKm2;
        }
        any = true;
      }
      if (!any) return;

      field.width = mask.width = gw;
      field.height = mask.height = gh;
      const img = fieldCtx.createImageData(gw, gh);
      const mimg = maskCtx.createImageData(gw, gh);
      const d = img.data, md = mimg.data;
      const rgba = lut.rgba, boltA = lut.bolt;
      for (let i = 0; i < acc.length; i++) {
        const li = lutIndex(acc[i]);
        if (li < 0) continue;
        const o = i * 4, lo = li * 4;
        d[o] = rgba[lo]; d[o + 1] = rgba[lo + 1]; d[o + 2] = rgba[lo + 2]; d[o + 3] = rgba[lo + 3];
        md[o + 3] = boltA[li];
      }
      fieldCtx.putImageData(img, 0, 0);
      maskCtx.putImageData(mimg, 0, 0);

      const dx = gx0 * cellNow - offX, dy = gy0 * cellNow - offY;
      const dw = gw * cellNow, dh = gh * cellNow;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(field, dx, dy, dw, dh);

      if (!pattern) return;
      /* Pattern anchored to world pixels, so the lattice rides with the map. */
      const tw = BOLT_STEP_X, th = BOLT_STEP_Y * 2;
      const ax = -(((offX % tw) + tw) % tw), ay = -(((offY % th) + th) % th);
      pattern.setTransform(new DOMMatrix([1 / dpr, 0, 0, 1 / dpr, ax, ay]));
      boltCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      boltCtx.globalCompositeOperation = 'source-over';
      boltCtx.clearRect(0, 0, padded.x, padded.y);
      boltCtx.fillStyle = pattern;
      boltCtx.fillRect(0, 0, padded.x, padded.y);
      /* Cut the pattern down to the density: its alpha is the mask's alpha. */
      boltCtx.globalCompositeOperation = 'destination-in';
      boltCtx.imageSmoothingEnabled = true;
      boltCtx.imageSmoothingQuality = 'high';
      boltCtx.drawImage(mask, dx, dy, dw, dh);
      boltCtx.globalCompositeOperation = 'source-over';

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(boltLayer, 0, 0);
    }

    function redraw() { if (lastTime !== null) draw(lastTime); }

    /* Redrawing mid-zoom would paint the previous zoom's grid onto the new
       frame for one tick, which flashes. Hide, then redraw once settled. */
    map.on('zoomstart', () => { canvas.style.visibility = 'hidden'; });
    map.on('zoomend', () => { canvas.style.visibility = ''; redraw(); });
    map.on('moveend', redraw);
    map.on('resize', () => { resize(); redraw(); });

    resize();

    return {
      update(t, force) {
        if (!force && lastTime !== null && Math.abs(t - lastTime) < MIN_TIMELINE_STEP) return;
        const now = performance.now();
        if (!force && now - lastDrawAt < MIN_REDRAW_MS) {
          pendingTime = t;
          if (!trailing) trailing = setTimeout(() => {
            trailing = null;
            if (pendingTime !== null) { lastTime = pendingTime; pendingTime = null; lastDrawAt = performance.now(); draw(lastTime); }
          }, MIN_REDRAW_MS);
          return;
        }
        pendingTime = null;
        lastTime = t;
        lastDrawAt = now;
        draw(t);
      },
      setEnabled(on) {
        enabled = on;
        canvas.style.display = on ? '' : 'none';
        if (on) redraw();
      },
      setRamp(name) {
        if (!RAMPS[name]) return;
        rampName = name;
        lut = buildLut(RAMPS[name]);
        buildPattern();
        redraw();
      }
    };
  }

  window.LightningDensity = { create, RAMPS, DEFAULT_RAMP, WINDOW_MIN, cssGradient };
})();
