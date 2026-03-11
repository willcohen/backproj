/**
 * mvt-decode.ts — MVT tile decoding and cross-tile feature grouping.
 *
 * Decodes Mapbox Vector Tile PBFs into GeoJSON features (real lon/lat
 * coordinates via @mapbox/vector-tile's toGeoJSON), then groups fragments
 * by (layerName, featureId) across multiple input tiles. Grouped fragments
 * are passed to mvt-pipeline.ts for stitching and reprojection.
 *
 * Feature IDs: uses the MVT numeric ID if present, otherwise derives a
 * stable key from sorted property key=value pairs.
 */
import Pbf from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';
import type { TileCoord } from './tiling.js';

export interface DecodedFeature {
  layerName: string;
  featureId: string | number;
  geojson: GeoJSON.Feature;
}

// TODO: accept a Set of source-layer names and skip decoding unused layers.
// Also filter by geometry type vs style paint layers.
export function decodeTile(
  data: ArrayBuffer,
  tile: TileCoord,
): DecodedFeature[] {
  const vt = new VectorTile(new Pbf(data));
  const features: DecodedFeature[] = [];

  for (const layerName of Object.keys(vt.layers)) {
    const layer = vt.layers[layerName];
    for (let i = 0; i < layer.length; i++) {
      const vtFeature = layer.feature(i);
      const geojson = vtFeature.toGeoJSON(tile.x, tile.y, tile.z);
      const featureId = deriveFeatureId(vtFeature, geojson);
      features.push({ layerName, featureId, geojson });
    }
  }

  return features;
}

function deriveFeatureId(
  vtFeature: any,
  geojson: GeoJSON.Feature,
): string | number {
  if (vtFeature.id != null) return vtFeature.id;
  const props = geojson.properties || {};
  const keys = Object.keys(props).sort();
  return JSON.stringify(Object.fromEntries(keys.map(k => [k, props[k]])));
}

export interface GroupedFeatures {
  [layerName: string]: {
    [featureId: string]: GeoJSON.Feature[];
  };
}

export function decodeAndGroupTiles(
  tiles: { data: ArrayBuffer; coord: TileCoord }[],
): GroupedFeatures {
  const groups: GroupedFeatures = {};

  for (const { data, coord } of tiles) {
    const features = decodeTile(data, coord);
    for (const { layerName, featureId, geojson } of features) {
      if (!groups[layerName]) groups[layerName] = {};
      const key = String(featureId);
      if (!groups[layerName][key]) groups[layerName][key] = [];
      groups[layerName][key].push(geojson);
    }
  }

  return groups;
}
