/**
 * mvt-encode.ts — Encode reprojected features into an MVT PBF.
 *
 * Takes wasmts Geometries in fake lon/lat space (output of mvt-pipeline.ts),
 * converts them to tile-local integer coordinates (extent 4096) using the
 * output tile's fake bounds, and encodes via vt-pbf.
 *
 * Debug overlay layers (_debug, _debug_input, _debug_input_labels) are
 * not gated by __DEV__ -- they ship in prod builds.
 */
import { fromGeojsonVt } from 'vt-pbf';
import type { Geometry as WasmGeometry } from '@wcohen/wasmts';
import type { OutputLayers } from './mvt-pipeline.js';

const EXTENT = 4096;

// In tile coords (Y-down): positive = CW, negative = CCW.
function ringSignedArea(ring: number[][]): number {
  let area = 0;
  for (let i = 0, len = ring.length, j = len - 1; i < len; j = i++) {
    area += (ring[j][0] - ring[i][0]) * (ring[i][1] + ring[j][1]);
  }
  return area;
}

// MVT spec: exterior rings CW (positive signed area in Y-down tile coords),
// interior rings CCW (negative). The Y-flip in lonLatToTile() reverses
// GeoJSON winding, but JTS operations (fix, intersection, reduce) may produce
// non-standard winding that the flip doesn't correct. Enforce explicitly.
function enforceWindingOrder(rings: number[][][]): number[][][] {
  for (let i = 0; i < rings.length; i++) {
    const area = ringSignedArea(rings[i]);
    const shouldBeCW = i === 0; // exterior ring
    if (shouldBeCW ? area < 0 : area > 0) {
      rings[i].reverse();
    }
  }
  return rings;
}

interface GvtFeature {
  geometry: number[][] | number[][][];
  type: 1 | 2 | 3;
  tags: Record<string, any>;
}

interface GvtLayer {
  features: GvtFeature[];
}

export interface DebugTileInfo {
  z: number;
  x: number;
  y: number;
}

export function encodeTilePbf(
  layers: OutputLayers,
  fakeBounds: { west: number; south: number; east: number; north: number },
  wts: typeof wasmts,
  debugTile?: DebugTileInfo | null,
  debugInputBounds?: number[][][] | null,
  debugInputLabels?: { label: string; cx: number; cy: number }[] | null,
  geojsonWriteAcc?: { ms: number } | null,
): ArrayBuffer {
  const tm = buildTileMapping(fakeBounds);
  const gvtLayers: Record<string, GvtLayer> = {};

  for (const [layerName, features] of Object.entries(layers)) {
    const gvtFeatures: GvtFeature[] = [];

    for (const feature of features) {
      for (const geom of feature.geometries) {
        const gvtFeature = geomToGvtFeature(
          geom, feature.properties, tm, wts, geojsonWriteAcc,
        );
        if (gvtFeature) gvtFeatures.push(gvtFeature);
      }
    }

    if (gvtFeatures.length > 0) {
      gvtLayers[layerName] = { features: gvtFeatures };
    }
  }

  if (debugTile) {
    const w = fakeBounds.east - fakeBounds.west;
    const h = fakeBounds.north - fakeBounds.south;
    const cx = Math.round(EXTENT / 2);
    const cy = Math.round(EXTENT / 2);
    const E = EXTENT;
    gvtLayers['_debug'] = {
      features: [
        {
          geometry: [[cx, cy]] as any,
          type: 1,
          tags: {
            label: `${debugTile.z}/${debugTile.x}/${debugTile.y}`,
            bounds: `${fakeBounds.west.toFixed(2)},${fakeBounds.south.toFixed(2)} ${fakeBounds.east.toFixed(2)},${fakeBounds.north.toFixed(2)}`,
            size: `${w.toFixed(4)} x ${h.toFixed(4)}`,
          },
        },
        {
          geometry: [[[0, 0], [E, 0], [E, E], [0, E], [0, 0]]],
          type: 2,
          tags: {},
        },
      ],
    };
  }

  // MapLibre warns "Geometry exceeds allowed extent" for coordinates far
  // outside [0, EXTENT]. Clamp debug geometry to 2x extent to avoid this.
  const DBG_MIN = -EXTENT;
  const DBG_MAX = 2 * EXTENT;

  if (debugInputBounds && debugInputBounds.length > 0) {
    const inputFeatures: GvtFeature[] = [];
    for (let i = 0; i < debugInputBounds.length; i++) {
      const ring = debugInputBounds[i];
      const tileRing = ring
        .map(([lon, lat]) => lonLatToTile(lon, lat, tm))
        .filter(([x, y]) => x >= DBG_MIN && x <= DBG_MAX && y >= DBG_MIN && y <= DBG_MAX);
      if (tileRing.length >= 2) {
        inputFeatures.push({
          geometry: [tileRing],
          type: 2,
          tags: { idx: i },
        });
      }
    }
    if (inputFeatures.length > 0) {
      gvtLayers['_debug_input'] = { features: inputFeatures };
    }
  }

  if (debugInputLabels && debugInputLabels.length > 0) {
    const labelFeatures: GvtFeature[] = [];
    for (const { label, cx, cy } of debugInputLabels) {
      const [tx, ty] = lonLatToTile(cx, cy, tm);
      if (tx >= DBG_MIN && tx <= DBG_MAX && ty >= DBG_MIN && ty <= DBG_MAX) {
        labelFeatures.push({
          geometry: [[tx, ty]],
          type: 1,
          tags: { label },
        });
      }
    }
    if (labelFeatures.length > 0) {
      gvtLayers['_debug_input_labels'] = { features: labelFeatures };
    }
  }

  if (Object.keys(gvtLayers).length === 0) {
    return new ArrayBuffer(0);
  }

  const pbf = fromGeojsonVt(gvtLayers, { version: 2, extent: EXTENT });
  return (pbf.buffer as ArrayBuffer).slice(pbf.byteOffset, pbf.byteOffset + pbf.byteLength);
}

