/**
 * mvt-pipeline.ts — Per-feature geometry processing for MVT reprojection.
 *
 * Implements the two-phase feature pipeline used by tile-worker.ts:
 *
 *   Phase 1 (processFeaturePhase1):
 *     fragments -> stitch (CoverageUnion) -> adaptive densify -> extract coords
 *     Input: GeoJSON fragments for a single feature (possibly from multiple tiles).
 *     Output: [lon, lat][] pair array + wasmts Geometry handle retained for phase 2.
 *
 *   Phase 2 (processFeaturePhase2):
 *     bbox disjoint check -> apply transformed coords -> repair -> bbox inside
 *     check / clip -> snap to grid
 *     Input: the retained Geometry + transformed [lon, lat][] from proj-wasm.
 *     Output: array of clipped, snapped Geometries ready for MVT encoding.
 *
 * Densification tolerance is zoom-dependent: coarser at low zoom (where tile
 * edges span many degrees) and finer at high zoom.
 *
 * All wasmts operations are synchronous. The async coord transformation
 * (proj-wasm) happens on the main thread between the two phases.
 */
import type { Geometry as WasmGeometry } from '@wcohen/wasmts';
type Wts = typeof import('@wcohen/wasmts');

export type FetchTileFn = (z: number, x: number, y: number) => Promise<ArrayBuffer>;

export interface OutputFeature {
  id: string;
  properties: Record<string, any>;
  geometries: WasmGeometry[];
}
export type OutputLayers = Record<string, OutputFeature[]>;

// At zoom z, a Mercator tile edge spans 360/2^z degrees of longitude.
// Without densification, straight edges in lon/lat become distorted arcs
// in the target projection. The formula adds ~8 intermediate points per
// tile edge: 360/(2^z * 8). This gives ~45 degrees at z0, ~5.6 at z2,
// down to the 0.01-degree floor at z14+.
export function densifyTolerance(z: number): number {
  return Math.max(0.01, 360 / (2 ** z * 8));
}

export interface Phase1Accumulator {
  featureCount: number;
  fragmentCount: number;
  stitchMs: number;
  stitchCount: number;
  densifyMs: number;
  coordExtractMs: number;
  coordsProduced: number;
}

export function createPhase1Accumulator(): Phase1Accumulator {
  return {
    featureCount: 0, fragmentCount: 0,
    stitchMs: 0, stitchCount: 0,
    densifyMs: 0, coordExtractMs: 0, coordsProduced: 0,
  };
}

export interface Phase2Accumulator {
  applyMs: number;
  fixMs: number;
  clipMs: number;
  clipEmptyCount: number;
  skipClipCount: number;
  precisionMs: number;
}

export function createPhase2Accumulator(): Phase2Accumulator {
  return { applyMs: 0, fixMs: 0, clipMs: 0, clipEmptyCount: 0, skipClipCount: 0, precisionMs: 0 };
}

// TODO: return Float64Array directly instead of [number,number][] to
// eliminate per-coord pair allocations and the packing loop in tile-worker.
export function processFeaturePhase1(
  fragments: GeoJSON.Feature[], wts: Wts, z: number,
  acc?: Phase1Accumulator | null,
): { coords: [number, number][]; geom: WasmGeometry } | null {
  if (__DEV__ && acc) {
    acc.featureCount++;
    acc.fragmentCount += fragments.length;
  }
  let t = 0;

  // Points never span tile boundaries — skip stitching duplicates from
  // overlapping input tiles (CoverageUnion of identical points returns empty).
  const isPoint = fragments[0].geometry?.type === 'Point' || fragments[0].geometry?.type === 'MultiPoint';
  const parseFragments = isPoint ? [fragments[0]] : fragments;

  const geoms = parseFragments.map(f =>
    wts.io.GeoJSONReader.read(JSON.stringify(f.geometry))
  );

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

  if (__DEV__ && acc) t = performance.now();
  const tolerance = densifyTolerance(z);
  const preCoords = wts.geom.getCoordinates(geom);
  let maxEdge = 0;
  for (let j = 1; j < preCoords.length; j++) {
    const dx = preCoords[j].x - preCoords[j - 1].x;
    const dy = preCoords[j].y - preCoords[j - 1].y;
    const d = Math.abs(dx) > Math.abs(dy) ? Math.abs(dx) : Math.abs(dy);
    if (d > maxEdge) maxEdge = d;
    if (maxEdge >= tolerance) break;
  }
  const needsDensify = maxEdge >= tolerance;
  if (needsDensify) {
    geom = wts.densify.Densifier.densify(geom, tolerance);
  }
  if (__DEV__ && acc) acc.densifyMs += performance.now() - t;

  if (__DEV__ && acc) t = performance.now();
  let pairs: [number, number][];
  if (!needsDensify) {
    pairs = preCoords.map(c => [c.x, c.y] as [number, number]);
  } else {
    const coords = wts.geom.getCoordinates(geom);
    pairs = coords.map(c => [c.x, c.y] as [number, number]);
  }
  if (__DEV__ && acc) {
    acc.coordExtractMs += performance.now() - t;
    acc.coordsProduced += pairs.length;
  }

  return { coords: pairs, geom };
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
  const buf = isPoint ? (clipMaxX - clipMinX) * 0.1 : 0;
  if (maxX < clipMinX - buf || minX > clipMaxX + buf ||
      maxY < clipMinY - buf || minY > clipMaxY + buf) {
    if (__DEV__ && acc) acc.clipEmptyCount++;
    return null;
  }

  if (__DEV__ && acc) t = performance.now();
  geom = wts.geom.applyCoordinates(geom, transformedCoords, valuesPerCoord);
  if (__DEV__ && acc) acc.applyMs += performance.now() - t;

  // Coordinate transform + apply can introduce invalidity.
  if (__DEV__ && acc) t = performance.now();
  if (!wts.geom.isValid(geom)) {
    geom = wts.geom.util.GeometryFixer.fix(geom);
  }
  if (__DEV__ && acc) acc.fixMs += performance.now() - t;

  // Skip clipping for point features — they don't need geometric intersection,
  // and clipping drops labels whose anchor falls just outside the tile edge.
  // Standard MVT tiles include a buffer zone for the same reason.
  if (isPoint) {
    if (__DEV__ && acc) acc.skipClipCount++;
  } else {
    // Features fully inside the clip envelope skip the WASM intersection() call.
    const fullyInside = minX >= clipMinX && maxX <= clipMaxX &&
                        minY >= clipMinY && maxY <= clipMaxY;

    if (fullyInside) {
      if (__DEV__ && acc) acc.skipClipCount++;
    } else {
      if (__DEV__ && acc) t = performance.now();
      geom = wts.geom.intersection(geom, clipEnvelope);
      if (__DEV__ && acc) acc.clipMs += performance.now() - t;

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
