# Change Log
All notable changes to this project will be documented in this file. This change
log follows the conventions of [keepachangelog.com](http://keepachangelog.com/).

## 0.0.1 - 2026-03-08

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
