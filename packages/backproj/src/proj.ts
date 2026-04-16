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
 * For global projections (Robinson, Mollweide, etc.), step 2 uses uniform
 * scale-only:
 *   S = MERC_MAX / max(xMax, yMax), Sx = Sy = S, Ox = Oy = 0
 * Uniform scale preserves aspect ratio. This maps the full projection
 * extent to the full Mercator world (+-20037508m).
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
 * PIPELINE COLLAPSE (single WASM call)
 *
 * proj-wasm exposes both the ISO 19111 high-level API and projCreate().
 * For any projected CRS, we extract the coordoperation — the pure map
 * projection conversion without datum shifts — via:
 *   projGetTargetCrs -> projCrsGetCoordoperation -> projAsProjString
 *
 * This gives us the PROJ pipeline steps (unitconvert, projection, etc.)
 * which we flatten and append affine + inverse Mercator + unit conversion:
 *   +proj=pipeline <coordoperation steps> +step +proj=affine ...
 *   +step +inv +proj=merc +a=6378137 +b=6378137
 *   +step +proj=unitconvert +xy_in=rad +xy_out=deg
 *
 * The result is a single PJ that replaces all three steps. Both forward
 * (direction=1) and inverse (direction=-1) use this PJ.
 *
 * The coordoperation omits datum shifts (~0.1 ft for NAD83), invisible
 * at display resolution. The critical invariant is that pipeline,
 * two-call fallback, and inverse all use the same projection and affine.
 * When the pipeline is available, _tFwd is set to the coordoperation PJ
 * (not the CRS-to-CRS PJ) so the fallback path is also consistent.
 *
 * TWO-CALL FALLBACK
 *
 * When the coordoperation cannot be extracted, falls back to the original
 * two-call path: projCreateCrsToCrs forward + JS affine + invMerc.
 * This happens for compound CRS (e.g. EPSG:7415 = Amersfoort/RD New +
 * NAP height) where the target is a CompoundCRS, not a ProjectedCRS.
 * Works for all simple projected CRS (EPSG, ESRI, PROJ strings, WKT).
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
export const MAX_MERC_LAT = 85.051129;

const REGIONAL_MAX_LON_SPAN = 350;
const REGIONAL_MAX_LAT_SPAN = 170;
const EXTENT_SAMPLE_GRID_SIZE = 32;
const PROJECTED_CRS_PROBE_THRESHOLD = 4;
const WORLD_BOUNDS_PADDING = 0.20;

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
 * The affine parameters (Sx, Sy, Ox, Oy) bridge projected metres and Mercator
 * metres: x_merc = x_proj * Sx + Ox, y_merc = y_proj * Sy + Oy.
 * When _tPipeline is available, the affine is embedded in the PROJ pipeline
 * string and all three steps execute in a single WASM call. Otherwise the
 * two-call fallback applies the affine in JS between tFwd and tInvMerc.
 *
 * For global CRS: Ox = Oy = 0, Sx = Sy (uniform scale, preserves aspect ratio).
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
  readonly _tPipeline?: PJ;
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

  if (!isFinite(x) || Math.abs(x) <= PROJECTED_CRS_PROBE_THRESHOLD) {
    throw new Error(
      `CRS does not appear to be a projected CRS: "${crsString}". ` +
      `Provide a ProjectedCRS (e.g. EPSG:3857, ESRI:54030, a WKT2 PROJCRS, ` +
      `or a PROJ string like +proj=robin).`
    );
  }
}

let _sharedInvMerc: PJ | null = null;

/**
 * Return a shared inverse-Mercator transform (EPSG:3857 -> WGS84 lon/lat).
 * This transform is independent of the target CRS, so one instance serves
 * all transformers.
 */
async function getSharedInvMerc(): Promise<PJ> {
  if (!_sharedInvMerc) {
    const t = await proj.projCreateCrsToCrs({
      source_crs: 'EPSG:3857',
      target_crs: WGS84_LON_LAT,
    });
    if (!t) throw new Error('Failed to create inverse Mercator transform');
    _sharedInvMerc = t;
  }
  return _sharedInvMerc!;
}

