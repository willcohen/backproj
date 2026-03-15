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
  wts: typeof import('@wcohen/wasmts'),
  debugTile?: DebugTileInfo | null,
  debugInputBounds?: number[][][] | null,
  debugInputLabels?: { label: string; cx: number; cy: number }[] | null,
  geojsonWriteAcc?: { ms: number } | null,
): ArrayBuffer {
  const gvtLayers: Record<string, GvtLayer> = {};

  for (const [layerName, features] of Object.entries(layers)) {
    const gvtFeatures: GvtFeature[] = [];

    for (const feature of features) {
      for (const geom of feature.geometries) {
        const gvtFeature = geomToGvtFeature(
          geom, feature.properties, fakeBounds, wts, geojsonWriteAcc,
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
        .map(([lon, lat]) => lonLatToTile(lon, lat, fakeBounds))
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
      const [tx, ty] = lonLatToTile(cx, cy, fakeBounds);
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

// TODO: replace GeoJSONWriter.write()+JSON.parse() with tree walk using
// wasmts ring accessors (getExteriorRing, getInteriorRingN, getCoordinateSequence).
function geomToGvtFeature(
  geom: WasmGeometry,
  properties: Record<string, any>,
  fakeBounds: { west: number; south: number; east: number; north: number },
  wts: typeof import('@wcohen/wasmts'),
  geojsonWriteAcc?: { ms: number } | null,
): GvtFeature | null {
  let t0 = 0;
  if (geojsonWriteAcc) t0 = performance.now();
  const geojsonStr = wts.io.GeoJSONWriter.write(geom);
  const geojson = JSON.parse(geojsonStr);
  if (geojsonWriteAcc) geojsonWriteAcc.ms += performance.now() - t0;

  const type = gvtType(geojson.type);
  if (!type) return null;

  const rings = coordsToTileLocal(geojson, fakeBounds);
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

function lonLatToTile(
  lon: number, lat: number,
  fakeBounds: { west: number; south: number; east: number; north: number },
): [number, number] {
  const x = Math.round((lon - fakeBounds.west) / (fakeBounds.east - fakeBounds.west) * EXTENT);
  const y = Math.round((fakeBounds.north - lat) / (fakeBounds.north - fakeBounds.south) * EXTENT);
  return [x, y];
}

function coordsToTileLocal(
  geojson: any,
  fakeBounds: { west: number; south: number; east: number; north: number },
): number[][] | number[][][] | null {
  const t = geojson.type;
  const c = geojson.coordinates;

  if (t === 'Point') {
    const [x, y] = lonLatToTile(c[0], c[1], fakeBounds);
    return [[x, y]];
  }
  if (t === 'MultiPoint') {
    return c.map((p: number[]) => {
      const [x, y] = lonLatToTile(p[0], p[1], fakeBounds);
      return [x, y];
    });
  }
  if (t === 'LineString') {
    return [c.map((p: number[]) => {
      const [x, y] = lonLatToTile(p[0], p[1], fakeBounds);
      return [x, y];
    })];
  }
  if (t === 'MultiLineString') {
    return c.map((line: number[][]) =>
      line.map((p: number[]) => {
        const [x, y] = lonLatToTile(p[0], p[1], fakeBounds);
        return [x, y];
      })
    );
  }
  if (t === 'Polygon') {
    const rings = c.map((ring: number[][]) =>
      ring.map((p: number[]) => {
        const [x, y] = lonLatToTile(p[0], p[1], fakeBounds);
        return [x, y];
      })
    );
    return enforceWindingOrder(rings);
  }
  if (t === 'MultiPolygon') {
    const allRings: number[][][] = [];
    for (const poly of c) {
      const polyRings = poly.map((ring: number[][]) =>
        ring.map((p: number[]) => {
          const [x, y] = lonLatToTile(p[0], p[1], fakeBounds);
          return [x, y];
        })
      );
      allRings.push(...enforceWindingOrder(polyRings));
    }
    return allRings;
  }
  return null;
}
