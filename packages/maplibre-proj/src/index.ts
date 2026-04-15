/**
 * maplibre-proj — MapLibre GL JS integration layer for backproj.
 *
 * reprojectStyle() takes a MapLibre style and a CRS string, returns a new
 * style with GeoJSON sources transformed and vector tile sources rewired
 * through protocol handlers that run the MVT reprojection pipeline.
 *
 * Regional CRS also returns maxBounds for viewport lock.
 */
import type { FeatureCollection } from 'geojson';
import {
  initProj,
  buildTransformer,
  buildTransformerPool,
  getWorldBounds,
  reprojectGeoJSON,
  createTileProcessor,
  createTileCache,
  transformCoords,
  debugConfig,
  shutdownTileWorkers as shutdownBackprojWorkers,
} from 'backproj';
import type { Transformer, FetchTileFn, TileProcessor } from 'backproj';
import type { LRUCache } from 'lru-cache';
import { addProtocol, removeProtocol } from 'maplibre-gl';
import { TileQueue } from './tile-queue.js';
import type { StyleSpecification } from 'maplibre-gl';

export type { Transformer } from 'backproj';

export interface ReprojectResult {
  style: StyleSpecification;
  bounds: [[number, number], [number, number]];
  maxBounds?: [[number, number], [number, number]];
  transformer: Transformer;
  cleanup: () => void;
}

let sharedProcessor: TileProcessor | null = null;
let sharedPoolCRS: string | null = null;

// Stable protocol/cache state per source name, reused across reprojectStyle
// calls for the same CRS. Avoids tearing down protocols and losing cached tiles
// when the user toggles unrelated settings (debug labels, data mode, etc.).
const stableProtocols = new Map<string, { protocolId: string; cache: LRUCache<string, ArrayBuffer>; crs: string; queue?: TileQueue }>();

export async function reprojectStyle(options: {
  style: StyleSpecification;
  crs: string;
  transformer?: Transformer;
  tileBoundaries?: boolean;
}): Promise<ReprojectResult> {
  const { crs } = options;
  const style: StyleSpecification = JSON.parse(JSON.stringify(options.style));

  let transformer: Transformer;
  if (options.transformer) {
    transformer = options.transformer;
  } else {
    await initProj();
    transformer = await buildTransformer(crs);
  }

  const activeProtocols: string[] = [];
  const staleProtocols: string[] = [];

  for (const [name, source] of Object.entries(style.sources)) {
    if (source.type === 'geojson' && source.data && typeof source.data === 'object') {
      const fc = source.data as FeatureCollection;
      if (fc.type === 'FeatureCollection') {
        style.sources[name] = { ...source, data: await reprojectGeoJSON(fc, transformer) };
      }
    }

    if (source.type === 'vector' && source.tiles) {
      if (!sharedProcessor) {
        sharedProcessor = await createTileProcessor();
      }
      if (sharedPoolCRS !== crs) {
        const poolSize = typeof navigator !== 'undefined'
          ? (navigator.hardwareConcurrency || 4)
          : 4;
        const tPool = await buildTransformerPool(crs, poolSize);
        sharedProcessor.setTransformerPool(tPool);
        sharedPoolCRS = crs;
      }

      const existing = stableProtocols.get(name);
      let protocolId: string;
      let cache: LRUCache<string, ArrayBuffer>;

      if (existing && existing.crs === crs) {
        protocolId = existing.protocolId;
        cache = existing.cache;
      } else {
        if (existing) {
          staleProtocols.push(existing.protocolId);
          existing.queue?.clear();
          stableProtocols.delete(name);
        }
        protocolId = `reproj-${Date.now()}-${name}`;
        cache = createTileCache();
        const queue = new TileQueue(sharedProcessor.poolSize);
        registerVectorProtocol(
          protocolId, source, transformer, sharedProcessor, cache, queue,
        );
        stableProtocols.set(name, { protocolId, cache, crs, queue });
      }

      source.tiles = source.tiles.map((url: string) =>
        url.startsWith(`${protocolId}://`) ? url : `${protocolId}://${url}`
      );
      activeProtocols.push(protocolId);
    }
  }

  (style as any).projection = { type: 'mercator' };

  const bounds = await getWorldBounds(transformer);

  let maxBounds: [[number, number], [number, number]] | undefined;
  const aou = transformer._areaOfUse;
  const isRegional = transformer._Ox !== 0 || transformer._Oy !== 0;
  if (aou && isRegional) {
    const MAX_BOUNDS_PADDING = 0.10;
    const padLon = (aou.east - aou.west) * MAX_BOUNDS_PADDING;
    const padLat = (aou.north - aou.south) * MAX_BOUNDS_PADDING;
    const mbCorners = await transformCoords(
      [
        [Math.max(-180, aou.west - padLon), Math.max(-89.999999, aou.south - padLat)],
        [Math.min(180, aou.east + padLon), Math.min(89.999999, aou.north + padLat)],
      ],
      transformer,
    );
    if (mbCorners.every(([lon, lat]: [number, number]) => isFinite(lon) && isFinite(lat))) {
      maxBounds = [mbCorners[0], mbCorners[1]];
    }
  }

  debugConfig.labels = options.tileBoundaries ?? false;

  if (options.tileBoundaries) {
    let vectorSourceId: string | null = null;
    for (const [name, source] of Object.entries(style.sources)) {
      if (source.type === 'vector') { vectorSourceId = name; break; }
    }
    if (vectorSourceId) {
      const hasGlyphs = !!style.glyphs;
      // TODO: if custom glyph servers lack these, may need style-based font detection
      const font = ['Open Sans Regular', 'Arial Unicode MS Regular'];

      style.layers.push({
        id: '_debug-borders',
        type: 'line',
        source: vectorSourceId,
        'source-layer': '_debug',
        filter: ['==', '$type', 'LineString'],
        paint: { 'line-color': '#d32f2f', 'line-width': 1.5, 'line-dasharray': [4, 4] },
      });
      if (hasGlyphs) {
        style.layers.push({
          id: '_debug-labels',
          type: 'symbol',
          source: vectorSourceId,
          'source-layer': '_debug',
          filter: ['==', '$type', 'Point'],
          layout: {
            'text-field': ['concat', ['get', 'label'], '\n', ['get', 'size'], '\n', ['get', 'bounds']],
            'text-size': 11,
            'text-allow-overlap': true,
            'text-font': font,
          },
          paint: { 'text-color': '#d32f2f', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 },
        });
      }
      style.layers.push({
        id: '_debug-input-borders',
        type: 'line',
        source: vectorSourceId,
        'source-layer': '_debug_input',
        paint: { 'line-color': '#1565c0', 'line-width': 1.5, 'line-dasharray': [2, 2] },
      });
      if (hasGlyphs) {
        style.layers.push({
          id: '_debug-input-labels',
          type: 'symbol',
          source: vectorSourceId,
          'source-layer': '_debug_input_labels',
          layout: {
            'text-field': ['get', 'label'],
            'text-size': 10,
            'text-allow-overlap': true,
            'text-font': font,
          },
          paint: { 'text-color': '#1565c0', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 },
        });
      }
    }
  } else {
    style.layers = style.layers.filter((l: any) => !l.id.startsWith('_debug'));
  }

  for (const proto of staleProtocols) {
    setTimeout(() => removeProtocol(proto), 5000);
  }

  const cleanup = () => {
    for (const proto of staleProtocols) {
      removeProtocol(proto);
    }
    for (const proto of activeProtocols) {
      removeProtocol(proto);
      for (const [name, entry] of stableProtocols) {
        if (entry.protocolId === proto) {
          entry.queue?.clear();
          stableProtocols.delete(name);
          break;
        }
      }
    }
  };

  return { style, bounds, maxBounds, transformer, cleanup };
}

