/**
 * proj.ts
 *
 * Core transform engine for the backproj reprojection pipeline using proj-wasm.
 *
 * Web map renderers typically only support Web Mercator. To display any other
 * projection, coordinates are run through a three-step affine pipeline:
 *   1. Forward-project lon/lat -> target CRS metres          (tFwd, WASM)
 *   2. Affine transform: x * Sx + Ox, y * Sy + Oy           (JS arithmetic)
 *   3. Inverse-project Mercator metres -> fake lon/lat       (tInvMerc, WASM)
 * The renderer draws the fake lon/lat as Mercator, which visually produces
 * the target projection.
 *
 * GLOBAL vs REGIONAL CRS (the zoom alignment problem)
 *
 * For global projections (Robinson, Mollweide, etc.), step 2 uses scale-only:
 *   Sx = MERC_MAX / xMax, Sy = MERC_MAX / yMax, Ox = Oy = 0
 * This maps the full projection extent to the full Mercator world (+-20037508m).
 *
 * For regional projections (state plane, UTM, national grids), the old
 * scale-only approach compressed the region into a tiny fraction of the
 * Mercator tile grid. Example: EPSG:2249 (Massachusetts State Plane) had
 * Sx ~0.009, so a z14 output tile covered ~0.43 degrees of real-world
 * longitude instead of 0.022 degrees. MapLibre requests z14 output tiles
 * but chooseInputZoom dropped to z11 — users could never see building detail.
 *
 * Fix: for regional CRS, step 2 uses an affine (scale + offset) that aligns
 * the projected area-of-use to its equivalent Mercator extent:
 *   Sx = merc_extent_x / proj_extent_x    (extent-matching scale)
 *   Sy = merc_extent_y / proj_extent_y
 *   Ox = merc_center_x - proj_center_x * Sx   (center-alignment offset)
 *   Oy = merc_center_y - proj_center_y * Sy
 * Result: within the area of use, fake lon/lat closely tracks real lon/lat.
 * A z14 output tile covers roughly the same real-world area as a z14
 * Mercator tile, so chooseInputZoom returns z14 input (not z11).
 *
 * Detection: if area-of-use spans < 350 deg lon AND < 170 deg lat, use
 * regional mode. Otherwise global mode.
 *
 * This technique originates from Development Seed's dirty-reprojectors, which
 * used d3-geo for both projections. d3 normalises all projections to pixel
 * space (~960x500px, shared scale ~153), so feeding one projection's output
 * into another's inverse works because the scales cancel implicitly. proj-wasm
 * outputs metres, not d3 pixels, so scales do NOT cancel — we must compute
 * explicit affine parameters Sx/Sy/Ox/Oy (see buildTransformer).
 *
 * proj-wasm exposes only the ISO 19111 high-level API, not proj_create().
 * There is no way to inject a raw pipeline string as a single transformer.
 * The working path is:
 *   projCreateCrsToCrs({ source_crs: string, target_crs: string })
 * which accepts any of: PROJ string, EPSG:xxxx, ESRI:xxxx, WKT2, WKT1, PROJJSON.
 * We pass the user's CRS directly as target_crs.
 *
 * Two PROJ transforms + JS affine because proj-wasm only exposes
 * CRS-to-CRS (not proj_create pipelines). With proj_create() this
 * collapses to one WASM call: +proj=pipeline +step +proj=robin
 * +step +proj=affine ... +step +inv +proj=merc
 *
 * AXIS ORDER TRAP
 * EPSG:4326 is officially lat/lon (ISO 19111). Passing 'EPSG:4326' as source_crs
 * causes projCreateCrsToCrs to expect (lat, lon) input — inputs are swapped.
 * Fix: pass a PROJJSON GeographicCRS with the lon axis listed FIRST. PROJ then
 * uses lon/lat input order without needing projNormalizeForVisualization.
 */

import * as proj from 'proj-wasm';
import { profiling } from './profiling.js';

const MERC_MAX = 20037508.3427892;

/**
 * WGS 84 geographic CRS as PROJJSON, with longitude listed FIRST.
 *
 * Do NOT replace with 'EPSG:4326' — that string triggers ISO 19111 axis order
 * (lat, lon) and will silently swap all coordinates.
 */
