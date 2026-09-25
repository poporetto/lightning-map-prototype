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
| `docs/density.js` | Strike-density surface: the kernel estimate, the ramp and the bolt texture |
| `docs/icon-options.html` | Throwaway: intra-cloud glyph comparison |
| `docs/strike-animations.html` | Throwaway: new-strike animation comparison |
| `docs/halo-vs-opacity.html` | Throwaway: static halo vs opacity-only comparison |
| `docs/icons/` | The map's icon files — one SVG per palette colour, plus the flash mask |
| `docs/strike-icons/` | Standalone handoff pack: the two strike types, its own CSS and demo |

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
| 15 min | 72% |
| 22 min | 45% |
| 30 min | 0% |
| over 30 min | hidden |

Each anchor is hit exactly at its own boundary; ages in between are linear and
quantised to 1%, which keeps a marker from being restyled on every frame. Ages
below zero — strikes in the future relative to the playhead — are hidden too.

The last stop is zero rather than a floor, so a strike fades out completely
instead of dimming to 45% and then popping out of existence at the boundary.

Because anything older than 30 minutes is hidden, only a fraction of the
12-hour dataset is on screen at once (around 370 markers at the storm peak).
Markers are mounted and unmounted as that window slides, rather than all being
created up front.

## Strike density

Under the markers sits a **density surface**: a kernel-density estimate of the
last **60 minutes** of strikes, shaded light where few strikes have landed and
dark where many. It deliberately looks back further than the markers do — they
clear at 30 minutes, so the surface still shows where a storm has been after its
individual strikes have gone. Toggle it from the control panel.

It is not flat colour. Over it sits a **fine pattern of small bolts**, in the
manner of Windy's lightning layer: 8 px bolts on a 16 × 12 px lattice with
alternate rows offset by half a step, so it reads as texture rather than as a
grid of icons. The bolts stay the same size on screen at every zoom, and the
lattice is anchored to world pixels, so it rides with the map on a pan rather
than sliding across the surface. The pattern is cut to the density field itself:
it fades in at the edge of the surface with the colour and grows firmer toward
the core (15% up to 31% opacity), so the texture thickens where the strikes do.
The bolts are a near-white tint of the ramp's hue and carry no dark edge, which
keeps them from being mistaken for the 10.5 × 14 strike markers above them.
**Bolt pattern** in the panel turns the pattern off and leaves the colour
surface; it goes inert while the density surface itself is off.

Five decisions here were made against measurements rather than by eye, because
the obvious version of each is wrong:

**The grid is fixed in geography, not in screen pixels.** A screen-pixel grid
seems natural — constant cell size on screen at every zoom — but strikes per km²
is then not zoom-invariant: zoom in far enough and almost every occupied cell
holds exactly one strike while its area keeps shrinking by 4× a level, so the
same data reads an order of magnitude denser. Measured on this generator, the
median rate climbed from 6e-4 at z6 to 8e-2 at z10. Pinning the grid to a
reference zoom makes density a property of the data, so one set of thresholds
holds everywhere and the legend means something.

**Strikes are smoothed, not hard-binned.** Hard bins are too sparse to shade: at
14 km cells three quarters of occupied cells held exactly one strike and the
busiest held eight, which paints a near-binary map, and widening to 49 km only
moved the median to 1.9. A Gaussian kernel spreads each strike over ~12 km and
yields a continuous field across three orders of magnitude.

**Colour is continuous, not banded.** The first version snapped the field to
five flat bands and switched alpha on at a threshold; upscaled, both showed as
stair-stepped contours and a hard, pixelated rim. The field now maps through a
256-entry interpolated ramp on a log scale, alpha fades in over a range
(1.1e-3 → 1.9e-3) instead of switching on, and the grid is resampled per zoom in
powers of two so a cell stays around 4 px on screen — fine enough that bilinear
upscaling leaves nothing to see, coarse enough that a zoomed-out view is not a
million cells. Coarser cells change nothing about the values, since the field is
per km² and the kernel is sized in km. A rebuild takes about 1 ms at any zoom.

**The floor sits just above a lone strike.** A single strike peaks at 1.08e-3 at
the centre of its own kernel, so any floor below that paints one strike on its
own — wrong twice over: one strike is not a density, and its two-or-three-cell
blob upscales into a visible hard-edged square adrift in empty map. The floor is
set above that peak, so it takes at least two strikes close together to shade a
cell at all, and the surface means "repeated activity" rather than "something
happened here once". The fade starts there too, so lone strikes stay bare.

**Each ramp is solved against composited luminance over the basemap.** Three
things went wrong when the first one was picked by eye:

- *Alpha must not climb steeply with density.* Over a dark basemap a low alpha
  drags the pale end back toward the background: the first attempt composited
  its first two steps to L=0.154 and L=0.151 — a 2% step, invisible.
- *The dark end must stop short of black.* A near-black plum measured 0.93× the
  basemap's own luminance, i.e. it vanished into it. The darkest stop sits at
  1.28× instead and separates by chroma, reading as a deep colour rather than as
  a hole punched in the map.
- *The light end cannot actually be light.* Solving for a genuinely pale stop
  forced either alpha high enough to bury the basemap or a colour so close to
  white it collided with the white arrival flash — the solver landed on
  `#fbf9f9`. So the range is modest and chroma carries much of the ramp.

Every ramp is solved to the same five luminance targets (steps of
23/24/27/31%), so they differ in hue only, never in how strongly they read, and
the palest stop still contrasts 4.8:1 against a white flash on top of it. Four
are offered from **Density colours** in the panel, for comparison:

| Ramp | Hue clearance from CG orange / IC blue | Notes |
| --- | --- | --- |
| Rose *(default)* | 74° / 75° | Even clearance from both strike colours |
| Teal | 115° / 51° | The Windy look; closest to IC blue, so faded CC markers blend most |
| Emerald | 74° / 111° | Widest clearance overall, but reads as vegetation on satellite |
| Crimson | 52° / 107° | Closest to CG orange, and reads as a warning |

Clearance is the CIELAB hue angle between the ramp's deeper stops and each
strike colour. Indigo was also solved and dropped, at 29° from IC blue.

The surface is rebuilt at most every half timeline-minute, since it only changes
as strikes enter or leave the hour, and at most every 120 ms of wall clock so 4×
playback does not rebuild it 30 times a second; a trailing redraw catches the
final state when playback or a scrub stops in between. The canvas is drawn half
a viewport larger than the map on every side, as Leaflet's own canvas renderer
does, so a drag never runs out of paint before `moveend` redraws it.

The legend gradient is generated from the same ramp the canvas paints from, so
the two cannot drift apart.

## New strikes: white, then colour

A strike animates **only on the step of the timeline it actually lands on** —
the newest timestamp — not for as long as it is young. Over about 1.5 seconds at
1× the bolt drops a few pixels into place **white-hot, and cools to its type
colour** — orange for cloud-to-ground, blue for cloud-to-cloud.

The glyph's own colour lives inside the SVG file and cannot be animated, so the
white is a separate layer masked to the glyph's silhouette, sitting on top and
fading off to reveal the colour underneath.

There is no halo and no ring: nothing radiates from the strike. Strikes carry a
tight dark drop shadow and nothing else —
which matters more than it used to, since it is what separates a bolt from the
density surface painted underneath it.

**The arrival is scaled to playback speed.** It runs in wall-clock seconds while
a strike's life is measured in timeline minutes, so fast playback would outrun
it: at 4× a strike exists for 30 ÷ (4 × 4) ≈ 1.9 s, and an unscaled arrival is
1.5 s, so strikes would barely finish cooling before they faded. `app.js` sets a
`--arrive-scale` custom property to 1/speed and every duration in the sequence
is expressed against it, which holds the arrival at a constant ~20% of a
strike's visible life at every speed.

The animation is pure CSS — two `@keyframes` rules in `styles.css`. JavaScript
only adds a class on arrival and removes it on `animationend`; it never touches
transforms, filters or colours. The removal keys on the white-to-colour flash,
which is both the longest part of the arrival and the only one that still runs
under `prefers-reduced-motion`. Opacity is the one thing JS must set directly,
since it is a function of where the playhead is and CSS has no way to know that.

Two details that keep it honest:

- Each type scales from the point it actually hits — the tip for
  cloud-to-ground, the centre for intra-cloud — so the strike location holds
  still while the glyph grows.
- The animation removes its own class on `animationend` rather than being
  cancelled when the strike ages, so it can never be cut off mid-flash.
  `prefers-reduced-motion` skips the drop but keeps the white-to-colour flash.

Scrubbing the slider more than five minutes at a time suppresses arrivals: a
jump mounts a whole backlog at once, and hundreds of simultaneous white flashes
would be noise rather than information.

## Strike colours

Fixed: orange `#ffb020` for cloud-to-ground and blue `#4da6ff` for
cloud-to-cloud. The strike-colour picker has been removed. The icon files for the
other two earlier palettes are still in `docs/icons/`, unused by the map.

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
  minutes. 0.5× slows it further.
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
`lightning.svg` in the repo root is the source shape. No icon set is involved and
nothing needs attributing.

Markers reference the recoloured copies in `docs/icons/` as `<img>`, not as
inlined SVG. That is a deliberate constraint, and it costs two things:

- **Recolouring means swapping the file.** CSS cannot reach the path inside an
  `<img>`, so a new strike colour means a new SVG. The map now uses one fixed
  pair, so this only matters if the colours change again.
- **The white-hot arrival flash is a separate layer.** It is a solid white block
  clipped to the glyph's silhouette by `lightning-mask.svg`, sitting inside the
  same wrapper as the `<img>` so the drop animation carries both together.

The drop shadow is unaffected — `drop-shadow` follows an image's alpha
channel, so it traces the bolt outline exactly as it did with inline SVG.

`docs/strike-icons/` is a separate, self-contained handoff pack carrying only
orange and blue. The map keeps its own set in `docs/icons/` (still including the
two retired palettes' files); the two orange/blue files are duplicated
between them, so a change to the artwork needs applying in both.

> **The pack has not been updated for the density work and now describes the
> older behaviour.** Its CSS still ships the `.strike-fresh` halo, the
> `strike-bloom` keyframes, the arrival ring and 15×20 markers, none of which the map uses any
> more. The artwork itself is unchanged and still correct; only the surrounding
> CSS has diverged. It is left as-is deliberately rather than half-migrated —
> sync it as its own change when the handoff next matters.

A type class (`.strike-cloud-to-ground` / `.strike-cloud-to-cloud`) is still
required even though the body colour now comes from the file. It sets which
point the icon anchors to and scales from.

Classes and icon filenames name the **strike type**, not the colour, since a
colour can change while the type does not. Map icons are
`<type>-<palette>.svg`; the pack ships one file per type.

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
