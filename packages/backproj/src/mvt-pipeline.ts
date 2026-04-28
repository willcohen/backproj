/**
 * mvt-pipeline.ts — Per-feature geometry processing for MVT reprojection.
 *
 * Implements the two-phase feature pipeline used by wasmts-handler.ts:
 *
 *   Phase 1 (processFeaturePhase1):
 *     fragments -> stitch (CoverageUnion) -> adaptive densify -> extract coords
 *     Input: GeoJSON fragments for a single feature (possibly from multiple tiles).
 *     Output: [lon, lat][] pair array + wasmts Geometry handle retained for phase 2.
 *
 *   Phase 2 (processFeaturePhase2):
 *     bbox disjoint check -> apply transformed coords -> repair -> bbox inside
 *     check / clip -> snap to grid
 *     Input: the retained Geometry + a transformed Float64Array from proj-wasm,
 *     packed at valuesPerCoord stride.
 *     Output: array of clipped, snapped Geometries ready for MVT encoding.
 *
 * Densification tolerance is zoom-dependent: coarser at low zoom (where tile
 * edges span many degrees) and finer at high zoom.
 *
 * All wasmts operations are synchronous. The async coord transformation
 * (proj-wasm) runs between the two phases on the same joint-pool worker that
 * holds the retained Geometry, since neither the Geometry handle nor the PROJ
 * context can cross a postMessage. See tile-processor.ts.
 */
import type { Geometry as WasmGeometry } from '@wcohen/wasmts';
type Wts = typeof wasmts;

export type FetchTileFn = (z: number, x: number, y: number) => Promise<ArrayBuffer>;

export interface OutputFeature {
  id: string;
  properties: Record<string, any>;
  geometries: WasmGeometry[];
}
export type OutputLayers = Record<string, OutputFeature[]>;

const DENSIFY_POINTS_PER_EDGE = 8;
const DENSIFY_FLOOR = 0.01;
const POINT_CLIP_BUFFER_RATIO = 0.10;
const CLIP_INSIDE_TOLERANCE_RATIO = 0.01;

// At low zoom, pre-clip features to geographic grid cells before reprojecting.
// Prevents globe-spanning polygons from creating topologically broken geometry
// after reprojection (e.g. antimeridian edges overlapping, polygon rings
// wrapping around the projection boundary).
const GEO_CLIP_MAX_ZOOM = 4;
const GEO_CLIP_CELL_DEG = 90;

// At zoom z, a Mercator tile edge spans 360/2^z degrees of longitude.
// Without densification, straight edges in lon/lat become distorted arcs
// in the target projection. The formula adds ~DENSIFY_POINTS_PER_EDGE
// intermediate points per tile edge. This gives ~45 degrees at z0, ~5.6
// at z2, down to the DENSIFY_FLOOR at z14+.
export function densifyTolerance(z: number): number {
  return Math.max(DENSIFY_FLOOR, 360 / (2 ** z * DENSIFY_POINTS_PER_EDGE));
}

export interface Phase1Accumulator {
  featureCount: number;
  fragmentCount: number;
  stitchMs: number;
  stitchCount: number;
  densifyMs: number;
  coordExtractMs: number;
  coordsProduced: number;
  constructMs: number;
  preDensifyCoords: number;
  postDensifyCoords: number;
}

export function createPhase1Accumulator(): Phase1Accumulator {
  return {
    featureCount: 0, fragmentCount: 0,
    stitchMs: 0, stitchCount: 0,
    densifyMs: 0, coordExtractMs: 0, coordsProduced: 0,
    constructMs: 0,
    preDensifyCoords: 0, postDensifyCoords: 0,
  };
}

export interface Phase2Accumulator {
  applyMs: number;
  isValidMs: number;
  fixRepairMs: number;
  fixRepairCount: number;
  clipMs: number;
  clipEmptyCount: number;
  skipClipCount: number;
  precisionMs: number;
  geojsonWriteMs: number;
}