const WGS84_LON_LAT: string = JSON.stringify({
  type: 'GeographicCRS',
  name: 'WGS 84 (lon/lat)',
  datum: {
    type: 'GeodeticReferenceFrame',
    name: 'World Geodetic System 1984',
    ellipsoid: {
      name: 'WGS 84',
      semi_major_axis: 6378137,
      inverse_flattening: 298.257223563,
    },
  },
  coordinate_system: {
    subtype: 'ellipsoidal',
    axis: [
      { name: 'Longitude', abbreviation: 'lon', direction: 'east',  unit: 'degree' },
      { name: 'Latitude',  abbreviation: 'lat', direction: 'north', unit: 'degree' },
    ],
  },
});

type PJ = object;

/**
 * A compiled transformer. Returned by buildTransformer.
 * Pass to transformCoords / inverseTransformCoords to reproject coordinates.
 *
 * The affine step between the two WASM calls is: x * Sx + Ox, y * Sy + Oy.
 * For global CRS: Ox = Oy = 0, Sx/Sy map full projection extent to +-MERC_MAX.
 * For regional CRS: Sx/Sy match the area-of-use extent to its Mercator equivalent,
 * and Ox/Oy shift the center so output tiles align with input tiles at the same
 * zoom level (see module preamble for the zoom alignment problem).
 *
 * _areaOfUse is the geographic bounding box from the PROJ database (if available).
 * Used for: regional vs global detection, tile clipping early exit, maxBounds,
 * and getWorldBounds fitBounds computation.
 */
export interface Transformer {
  readonly _tFwd: PJ;
  readonly _tInvMerc: PJ;
  readonly _Sx: number;
  readonly _Sy: number;
  readonly _Ox: number;
  readonly _Oy: number;
  readonly sourceCRS: string;
  readonly _areaOfUse?: {
    west: number; south: number; east: number; north: number;
  };
}

/**
 * Validates that tFwd outputs projected (metric) coordinates, not geographic
 * (degree) coordinates. Transforms probe point (lon=1, lat=0) and checks |x| > 4.
 */
async function assertIsProjectedCRS(tFwd: PJ, crsString: string): Promise<void> {
  const buf = await proj.coordArray(1);
  await proj.setCoords(buf, [[1, 0, 0, 0]]);
  await proj.projTransArray({ p: tFwd, direction: 1, n: 1, coord: buf });
  const x = ((buf as any).buffer as Float64Array)[0];

  if (!isFinite(x) || Math.abs(x) <= 4) {
    throw new Error(
      `CRS does not appear to be a projected CRS: "${crsString}". ` +
      `Provide a ProjectedCRS (e.g. EPSG:3857, ESRI:54030, a WKT2 PROJCRS, ` +
      `or a PROJ string like +proj=robin).`
    );
  }
}

/**
 * Samples a 33x33 grid of lon/lat through tFwd to find the maximum x and y
 * extents. Throws if <10% of samples are finite (interrupted projection).
 *
 * Used only for global-mode CRS to compute Sx = MERC_MAX / xMax. For regional
 * CRS, the affine parameters are computed directly from area-of-use edges
 * (see buildTransformer), so this function is not called.
 *
 * Accepts optional bounds to restrict sampling to a geographic region.
 * Without bounds, samples the full world (lon +-180, lat +-89).
 */