function geomToGvtFeature(
  geom: WasmGeometry,
  properties: Record<string, any>,
  tm: TileMapping,
  wts: typeof wasmts,
  geojsonWriteAcc?: { ms: number } | null,
): GvtFeature | null {
  // toFlat instead of GeoJsonWriter.write() + JSON.parse(): the writer costs a
  // JSON text serialize in Java and a parse in JS, and nothing here wants text.
  // toFlat hands back the same structure directly -- ringOffsets delimits rings,
  // partOffsets delimits polygons, which is exactly what enforceWindingOrder
  // needs to run per polygon.
  let t0 = 0;
  if (geojsonWriteAcc) t0 = performance.now();
  const flat = wts.geom.toFlat(geom, 2);
  if (geojsonWriteAcc) geojsonWriteAcc.ms += performance.now() - t0;

  const type = gvtType(flat.type);
  if (!type) return null;

  const rings = flatToTileLocal(flat, tm);
  if (!rings || rings.length === 0) return null;

  return { geometry: rings, type, tags: properties };
}

function gvtType(geojsonType: string): 1 | 2 | 3 | null {
  switch (geojsonType) {
    case 'Point':
    case 'MultiPoint':
      return 1;
    case 'LineString':
    case 'MultiLineString':
      return 2;
    case 'Polygon':
    case 'MultiPolygon':
      return 3;
    default:
      return null;
  }
}

// Mercator y for a latitude in degrees.  Same formula as the tile-grid
// inverse in tiling.ts, just the forward direction.
function latToMercY(latDeg: number): number {
  return Math.log(Math.tan(Math.PI / 4 + (latDeg * Math.PI) / 360));
}

// Precomputed per-tile constants so lonLatToTile avoids redundant trig.
interface TileMapping {
  west: number;
  invLonSpan: number;  // EXTENT / (east - west)
  mercNorth: number;
  invMercSpan: number; // EXTENT / (mercNorth - mercSouth)
}

