# Lightning Map Prototype — Australia

A single-page prototype of a lightning tracker over SE Australia: a grey (or
satellite) base map, a live rain-radar overlay, and a 12-hour scrubbable /
auto-playing timeline of lightning strikes.

Open it with any static server:

```bash
python3 -m http.server 5178 --directory docs
```

then visit http://localhost:5178

## What's in here

| File | Purpose |
| --- | --- |
| `docs/index.html` | Layout: map container, control panel, timeline bar |
| `docs/styles.css` | Dark UI, marker colours, arrival animation |
| `docs/data.js` | Seeded mock strike generator |
| `docs/app.js` | Map, radar, timeline, strike rendering |
| `docs/icon-options.html` | Throwaway: intra-cloud glyph comparison |
| `docs/strike-animations.html` | Throwaway: new-strike animation comparison |
| `docs/halo-vs-opacity.html` | Throwaway: static halo vs opacity-only comparison |

Everything lives in `docs/` so GitHub Pages can serve it directly — set
**Settings → Pages → Source** to *Deploy from a branch*, branch `main`, folder
`/docs`. There is no build step; the files in `docs/` are the source. `.nojekyll`
stops Pages running the files through Jekyll.

## Strike rendering

Two strike types, drawn with the Font Awesome **bolt** path inlined as SVG so
each marker can carry its own fill and animation:

- **Cloud-to-ground** — orange-yellow, slightly larger, anchored at the bolt tip
  so it points at the ground. ~13% of strikes.
- **Cloud (intra-cloud)** — blue, smaller, centre-anchored. ~87% of strikes.

Opacity follows the strike's age **relative to the currently selected timeline
time** (not wall-clock now), so scrubbing backwards behaves the same as playing
forwards. The spec's four steps are kept as anchor points, but the value is
interpolated between them so a strike fades continuously as the timeline moves
rather than snapping down in four jumps:

| Strike age | Opacity |
| --- | --- |
| 0–5 min | 100% |
| 15 min | 85% |
| 30 min | 65% |
| 60 min | 45% |
| over 60 min | hidden |

Each anchor is hit exactly at its own boundary; ages in between are linear and
quantised to 1%, which keeps a marker from being restyled on every frame. Ages
below zero — strikes in the future relative to the playhead — are hidden too.

Because anything older than 60 minutes is hidden, only a fraction of the
12-hour dataset is on screen at once (roughly 500–650 markers at the storm
peak). Markers are mounted and unmounted as that window slides, rather than all
being created up front.

## The arrival animation

A strike animates **only on the step of the timeline it actually lands on** —
the newest timestamp — not for as long as it is young. Over about 2.9 seconds a
ring expands outward from the strike point (its motion is far larger than the
glyph, so it reads even where the marker is buried under neighbours), while the
bolt drops a few pixels into place, white-hot, and cools to its type colour.

Once it has played out the marker is plain again, carrying nothing but its age
opacity. Every keyframe ends on the marker's resting appearance, so dropping the
class at the end is invisible.

The animation is pure CSS — four `@keyframes` rules in `styles.css`. JavaScript
only adds a class on arrival and removes it on `animationend`; it never touches
transforms, filters or colours. Opacity is the one thing JS must set directly,
since it is a function of where the playhead is and CSS has no way to know that.

Two details that keep it honest:

- The drop is applied to the `<svg>` rather than the marker wrapper, so the ring
  stays pinned to the strike point instead of being dragged down with the glyph.
  Each type scales from the point it actually hits — the tip for
  cloud-to-ground, the centre for intra-cloud — so the strike location holds
  still while the glyph grows.
- The animation removes its own class on `animationend` rather than being
  cancelled when the strike ages, so it can never be cut off mid-flash.
  `prefers-reduced-motion` skips it entirely.

Scrubbing the slider more than five minutes at a time suppresses arrivals: a
jump mounts a whole backlog at once, and hundreds of simultaneous rings would be
noise rather than information.

## Strike colours

Three palettes, switchable from the panel. They only change CSS custom
properties, so every marker already on the map repaints instantly with no
re-render.