/**
 * Samples a 33x33 grid of lon/lat through tFwd to find the maximum x and y
 * extents. Throws if both xMax and yMax are zero.
 *
 * Used only for global-mode CRS to compute S = MERC_MAX / max(xMax, yMax). For regional
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
  const N = EXTENT_SAMPLE_GRID_SIZE;
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
  _sharedInvMerc = null;
  await proj.init();
}

/**
 * Try to look up the area of use for a CRS from the PROJ database.
 * Works for "AUTH:CODE" format strings (e.g. EPSG:5070, ESRI:54030).
 * Returns undefined for PROJ strings, WKT, or if the lookup fails.
 */
async function lookupAreaOfUse(
  crsString: string,
): Promise<{ west: number; south: number; east: number; north: number } | undefined> {
  const match = crsString.match(/^(\w+):(\w+)$/);
  if (!match) return undefined;
  const [, authName, code] = match;
  try {
    const list = await proj.projGetCrsInfoListFromDatabase({ auth_name: authName, types: [15] }); // 15 = PJ_TYPE_PROJECTED_CRS
    const entry = list.find((e: any) => e.code === code);
    if (!entry || entry.westLonDegree == null) return undefined;
    return {
      west: entry.westLonDegree,
      south: entry.southLatDegree,
      east: entry.eastLonDegree,
      north: entry.northLatDegree,
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
 * Throws if the CRS is geographic or unparseable. Interrupted projections
 * (e.g. Goode Homolosine) are not rejected but will produce visual artifacts.
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

  const tInvMerc = await getSharedInvMerc();

  const areaOfUse = await lookupAreaOfUse(crsString);

  // Extract the coordoperation for pipeline construction.
  const coordOpInfo = await getCoordoperationInfo(tFwd);

  // Regional: area of use < 350 deg lon AND < 170 deg lat (state plane, UTM, etc.)
  // Global: everything else (Robinson, Mollweide, full-world projections)
  const isRegional = areaOfUse
    && (areaOfUse.east - areaOfUse.west) < REGIONAL_MAX_LON_SPAN
    && (areaOfUse.north - areaOfUse.south) < REGIONAL_MAX_LAT_SPAN;

  if (isRegional) {
    // REGIONAL MODE: affine scale + offset
    // Align the projected area-of-use to its Mercator equivalent so that
    // output tile zoom levels correspond 1:1 with input tile zoom levels.
    const aou = areaOfUse!;

    const centerLon = (aou.west + aou.east) / 2;
    const centerLat = (aou.south + aou.north) / 2;

    // Use convPJ when available so affine matches the pipeline exactly.
    // Falls back to tFwd for compound CRS where coordoperation extraction fails.
    const tProj = coordOpInfo ? coordOpInfo.convPJ : tFwd;

    // Project area-of-use edges and center through tProj to get
    // the projected extent and the projected center point.
    const edgeBuf = await proj.coordArray(5);
    await proj.setCoords(edgeBuf, [
      [aou.west, centerLat, 0, 0],
      [aou.east, centerLat, 0, 0],
      [centerLon, aou.south, 0, 0],
      [centerLon, aou.north, 0, 0],
      [centerLon, centerLat, 0, 0],
    ]);
    await proj.projTransArray({ p: tProj, direction: 1, n: 5, coord: edgeBuf });
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

    let tPipeline: PJ | undefined;
    if (coordOpInfo) {
      const pipeStr = buildPipelineString(coordOpInfo.convStr, Sx, Sy, Ox, Oy);
      tPipeline = (await proj.projCreate({ definition: pipeStr })) ?? undefined;
    }

    return {
      _tFwd:      tProj,
      _tInvMerc:  tInvMerc,
      _tPipeline: tPipeline,
      _Sx:        Sx,
      _Sy:        Sy,
      _Ox:        Ox,
      _Oy:        Oy,
      sourceCRS:  crsString,
      _areaOfUse: aou,
    };
  }

  let tPipeline: PJ | undefined;
  let finalTFwd = tFwd;

  if (coordOpInfo) {
    // Use convPJ for extent sampling so affine matches the pipeline exactly.
    const { xMax, yMax } = await sampleProjectionExtent(coordOpInfo.convPJ);
    const S = MERC_MAX / Math.max(xMax, yMax);
    finalTFwd = coordOpInfo.convPJ;
    const pipeStr = buildPipelineString(coordOpInfo.convStr, S, S, 0, 0);
    tPipeline = (await proj.projCreate({ definition: pipeStr })) ?? undefined;

    return {
      _tFwd:      finalTFwd,
      _tInvMerc:  tInvMerc,
      _tPipeline: tPipeline,
      _Sx:        S,
      _Sy:        S,
      _Ox:        0,
      _Oy:        0,
      sourceCRS:  crsString,
      _areaOfUse: areaOfUse,
    };
  }

  const { xMax, yMax } = await sampleProjectionExtent(tFwd);
  const S = MERC_MAX / Math.max(xMax, yMax);

  return {
    _tFwd:     tFwd,
    _tInvMerc: tInvMerc,
    _tPipeline: undefined,
    _Sx:       S,
    _Sy:       S,
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
 * Transform coordinates in stride-4 Float64Array layout.
 * This is the sole transform engine -- transformCoords delegates here.
 *
 * Primary path (pipeline available): single projTransArray call through
 * _tPipeline, which encapsulates forward + affine + inverse Mercator.
 *
 * Fallback path (no pipeline, e.g. compound CRS):
 *   lon/lat -> tFwd (WASM) -> proj_x, proj_y
 *   -> affine: x * Sx + Ox, y * Sy + Oy  (JS, produces Mercator metres)
 *   -> tInvMerc (WASM) -> fake lon/lat
 * Uses 2 batch WASM calls with JS affine between them. Reads/writes the
 * coord-array's underlying Float64Array buffer directly (4 values per
 * coord: x,y,z,t) to apply the affine.
 *
 * PERF: DO NOT replace direct buffer access with proj.getCoords() calls.
 * getCoords sends a postMessage round-trip per coordinate per call.
 */
export async function transformCoordsF64(
  coords: Float64Array,
  transformer: Transformer,
): Promise<Float64Array> {
  const n = coords.length / 4;
  if (n === 0) return new Float64Array(0);

  if (transformer._tPipeline) {
    const enabled = __DEV__ && profiling.enabled;
    let t0 = 0;
    if (__DEV__ && enabled) t0 = performance.now();

    const buf = await proj.coordArray(n);
    const f64: Float64Array = (buf as any).buffer;
    f64.set(coords);
    // Zero z/t slots — WASM heap uses malloc not calloc, and callers of the
    // exported transformCoordsF64 may pass non-zero z/t values.
    for (let i = 0; i < n; i++) { f64[i * 4 + 2] = 0; f64[i * 4 + 3] = 0; }
    await proj.projTransArray({ p: transformer._tPipeline, direction: 1, n, coord: buf });

    if (__DEV__ && enabled) {
      console.debug(
        `[backproj:transformCoordsF64] n=${n} pipeline=${tcFmtMs(performance.now() - t0)}`,
      );
    }

    return new Float64Array(f64);
  }

  const { _tFwd, _tInvMerc, _Sx, _Sy, _Ox, _Oy } = transformer;

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
 * Extract the coordoperation PROJ string from a CRS-to-CRS transform.
 * Returns the conversion pipeline (without datum shift) and the
 * coordoperation as a usable PJ for affine computation.
 *
 * Returns null for CRS types where coordoperation extraction doesn't apply,
 * e.g. compound CRS (EPSG:7415 = Amersfoort/RD New + NAP height). PROJ logs
 * "Object is not a DerivedCRS or BoundCRS" to stderr in this case — harmless,
 * only during buildTransformer init, not the hot path.
 */
async function getCoordoperationInfo(
  tFwd: PJ,
): Promise<{ convStr: string; convPJ: PJ } | null> {
  try {
    const targetCrs = await proj.projGetTargetCrs({ pj: tFwd });
    const coordOp = await proj.projCrsGetCoordoperation({ crs: targetCrs });
    const convStr: string = await proj.projAsProjString({ pj: coordOp, type: 0 });
    if (!convStr) return null;
    // Create a usable PJ from the coordoperation string (with axisswap stripped
    // since our input is lon/lat, not EPSG's lat/lon).
    const stripped = convStr
      .replace(/\+step\s+\+proj=axisswap\s+\+order=2,1\s+/, '');
    const convPJ = await proj.projCreate({ definition: stripped });
    if (!convPJ) return null;
    return { convStr, convPJ };
  } catch {
    return null;
  }
}

function buildPipelineString(
  convStr: string, Sx: number, Sy: number, Ox: number, Oy: number,
): string {
  const inner = convStr
    .replace(/^\+proj=pipeline\s+/, '')
    .replace(/\+step\s+\+proj=axisswap\s+\+order=2,1\s+/, '');
  // THREE PROJ API TRAPS (each silently produces wrong output, not errors):
  //
  // 1. Affine offsets: +xoff/+yoff, NOT +x0/+y0. Wrong names are silently
  //    ignored, producing scale-only output with no translation.
  //
  // 2. Spherical Mercator: +a=6378137 +b=6378137, NOT the CRS's +ellps.
  //    The affine maps into EPSG:3857 (Web Mercator) metre space, which uses
  //    a spherical formulation. Using the coordoperation's ellipsoid here
  //    applies ellipsoidal inverse Mercator — subtly wrong fake coordinates.
  //
  // 3. Radians to degrees: +inv +proj=merc outputs radians. Must append
  //    +proj=unitconvert +xy_in=rad +xy_out=deg or output is ~57x too small.
  return `+proj=pipeline ${inner} +step +proj=affine +s11=${Sx} +s22=${Sy} +xoff=${Ox} +yoff=${Oy} +step +inv +proj=merc +a=6378137 +b=6378137 +step +proj=unitconvert +xy_in=rad +xy_out=deg`;
}

/**
 * Inverse of transformCoords: given fake [lon, lat] produced by the pipeline,
 * recover the original real [lon, lat].
 *
 * Primary path (pipeline available): single projTransArray call with
 * direction=-1 through _tPipeline.
 *
 * Fallback path (exact reverse of the forward fallback):
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
  const n = fakeCoords.length;
  if (n === 0) return [];

  if (transformer._tPipeline) {
    const buf = await proj.coordArray(n);
    await proj.setCoords(buf, fakeCoords.map(([lon, lat]) => [lon, lat, 0, 0]));
    await proj.projTransArray({ p: transformer._tPipeline, direction: -1, n, coord: buf });
    const f64: Float64Array = (buf as any).buffer;
    const result: [number, number][] = new Array(n);
    for (let i = 0; i < n; i++) {
      result[i] = [f64[i * 4], f64[i * 4 + 1]];
    }
    return result;
  }

  const { _tFwd, _tInvMerc, _Sx, _Sy, _Ox, _Oy } = transformer;

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
 * those geographic bounds through the pipeline for a tight fit. For global
 * CRS without area of use, transforms world corners to get the actual
 * fake extent (which may be smaller than ±85° with uniform scale).
 */
export async function getWorldBounds(
  transformer: Transformer,
): Promise<[[number, number], [number, number]]> {
  const aou = transformer._areaOfUse;
  const sw = aou
    ? [Math.max(-180, aou.west - (aou.east - aou.west) * WORLD_BOUNDS_PADDING),
       Math.max(-89.999999, aou.south - (aou.north - aou.south) * WORLD_BOUNDS_PADDING)] as [number, number]
    : [-180, -89.999999] as [number, number];
  const ne = aou
    ? [Math.min(180, aou.east + (aou.east - aou.west) * WORLD_BOUNDS_PADDING),
       Math.min(89.999999, aou.north + (aou.north - aou.south) * WORLD_BOUNDS_PADDING)] as [number, number]
    : [180, 89.999999] as [number, number];

  const corners = await transformCoords([sw, ne], transformer);
  if (corners.every(([lon, lat]) => isFinite(lon) && isFinite(lat))) {
    return [corners[0], corners[1]];
  }
  return [[-180, -MAX_MERC_LAT], [180, MAX_MERC_LAT]];
}
