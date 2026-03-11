/**
 * tile-processor.ts -- Worker pool orchestrator for MVT reprojection.
 *
 * End-to-end data flow for reprojectTile(z, x, y):
 *
 * MAIN THREAD                            WORKER (tile-worker.ts)
 * -----------                            ----------------------
 * 1. Inverse-project output tile
 *    corners to real WGS84 bbox.
 *    Skip if outside area of use;
 *    clamp to area of use.
 * 2. Choose input zoom level,
 *    enumerate input Mercator tiles.
 * 3. Fetch input tile PBFs
 *    (LRU-cached).
 *    [abort check]
 * 4. Send PBFs to worker --------->  5. PHASE 1: decode PBFs, group
 *                                       fragments by feature ID, stitch
 *                                       (CoverageUnion), adaptive densify,
 *                                       extract flat coord arrays.
 *                                       Retain geometry handles for phase 2.
 *    <--------- coord arrays
 *    [abort check]
 * 6. Batch-transform all coords
 *    via proj-wasm (single
 *    transformCoordsF64 call),
 *    split results per feature.
 *    [abort check]
 * 7. Send transformed coords ---->  8. PHASE 2: apply transformed coords
 *    (+ debug overlay geometry        back onto retained geometries,
 *    if enabled)                      repair invalidity, clip to output
 *                                     tile envelope, snap to MVT grid,
 *                                     encode output PBF.
 *    <--------- encoded PBF
 *
 * WHY TWO PHASES: proj-wasm manages its own internal worker pool with a
 * single shared WASM context. It cannot be instantiated inside another
 * worker (browsers block nested workers). All projection math stays on
 * the main thread; workers handle synchronous wasmts (JTS) geometry
 * operations in both phases, keeping the main thread free between the
 * two postMessage round-trips.
 *
 * The pool round-robins requests across workers. Phase 2 is routed to
 * the same worker that handled phase 1 for a given request, because
 * the worker retains intermediate geometry state between phases.
 *
 * Profiling data flows back from workers via phase1Result/phase2Result
 * messages. performance.mark/measure entries (bp:tile:*, bp:transformCoords:*)
 * appear in the DevTools Performance "Timings" lane when profiling is enabled.
 */
import type { LRUCache } from 'lru-cache';
import { Transformer, transformCoordsF64 } from './proj.js';
import {
  fakeBoundsForTile, outputTileToRealBounds, chooseInputZoom,
  enumerateInputTiles,
} from './tiling.js';
import type { TileCoord } from './tiling.js';
import type { FetchTileFn } from './mvt-pipeline.js';
import {
  profiling, recordTileProfile, setProfilingMetadata,
} from './profiling.js';
import type { WorkerProfile } from './profiling.js';

export interface TileProcessor {
  reprojectTile(
    z: number, x: number, y: number,
    transformer: Transformer,
    fetchTile: FetchTileFn,
    cache?: LRUCache<string, ArrayBuffer>,
    signal?: AbortSignal,
  ): Promise<ArrayBuffer>;
  setTransformerPool(transformers: Transformer[]): void;
  shutdown(): void;
  readonly poolSize: number;
  cleanupRequest(requestId: string): void;
}

export function detectWasmtsUrl(): string | null {
  if (typeof document === 'undefined') return null;

  const el = document.querySelector('script[src*="wasmts"]');
  if (el) return (el as HTMLScriptElement).src;

  const im = document.querySelector('script[type="importmap"]');
  if (im) {
    try {
      const map = JSON.parse(im.textContent || '');
      if (map.imports?.['@wcohen/wasmts'])
        return new URL(map.imports['@wcohen/wasmts'], location.href).href;
    } catch {}
  }

  return null;
}

interface PendingCall {
  resolve: (msg: any) => void;
  reject: (err: Error) => void;
}

interface PoolWorker {
  worker: Worker;
}

const WORKER_INIT_TIMEOUT_MS = 30_000;

async function createWorkerFromUrl(url: string): Promise<Worker> {
  const resp = await fetch(url);
  const text = await resp.text();
  const blob = new Blob([text], { type: 'application/javascript' });
  return new Worker(URL.createObjectURL(blob));
}

class WorkerPool {
  private workers: PoolWorker[] = [];
  private pendingCalls = new Map<string, PendingCall>();
  private nextWorker = 0;
  private requestWorkerMap = new Map<string, number>();
  private profilingSynced = false;
  private debugLabelsSynced = false;

