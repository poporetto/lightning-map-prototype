# Lightning Map Prototype — Australia

A single-page prototype of a lightning tracker over SE Australia: a grey (or
satellite) base map, a live rain-radar overlay, and a 12-hour scrubbable /
auto-playing timeline of lightning strikes.

Open it with any static server:

```bash
python3 -m http.server 5178
```

then visit http://localhost:5178

## What's in here

| File | Purpose |
| --- | --- |
| `index.html` | Layout: map container, control panel, timeline bar |
| `styles.css` | Dark UI, marker colours, arrival + glow animations |
| `data.js` | Seeded mock strike generator |
| `app.js` | Map, radar, timeline, strike rendering |

## Strike rendering

Two strike types, drawn with the Font Awesome **bolt** path inlined as SVG so
each marker can carry its own fill and animation:

- **Cloud-to-ground** — orange-yellow, slightly larger, anchored at the bolt tip
  so it points at the ground. ~13% of strikes.
- **Cloud (intra-cloud)** — blue, smaller, centre-anchored. ~87% of strikes.

Opacity follows the strike's age **relative to the currently selected timeline
time** (not wall-clock now), so scrubbing backwards behaves the same as playing
forwards:

| Strike age | Opacity | Extra |
| --- | --- | --- |
| 0–5 min | 100% | subtle glow pulse |
| 5–15 min | 85% | — |
| 15–30 min | 65% | — |
| 30–60 min | 45% | — |
| over 60 min | hidden | — |

Because anything older than 60 minutes is hidden, only ~1/12 of the 12-hour
dataset is on screen at once (roughly 200–460 markers at the storm peak).
Markers are mounted and unmounted as that window slides, rather than all being
created up front.

A strike that arrives inside the 5-minute band gets a one-shot **arrival**
animation — it drops in from slightly above, flashes bright, and settles — then
holds the glow pulse until it ages past 5 minutes. Scrubbing into the middle of
the window does not re-flash strikes that were already old.

## Timeline

- 12 hours ending at page load, at 1-minute resolution.
- Drag the slider, or press play. Playback loops back to the start when it
  reaches the end.
- Speeds are minutes-of-data per second: 1× walks the full 12 h in about three
  minutes, so the 0–5 minute "fresh" band stays long enough to actually see the
  glow. 0.5× slows it further.
- Keyboard: **space** toggles playback, **←/→** nudge one minute.

## Rain radar

**This is not BOM's radar layer.** BOM's own map is served from
`https://api.bom.gov.au/apikey/v1/mapping/...` — an ArcGIS MapServer behind an
API key, with no CORS headers for third-party origins (fetching it cross-origin
from this prototype fails outright). There is no documented public tile endpoint
to point at.

The default source is therefore **RainViewer**, which is free, CORS-open, and
covers Australia. Its Australian composite is not verified to be BOM data. The
source lives in one config object in `app.js`:

```js
const RADAR_SOURCE = { name: '…', index: 'https://api.rainviewer.com/public/weather-maps.json' };
```

Anything that can produce `{ frames: [{ time, url }] }` drops straight in — a
BOM API key and its MapServer tile URL included, if you can obtain one.

**Known gap:** free radar history is roughly the last 2 hours at ~10-minute
spacing, which is much shorter than the 12-hour strike timeline. The radar
follows the slider inside the window it has frames for, and holds on the oldest
available frame before that. The control panel states which frames are loaded so
the mismatch is visible rather than silently faked. Full 12-hour radar history
would need an archive feed.

## Mock data

`data.js` generates strikes from seven convective cells that migrate roughly
W→E across the 12 hours, matching the reference imagery (Adelaide / Gulf St
Vincent, Kingston SE, a western Victoria front trailing into Bass Strait,
western Tasmania, inland NSW, northern SA). Each cell has an activity envelope
that ramps up, peaks, and decays, and fires Poisson bursts within it — quiet
stretches then flurries — with scatter elongated along the drift axis so cells
read as streaks rather than blobs.

The PRNG is seeded, so the data is identical on every reload. Change the seed in
`generateStrikes(endTime, seed)` for a different storm.

## Icon licence

The bolt glyph is Font Awesome Free 6.5.2. Font Awesome Free is licensed for
commercial use: **icons under CC BY 4.0**, fonts under SIL OFL 1.1, code under
MIT. CC BY 4.0 requires attribution, which is why the copyright line stays in
the comment above the path in `app.js`. The credit also belongs somewhere
user-visible in a shipped product (an about screen or a colophon is enough).

Only the path data is inlined — no Font Awesome CSS or webfont is loaded.

## Base maps

Both are key-free: **Esri Dark Gray Canvas** for the grey view (with a separate
label layer drawn above the radar so place names stay readable) and **Esri World
Imagery** for satellite.