export function createPhase2Accumulator(): Phase2Accumulator {
  return { applyMs: 0, isValidMs: 0, fixRepairMs: 0, fixRepairCount: 0, clipMs: 0, clipEmptyCount: 0, skipClipCount: 0, precisionMs: 0, geojsonWriteMs: 0 };
}

interface FlatGeometry {
  type: string;
  coords: Float64Array;
  ringOffsets: Int32Array | null;
  partOffsets: Int32Array | null;
}

// Walk toGeoJSON's nested coordinate arrays straight into typed arrays for
// wasmts.geom.fromFlat, skipping JSON entirely. The win is on the Java
// side: GeoJsonReader.read is one string crossing, but it parses JSON *text* --
// ~94% of that path's cost at 1k coords. stringify is only ~6%.
//
// Two facts from @mapbox/vector-tile that this relies on, both verified in its
// source rather than assumed: loadGeometry already closes rings (the ClosePath
// command pushes line[0].clone()), so no closure fixup is needed; and
// classifyRings emits shell-first/holes-after per polygon, which is exactly
// JTS's createPolygon(shell, holes) contract, so its grouping feeds
// partOffsets/ringOffsets directly.
//
// ringOffsets indexes coords in coordinate units; partOffsets indexes
// ringOffsets. Both carry a trailing end entry.
function flattenGeoJSON(geometry: any): FlatGeometry {
  const type: string = geometry.type;
  const c = geometry.coordinates;

  if (type === 'Point') {
    return { type, coords: new Float64Array([c[0], c[1]]), ringOffsets: null, partOffsets: null };
  }

  if (type === 'MultiPoint' || type === 'LineString') {
    const coords = new Float64Array(c.length * 2);
    for (let i = 0; i < c.length; i++) {
      coords[i * 2] = c[i][0];
      coords[i * 2 + 1] = c[i][1];
    }
    return { type, coords, ringOffsets: null, partOffsets: null };
  }

  // MultiLineString and Polygon are the same shape here: one level of rings
  // over a flat coord buffer. MultiPolygon adds the part level on top.
  const rings: any[][] = type === 'MultiPolygon' ? [] : c;
  const partOffsets: number[] | null = type === 'MultiPolygon' ? [] : null;
  if (type === 'MultiPolygon') {
    for (const poly of c) {
      partOffsets!.push(rings.length);
      for (const ring of poly) rings.push(ring);
    }
    partOffsets!.push(rings.length);
  }

  let n = 0;
  for (const r of rings) n += r.length;
  const coords = new Float64Array(n * 2);
  const ringOffsets = new Int32Array(rings.length + 1);
  let k = 0;
  for (let r = 0; r < rings.length; r++) {
    ringOffsets[r] = k;
    const ring = rings[r];
    for (let i = 0; i < ring.length; i++) {
      coords[k * 2] = ring[i][0];
      coords[k * 2 + 1] = ring[i][1];
      k++;
    }
  }
  ringOffsets[rings.length] = k;

  return {
    type,
    coords,
    ringOffsets,
    partOffsets: partOffsets ? new Int32Array(partOffsets) : null,
  };
}

