# Change Log

## [0.0.3] - 2026-03-15

### Changed
- `transformCoordsF64()` is now the sole transform engine; `transformCoords()` delegates to it. Both are exported.
- `reprojectGeoJSON()` uses `Float64Array` internally, eliminating intermediate `[number,number][]` allocations
- Clip envelope built via `createEnvelope()`/`toGeometry()` instead of GeoJSONReader parse
- Clip fully-inside check expanded with 1% buffer to skip more geometric intersections
- Validity repair (`GeometryFixer.fix`) skipped for point geometries
- Finer-grained profiling breakdown (isValid vs fixRepair, geojsonRead/Write, densify ratio)
- Made `proj-wasm` a dependency of backproj, made `backproj` a dependency of maplibre-proj

### Removed
- `reprojectTile()` standalone function — use `createTileProcessor().reprojectTile()` instead
- `mvt.ts` module removed; `FetchTileFn` and `OutputFeature` types now exported from `mvt-pipeline.ts`

## [0.0.2] - 2026-03-11

### Added
- MVT reprojection via worker pool with input/output tile caching
- Demo page shows both GeoJSON and MVT layers with data mode selector
- Debug tile boundary overlay via `reprojectStyle` `tileBoundaries` option
- `__DEV__` build split: prod builds eliminate all profiling code

### Fixed
- Protocol handler errors on CRS change (stale protocol removed before MapLibre finished with it)

### Changed
- wasmts dependency updated to 0.1.0-alpha4
- Demo page loads wasmts from CDN via import map instead of local script tag

## [0.0.1] - 2026-03-08

### Added
- `backproj` core package: projection-agnostic coordinate transformation via proj-wasm
  - `initProj()`, `buildTransformer(crs)`, `transformCoords()`, `transformPoint()`, `getWorldBounds()`
  - `reprojectGeoJSON()` for batch reprojection of GeoJSON FeatureCollections
  - Accepts EPSG/ESRI codes, PROJ strings, WKT, PROJJSON
  - Rejects geographic CRS and interrupted projections at build time
  - Antimeridian-crossing and non-finite coordinate filtering (per-ring, handles MultiPolygon correctly)
- `maplibre-proj` wrapper package: `reprojectStyle()` reprojects all inline GeoJSON sources in a MapLibre style and returns fake Mercator bounds for `fitBounds()`
- npm workspaces monorepo structure
- Browser demo page (`docs/index.html`)
  - CRS selector with searchable PROJ database browser and manual input mode (PROJ strings, WKT, .prj upload)
  - GeoJSON layer management: add by URL, upload file, remove, per-layer color/opacity
  - Default layers: Natural Earth 110m land, graticules, and countries
  - coi-serviceworker for SharedArrayBuffer on static hosting

[Unreleased]: https://github.com/willcohen/backproj/compare/0.0.3...HEAD
[0.0.3]: https://github.com/willcohen/backproj/compare/0.0.2...0.0.3
[0.0.2]: https://github.com/willcohen/backproj/compare/0.0.1...0.0.2
[0.0.1]: https://github.com/willcohen/backproj/compare/0.0.1