async function sampleProjectionExtent(
  tFwd: PJ,
  bounds?: { west: number; south: number; east: number; north: number },
): Promise<{ xMax: number; yMax: number }> {
  const N = 32;
  const total = (N + 1) * (N + 1);
  const samples: [number, number, number, number][] = [];

  const lonMin = bounds ? bounds.west : -180;
  const lonMax = bounds ? bounds.east : 180;
  const latMin = bounds ? Math.max(bounds.south, -89) : -89;
  const latMax = bounds ? Math.min(bounds.north, 89) : 89;

  for (let i = 0; i <= N; i++)
    for (let j = 0; j <= N; j++)
      samples.push([lonMin + (i / N) * (lonMax - lonMin), latMin + (j / N) * (latMax - latMin), 0, 0]);

  const buf = await proj.coordArray(total);
  await proj.setCoords(buf, samples);
  await proj.projTransArray({ p: tFwd, direction: 1, n: total, coord: buf });

  let xMax = 0, yMax = 0, finiteCount = 0;
  const bufF64: Float64Array = (buf as any).buffer;
  for (let i = 0; i < total; i++) {
    const off = i * 4;
    const x = bufF64[off], y = bufF64[off + 1];
    if (isFinite(x) && isFinite(y)) {
      xMax = Math.max(xMax, Math.abs(x));
      yMax = Math.max(yMax, Math.abs(y));
      finiteCount++;
    }
  }

  if (finiteCount < total * 0.1) {
    throw new Error(
      'CRS produces finite output for fewer than 10% of sampled points. ' +
      'Interrupted projections (e.g. Goode Homolosine) are not supported.'
    );
  }

  if (xMax === 0 || yMax === 0) {
    throw new Error('CRS has zero extent — cannot compute scale factors.');
  }

  return { xMax, yMax };
}

/**
 * Initialise proj-wasm. Must be called once before any other function.
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export async function initProj(): Promise<void> {
  await proj.init();
}

/**
 * Try to look up the area of use for a CRS from the PROJ database.
 * Works for "AUTH:CODE" format strings (e.g. EPSG:5070, ESRI:54030).
 * Returns undefined for PROJ strings, WKT, or if the lookup fails.
 *
 * Workaround: proj-wasm doesn't expose proj_get_area_of_use(), so we
 * fall back to getCrsInfoListFromDatabase which only works for registered
 * AUTH:CODE identifiers. If proj-wasm added proj_get_area_of_use(), this
 * could work for any PJ object (PROJ strings, WKT, etc.).
 */
async function lookupAreaOfUse(
  crsString: string,
): Promise<{ west: number; south: number; east: number; north: number } | undefined> {
  const match = crsString.match(/^(\w+):(\w+)$/);
  if (!match) return undefined;
  const [, authName, code] = match;
  try {
    const list = await proj.getCrsInfoListFromDatabase({ auth_name: authName, types: [15] }); // 15 = PJ_TYPE_PROJECTED_CRS
    const entry = list.find((e: any) => e.code === code);
    if (!entry || entry.west_lon_degree == null) return undefined;
    return {
      west: entry.west_lon_degree,
      south: entry.south_lat_degree,
      east: entry.east_lon_degree,
      north: entry.north_lat_degree,
    };
  } catch {
    return undefined;
  }
}

/**
 * Compile a transformer for any projected CRS.
 *
 * Accepts any CRS string that PROJ understands:
 *   PROJ string, EPSG:xxxx, ESRI:xxxx, WKT2, WKT1-GDAL, ESRI WKT, PROJJSON.
 *
 * For AUTH:CODE CRS strings, looks up the area of use from the PROJ database
 * and selects global or regional mode (see module preamble). Regional mode
 * computes an affine (scale + offset) by projecting the area-of-use edges
 * through both tFwd and tFwdMerc, then matching extents and centers.
 *
 * Throws if the CRS is geographic, unparseable, or interrupted.
 */