// TODO: return Float64Array directly instead of [number,number][] to
// eliminate per-coord pair allocations and the packing loop in
// wasmts-handler.ts's phase1.
export function processFeaturePhase1(
  fragments: GeoJSON.Feature[], wts: Wts, z: number,
  acc?: Phase1Accumulator | null,
): { coords: [number, number][]; geom: WasmGeometry }[] | null {
  if (__DEV__ && acc) {
    acc.featureCount++;
    acc.fragmentCount += fragments.length;
  }
  let t = 0;

  // Points never span tile boundaries — skip stitching duplicates from
  // overlapping input tiles (CoverageUnion of identical points returns empty).
  const isPoint = fragments[0].geometry?.type === 'Point' || fragments[0].geometry?.type === 'MultiPoint';
  const parseFragments = isPoint ? [fragments[0]] : fragments;

  // fromFlat matches GeoJsonReader.read geometry-for-geometry; wasmts pins
  // that with a differential test (equalsExact), which is what lets this
  // path skip the JSON text round trip entirely.
  if (__DEV__ && acc) t = performance.now();
  const geoms: WasmGeometry[] = parseFragments.map(f => {
    const flat = flattenGeoJSON(f.geometry);
    return wts.geom.fromFlat(
      flat.type as any, flat.coords, 2, flat.ringOffsets, flat.partOffsets);
  });
  if (__DEV__ && acc) acc.constructMs += performance.now() - t;

  let geom: WasmGeometry;
  if (geoms.length === 1) {
    geom = geoms[0];
  } else {
    if (__DEV__ && acc) {
      acc.stitchCount++;
      t = performance.now();
    }
    try {
      geom = wts.coverage.CoverageUnion.union(geoms);
    } catch {
      // CoverageUnion requires valid non-overlapping coverage; degenerate or
      // slightly-overlapping fragments from tile clipping can violate this,
      // producing a TopologyException. Fall back to iterative union.
      geom = geoms.reduce((a, g) => wts.geom.union(a, g));
    }
    if (__DEV__ && acc) acc.stitchMs += performance.now() - t;
  }

  // At low zoom, clip to geographic grid cells so that no piece spans more
  // than GEO_CLIP_CELL_DEG degrees. This prevents globe-spanning polygons
  // from producing irrecoverably broken topology after reprojection.
  let pieces: WasmGeometry[];
  if (!isPoint && z <= GEO_CLIP_MAX_ZOOM) {
    pieces = clipToGeoGrid(geom, wts);
  } else {
    pieces = [geom];
  }

  const results: { coords: [number, number][]; geom: WasmGeometry }[] = [];
  const tolerance = densifyTolerance(z);

  for (const piece of pieces) {
    if (wts.geom.isEmpty(piece)) continue;

    if (__DEV__ && acc) t = performance.now();
    const preCoords = wts.geom.getCoordinates(piece);
    if (__DEV__ && acc) acc.preDensifyCoords += preCoords.length;
    let maxEdge = 0;
    for (let j = 1; j < preCoords.length; j++) {
      const dx = preCoords[j].x - preCoords[j - 1].x;
      const dy = preCoords[j].y - preCoords[j - 1].y;
      const d = Math.abs(dx) > Math.abs(dy) ? Math.abs(dx) : Math.abs(dy);
      if (d > maxEdge) maxEdge = d;
      if (maxEdge >= tolerance) break;
    }
    const needsDensify = maxEdge >= tolerance;
    let densified = piece;
    if (needsDensify) {
      densified = wts.densify.Densifier.densify(piece, tolerance);
    }
    if (__DEV__ && acc) acc.densifyMs += performance.now() - t;

    if (__DEV__ && acc) t = performance.now();
    let pairs: [number, number][];
    if (!needsDensify) {
      pairs = preCoords.map(c => [c.x, c.y] as [number, number]);
    } else {
      const coords = wts.geom.getCoordinates(densified);
      pairs = coords.map(c => [c.x, c.y] as [number, number]);
    }
    if (__DEV__ && acc) {
      acc.coordExtractMs += performance.now() - t;
      acc.coordsProduced += pairs.length;
      acc.postDensifyCoords += pairs.length;
    }

    results.push({ coords: pairs, geom: densified });
  }

  return results.length > 0 ? results : null;
}

function clipToGeoGrid(geom: WasmGeometry, wts: Wts): WasmGeometry[] {
  const factory = wts.geom.GeometryFactory.create0();
  const cell = GEO_CLIP_CELL_DEG;
  const results: WasmGeometry[] = [];
  for (let lon = -180; lon < 180; lon += cell) {
    for (let lat = -90; lat < 90; lat += cell) {
      const clipEnv = wts.geom.GeometryFactory.toGeometry(
        factory,
        wts.geom.Envelope.create4(lon, lon + cell, Math.max(lat, -90), Math.min(lat + cell, 90)),
      );
      try {
        const clipped = wts.geom.intersection(geom, clipEnv);
        if (!wts.geom.isEmpty(clipped)) {
          results.push(clipped);
        }
      } catch {
        // intersection can throw on degenerate geometry; skip cell
      }
    }
  }
  return results;
}

