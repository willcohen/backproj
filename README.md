# backproj

**[Live Demo](https://willcohen.github.io/backproj/)**

Display any map projection in a web map. Projection math powered by [proj-wasm](https://www.npmjs.com/package/proj-wasm) (PROJ 9 transpiled to WebAssembly).

## EARLY DEVELOPMENT

This project is in its initial phases. APIs and package structure may
change substantially. Currently supports GeoJSON and vector tile
reprojection for both regional CRS (state plane, UTM, national grids)
and global projections (Robinson, Mollweide, Eckert IV, etc.). Vector
tile support covers MVT (Mapbox Vector Tiles); MLT (MapLibre Tiles)
support is pending.

Interrupted projections (Goode Homolosine, etc.) are not yet supported.

## Packages

This is an npm workspaces monorepo with two packages:

### `backproj` — core reprojection engine

Projection-agnostic coordinate transformation. No map renderer dependency.

```bash
npm install backproj
```

Depends on `@wcohen/wasmts` (`^0.1.0-alpha6`) for vector tile reprojection; it is
a regular dependency, not a peer, so it installs with the package.

```typescript
import { initProj, buildTransformer, transformCoords, reprojectGeoJSON } from 'backproj';

await initProj();
const transformer = await buildTransformer('EPSG:5070'); // NAD83 / Conus Albers

// Transform individual coordinates
const fakeCoords = await transformCoords([[0, 51.5], [-73.9, 40.7]], transformer);

// Reproject an entire GeoJSON FeatureCollection
const reprojected = await reprojectGeoJSON(featureCollection, transformer);
```

#### API

| Function | Description |
|---|---|
| `initProj()` | Initialize proj-wasm. Only for use without a tile processor; `createTileProcessor` initializes proj-wasm itself, and transformers for tile work must be built after the processor. |
| `buildTransformer(crs)` | Compile a transformer for any projected CRS. Accepts EPSG/ESRI codes, PROJ strings, WKT, or PROJJSON. |
| `transformCoords(coords, transformer)` | Batch transform `[lon, lat][]` to fake `[lon, lat][]` for Mercator rendering. |
| `transformPoint(coord, transformer)` | Single-point convenience wrapper. |
| `getWorldBounds(transformer)` | Fake bounding box for `map.fitBounds()`. |
| `reprojectGeoJSON(fc, transformer)` | Reproject a GeoJSON FeatureCollection. Returns a deep copy. |
| `createTileProcessor(opts?)` | Create the shared worker pool for vector tile reprojection. Accepts a `wasmtsUrl` string or an options object. Requires `@wcohen/wasmts`. |
| `createTileCache(opts?)` | LRU cache for fetched Mercator tile PBFs. |

### `maplibre-proj` — MapLibre GL JS integration

Thin wrapper that reprojects a MapLibre style for display in any projection.

```bash
npm install maplibre-proj
```

Peer dependencies: `maplibre-gl` (>=5.0.0), `@wcohen/wasmts` (>=0.1.0-alpha6)

```typescript
import { Map as MapGL } from 'maplibre-gl';
import { reprojectStyle } from 'maplibre-proj';

const { style, bounds } = await reprojectStyle({
  style: { version: 8, sources: { ... }, layers: [ ... ] },
  crs: 'EPSG:5070',
});

const map = new MapGL({
  container: 'map',
  style,
  projection: { type: 'mercator' },
  renderWorldCopies: false,
});
map.fitBounds(bounds, { animate: false });
```

`reprojectStyle` reprojects inline GeoJSON source data and rewires vector tile sources through a reprojection pipeline (worker pool + wasmts geometry engine). The returned style uses Mercator internally with fake coordinates that produce the target projection visually.

## How it works

MapLibre renders everything in Web Mercator. To display another projection, coordinates are pre-warped so that when the Mercator renderer places a vertex on screen, it lands at the correct position for the target projection.

```
real lon/lat  ->  [target projection]  ->  scale to Mercator range  ->  [inv Mercator]  ->  fake lon/lat
```

For each point:
1. Forward-project through the target CRS via proj-wasm (lon/lat to metres)
2. Scale from the projection's native extent into the Web Mercator extent
3. Inverse-project through Mercator back to fake lon/lat

When the CRS coordoperation is available, all three steps collapse into a single
PROJ pipeline (`proj_create`), executing as one WASM call. Falls back to two WASM
calls + JS arithmetic for compound CRS. This is an implementation of the
["dirty reprojectors"](https://medium.com/devseed/dirty-reprojectors-1df66e8f308d)
technique originally described by
[Development Seed](https://github.com/developmentseed/dirty-reprojectors) in 2016.

Real coordinates are replaced by fake WGS-84 values after warping. `map.project()` and popup positions operate in fake space. Globe mode must be off (Mercator rendering is used internally).

## Supported CRS

Any CRS string that PROJ understands: EPSG codes, ESRI codes, PROJ strings, WKT2, WKT1, PROJJSON.

Rejected inputs:
- Geographic CRS (EPSG:4326, `+proj=longlat`) -- detected and rejected at build time

Unsupported (not rejected, but will produce visual artifacts):
- Interrupted projections (e.g. Goode Homolosine)

## Demo

A live demo page is at `docs/index.html`. It loads Natural Earth GeoJSON data and lets you switch between any projected CRS from the PROJ database or enter a custom CRS string.

```bash
npm install
npm run build --workspaces
npx serve .
# open http://localhost:3000/docs/
```

## Development

```bash
npm install
npm run build --workspaces   # esbuild -> dist/ in each package
npm run check --workspaces   # TypeScript type checking
npm test                     # pipeline smoke test + integration test
```

Build order matters: `backproj` must build before `maplibre-proj` (type dependency).

### Benchmarking

Two paths, measuring different things:

```bash
# Live (Playwright + MapLibre + real network). Multi-minute, end-to-end.
# An integration check, not a benchmark: it does not gate on timings, because
# network variance swamps them. Side-effect: writes a ScenarioFixture to
# fixtures/<scenario_name>/ for the replay path below.
npm run bench

# Replay (offline, no map, no network). Drives TileProcessor against a
# captured fixture; mitata-shaped per-phase stats. Fast inner-loop for
# transform-code iteration, and the only reproducible timing source here.
npm run bench:replay -- --fixture fixtures/EPSG2249              # default lru
npm run bench:replay -- --fixture fixtures/EPSG2249 --cache cold # no-locality variant
npm run bench:replay -- --fixture fixtures/EPSG2249 --concurrency 1   # real per-tile work

# Build-vs-build. The only comparison that cannot run in-process: two wasm
# builds both install to globalThis.wasmts, so they cannot share a page.
npm run bench:replay:compare a.json b.json                        # warns: see below
npm run bench:replay:compare a1.json,a2.json b1.json,b2.json      # mirrored + paired
```

Timing methodology, learned the hard way: a developer box benchmarks the *same
code* 13-25% apart depending on ambient load, so **one report per side cannot
resolve anything smaller than that** and `bench:replay:compare` says so rather
than pretending. Run the two builds mirrored — `A1 B1 B2 A2` — and pass
`a1,a2 b1,b2`; the tool pairs by index, and because each pair is adjacent in
time the drift cancels. It also reports how many pairs agree with the mean's
sign, since a mean that only half the pairs agree with is a coin flip.

The gate metric is pass wall time. Per-tile figures (`total_ms`, `phase1_ms`,
`transform_coords_ms`) are diagnostic only: replay dispatches every tile at
once and worker calls run serially, so each tile's clock spans most of the
whole pass and those numbers track queueing rather than work. Use
`--concurrency 1` when you want real per-tile work.

Replay refuses to run against a stale fixture (waypoints hash, scenario name, or tile source URL drifted from current `scenarios.json`). Manifest version-vector mismatch between two replay reports causes the comparison to skip cleanly with exit 0. See `--help` on each script for the full flag set.

`npm run test:bench` runs the bench-side test suite in pure Node: capture state, replay validation, fixture / report shape, and the comparison CLI. Two paths still rely on manual smoke testing rather than CI assertions — the live capture happy path and replay determinism — because both require real Playwright runs costing minutes apiece. Either could be promoted behind a `SLOW_TESTS=1` env opt-in if drift becomes an issue.

#### Stats shape

Live and replay benchmark reports use different per-phase stats shapes by design.

- Live `BenchmarkReport` carries `StageStats` (`min`, `max`, `mean`, `p50`, `p95`, `count`), computed by `computeStats` inside `packages/backproj/src/profiling.ts`. The live profiler is hand-rolled and runs in the browser; backproj never imports mitata.
- Replay `ReplayBenchmarkReport` carries `MitataTrialStats` per phase (`min`, `max`, `mean`, `p50`, `p99`, `mad`, `samples`), matching the field shape of [mitata](https://github.com/evanwashere/mitata)'s public `stats` interface (MIT, copyright 2022 evanwashere; full license reproduced in `tests/bench-replay.mjs`). mitata drives per-pass iteration: `measure()` wraps the scenario-pass closure, one iteration per walk of the captured `output_requests` list, and mitata picks the warmup-plus-measurement count. Per-pass wall stats land in `replay_metadata.pass_wall_stats`. Per-phase samples come from the in-pipeline `performance.now()` taps and aggregate inside the closure, rolling their own math because `measure()` does not accept precomputed sample arrays. mitata stays a `devDependency`.

The two shapes are not unified: live measures the user-facing system end-to-end with all its variance, replay measures the pipeline in isolation. Only replay is compared. `replay-compare.mjs` gates on pass wall time and pairs mirrored report sets so drift cancels; the live bench carries no timing gate at all, because network variance swamps anything it could assert. The live-side `compare.mjs` was deleted rather than kept: it duplicated `replay-compare` at a 10% threshold, well under this box's measured run-to-run drift on identical code, which makes it a false-alarm generator.

### Dev server

```bash
node tests/server.mjs        # COEP/COOP server on :8973
# open http://localhost:8973/#profile=1&crs=EPSG:2249&data=mvt
```

## License

```
MIT License

Copyright (c) 2026 Will Cohen

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

--

This project reimplements the technique described in [dirty-reprojectors](
https://github.com/developmentseed/dirty-reprojectors) as its core functionality.

```
MIT License

Copyright (c) 2016 Development Seed

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```