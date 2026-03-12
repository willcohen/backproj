# backproj

**[Live Demo](https://willcohen.github.io/backproj/)**

Display any map projection in a web map. Projection math powered by [proj-wasm](https://www.npmjs.com/package/proj-wasm) (PROJ 9 transpiled to WebAssembly).

## EARLY DEVELOPMENT

This project is in its initial phases. APIs and package structure may
change substantially. Currently supports GeoJSON and MVT reprojection.

## Packages

This is an npm workspaces monorepo with two packages:

### `backproj` — core reprojection engine

Projection-agnostic coordinate transformation. No map renderer dependency.

```bash
npm install backproj
```

Peer dependencies: `proj-wasm` (>=0.1.0-alpha7), `@wcohen/wasmts` (>=0.1.0-alpha4, for MVT reprojection)

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
| `initProj()` | Initialize proj-wasm. Call once before any other function. |
| `buildTransformer(crs)` | Compile a transformer for any projected CRS. Accepts EPSG/ESRI codes, PROJ strings, WKT, or PROJJSON. |
| `transformCoords(coords, transformer)` | Batch transform `[lon, lat][]` to fake `[lon, lat][]` for Mercator rendering. |
| `transformPoint(coord, transformer)` | Single-point convenience wrapper. |
| `getWorldBounds(transformer)` | Fake bounding box for `map.fitBounds()`. |
| `reprojectGeoJSON(fc, transformer)` | Reproject a GeoJSON FeatureCollection. Returns a deep copy. |
| `createTileProcessor(wasmtsUrl?)` | Create a worker pool for MVT reprojection. Requires `@wcohen/wasmts`. |
| `createTileCache(opts?)` | LRU cache for fetched Mercator tile PBFs. |

### `maplibre-proj` — MapLibre GL JS integration

Thin wrapper that reprojects a MapLibre style for display in any projection.

```bash
npm install maplibre-proj
```

Peer dependencies: `backproj` (>=0.0.2), `maplibre-gl` (>=5.0.0), `proj-wasm` (>=0.1.0-alpha7), `@wcohen/wasmts` (>=0.1.0-alpha4)

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

Two batch WASM calls per coordinate array, plus O(n) JS arithmetic for the scaling step. This is an implementation of the ["dirty reprojectors"](https://medium.com/devseed/dirty-reprojectors-1df66e8f308d) technique originally described by [Development Seed](https://github.com/developmentseed/dirty-reprojectors) in 2016.

Real coordinates are replaced by fake WGS-84 values after warping. `map.project()` and popup positions operate in fake space. Globe mode must be off (Mercator rendering is used internally).

## Supported CRS

Any CRS string that PROJ understands: EPSG codes, ESRI codes, PROJ strings, WKT2, WKT1, PROJJSON.

Rejected inputs:
- Geographic CRS (EPSG:4326, `+proj=longlat`) — detected and rejected at build time
- Interrupted projections (e.g. Goode Homolosine with interruptions) — rejected when <10% of sampled points produce finite output

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
```

Build order matters: `backproj` must build before `maplibre-proj` (type dependency).

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

--

The browser demo uses [coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker)
for SharedArrayBuffer support on static hosting, which is distributed under the MIT license:

```
MIT License

Copyright (c) 2021 Guido Zuidhof

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