export function processFeaturePhase2(
  geom: WasmGeometry, transformedCoords: Float64Array,
  valuesPerCoord: number,
  clipEnvelope: WasmGeometry,
  clipMinX: number, clipMaxX: number, clipMinY: number, clipMaxY: number,
  pm: any, wts: Wts,
  acc?: Phase2Accumulator | null,
): WasmGeometry[] | null {
  let t = 0;

  // Point features get a 10% buffer zone so labels near tile edges aren't dropped.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const n = transformedCoords.length / valuesPerCoord;
  for (let j = 0; j < n; j++) {
    const x = transformedCoords[j * valuesPerCoord];
    const y = transformedCoords[j * valuesPerCoord + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const isPoint = (minX === maxX && minY === maxY);
  const buf = isPoint ? (clipMaxX - clipMinX) * POINT_CLIP_BUFFER_RATIO : 0;
  if (maxX < clipMinX - buf || minX > clipMaxX + buf ||
      maxY < clipMinY - buf || minY > clipMaxY + buf) {
    if (__DEV__ && acc) acc.clipEmptyCount++;
    return null;
  }

  if (__DEV__ && acc) t = performance.now();
  geom = wts.geom.applyCoordinates(geom, transformedCoords, valuesPerCoord);
  if (__DEV__ && acc) acc.applyMs += performance.now() - t;

  if (!isPoint) {
    if (__DEV__ && acc) t = performance.now();
    const valid = wts.geom.isValid(geom);
    if (__DEV__ && acc) acc.isValidMs += performance.now() - t;
    if (!valid) {
      const tFix = performance.now();
      geom = wts.geom.util.GeometryFixer.fix(geom);
      const fixElapsed = performance.now() - tFix;
      if (__DEV__ && acc) { acc.fixRepairMs += fixElapsed; acc.fixRepairCount++; }
    }
  }

  // Skip clipping for point features — they don't need geometric intersection,
  // and clipping drops labels whose anchor falls just outside the tile edge.
  // Standard MVT tiles include a buffer zone for the same reason.
  if (isPoint) {
    if (__DEV__ && acc) acc.skipClipCount++;
  } else {
    const clipW = clipMaxX - clipMinX;
    const clipH = clipMaxY - clipMinY;
    const clipBuf = Math.min(clipW, clipH) * CLIP_INSIDE_TOLERANCE_RATIO;
    const fullyInside = minX >= clipMinX - clipBuf && maxX <= clipMaxX + clipBuf &&
                        minY >= clipMinY - clipBuf && maxY <= clipMaxY + clipBuf;

    if (fullyInside) {
      if (__DEV__ && acc) acc.skipClipCount++;
    } else {
      const tClip = performance.now();
      geom = wts.geom.intersection(geom, clipEnvelope);
      const clipElapsed = performance.now() - tClip;
      if (__DEV__ && acc) acc.clipMs += clipElapsed;

      if (wts.geom.isEmpty(geom)) {
        if (__DEV__ && acc) acc.clipEmptyCount++;
        return null;
      }
    }
  }

  if (!isPoint) {
    if (__DEV__ && acc) t = performance.now();
    geom = wts.precision.GeometryPrecisionReducer.reduce(geom, pm);
    if (__DEV__ && acc) acc.precisionMs += performance.now() - t;
  }

  const result: WasmGeometry[] = [];
  const numGeoms = wts.geom.getNumGeometries(geom);
  for (let g = 0; g < numGeoms; g++) {
    result.push(wts.geom.getGeometryN(geom, g));
  }
  return result.length > 0 ? result : null;
}