  async init(poolSize: number, wasmtsUrl: string): Promise<void> {
    const workerUrl = new URL('./tile-worker.js', import.meta.url).href;

    const readyPromises: Promise<void>[] = [];

    for (let i = 0; i < poolSize; i++) {
      const worker = await createWorkerFromUrl(workerUrl);
      const pw: PoolWorker = { worker };
      this.workers.push(pw);

      const workerIdx = i;
      const readyPromise = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`Worker ${workerIdx} init timed out after ${WORKER_INIT_TIMEOUT_MS}ms`));
        }, WORKER_INIT_TIMEOUT_MS);

        const onReady = (e: MessageEvent) => {
          if (e.data.cmd === 'ready') {
            clearTimeout(timer);
            worker.removeEventListener('message', onReady);
            resolve();
          }
        };
        worker.addEventListener('message', onReady);
      });
      readyPromises.push(readyPromise);

      worker.addEventListener('error', (e) => {
        console.error(`[tile-processor] worker ${workerIdx} error:`, e.message || e.filename || e.type, 'lineno:', e.lineno, 'colno:', e.colno);
      });

      worker.addEventListener('message', (e: MessageEvent) => {
        const { requestId } = e.data;
        if (!requestId) return;
        const pending = this.pendingCalls.get(requestId + ':' + e.data.cmd);
        if (pending) {
          this.pendingCalls.delete(requestId + ':' + e.data.cmd);
          if (e.data.error) {
            pending.reject(new Error(e.data.error));
          } else {
            pending.resolve(e.data);
          }
        }
      });

      worker.postMessage({ cmd: 'init', wasmtsUrl, workerIdx });
    }

    await Promise.all(readyPromises);
  }

  private pickWorker(): number {
    const idx = this.nextWorker;
    this.nextWorker = (this.nextWorker + 1) % this.workers.length;
    return idx;
  }

  phase1(
    requestId: string,
    tileData: ArrayBuffer[],
    tileCoords: TileCoord[],
    outputZ: number,
  ): Promise<{ coordArrays: Float64Array[] }> {
    const workerIdx = this.pickWorker();
    this.requestWorkerMap.set(requestId, workerIdx);

    return new Promise((resolve, reject) => {
      this.pendingCalls.set(requestId + ':phase1Result', { resolve, reject });
      // Not transferred: tileData buffers may be shared with the LRU cache.
      // Transferring would neuter cached entries. Structured clone is correct here.
      this.workers[workerIdx].worker.postMessage({
        cmd: 'phase1',
        requestId,
        tileData,
        tileCoords,
        outputZ,
      });
    });
  }

  phase2(
    requestId: string,
    transformedCoords: Float64Array[],
    fakeBounds: { west: number; south: number; east: number; north: number },
    scale: number,
    outputZ: number, outputX: number, outputY: number,
    debugInputBounds?: number[][][],
    debugInputLabels?: { label: string; cx: number; cy: number }[],
  ): Promise<{ data: ArrayBuffer }> {
    const workerIdx = this.requestWorkerMap.get(requestId);
    if (workerIdx === undefined) throw new Error(`no worker mapped for requestId ${requestId}`);
    this.requestWorkerMap.delete(requestId);

    const transfer = transformedCoords.map(a => a.buffer);
    return new Promise((resolve, reject) => {
      this.pendingCalls.set(requestId + ':phase2Result', { resolve, reject });
      this.workers[workerIdx].worker.postMessage(
        { cmd: 'phase2', requestId, transformedCoords, fakeBounds, scale, outputZ, outputX, outputY, debugInputBounds, debugInputLabels },
        transfer as any,
      );
    });
  }

  syncConfig(): void {
    if (__DEV__) {
      const wantProfiling = profiling.enabled;
      if (wantProfiling !== this.profilingSynced) {
        for (const pw of this.workers) {
          pw.worker.postMessage({ cmd: 'setConfig', profilingEnabled: wantProfiling });
        }
        this.profilingSynced = wantProfiling;
      }
    }
    const wantDebug = debugConfig.labels;
    if (wantDebug !== this.debugLabelsSynced) {
      for (const pw of this.workers) {
        pw.worker.postMessage({ cmd: 'setConfig', debugLabels: wantDebug });
      }
      this.debugLabelsSynced = wantDebug;
    }
  }

  get size(): number {
    return this.workers.length;
  }

  cleanupRequest(requestId: string): void {
    const workerIdx = this.requestWorkerMap.get(requestId);
    if (workerIdx !== undefined) {
      this.workers[workerIdx].worker.postMessage({ cmd: 'cleanup', requestId });
      this.requestWorkerMap.delete(requestId);
    }
    this.pendingCalls.delete(requestId + ':phase1Result');
    this.pendingCalls.delete(requestId + ':phase2Result');
  }

  shutdown(): void {
    for (const pw of this.workers) {
      pw.worker.terminate();
    }
    this.workers = [];
    this.pendingCalls.clear();
    this.requestWorkerMap.clear();
  }
}