export async function buildTransformer(crsString: string): Promise<Transformer> {
  const tFwd: PJ | null = await proj.projCreateCrsToCrs({
    source_crs: WGS84_LON_LAT,
    target_crs: crsString,
  });

  if (!tFwd) {
    throw new Error(`proj-wasm could not parse CRS: "${crsString}"`);
  }

  await assertIsProjectedCRS(tFwd, crsString);

  // TODO: tInvMerc is constant (independent of target CRS). It could be
  // created once and shared across all transformers instead of per-call.
  const tInvMerc: PJ = await proj.projCreateCrsToCrs({
    source_crs: 'EPSG:3857',
    target_crs: WGS84_LON_LAT,
  });

  const areaOfUse = await lookupAreaOfUse(crsString);

  // Regional: area of use < 350 deg lon AND < 170 deg lat (state plane, UTM, etc.)
  // Global: everything else (Robinson, Mollweide, full-world projections)
  const isRegional = areaOfUse
    && (areaOfUse.east - areaOfUse.west) < 350
    && (areaOfUse.north - areaOfUse.south) < 170;

  if (isRegional) {
    // REGIONAL MODE: affine scale + offset
    // Align the projected area-of-use to its Mercator equivalent so that
    // output tile zoom levels correspond 1:1 with input tile zoom levels.
    const aou = areaOfUse!;

    const centerLon = (aou.west + aou.east) / 2;
    const centerLat = (aou.south + aou.north) / 2;

    // Project area-of-use edges and center through tFwd to get
    // the projected extent (in CRS metres) and the projected center point.
    const edgeBuf = await proj.coordArray(5);
    await proj.setCoords(edgeBuf, [
      [aou.west, centerLat, 0, 0],
      [aou.east, centerLat, 0, 0],
      [centerLon, aou.south, 0, 0],
      [centerLon, aou.north, 0, 0],
      [centerLon, centerLat, 0, 0],
    ]);
    await proj.projTransArray({ p: tFwd, direction: 1, n: 5, coord: edgeBuf });
    const edgeF64: Float64Array = (edgeBuf as any).buffer;

    const projExtentX = edgeF64[1 * 4] - edgeF64[0 * 4];     // east.x - west.x
    const projExtentY = edgeF64[3 * 4 + 1] - edgeF64[2 * 4 + 1]; // north.y - south.y
    const projCenterX = edgeF64[4 * 4];
    const projCenterY = edgeF64[4 * 4 + 1];

    // Project the same geographic edges through Mercator to get
    // the Mercator extent and center — the target we want to match.
    const mercBuf = await proj.coordArray(3);
    const tFwdMerc: PJ = await proj.projCreateCrsToCrs({
      source_crs: WGS84_LON_LAT,
      target_crs: 'EPSG:3857',
    });
    await proj.setCoords(mercBuf, [
      [aou.west, centerLat, 0, 0],
      [aou.east, centerLat, 0, 0],
      [centerLon, centerLat, 0, 0],
    ]);
    await proj.projTransArray({ p: tFwdMerc, direction: 1, n: 3, coord: mercBuf });
    const mercF64: Float64Array = (mercBuf as any).buffer;

    const mercExtentX = mercF64[1 * 4] - mercF64[0 * 4];

    // For Y: Mercator y at north/south edges
    const mercYBuf = await proj.coordArray(2);
    await proj.setCoords(mercYBuf, [
      [centerLon, aou.south, 0, 0],
      [centerLon, aou.north, 0, 0],
    ]);
    await proj.projTransArray({ p: tFwdMerc, direction: 1, n: 2, coord: mercYBuf });
    const mercYF64: Float64Array = (mercYBuf as any).buffer;
    const mercExtentY = mercYF64[1 * 4 + 1] - mercYF64[0 * 4 + 1];

    const mercCenterX = mercF64[2 * 4];
    const mercCenterY = (mercYF64[0 * 4 + 1] + mercYF64[1 * 4 + 1]) / 2;

    // Scale matches extents, offset aligns centers.
    const Sx = mercExtentX / projExtentX;
    const Sy = mercExtentY / projExtentY;
    const Ox = mercCenterX - projCenterX * Sx;
    const Oy = mercCenterY - projCenterY * Sy;

    return {
      _tFwd:      tFwd,
      _tInvMerc:  tInvMerc,
      _Sx:        Sx,
      _Sy:        Sy,
      _Ox:        Ox,
      _Oy:        Oy,
      sourceCRS:  crsString,
      _areaOfUse: aou,
    };
  }

  const { xMax, yMax } = await sampleProjectionExtent(tFwd);

  return {
    _tFwd:     tFwd,
    _tInvMerc: tInvMerc,
    _Sx:       MERC_MAX / xMax,
    _Sy:       MERC_MAX / yMax,
    _Ox:       0,
    _Oy:       0,
    sourceCRS: crsString,
    _areaOfUse: areaOfUse,
  };
}