export function buildTileMapping(
  fakeBounds: { west: number; south: number; east: number; north: number },
): TileMapping {
  const mercNorth = latToMercY(fakeBounds.north);
  const mercSouth = latToMercY(fakeBounds.south);
  return {
    west: fakeBounds.west,
    invLonSpan: EXTENT / (fakeBounds.east - fakeBounds.west),
    mercNorth,
    invMercSpan: EXTENT / (mercNorth - mercSouth),
  };
}

function lonLatToTile(
  lon: number, lat: number, tm: TileMapping,
): [number, number] {
  const x = Math.round((lon - tm.west) * tm.invLonSpan);
  // MVT tile y is linear in Mercator y, not latitude.
  const y = Math.round((tm.mercNorth - latToMercY(lat)) * tm.invMercSpan);
  return [x, y];
}

// toFlat is always called with dim 2 here, so coords are xy pairs.
interface FlatGeometry {
  type: string;
  coords: Float64Array;
  ringOffsets: Int32Array | null;
  partOffsets: Int32Array | null;
}

// Coordinates [start, end) of the flat buffer, projected to tile-local ints.
function ringToTileLocal(
  coords: Float64Array, start: number, end: number, tm: TileMapping,
): number[][] {
  const out: number[][] = new Array(end - start);
  for (let i = start; i < end; i++) {
    out[i - start] = lonLatToTile(coords[i * 2], coords[i * 2 + 1], tm);
  }
  return out;
}

// Rings [ringStart, ringEnd) of ringOffsets, as one polygon's worth.
function ringsOf(
  f: FlatGeometry, ringStart: number, ringEnd: number, tm: TileMapping,
): number[][][] {
  const ro = f.ringOffsets!;
  const rings: number[][][] = new Array(ringEnd - ringStart);
  for (let r = ringStart; r < ringEnd; r++) {
    rings[r - ringStart] = ringToTileLocal(f.coords, ro[r], ro[r + 1], tm);
  }
  return rings;
}

// An empty ring makes vt-pbf write a MoveTo header with no coordinate pairs,
// which decodes as a stray vertex at the tile corner (verified for both line and
// polygon features). Empty rings arrive routinely rather than exceptionally:
// phase2 reduces precision after its last isEmpty guard, so any geometry smaller
// than a tile unit reaches here collapsed.
//
// Polygons also need this for parity with the retired GeoJsonWriter walk, which
// spelled an empty polygon as zero rings where toFlat always emits the exterior
// ring. Lines emitted the stray vertex on both walks, so the frozen reference in
// encode-flat.test.mjs reproduces that bug and deliberately disagrees here.
function dropEmptyRings(rings: number[][][]): number[][][] {
  return rings.filter(ring => ring.length > 0);
}

// The toFlat equivalent of walking parsed GeoJSON coordinates. Offsets carry the
// structure, so this reads the same shape without the text round trip.
// Exported for tests/encode-flat.test.mjs, which differentials it against the
// GeoJSON walk it replaced -- winding order is restructured here and nothing
// else covers it.
export function flatToTileLocal(
  f: FlatGeometry, tm: TileMapping,
): number[][] | number[][][] | null {
  const n = f.coords.length / 2;

  switch (f.type) {
    case 'Point':
    case 'MultiPoint':
      return ringToTileLocal(f.coords, 0, n, tm);
    case 'LineString':
      return dropEmptyRings([ringToTileLocal(f.coords, 0, n, tm)]);
    case 'MultiLineString':
      return dropEmptyRings(ringsOf(f, 0, f.ringOffsets!.length - 1, tm));
    case 'Polygon':
      return enforceWindingOrder(dropEmptyRings(ringsOf(f, 0, f.ringOffsets!.length - 1, tm)));
    case 'MultiPolygon': {
      // Winding is enforced per polygon, so partOffsets has to drive this --
      // running it across every ring at once would treat the second polygon's
      // shell as a hole.
      const po = f.partOffsets!;
      const all: number[][][] = [];
      for (let i = 0; i < po.length - 1; i++) {
        all.push(...enforceWindingOrder(dropEmptyRings(ringsOf(f, po[i], po[i + 1], tm))));
      }
      return all;
    }
    default:
      return null;
  }
}