export const debugConfig = { labels: false };

let sharedPool: WorkerPool | null = null;
let nextRequestId = 0;

export async function createTileProcessor(wasmtsUrl?: string): Promise<TileProcessor> {
  if (!sharedPool) {
    const url = wasmtsUrl ?? detectWasmtsUrl();
    if (!url) {
      throw new Error(
        'Could not detect wasmts URL. Include a <script src="...wasmts.js"> tag ' +
        'or pass wasmtsUrl to createTileProcessor().',
      );
    }
    const poolSize = typeof navigator !== 'undefined'
      ? (navigator.hardwareConcurrency || 4)
      : 4;
    sharedPool = new WorkerPool();
    await sharedPool.init(poolSize, url);
    if (__DEV__) setProfilingMetadata({ poolSize });
  }

  const pool = sharedPool;
  let transformerPool: Transformer[] | null = null;
  let nextTransformerIdx = 0;

  return {
    async reprojectTile(
      z: number, x: number, y: number,
      transformer: Transformer,
      fetchTile: FetchTileFn,
      cache?: LRUCache<string, ArrayBuffer>,
      signal?: AbortSignal,
    ): Promise<ArrayBuffer> {
      const effectiveTransformer = transformerPool
        ? transformerPool[nextTransformerIdx++ % transformerPool.length]
        : transformer;
      const requestId = String(nextRequestId++);
      pool.syncConfig();
      const enabled = __DEV__ && profiling.enabled;
      let tTotal = 0, t0 = 0;
      if (__DEV__ && enabled) {
        tTotal = performance.now();
        setProfilingMetadata({ crs: transformer.sourceCRS });
        performance.mark(`bp:tile:start:${requestId}`);
      }

      if (__DEV__ && enabled) t0 = performance.now();
      const realBounds = await outputTileToRealBounds(z, x, y, effectiveTransformer);
      let inverseBoundsMs = 0;
      if (__DEV__ && enabled) inverseBoundsMs = performance.now() - t0;

      // Regional CRS: skip tiles outside the area of use.
      const aou = effectiveTransformer._areaOfUse;
      if (aou) {
        if (realBounds.east < aou.west || realBounds.west > aou.east ||
            realBounds.north < aou.south || realBounds.south > aou.north) {
          return new ArrayBuffer(0);
        }
      }

      // Clamp to area of use to prevent fetching the entire globe.
      if (aou) {
        realBounds.west = Math.max(realBounds.west, aou.west);
        realBounds.east = Math.min(realBounds.east, aou.east);
        realBounds.south = Math.max(realBounds.south, aou.south);
        realBounds.north = Math.min(realBounds.north, aou.north);
      }

      if (__DEV__ && enabled) t0 = performance.now();
      const inputZ = chooseInputZoom(z, realBounds);
      const inputTiles = enumerateInputTiles(realBounds, inputZ);
      let inputTileEnumMs = 0;
      if (__DEV__ && enabled) inputTileEnumMs = performance.now() - t0;

      let cacheHits = 0, cacheMisses = 0;
      const cachedFetch = async (fz: number, fx: number, fy: number): Promise<ArrayBuffer> => {
        if (!cache) {
          if (__DEV__ && enabled) cacheMisses++;
          return fetchTile(fz, fx, fy);
        }
        const key = `${fz}/${fx}/${fy}`;
        const cached = cache.get(key);
        if (cached) {
          if (__DEV__ && enabled) cacheHits++;
          return cached;
        }
        if (__DEV__ && enabled) cacheMisses++;
        const data = await fetchTile(fz, fx, fy);
        cache.set(key, data);
        return data;
      };

      if (__DEV__ && enabled) t0 = performance.now();
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
      let fetchMs = 0;
      if (__DEV__ && enabled) fetchMs = performance.now() - t0;

      if (signal?.aborted) return new ArrayBuffer(0);

      if (validTiles.length === 0) {
        return new ArrayBuffer(0);
      }

      const tileData = validTiles.map(t => t.data);
      const tileCoords = validTiles.map(t => t.coord);

      if (__DEV__ && enabled) t0 = performance.now();
      const phase1Result = await pool.phase1(requestId, tileData, tileCoords, z);
      let phase1RoundtripMs = 0;
      if (__DEV__ && enabled) phase1RoundtripMs = performance.now() - t0;

      const { coordArrays } = phase1Result;
      const phase1WorkerProfile = (phase1Result as any).profile;

      if (signal?.aborted) {
        pool.cleanupRequest(requestId);
        return new ArrayBuffer(0);
      }

      if (coordArrays.length === 0) {
        return new ArrayBuffer(0);
      }

      if (__DEV__ && enabled) t0 = performance.now();
      let totalCoords = 0;
      for (const flat of coordArrays) totalCoords += flat.length / 4;

      const allF64 = new Float64Array(totalCoords * 4);
      let writeIdx = 0;
      for (const flat of coordArrays) {
        allF64.set(flat, writeIdx);
        writeIdx += flat.length;
      }
      let marshalMs = 0;
      if (__DEV__ && enabled) marshalMs = performance.now() - t0;

      if (__DEV__ && enabled) t0 = performance.now();
      const allTransformed = await transformCoordsF64(allF64, effectiveTransformer);
      let transformCoordsMs = 0;
      if (__DEV__ && enabled) {
        transformCoordsMs = performance.now() - t0;
        performance.measure(`bp:transformCoords:${requestId}`, { start: t0, duration: transformCoordsMs });
      }

      if (signal?.aborted) {
        pool.cleanupRequest(requestId);
        return new ArrayBuffer(0);
      }

      if (__DEV__ && enabled) t0 = performance.now();
      const transformedArrays: Float64Array[] = [];
      let readIdx = 0;
      for (const flat of coordArrays) {
        const len = flat.length;
        transformedArrays.push(allTransformed.slice(readIdx, readIdx + len));
        readIdx += len;
      }
      if (__DEV__ && enabled) marshalMs += performance.now() - t0;

      const fakeBounds = fakeBoundsForTile(z, x, y);
      const scale = 4096 / (fakeBounds.east - fakeBounds.west);

      let debugInputBounds: number[][][] | undefined;
      let debugInputLabels: { label: string; cx: number; cy: number }[] | undefined;
      if (debugConfig.labels) {
        const EDGE_PTS = 16;
        const MAX_MERC_LAT = 85.051129;
        const allBoundaryPts: [number, number][] = [];
        const tilePtCounts: number[] = [];
        const tileCenters: [number, number][] = [];
        const tileLabels: string[] = [];
        for (const tc of tileCoords) {
          const tn = 2 ** tc.z;
          const w = (tc.x / tn) * 360 - 180;
          const e = ((tc.x + 1) / tn) * 360 - 180;
          const nLat = Math.atan(Math.sinh(Math.PI * (1 - 2 * tc.y / tn))) * 180 / Math.PI;
          const sLat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (tc.y + 1) / tn))) * 180 / Math.PI;
          const clampN = Math.min(MAX_MERC_LAT, nLat);
          const clampS = Math.max(-MAX_MERC_LAT, sLat);
          const pts: [number, number][] = [];
          for (let i = 0; i <= EDGE_PTS; i++) {
            const t = i / EDGE_PTS;
            pts.push([w + t * (e - w), clampS]);        // bottom
          }
          for (let i = 0; i <= EDGE_PTS; i++) {
            const t = i / EDGE_PTS;
            pts.push([e, clampS + t * (clampN - clampS)]); // right
          }
          for (let i = 0; i <= EDGE_PTS; i++) {
            const t = i / EDGE_PTS;
            pts.push([e - t * (e - w), clampN]);         // top (reversed)
          }
          for (let i = 0; i <= EDGE_PTS; i++) {
            const t = i / EDGE_PTS;
            pts.push([w, clampN - t * (clampN - clampS)]); // left (reversed)
          }
          tilePtCounts.push(pts.length);
          allBoundaryPts.push(...pts);
          tileCenters.push([(w + e) / 2, (clampS + clampN) / 2]);
          tileLabels.push(`${tc.z}/${tc.x}/${tc.y}`);
        }
        // Transform boundary points + center points together
        const totalPts = allBoundaryPts.length + tileCenters.length;
        const dbgF64 = new Float64Array(totalPts * 4);
        for (let i = 0; i < allBoundaryPts.length; i++) {
          dbgF64[i * 4] = allBoundaryPts[i][0];
          dbgF64[i * 4 + 1] = allBoundaryPts[i][1];
        }
        for (let i = 0; i < tileCenters.length; i++) {
          const off = (allBoundaryPts.length + i) * 4;
          dbgF64[off] = tileCenters[i][0];
          dbgF64[off + 1] = tileCenters[i][1];
        }
        const dbgTransformed = await transformCoordsF64(dbgF64, effectiveTransformer);
        debugInputBounds = [];
        debugInputLabels = [];
        let off = 0;
        for (let ti = 0; ti < tilePtCounts.length; ti++) {
          const count = tilePtCounts[ti];
          const ring: number[][] = [];
          for (let j = 0; j < count; j++) {
            const fx = dbgTransformed[off * 4];
            const fy = dbgTransformed[off * 4 + 1];
            if (isFinite(fx) && isFinite(fy)) ring.push([fx, fy]);
            off++;
          }
          if (ring.length > 1) debugInputBounds.push(ring);
          const cOff = (allBoundaryPts.length + ti) * 4;
          const cx = dbgTransformed[cOff];
          const cy = dbgTransformed[cOff + 1];
          if (isFinite(cx) && isFinite(cy)) {
            debugInputLabels.push({ label: tileLabels[ti], cx, cy });
          }
        }
      }

      if (__DEV__ && enabled) t0 = performance.now();
      const phase2Result = await pool.phase2(requestId, transformedArrays, fakeBounds, scale, z, x, y, debugInputBounds, debugInputLabels);
      let phase2RoundtripMs = 0;
      if (__DEV__ && enabled) phase2RoundtripMs = performance.now() - t0;

      const { data } = phase2Result;
      const phase2WorkerProfile = (phase2Result as any).profile;

      if (__DEV__ && enabled) {
        const workerProfile: WorkerProfile = {
          workerId: phase1WorkerProfile?.workerId ?? -1,
          phase1Ms: phase1WorkerProfile?.phase1Ms ?? phase1RoundtripMs,
          phase1Detail: phase1WorkerProfile?.phase1Detail ?? emptyPhase1Detail(),
          phase2Ms: phase2WorkerProfile?.phase2Ms ?? phase2RoundtripMs,
          phase2Detail: phase2WorkerProfile?.phase2Detail ?? emptyPhase2Detail(),
          idleBeforePhase1Ms: phase1WorkerProfile?.idleBeforePhase1Ms ?? 0,
          interPhaseIdleMs: phase1WorkerProfile?.interPhaseIdleMs ?? 0,
        };

        recordTileProfile({
          tileKey: `${z}/${x}/${y}`,
          requestId,
          totalMs: performance.now() - tTotal,
          inverseBoundsMs,
          inputTileEnumMs,
          fetchMs,
          fetchCount: inputTiles.length,
          cacheHits,
          cacheMisses,
          transformCoordsMs,
          coordCount: totalCoords,
          marshalMs,
          worker: workerProfile,
        });

        performance.measure(`bp:tile:${z}/${x}/${y}`, `bp:tile:start:${requestId}`);
      }

      return data;
    },

    get poolSize(): number {
      return pool.size;
    },

    cleanupRequest(requestId: string): void {
      pool.cleanupRequest(requestId);
    },

    setTransformerPool(transformers: Transformer[]): void {
      transformerPool = transformers;
      nextTransformerIdx = 0;
    },

    shutdown(): void {
      if (sharedPool === pool) {
        sharedPool.shutdown();
        sharedPool = null;
      }
    },
  };
}

export function shutdownTileWorkers(): void {
  if (sharedPool) {
    sharedPool.shutdown();
    sharedPool = null;
  }
}

function emptyPhase1Detail(): import('./profiling.js').Phase1Detail {
  return {
    decodeMs: 0, featureCount: 0, fragmentCount: 0,
    stitchMs: 0, stitchCount: 0,
    densifyMs: 0, coordExtractMs: 0, coordsProduced: 0,
  };
}

function emptyPhase2Detail(): import('./profiling.js').Phase2Detail {
  return {
    applyMs: 0, fixMs: 0, clipMs: 0, clipEmptyCount: 0, skipClipCount: 0,
    precisionMs: 0, encodeMs: 0, outputFeatureCount: 0, outputBytes: 0,
  };
}