function registerVectorProtocol(
  protocolId: string,
  source: any,
  transformer: Transformer,
  processor: TileProcessor,
  cache: LRUCache<string, ArrayBuffer>,
  queue: TileQueue,
): void {
  const originalTiles = [...source.tiles];
  const outputCache = createTileCache();

  addProtocol(protocolId, (params: { url: string }, abortController: AbortController) => {
    const url = params.url.replace(`${protocolId}://`, '');

    const match = url.match(/(\d+)\/(\d+)\/(\d+)/);
    if (!match) return Promise.reject(new Error(`Cannot parse tile coords from ${url}`));
    const [, zStr, xStr, yStr] = match;
    const z = parseInt(zStr), x = parseInt(xStr), y = parseInt(yStr);

    const outputKey = `${z}/${x}/${y}`;
    const cached = outputCache.get(outputKey);
    if (cached) return Promise.resolve({ data: cached.slice(0) });

    return new Promise<{ data: ArrayBuffer }>((resolve, reject) => {
      queue.enqueue(outputKey, abortController, async () => {
        const cached2 = outputCache.get(outputKey);
        if (cached2) { resolve({ data: cached2.slice(0) }); return; }

        // Uses first tile URL only. Multi-URL round-robin not implemented.
        const fetchTile: FetchTileFn = async (fz: number, fx: number, fy: number) => {
          const realUrl = originalTiles[0]
            .replace('{z}', String(fz))
            .replace('{x}', String(fx))
            .replace('{y}', String(fy));
          const resp = await fetch(realUrl, { signal: abortController.signal });
          if (!resp.ok) throw new Error(`Tile fetch ${resp.status}: ${realUrl}`);
          return resp.arrayBuffer();
        };

        try {
          const data = await processor.reprojectTile(
            z, x, y, transformer, fetchTile, cache, abortController.signal,
          );
          if (data.byteLength > 0) {
            outputCache.set(outputKey, data.slice(0));
          }
          resolve({ data });
        } catch (err: any) {
          let msg = 'tile processing failed';
          try { msg = err?.message || String(err); } catch {}
          if (!abortController.signal.aborted) {
            console.error('[mvt] protocol handler error:', msg);
          }
          reject(new Error(msg));
        }
      }, () => {
        reject(new Error('aborted'));
      });
    });
  });
}

export function shutdownTileWorkers(): void {
  sharedProcessor = null;
  sharedPoolCRS = null;
  for (const [, entry] of stableProtocols) {
    removeProtocol(entry.protocolId);
    entry.queue?.clear();
  }
  stableProtocols.clear();
  shutdownBackprojWorkers();
}