/**
 * Build a pool of N transformers for the same CRS, each pinned to a
 * different proj-wasm worker via round-robin context assignment.
 * Sequential creation ensures each call lands on a different worker.
 *
 * Enables inter-tile parallelism: concurrent reprojectTile calls send
 * their projTransArray messages to different proj-wasm workers.
 *
 * TODO: consider removing if benchmarking shows no benefit
 */
export async function buildTransformerPool(
  crsString: string,
  poolSize: number,
): Promise<Transformer[]> {
  const transformers: Transformer[] = [];
  for (let i = 0; i < poolSize; i++) {
    transformers.push(await buildTransformer(crsString));
  }
  return transformers;
}

/**
 * Transform an array of [lon, lat] coordinates through the pipeline,
 * returning fake [lon, lat] that a Web Mercator renderer displays as the
 * target projection. Thin wrapper around transformCoordsF64.
 */
export async function transformCoords(
  coords: [number, number][],
  transformer: Transformer,
): Promise<[number, number][]> {
  const n = coords.length;
  if (n === 0) return [];

  const f64 = new Float64Array(n * 4);
  for (let i = 0; i < n; i++) {
    f64[i * 4] = coords[i][0];
    f64[i * 4 + 1] = coords[i][1];
  }

  const result = await transformCoordsF64(f64, transformer);

  const out: [number, number][] = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = [result[i * 4], result[i * 4 + 1]];
  }
  return out;
}

/**
 * Transform coordinates in stride-4 Float64Array layout through the pipeline.
 * This is the sole transform engine -- transformCoords delegates here.
 *
 * Pipeline:
 *   lon/lat -> tFwd (WASM) -> proj_x, proj_y
 *   -> affine: x * Sx + Ox, y * Sy + Oy  (JS, produces Mercator metres)
 *   -> tInvMerc (WASM) -> fake lon/lat
 *
 * Uses exactly 2 batch WASM calls (projTransArray) regardless of array size.
 * Between passes, reads/writes the coord-array's underlying Float64Array
 * buffer directly (4 values per coord: x,y,z,t) to apply the affine.
 *
 * PERF: DO NOT replace direct buffer access with proj.getCoords() calls.
 * getCoords sends a postMessage round-trip per coordinate per call.
 */
export async function transformCoordsF64(
  coords: Float64Array,
  transformer: Transformer,
): Promise<Float64Array> {
  const { _tFwd, _tInvMerc, _Sx, _Sy, _Ox, _Oy } = transformer;
  const n = coords.length / 4;
  if (n === 0) return new Float64Array(0);

  const enabled = __DEV__ && profiling.enabled;
  let tAlloc = 0, tTrans1 = 0, tAffine = 0, tTrans2 = 0;

  if (__DEV__ && enabled) tAlloc = performance.now();
  const fwdBuf = await proj.coordArray(n);
  const fwdF64: Float64Array = (fwdBuf as any).buffer;
  fwdF64.set(coords);
  if (__DEV__ && enabled) tAlloc = performance.now() - tAlloc;

  if (__DEV__ && enabled) tTrans1 = performance.now();
  await proj.projTransArray({ p: _tFwd, direction: 1, n, coord: fwdBuf });
  if (__DEV__ && enabled) tTrans1 = performance.now() - tTrans1;

  if (__DEV__ && enabled) tAffine = performance.now();
  const invBuf = await proj.coordArray(n);
  const invF64: Float64Array = (invBuf as any).buffer;
  for (let i = 0; i < n; i++) {
    const off = i * 4;
    invF64[off]     = fwdF64[off]     * _Sx + _Ox;
    invF64[off + 1] = fwdF64[off + 1] * _Sy + _Oy;
    invF64[off + 2] = 0;
    invF64[off + 3] = 0;
  }
  if (__DEV__ && enabled) tAffine = performance.now() - tAffine;

  if (__DEV__ && enabled) tTrans2 = performance.now();
  await proj.projTransArray({ p: _tInvMerc, direction: 1, n, coord: invBuf });
  if (__DEV__ && enabled) tTrans2 = performance.now() - tTrans2;

  if (__DEV__ && enabled) {
    console.debug(
      `[backproj:transformCoordsF64] n=${n}`,
      `alloc=${tcFmtMs(tAlloc)} fwd=${tcFmtMs(tTrans1)} affine=${tcFmtMs(tAffine)} inv=${tcFmtMs(tTrans2)}`,
    );
  }

  return new Float64Array(invF64);
}

