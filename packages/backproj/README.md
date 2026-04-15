# backproj

Reproject geospatial data through any coordinate reference system in the
browser, using [proj-wasm](https://www.npmjs.com/package/proj-wasm)
(PROJ 9 compiled to WebAssembly).

Supports GeoJSON and vector tile reprojection with a worker pool for
performance. Currently handles MVT (Mapbox Vector Tiles); MLT (MapLibre
Tiles) support is pending. Framework-agnostic -- for MapLibre GL JS
integration, see [maplibre-proj](../maplibre-proj/).

## Install

```
npm install backproj
```

For vector tile reprojection, also install the geometry engine (peer dependency):

```
npm install @wcohen/wasmts
```

## Quick start

### GeoJSON reprojection

```typescript
import { initProj, buildTransformer, reprojectGeoJSON } from 'backproj';

await initProj();
const transformer = await buildTransformer('ESRI:54030'); // Robinson

const reprojected = await reprojectGeoJSON(featureCollection, transformer);
// reprojected contains "fake" lon/lat that renders as Robinson in Mercator
```

### Coordinate transformation

```typescript
import { initProj, buildTransformer, transformCoords, transformPoint } from 'backproj';

await initProj();
const transformer = await buildTransformer('EPSG:5070'); // NAD83 / Conus Albers

// Single point
const [fakeLon, fakeLat] = await transformPoint([-77.0, 38.9], transformer);

// Batch
const results = await transformCoords(coordArray, transformer);

// Inverse: recover real lon/lat from fake coordinates
const real = await inverseTransformCoords(fakeCoords, transformer);
```

### Vector tile reprojection (with worker pool)

```typescript
import { initProj, buildTransformer, createTileProcessor, createTileCache } from 'backproj';

await initProj();
const transformer = await buildTransformer('EPSG:5070');
const processor = await createTileProcessor(); // auto-detects wasmts URL
const cache = createTileCache();

const pbf = await processor.reprojectTile(z, x, y, transformer, fetchTile, cache);
```

## Supported CRS formats

`buildTransformer()` accepts any CRS string that PROJ understands:

- EPSG codes: `'EPSG:5070'`, `'EPSG:2249'`, `'EPSG:32632'`
- ESRI codes: `'ESRI:54030'` (Robinson), `'ESRI:54009'` (Mollweide)
- PROJ strings: `'+proj=robin +lon_0=0 +datum=WGS84 +units=m'`
- WKT2, WKT1-GDAL, ESRI WKT
- PROJJSON

Both regional CRS (state plane, UTM, national grids) and global projections
(Robinson, Mollweide, Eckert IV) are supported. Geographic CRS (e.g. `EPSG:4326`)
are rejected. Interrupted projections (e.g. Goode Homolosine) are not rejected
but will produce visual artifacts.

## Public API

### Projection engine (`proj.ts`)

| Export | Description |
|---|---|
| `initProj()` | Initialize proj-wasm. Call once before anything else. |
| `buildTransformer(crs)` | Compile a transformer for any projected CRS. |
| `buildTransformerPool(crs, n)` | Build N transformers for parallel proj-wasm dispatch. |
| `transformCoords(coords, t)` | Batch transform `[lon,lat][]` to fake coordinates. |
| `transformPoint(coord, t)` | Single-point convenience wrapper. |
| `inverseTransformCoords(fake, t)` | Recover real lon/lat from fake coordinates. |
| `inverseTransformPoint(fake, t)` | Single-point inverse. |
| `getWorldBounds(t)` | Fake bounding box for `map.fitBounds()`. |

### GeoJSON (`geojson.ts`)

| Export | Description |
|---|---|
| `reprojectGeoJSON(fc, t)` | Reproject a FeatureCollection. Returns a deep copy. |

### Vector tile worker pool (`tile-processor.ts`)

| Export | Description |
|---|---|
| `createTileProcessor(wasmtsUrl?)` | Create/return a shared worker pool. |
| `shutdownTileWorkers()` | Terminate all workers. |

### Tile math (`tiling.ts`)

| Export | Description |
|---|---|
| `fakeBoundsForTile(z, x, y)` | Output tile -> fake lon/lat bbox. |
| `outputTileToRealBounds(z, x, y, t)` | Output tile -> real WGS84 bbox. |
| `chooseInputZoom(z, realBounds)` | Select input zoom level. |
| `enumerateInputTiles(bounds, z)` | Real bbox -> list of Mercator tiles. |
| `tileLocalToLonLat(tileX, tileY, z, tx, ty)` | Tile-local integers -> real lon/lat. |

### Profiling (`profiling.ts`)

| Export | Description |
|---|---|
| `enableProfiling()` / `disableProfiling()` | Toggle timing instrumentation. |
| `printProfilingSummary()` | Console table with stage breakdown and percentile stats. |
| `exportProfilingJSON()` | Full structured data for external analysis. |
| `getProfilingData()` | Access the raw `ProfilingReport` object. |
| `clearProfilingData()` | Reset collected profiling data. |
| `setProfilingMetadata(meta)` | Set metadata (CRS, pool size) attached to profiling reports. |

### Caching (`tile-cache.ts`)

| Export | Description |
|---|---|
| `createTileCache(opts?)` | LRU cache for fetched tile PBFs. 200 MB default (overridable via `maxBytes`). |

## Build variants

Two build modes via esbuild `--define:__DEV__`:

- **`npm run build`** (prod): `__DEV__=false`. All profiling, timing
  instrumentation, and `performance.now()` calls are dead-code-eliminated.
  Prod builds are fully minified.
- **`npm run build:dev`**: `__DEV__=true`. Profiling and debug config sync
  are included. Used by the demo page for development.

## Architecture

### Transform pipeline

Coordinates flow through a three-step pipeline:

```
real lon/lat  ->  [target CRS]  ->  scale to Mercator range  ->  [inv Mercator]  ->  fake lon/lat
```

The web map renderer draws the fake lon/lat in Mercator, which visually
produces the target projection. When the CRS coordoperation is available,
all three steps collapse into a single PROJ pipeline (one WASM call).
Falls back to 2 WASM calls + JS arithmetic for compound CRS.

### Vector tile reprojection pipeline

For each output tile `(z, x, y)` requested by the map renderer:

1. **Inverse-project** the output tile's corners to find which real-world
   area it covers (skip/clamp for regional CRS area of use)
2. **Enumerate** input Mercator tiles covering that area (zoom level drops
   for heavily distorted projections)
3. **Fetch** input tiles (with LRU caching)
4. **Decode** PBFs, group feature fragments by ID across tiles
5. **Per feature**: stitch fragments -> densify -> extract coords
6. **Transform** all coordinates through the projection pipeline
7. **Per feature**: apply transformed coords -> repair -> clip -> snap to grid
8. **Encode** output PBF

Steps 4-5 and 7-8 run in Web Workers (wasmts/JTS geometry operations).
Step 6 runs on the main thread (proj-wasm cannot run inside workers).
See `tile-processor.ts` for the full data flow diagram with thread boundaries.

## License

MIT
