# maplibre-proj

Display [MapLibre GL JS](https://maplibre.org/) maps in any coordinate
reference system. Wraps [backproj](../backproj/) to handle GeoJSON
reprojection and MVT tile reprojection via protocol handlers.

## Install

```
npm install maplibre-proj backproj proj-wasm maplibre-gl
```

For MVT reprojection (vector tile sources), also install:

```
npm install @wcohen/wasmts
```

## Usage

```typescript
import { Map } from 'maplibre-gl';
import { reprojectStyle } from 'maplibre-proj';

const map = new Map({
  container: 'map',
  style: myStyle,
  projection: { type: 'mercator' },
  renderWorldCopies: false,
});

const { style, bounds, transformer, cleanup } = await reprojectStyle({
  style: myStyle,
  crs: 'EPSG:5070',  // NAD83 / Conus Albers
});

map.setStyle(style);
map.fitBounds(bounds);

// Later, to change projection:
cleanup();  // removes protocol handlers
const result2 = await reprojectStyle({
  style: myStyle,
  crs: 'ESRI:54030',  // Robinson
});
map.setStyle(result2.style);
map.fitBounds(result2.bounds);
```

### Reusing transformers

Building a transformer is expensive (samples the projection to compute
scale factors). When calling `reprojectStyle` repeatedly for the same CRS
(e.g. toggling layers), pass the existing transformer to skip rebuilding:

```typescript
const { style, bounds, transformer } = await reprojectStyle({
  style: newStyle,
  crs: 'EPSG:5070',
  transformer: existingTransformer,  // reuse
});
```

### MVT vector tiles

Vector tile sources in the style are automatically handled. The source's
tile URLs are rewritten to a custom protocol handler that:

1. Intercepts MapLibre's tile requests
2. Fetches the necessary input Mercator tiles
3. Runs them through backproj's MVT reprojection pipeline (worker pool)
4. Returns reprojected PBF data

This requires `@wcohen/wasmts` to be loadable at runtime. Either:

```html
<!-- Script tag (detected by src containing "wasmts") -->
<script src="./node_modules/@wcohen/wasmts/dist/wasmts.js"></script>

<!-- Or import map -->
<script type="importmap">
{ "imports": { "@wcohen/wasmts": "./node_modules/@wcohen/wasmts/dist/wasmts.js" } }
</script>
```

The WASM file must be available alongside the JS entry point.

## Public API

### `reprojectStyle(options)`

```typescript
reprojectStyle(options: {
  style: StyleSpecification;
  crs: string;
  transformer?: Transformer;
  tileBoundaries?: boolean;
}): Promise<ReprojectResult>
```

When `tileBoundaries: true`, debug overlay layers are added to the returned
style showing output tile borders (red dashed), input tile borders (blue
dashed), and tile coordinate labels.

Returns:

| Field | Type | Description |
|---|---|---|
| `style` | `StyleSpecification` | New style with reprojected sources. |
| `bounds` | `[[number, number], [number, number]]` | Fake bounds for `map.fitBounds()`. |
| `maxBounds` | `[[number, number], [number, number]] \| undefined` | Padded area-of-use for `map.setMaxBounds()`. Regional CRS only. |
| `transformer` | `Transformer` | Compiled transformer (pass back to reuse). |
| `cleanup` | `() => void` | Call to remove registered protocol handlers. |

### `shutdownTileWorkers()`

Terminate the shared worker pool. Call when the map is destroyed.

### Caching and protocol reuse

`reprojectStyle` maintains stable protocol handlers across calls for the
same CRS. When you call it again with the same CRS (e.g. to toggle tile
boundaries or change data mode), protocol handlers are reused rather than
torn down and recreated. This preserves the output tile cache -- reprojected
tiles from the previous call remain available immediately.

Cleanup only tears down protocols on a CRS change (different `crs` value)
or when `cleanup()` is called explicitly.

There are two cache layers:
- **Input tile cache**: LRU cache of fetched Mercator PBFs, shared across
  all output tiles (via `createTileCache` in backproj)
- **Output tile cache**: Reprojected PBF results cached by the stable
  protocol handler, so repeated requests for the same output tile skip
  the reprojection pipeline entirely

## Requirements

- `renderWorldCopies: false` on the Map constructor -- the fake coordinate space does not tile
- `reprojectStyle` automatically forces `projection: { type: 'mercator' }`

## Known limitations

- **Labels/symbols**: MapLibre's collision detection assumes Mercator, so
  text placement is slightly wrong in distorted areas.
- **queryRenderedFeatures**: returns fake lon/lat coordinates. Use
  `inverseTransformCoords` from backproj to recover real coordinates.
- **Geographic CRS** (e.g. EPSG:4326) and **interrupted projections**
  (e.g. Goode Homolosine) are not supported.

## License

MIT
