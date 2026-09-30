# Change Log
This file documents notable changes to this project. This change log uses the
conventions of [keepachangelog.com](http://keepachangelog.com/).

## [Unreleased]

### Fixed
- npm packages link to the repository and issues.

## [0.0.6] - 2026-09-30

### Changed
- The worker decode cache has a byte budget. Before, it had an entry count.
- `proj-wasm` 0.1.0-alpha11 and `ffi-wasm` 0.0.2, pinned exactly. semver sorts
  `0.1.0-alpha11` before `0.1.0-alpha9`, so a caret range resolves to alpha9.
- `@wcohen/wasmts` ^0.1.0-alpha7.

### Fixed
- maplibre-proj: the first `reprojectStyle` of a page could trap in proj-wasm
  ("memory access out of bounds") when proj-wasm already ran on its own pool.
  `reprojectStyle` now starts the tile workers before it builds the
  transformer, and a call that starts them ignores a passed `transformer`.

## [0.0.5] - 2026-08-26

### Added
- Bench capture and replay. `npm run bench` writes a fixture, and
  `npm run bench:replay` replays it offline. `backproj` exports the capture
  taps, which are off by default.

### Changed
- **Breaking.** One worker pool hosts the wasmts and proj handlers, and each
  tile runs phase 1, the transform and phase 2 as one call on one worker.
  `backproj/wasmts-handler` replaces `backproj/tile-worker`, and
  `TileProcessor.cleanupRequest` is removed.
- **Breaking.** `@wcohen/wasmts` (`^0.1.0-alpha6`) moves from the peer
  dependencies to the dependencies. Geometry goes to wasmts through flat
  construction, with no GeoJSON text round trip.
- `proj-wasm` ^0.1.0-alpha9, with the new dependencies `ffi-wasm` and
  `worker-router`.
- `createTileProcessor` takes an options map (`{wasmtsUrl?, poolSize?}`), and
  `reprojectTile` takes an optional `outputRequestId`.
- `shutdown()` and `shutdownTileWorkers()` return a promise that resolves when
  the teardown is complete.
- `createTileProcessor` starts proj-wasm on the shared pool. Create the
  processor first, and build the transformers after it. An earlier
  `initProj()` moves onto the pool, and a transformer built before the
  processor must be built again.
- Each worker keeps a small LRU cache of decoded input tiles.

### Removed
- The COI service worker. proj-wasm 0.1.0-alpha9 is single-threaded, so the
  demo needs no isolation headers.

## [0.0.4] - 2026-04-15

### Added
- A single-call PROJ pipeline. The forward, affine and inverse Mercator steps
  run as one `proj_create` pipeline, and a compound CRS uses two calls.
- World projections, for example Robinson, Mollweide and Eckert IV.
- A test suite and a benchmark.

### Changed
- proj-wasm ^0.1.0-alpha8 (PROJ 9.8.1).
- The inverse Mercator transform is shared.

### Fixed
- World projections had a distorted aspect ratio, because tile-local y was
  linear in latitude. It is now Mercator y.
- Geometry broke at low zoom. Features are now clipped to a 90-degree
  geographic grid before the reprojection.
- `getWorldBounds` gave an incorrect reprojected extent.

### Known limitations
- Interrupted projections, for example Goode Homolosine, are not supported.

## [0.0.3] - 2026-03-15

### Changed
- `transformCoordsF64()` is the transform engine, and `transformCoords()` calls
  it. Both are exported.
- `reprojectGeoJSON()` uses a `Float64Array` internally.
- Faster clipping. The clip envelope comes from `createEnvelope()`, a 1% buffer
  lets more features skip the intersection, and points skip `GeometryFixer`.
- `proj-wasm` is a dependency of backproj, and `backproj` is a dependency of
  maplibre-proj.

### Removed
- The standalone `reprojectTile()`. Use `createTileProcessor().reprojectTile()`.
- The `mvt.ts` module. `FetchTileFn` and `OutputFeature` come from
  `mvt-pipeline.ts`.

## [0.0.2] - 2026-03-11

### Added
- MVT reprojection through a worker pool, with input and output tile caches.
- A `tileBoundaries` option of `reprojectStyle` that draws the tile
  boundaries.
- A `__DEV__` build flag. Production builds contain no profiling code.
- The demo page shows GeoJSON and MVT layers, with a data mode selector.

### Changed
- wasmts 0.1.0-alpha4.
- The demo page loads wasmts from a CDN through an import map.

### Fixed
- A CRS change caused protocol handler errors, because the old protocol was
  removed before MapLibre was done with it.

## [0.0.1] - 2026-03-08

### Added
- `backproj`: coordinate transformation through proj-wasm, for any projected
  CRS.
  - `initProj()`, `buildTransformer(crs)`, `transformCoords()`,
    `transformPoint()` and `getWorldBounds()`.
  - `reprojectGeoJSON()` reprojects a GeoJSON FeatureCollection.
  - A CRS can be an EPSG or ESRI code, a PROJ string, WKT or PROJJSON.
    Geographic CRSs and interrupted projections are rejected.
  - Coordinates that cross the antimeridian or are not finite are filtered
    for each ring.
- `maplibre-proj`: `reprojectStyle()` reprojects the inline GeoJSON sources of
  a MapLibre style, and returns Mercator bounds for `fitBounds()`.
- A demo page (`docs/index.html`) with a CRS picker and GeoJSON layer
  controls.

[Unreleased]: https://github.com/willcohen/backproj/compare/0.0.6...HEAD
[0.0.6]: https://github.com/willcohen/backproj/compare/0.0.5...0.0.6
[0.0.5]: https://github.com/willcohen/backproj/compare/0.0.4...0.0.5
[0.0.4]: https://github.com/willcohen/backproj/compare/0.0.3...0.0.4
[0.0.3]: https://github.com/willcohen/backproj/compare/0.0.2...0.0.3
[0.0.2]: https://github.com/willcohen/backproj/compare/0.0.1...0.0.2
[0.0.1]: https://github.com/willcohen/backproj/tree/0.0.1
