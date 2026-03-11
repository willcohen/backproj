/**
 * tiling.ts — Tile math for the MVT reprojection pipeline.
 *
 * Maps between the fake-projection tile grid (what MapLibre requests) and
 * the real Web Mercator tile grid (where source tiles live):
 *
 *   fakeBoundsForTile:       output tile (z,x,y) -> fake lon/lat bbox
 *   outputTileToRealBounds:  fake bbox -> real WGS84 bbox (via inverse transform)
 *   chooseInputZoom:         select input zoom (drops when output tile covers
 *                            a large real-world area, e.g. Robinson z2 -> z0)
 *   enumerateInputTiles:     real bbox + zoom -> list of Mercator tile coords
 *   tileLocalToLonLat:       MVT tile-local integers -> real lon/lat
 */
import { Transformer, inverseTransformCoords } from './proj.js';

const MAX_MERC_LAT = 85.051129;

export interface TileCoord {
  z: number;
  x: number;
  y: number;
}

export function fakeBoundsForTile(z: number, x: number, y: number): {
  west: number; south: number; east: number; north: number;
} {
  const n = 2 ** z;
  const west = (x / n) * 360 - 180;
  const east = ((x + 1) / n) * 360 - 180;
  const north = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI;
  const south = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / n))) * 180 / Math.PI;
  return { west, south, east, north };
}

export async function outputTileToRealBounds(
  z: number, x: number, y: number, transformer: Transformer,
): Promise<{ west: number; south: number; east: number; north: number }> {
  const fb = fakeBoundsForTile(z, x, y);

  // 4 samples per edge (20 total) balances accuracy vs WASM call overhead
  // for the inverse transform.
  const samples: [number, number][] = [];
  const EDGE_SAMPLES = 4;
  for (let i = 0; i <= EDGE_SAMPLES; i++) {
    const t = i / EDGE_SAMPLES;
    const lon = fb.west + t * (fb.east - fb.west);
    const lat = fb.south + t * (fb.north - fb.south);
    samples.push([lon, fb.south]);  // bottom edge
    samples.push([lon, fb.north]);  // top edge
    samples.push([fb.west, lat]);   // left edge
    samples.push([fb.east, lat]);   // right edge
  }

  const real = await inverseTransformCoords(samples, transformer);

  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  for (const [lon, lat] of real) {
    if (!isFinite(lon) || !isFinite(lat)) continue;
    west = Math.min(west, lon);
    south = Math.min(south, lat);
    east = Math.max(east, lon);
    north = Math.max(north, lat);
  }
  // All samples non-finite: tile is entirely outside the projection's domain.
  if (west > east) return { west: 0, south: 0, east: 0, north: 0 };
  return { west, south, east, north };
}

// 4x area rule: if the output tile's real-world footprint spans more than
// 4 tile-widths in lon or lat at the current zoom, drop one zoom level.
// Without this, a single output tile in a heavily distorted projection
// (e.g. Robinson at z2) could require hundreds of input tiles. The 4x
// threshold keeps the input tile count manageable while preserving detail.
export function chooseInputZoom(
  outputZ: number,
  realBounds: { west: number; south: number; east: number; north: number },
): number {
  const lonSpan = realBounds.east - realBounds.west;
  const latSpan = realBounds.north - realBounds.south;
  let z = outputZ;
  while (z > 0) {
    const tileSpan = 360 / (2 ** z);
    if (lonSpan > tileSpan * 4 || latSpan > tileSpan * 4) {
      z--;
    } else {
      break;
    }
  }
  return z;
}

export function enumerateInputTiles(
  bounds: { west: number; south: number; east: number; north: number },
  z: number,
): TileCoord[] {
  const n = 2 ** z;

  const clampedSouth = Math.max(-MAX_MERC_LAT, bounds.south);
  const clampedNorth = Math.min(MAX_MERC_LAT, bounds.north);

  function lonToTileX(lon: number): number {
    return Math.floor(((lon + 180) / 360) * n);
  }
  function latToTileY(lat: number): number {
    const latRad = lat * Math.PI / 180;
    return Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
  }

  const yMin = Math.max(0, latToTileY(clampedNorth));
  const yMax = Math.min(n - 1, latToTileY(clampedSouth));

  const tiles: TileCoord[] = [];

  function addRange(westLon: number, eastLon: number) {
    const xMin = Math.max(0, lonToTileX(westLon));
    const xMax = Math.min(n - 1, lonToTileX(eastLon));
    for (let x = xMin; x <= xMax; x++) {
      for (let y = yMin; y <= yMax; y++) {
        tiles.push({ z, x, y });
      }
    }
  }

  if (bounds.west > bounds.east) {
    // Antimeridian crossing: split into [west, 180] and [-180, east]
    addRange(bounds.west, 180);
    addRange(-180, bounds.east);
  } else {
    addRange(bounds.west, bounds.east);
  }

  return tiles;
}

export function tileLocalToLonLat(
  tileX: number, tileY: number,
  z: number, tx: number, ty: number,
  extent: number = 4096,
): [number, number] {
  const n = 2 ** z;
  const lon = ((tx + tileX / extent) / n) * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * (ty + tileY / extent) / n)));
  const lat = latRad * 180 / Math.PI;
  return [lon, lat];
}