function tcFmtMs(ms: number): string {
  return ms < 0.1 ? '<0.1ms' : ms.toFixed(1) + 'ms';
}

/**
 * Inverse of transformCoords: given fake [lon, lat] produced by the pipeline,
 * recover the original real [lon, lat].
 *
 * Pipeline (exact reverse of transformCoords):
 *   fake lon/lat -> Merc metres (tInvMerc, direction -1)
 *   -> inverse affine: (merc_x - Ox) / Sx, (merc_y - Oy) / Sy
 *   -> real lon/lat (tFwd, direction -1)
 *
 * Used by outputTileToRealBounds to map fake tile corners back to WGS84
 * for input tile enumeration and area-of-use clipping.
 */
export async function inverseTransformCoords(
  fakeCoords: [number, number][],
  transformer: Transformer,
): Promise<[number, number][]> {
  const { _tFwd, _tInvMerc, _Sx, _Sy, _Ox, _Oy } = transformer;
  const n = fakeCoords.length;
  if (n === 0) return [];

  const mercBuf = await proj.coordArray(n);
  await proj.setCoords(mercBuf, fakeCoords.map(([lon, lat]) => [lon, lat, 0, 0]));
  await proj.projTransArray({ p: _tInvMerc, direction: -1, n, coord: mercBuf }); // PJ_INV

  const fwdBuf = await proj.coordArray(n);
  const mercF64: Float64Array = (mercBuf as any).buffer;
  const fwdF64: Float64Array = (fwdBuf as any).buffer;
  for (let i = 0; i < n; i++) {
    const off = i * 4;
    fwdF64[off]     = (mercF64[off]     - _Ox) / _Sx;
    fwdF64[off + 1] = (mercF64[off + 1] - _Oy) / _Sy;
    fwdF64[off + 2] = 0;
    fwdF64[off + 3] = 0;
  }
  await proj.projTransArray({ p: _tFwd, direction: -1, n, coord: fwdBuf });

  const result: [number, number][] = new Array(n);
  for (let i = 0; i < n; i++) {
    const off = i * 4;
    result[i] = [fwdF64[off], fwdF64[off + 1]];
  }
  return result;
}

export async function inverseTransformPoint(
  coord: [number, number],
  transformer: Transformer,
): Promise<[number, number]> {
  const result = await inverseTransformCoords([coord], transformer);
  return result[0];
}

/**
 * Transform a single [lon, lat] coordinate. Convenience wrapper.
 * For bulk transforms, use transformCoords instead.
 */
export async function transformPoint(
  coord: [number, number],
  transformer: Transformer,
): Promise<[number, number]> {
  const result = await transformCoords([coord], transformer);
  return result[0];
}

/**
 * Compute the fake bounding box for use with map.fitBounds().
 *
 * If the CRS has a known area of use (from the PROJ database), transforms
 * those geographic bounds through the pipeline for a tight fit. Otherwise
 * falls back to the full Mercator world bounds.
 */
export async function getWorldBounds(
  transformer: Transformer,
): Promise<[[number, number], [number, number]]> {
  const aou = transformer._areaOfUse;
  if (aou) {
    const padLon = (aou.east - aou.west) * 0.2;
    const padLat = (aou.north - aou.south) * 0.2;
    const corners = await transformCoords(
      [
        [Math.max(-180, aou.west - padLon), Math.max(-89.999999, aou.south - padLat)],
        [Math.min(180, aou.east + padLon), Math.min(89.999999, aou.north + padLat)],
      ],
      transformer,
    );
    if (corners.every(([lon, lat]) => isFinite(lon) && isFinite(lat))) {
      return [corners[0], corners[1]];
    }
  }
  return [[-180, -85.051129], [180, 85.051129]];
}
