/**
 * mvt.ts — Single-threaded MVT reprojection (no worker pool).
 *
 * Provides reprojectTile(), which runs the full decode -> stitch -> densify
 * -> reproject -> clip -> encode pipeline on the main thread using wasmts
 * directly. Useful for Node.js or testing. For browser use with MapLibre,
 * prefer createTileProcessor() from tile-processor.ts, which offloads the
 * wasmts work to a worker pool.
 *
 * See tile-processor.ts for the full end-to-end data flow diagram.
 */
import type { Geometry as WasmGeometry } from '@wcohen/wasmts';
import type { LRUCache } from 'lru-cache';
import { Transformer, transformCoordsF64 } from './proj.js';
import {
  fakeBoundsForTile, outputTileToRealBounds, chooseInputZoom,
  enumerateInputTiles, TileCoord,
} from './tiling.js';
import { decodeAndGroupTiles, GroupedFeatures } from './mvt-decode.js';
import { encodeTilePbf } from './mvt-encode.js';
import {
  processFeaturePhase1, processFeaturePhase2,
} from './mvt-pipeline.js';
export type { FetchTileFn, OutputFeature } from './mvt-pipeline.js';

// wts is explicit because auto-detection doesn't apply outside browsers.
export async function reprojectTile(
  z: number, x: number, y: number,
  transformer: Transformer,
  fetchTile: (z: number, x: number, y: number) => Promise<ArrayBuffer>,
  wts: typeof import('@wcohen/wasmts'),
  cache?: LRUCache<string, ArrayBuffer>,
): Promise<ArrayBuffer> {
  const realBounds = await outputTileToRealBounds(z, x, y, transformer);

  const inputZ = chooseInputZoom(z, realBounds);
  const inputTiles = enumerateInputTiles(realBounds, inputZ);

  const cachedFetch = async (fz: number, fx: number, fy: number): Promise<ArrayBuffer> => {
    if (!cache) return fetchTile(fz, fx, fy);
    const key = `${fz}/${fx}/${fy}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const data = await fetchTile(fz, fx, fy);
    cache.set(key, data);
    return data;
  };

  const fetched = await Promise.all(
    inputTiles.map(async (coord) => {
      try {
        const data = await cachedFetch(coord.z, coord.x, coord.y);
        return { data, coord };
      } catch {
        return null;
      }
    }),
  );
  const validTiles = fetched.filter(Boolean) as { data: ArrayBuffer; coord: TileCoord }[];

  if (validTiles.length === 0) {
    return new ArrayBuffer(0);
  }

  const groups = decodeAndGroupTiles(validTiles);

  const fakeBounds = fakeBoundsForTile(z, x, y);
  // MVT_EXTENT / tileWidthInFakeDegrees — maps the output tile's coordinate
  // range onto the 4096-unit MVT integer grid for reducePrecision snapping.
  const scale = 4096 / (fakeBounds.east - fakeBounds.west);
  const outputLayers = await processGroups(
    groups, transformer, fakeBounds, scale, wts, z,
  );

  return encodeTilePbf(outputLayers, fakeBounds, wts);
}

async function processGroups(
  groups: GroupedFeatures,
  transformer: Transformer,
  fakeBounds: { west: number; south: number; east: number; north: number },
  scale: number,
  wts: typeof import('@wcohen/wasmts'),
  z: number,
): Promise<Record<string, { id: string; properties: Record<string, any>; geometries: WasmGeometry[] }[]>> {
  // TODO: replace with wts.geom.createEnvelope()+toGeometry() to avoid
  // GeoJSONReader parse overhead per tile.
  const clipEnvelope = wts.io.GeoJSONReader.read(JSON.stringify({
    type: 'Polygon',
    coordinates: [[
      [fakeBounds.west, fakeBounds.south],
      [fakeBounds.east, fakeBounds.south],
      [fakeBounds.east, fakeBounds.north],
      [fakeBounds.west, fakeBounds.north],
      [fakeBounds.west, fakeBounds.south],
    ]],
  }));

  const pm = wts.geom.PrecisionModel.createFixed(scale);
  const clipEnv = wts.geom.getEnvelopeInternal(clipEnvelope);
  const clipMinX = clipEnv.getMinX(), clipMaxX = clipEnv.getMaxX();
  const clipMinY = clipEnv.getMinY(), clipMaxY = clipEnv.getMaxY();
  const layers: Record<string, { id: string; properties: Record<string, any>; geometries: WasmGeometry[] }[]> = {};

  for (const [layerName, features] of Object.entries(groups)) {
    layers[layerName] = [];
    for (const [featureId, fragments] of Object.entries(features)) {
      try {
        const phase1 = processFeaturePhase1(fragments, wts, z);
        if (!phase1) continue;

        const f64 = new Float64Array(phase1.coords.length * 4);
        for (let ci = 0; ci < phase1.coords.length; ci++) {
          const off = ci * 4;
          f64[off] = phase1.coords[ci][0];
          f64[off + 1] = phase1.coords[ci][1];
        }
        const reprojected = await transformCoordsF64(f64, transformer);
        const result = processFeaturePhase2(
          phase1.geom, reprojected, 4, clipEnvelope, clipMinX, clipMaxX, clipMinY, clipMaxY, pm, wts,
        );
        if (result) {
          layers[layerName].push({
            id: featureId,
            properties: fragments[0].properties || {},
            geometries: result,
          });
        }
      } catch {
      }
    }
  }

  return layers;
}