| Scheme | Cloud-to-ground | Cloud (intra-cloud) |
| --- | --- | --- |
| Orange & blue *(default)* | `#ffb020` | `#4da6ff` |
| Orange & purple | `#ffb020` | `#a06bff` |
| Hot & muted | `#ffc233` | `#7fb3d5` |

Violet sits nearly opposite orange on the wheel, so **orange & purple** separates
the two types further than blue manages, and it carries an electrical-discharge
association that suits intra-cloud.

**Hot & muted** is deliberately unequal rather than a third colour pairing.
Cloud-to-ground runs hotter and brighter while intra-cloud drops to a muted
steel that recedes. Intra-cloud is ~87% of strikes and cloud-to-ground is the
one that matters on the ground, so this palette spends its contrast where the
significance is instead of splitting it evenly. It is the best of the three at
storm density; the other two are easier to read as two equal categories.

The strike-age swatches in the legend show both types as solid bars at each
opacity step — no gradient, since the ramp encodes opacity only and blending the
two type colours would imply a scale between them.

## Timeline

- Pinned to **08:00–20:00 today**, at 1-minute resolution, so the timeline reads
  the same whenever the page is opened rather than trailing the clock.
- **Autoplays on load**, opening 15 minutes into the window (`OPEN_AT_MIN`).
  Drag the slider or hit pause to take over; playback loops back to 08:00 when
  it reaches the end.
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

The map opens on Sydney at zoom 8 and autoplays from the start of the window.

`data.js` generates strikes from eight convective cells that migrate roughly
W→E across the 12 hours, matching the reference imagery (Adelaide / Gulf St
Vincent, Kingston SE, a western Victoria front trailing into Bass Strait,
western Tasmania, inland NSW, northern SA), plus a cell building over the Blue
Mountains and running east across the Sydney basin — the classic summer pattern
there, and what the default view is looking at.

Every cell's activity envelope is randomised except the Sydney one, whose peak
and width are pinned to a wide envelope centred mid-window. Playback starts at
08:00 and can be dragged to 20:00, so that cell needs to have something to show
at both ends rather than only at its peak. Both random draws still happen for
it, so overriding them cannot shift the sequence for the other cells.

Note that the opening is sparse by construction: nothing exists behind the
window start, so the trailing hour of strikes has to accumulate before the map
looks busy. `OPEN_AT_MIN` starts playback 15 minutes in, which is still only a
handful of strikes; the view fills out within about 15 seconds of playback at
1&times;. Raise `OPEN_AT_MIN` if you want it to open mid-storm instead. Each cell has an activity envelope
that ramps up, peaks, and decays, and fires Poisson bursts within it — quiet
stretches then flurries — with scatter elongated along the drift axis so cells
read as streaks rather than blobs.

The PRNG is seeded, so the data is identical on every reload. Change the seed in
`generateStrikes(endTime, seed)` for a different storm.

## Icon licence

None to observe. The bolt is original artwork supplied for this project —
`lightning.svg` in the repo root is the source of truth, and its path is inlined
into `BOLT_PATH`. No icon set is involved and nothing needs attributing.

The export's hardcoded `fill="#FFD426"` is deliberately dropped when the path is
inlined. Markers take their fill, rim stroke and the white-hot arrival flash from
CSS custom properties, so a baked-in colour would break both the palette switcher
and the arrival animation.

This replaced Font Awesome. FA Free is fine for commercial use, but its icons are
CC BY 4.0, which requires attribution — and the popular alternatives only lighten
that: Bootstrap Icons, Lucide, Tabler and Heroicons are MIT or ISC, which still
require the copyright notice to be preserved. Genuinely obligation-free means CC0
or your own artwork.

`icon-options.html` still shows Font Awesome glyphs with their copyright line
intact — it is a comparison artifact, not shipped code.

## Base maps

Both are key-free: **Esri Dark Gray Canvas** for the grey view (with a separate
label layer drawn above the radar so place names stay readable) and **Esri World
Imagery** for satellite.
