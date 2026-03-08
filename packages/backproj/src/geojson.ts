import type { FeatureCollection, Geometry } from 'geojson';
import { transformCoords, Transformer } from './proj.js';

/**
 * Reproject a GeoJSON FeatureCollection through a backproj Transformer.
 *
 * Collects all coordinates into a single flat array, transforms them in one
 * batch call (2 WASM invocations total), then rebuilds the geometry with the
 * reprojected coordinates. Returns a deep copy — the input is not mutated.
 *
 * Features are dropped if any reprojected coordinate is non-finite, or if
 * any consecutive pair of SOURCE coordinates crosses the antimeridian
 * (longitude jump > 180 degrees). The antimeridian check uses source
 * coordinates because reprojected fake lon/lat values have no meaningful
 * relationship to geographic longitude.
 */
export async function reprojectGeoJSON(
  fc: FeatureCollection,
  transformer: Transformer,
): Promise<FeatureCollection> {
  const allCoords: [number, number][] = [];
  const cloned: FeatureCollection = JSON.parse(JSON.stringify(fc));

  const featureRingRanges: { start: number; end: number }[][] = [];
  for (const feature of cloned.features) {
    const rings: { start: number; end: number }[] = [];
    collectCoords(feature.geometry, allCoords, rings);
    featureRingRanges.push(rings);
  }

  if (allCoords.length === 0) return cloned;

  const reprojected = await transformCoords(allCoords, transformer);

  let idx = 0;
  for (const feature of cloned.features) {
    idx = applyCoords(feature.geometry, reprojected, idx);
  }

  const beforeCount = cloned.features.length;
  cloned.features = cloned.features.filter((_feature, i) => {
    const rings = featureRingRanges[i];
    for (const { start, end } of rings) {
      for (let j = start; j < end; j++) {
        const [lon, lat] = reprojected[j];
        if (!isFinite(lon) || !isFinite(lat)) return false;
      }
      if (end - start >= 2) {
        for (let j = start; j < end - 1; j++) {
          const dLon = Math.abs(allCoords[j + 1][0] - allCoords[j][0]);
          if (dLon > 180) return false;
        }
      }
    }
    return true;
  });
  console.log(`reprojectGeoJSON: ${beforeCount} features in, ${cloned.features.length} out`);

  return cloned;
}

function collectCoords(geom: Geometry, out: [number, number][], rings: { start: number; end: number }[]): void {
  switch (geom.type) {
    case 'Point': {
      const start = out.length;
      out.push([geom.coordinates[0], geom.coordinates[1]]);
      rings.push({ start, end: out.length });
      break;
    }
    case 'MultiPoint':
    case 'LineString': {
      const start = out.length;
      for (const pos of geom.coordinates) out.push([pos[0], pos[1]]);
      rings.push({ start, end: out.length });
      break;
    }
    case 'MultiLineString':
    case 'Polygon':
      for (const ring of geom.coordinates) {
        const start = out.length;
        for (const pos of ring) out.push([pos[0], pos[1]]);
        rings.push({ start, end: out.length });
      }
      break;
    case 'MultiPolygon':
      for (const poly of geom.coordinates)
        for (const ring of poly) {
          const start = out.length;
          for (const pos of ring) out.push([pos[0], pos[1]]);
          rings.push({ start, end: out.length });
        }
      break;
    case 'GeometryCollection':
      for (const child of geom.geometries) collectCoords(child, out, rings);
      break;
  }
}

function applyCoords(geom: Geometry, coords: [number, number][], idx: number): number {
  switch (geom.type) {
    case 'Point':
      geom.coordinates = [coords[idx][0], coords[idx][1]];
      return idx + 1;
    case 'MultiPoint':
    case 'LineString':
      for (let i = 0; i < geom.coordinates.length; i++, idx++)
        geom.coordinates[i] = [coords[idx][0], coords[idx][1]];
      return idx;
    case 'MultiLineString':
    case 'Polygon':
      for (const ring of geom.coordinates)
        for (let i = 0; i < ring.length; i++, idx++)
          ring[i] = [coords[idx][0], coords[idx][1]];
      return idx;
    case 'MultiPolygon':
      for (const poly of geom.coordinates)
        for (const ring of poly)
          for (let i = 0; i < ring.length; i++, idx++)
            ring[i] = [coords[idx][0], coords[idx][1]];
      return idx;
    case 'GeometryCollection':
      for (const child of geom.geometries)
        idx = applyCoords(child, coords, idx);
      return idx;
  }
}
