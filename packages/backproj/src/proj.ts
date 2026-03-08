/**
 * proj.ts
 *
 * Core transform engine for the backproj reprojection pipeline using proj-wasm.
 *
 * Web map renderers typically only support Web Mercator. To display any other
 * projection, coordinates are run through a three-step pipeline:
 *   1. Forward-project lon/lat -> target CRS metres
 *   2. Scale those metres to fit the Web Mercator world extent (+-20037508m)
 *   3. Inverse-project back through Mercator -> fake lon/lat
 * The renderer draws the fake lon/lat as Mercator, which visually produces
 * the target projection.
 *
 * proj-wasm exposes only the ISO 19111 high-level API, not proj_create().
 * There is no way to inject a raw pipeline string as a single transformer.
 * The working path is:
 *   projCreateCrsToCrs({ source_crs: string, target_crs: string })
 * which accepts any of: PROJ string, EPSG:xxxx, ESRI:xxxx, WKT2, WKT1, PROJJSON.
 * We pass the user's CRS directly as target_crs.
 *
 * WHY TWO TRANSFORMERS + JS AFFINE (not one pipeline)
 * Ideally this would be a single PROJ pipeline via proj_create():
 *   +proj=pipeline +step +proj=robin +step +proj=affine ... +step +inv +proj=merc
 * but proj_create() is not exposed in the proj-wasm binding. Only the
 * ISO 19111 projCreateCrsToCrs path is available, which accepts CRS-to-CRS
 * transforms, not arbitrary pipelines. So we chain:
 *   tFwd     : lon/lat -> target projection metres
 *   jsAffine : scale in plain JS (no WASM call)
 *   tInvMerc : Mercator metres -> fake lon/lat
 * Total: 2 batch WASM calls per coord array + O(n) JS arithmetic.
 * If proj-wasm adds proj_create(), this collapses to 1 WASM call.
 * If proj-wasm adds proj_get_area_of_use(), getWorldBounds() could
 * return tight bounds for any CRS, not just registered AUTH:CODE ones.
 *
 * AXIS ORDER TRAP
 * EPSG:4326 is officially lat/lon (ISO 19111). Passing 'EPSG:4326' as source_crs
 * causes projCreateCrsToCrs to expect (lat, lon) input — inputs are swapped.
 * Fix: pass a PROJJSON GeographicCRS with the lon axis listed FIRST. PROJ then
 * uses lon/lat input order without needing projNormalizeForVisualization
 * (which is broken in this binding for ProjectedCRS transformers anyway).
 */

import * as proj from 'proj-wasm';

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
 * Pass to transformCoords to reproject coordinates.
 */
export interface Transformer {
  readonly _tFwd: PJ;
  readonly _tInvMerc: PJ;
  readonly _Sx: number;
  readonly _Sy: number;
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
  const [x] = await proj.getCoords(buf, 0);

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
 * extents. Uses lat range +-89 to avoid pole singularities. Throws if <10%
 * of samples are finite (interrupted projection).
 */
async function sampleProjectionExtent(
  tFwd: PJ
): Promise<{ xMax: number; yMax: number }> {
  const N = 32;
  const total = (N + 1) * (N + 1);
  const samples: [number, number, number, number][] = [];

  for (let i = 0; i <= N; i++)
    for (let j = 0; j <= N; j++)
      samples.push([-180 + (i / N) * 360, -89 + (j / N) * 178, 0, 0]);

  const buf = await proj.coordArray(total);
  await proj.setCoords(buf, samples);
  await proj.projTransArray({ p: tFwd, direction: 1, n: total, coord: buf });

  let xMax = 0, yMax = 0, finiteCount = 0;
  for (let i = 0; i < total; i++) {
    const [x, y] = await proj.getCoords(buf, i);
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
    const list = await proj.getCrsInfoListFromDatabase({ auth_name: authName, types: [15] });
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

  const tInvMerc: PJ = await proj.projCreateCrsToCrs({
    source_crs: 'EPSG:3857',
    target_crs: WGS84_LON_LAT,
  });

  const { xMax, yMax } = await sampleProjectionExtent(tFwd);

  const areaOfUse = await lookupAreaOfUse(crsString);

  return {
    _tFwd:     tFwd,
    _tInvMerc: tInvMerc,
    _Sx:       MERC_MAX / xMax,
    _Sy:       MERC_MAX / yMax,
    sourceCRS: crsString,
    _areaOfUse: areaOfUse,
  };
}

/**
 * Transform an array of [lon, lat] coordinates through the pipeline,
 * returning fake [lon, lat] that a Web Mercator renderer displays as the
 * target projection.
 *
 * Uses exactly 2 batch WASM calls regardless of array size.
 */
export async function transformCoords(
  coords: [number, number][],
  transformer: Transformer,
): Promise<[number, number][]> {
  const { _tFwd, _tInvMerc, _Sx, _Sy } = transformer;
  const n = coords.length;
  if (n === 0) return [];

  const fwdBuf = await proj.coordArray(n);
  await proj.setCoords(fwdBuf, coords.map(([lon, lat]) => [lon, lat, 0, 0]));
  await proj.projTransArray({ p: _tFwd, direction: 1, n, coord: fwdBuf });

  const mercatorCoords: [number, number, number, number][] = [];
  for (let i = 0; i < n; i++) {
    const [x, y] = await proj.getCoords(fwdBuf, i);
    mercatorCoords.push([x * _Sx, y * _Sy, 0, 0]);
  }

  const invBuf = await proj.coordArray(n);
  await proj.setCoords(invBuf, mercatorCoords);
  await proj.projTransArray({ p: _tInvMerc, direction: 1, n, coord: invBuf });

  const result: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const [lon, lat] = await proj.getCoords(invBuf, i);
    result.push([lon, lat]);
  }
  return result;
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
        [Math.max(-180, aou.west - padLon), Math.max(-85, aou.south - padLat)],
        [Math.min(180, aou.east + padLon), Math.min(85, aou.north + padLat)],
      ],
      transformer,
    );
    if (corners.every(([lon, lat]) => isFinite(lon) && isFinite(lat))) {
      return [corners[0], corners[1]];
    }
  }
  return [[-180, -85.051129], [180, 85.051129]];
}
