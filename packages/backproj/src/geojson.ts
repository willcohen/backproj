/**
 * geojson.ts — GeoJSON FeatureCollection reprojection.
 *
 * Collects all coordinates from all features into a single stride-4 Float64Array,
 * transforms them in one batch call via transformCoordsF64 (2 proj-wasm WASM
 * invocations), then rebuilds the geometry with reprojected coordinates.
 * Returns a deep copy.
 *
 * Features are dropped if any reprojected coordinate is non-finite or if
 * consecutive source coordinates cross the antimeridian (lon jump > 180).
 */
import type { FeatureCollection, Geometry } from 'geojson';
import { transformCoordsF64, Transformer } from './proj.js';
import { profiling } from './profiling.js';

export async function reprojectGeoJSON(
  fc: FeatureCollection,
  transformer: Transformer,
): Promise<FeatureCollection> {
  const enabled = __DEV__ && profiling.enabled;
  let tClone = 0, tCount = 0, tCollect = 0, tTransform = 0, tApply = 0, tFilter = 0;

  if (enabled) tClone = performance.now();
  const cloned: FeatureCollection = JSON.parse(JSON.stringify(fc));
  if (enabled) tClone = performance.now() - tClone;

  if (enabled) tCount = performance.now();
  let totalCoords = 0;
  for (const feature of cloned.features) totalCoords += countCoords(feature.geometry);
  if (enabled) tCount = performance.now() - tCount;

  if (totalCoords === 0) return cloned;

  if (enabled) tCollect = performance.now();
  const original = new Float64Array(totalCoords * 4);
  const featureRingRanges: { start: number; end: number }[][] = [];
  let offset = 0;
  for (const feature of cloned.features) {
    const rings: { start: number; end: number }[] = [];
    offset = collectCoordsF64(feature.geometry, original, offset, rings);
    featureRingRanges.push(rings);
  }
  if (enabled) tCollect = performance.now() - tCollect;

  if (enabled) tTransform = performance.now();
  const reprojected = await transformCoordsF64(original, transformer);
  if (enabled) tTransform = performance.now() - tTransform;

  if (enabled) tApply = performance.now();
  let idx = 0;
  for (const feature of cloned.features) {
    idx = applyFromF64(feature.geometry, reprojected, idx);
  }
  if (enabled) tApply = performance.now() - tApply;

  if (enabled) tFilter = performance.now();
  cloned.features = cloned.features.filter((_feature, i) => {
    const rings = featureRingRanges[i];
    for (const { start, end } of rings) {
      for (let j = start; j < end; j++) {
        const lon = reprojected[j * 4];
        const lat = reprojected[j * 4 + 1];
        if (!isFinite(lon) || !isFinite(lat)) return false;
      }
      if (end - start >= 2) {
        for (let j = start; j < end - 1; j++) {
          const dLon = Math.abs(original[(j + 1) * 4] - original[j * 4]);
          if (dLon > 180) return false;
        }
      }
    }
    return true;
  });
  if (enabled) tFilter = performance.now() - tFilter;

  if (enabled) {
    const total = tClone + tCount + tCollect + tTransform + tApply + tFilter;
    console.debug(
      `[backproj:reprojectGeoJSON] ${totalCoords} coords, ${cloned.features.length}/${fc.features.length} features kept`,
      `total=${fmtMs(total)} clone=${fmtMs(tClone)} collect=${fmtMs(tCollect)} transform=${fmtMs(tTransform)} apply=${fmtMs(tApply)} filter=${fmtMs(tFilter)}`,
    );
  }

  return cloned;
}

function fmtMs(ms: number): string {
  return ms < 0.1 ? '<0.1ms' : ms.toFixed(1) + 'ms';
}

function countCoords(geom: Geometry): number {
  switch (geom.type) {
    case 'Point': return 1;
    case 'MultiPoint':
    case 'LineString': return geom.coordinates.length;
    case 'MultiLineString':
    case 'Polygon': return geom.coordinates.reduce((s, r) => s + r.length, 0);
    case 'MultiPolygon': return geom.coordinates.reduce(
      (s, p) => s + p.reduce((s2, r) => s2 + r.length, 0), 0);
    case 'GeometryCollection': return geom.geometries.reduce((s, g) => s + countCoords(g), 0);
  }
}

function collectCoordsF64(geom: Geometry, f64: Float64Array, offset: number, rings: { start: number; end: number }[]): number {
  const writeCoord = (lon: number, lat: number): void => {
    f64[offset * 4] = lon;
    f64[offset * 4 + 1] = lat;
    offset++;
  };

  switch (geom.type) {
    case 'Point': {
      const start = offset;
      writeCoord(geom.coordinates[0], geom.coordinates[1]);
      rings.push({ start, end: offset });
      break;
    }
    case 'MultiPoint':
    case 'LineString': {
      const start = offset;
      for (const pos of geom.coordinates) writeCoord(pos[0], pos[1]);
      rings.push({ start, end: offset });
      break;
    }
    case 'MultiLineString':
    case 'Polygon':
      for (const ring of geom.coordinates) {
        const start = offset;
        for (const pos of ring) writeCoord(pos[0], pos[1]);
        rings.push({ start, end: offset });
      }
      break;
    case 'MultiPolygon':
      for (const poly of geom.coordinates)
        for (const ring of poly) {
          const start = offset;
          for (const pos of ring) writeCoord(pos[0], pos[1]);
          rings.push({ start, end: offset });
        }
      break;
    case 'GeometryCollection':
      for (const child of geom.geometries) offset = collectCoordsF64(child, f64, offset, rings);
      break;
  }
  return offset;
}

function applyFromF64(geom: Geometry, f64: Float64Array, idx: number): number {
  switch (geom.type) {
    case 'Point':
      geom.coordinates = [f64[idx * 4], f64[idx * 4 + 1]];
      return idx + 1;
    case 'MultiPoint':
    case 'LineString':
      for (let i = 0; i < geom.coordinates.length; i++, idx++)
        geom.coordinates[i] = [f64[idx * 4], f64[idx * 4 + 1]];
      return idx;
    case 'MultiLineString':
    case 'Polygon':
      for (const ring of geom.coordinates)
        for (let i = 0; i < ring.length; i++, idx++)
          ring[i] = [f64[idx * 4], f64[idx * 4 + 1]];
      return idx;
    case 'MultiPolygon':
      for (const poly of geom.coordinates)
        for (const ring of poly)
          for (let i = 0; i < ring.length; i++, idx++)
            ring[i] = [f64[idx * 4], f64[idx * 4 + 1]];
      return idx;
    case 'GeometryCollection':
      for (const child of geom.geometries) idx = applyFromF64(child, f64, idx);
      return idx;
  }
}
