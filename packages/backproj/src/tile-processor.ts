/**
 * tile-processor.ts -- Joint-pool orchestrator for MVT reprojection.
 *
 * A single worker-router WorkerPool hosts BOTH the wasmts handler
 * (phase1/phase2 geometry ops) and the proj handler (PROJ ccall
 * dispatch). Per tile, phase1, proj.transformCoordsF64, and phase2 all
 * run on the same worker, eliminating cross-pool coord transfer.
 *
 * End-to-end data flow for reprojectTile(z, x, y):
 *
 * MAIN THREAD                            JOINT-POOL WORKER (one per request)
 * -----------                            ----------------------------------
 * 1. Inverse-project output tile
 *    corners to real WGS84 bbox.
 *    Skip if outside area of use;
 *    clamp to area of use.
 * 2. Choose input zoom level,
 *    enumerate input Mercator tiles.
 * 3. Fetch input tile PBFs
 *    (LRU-cached).
 *    [abort check]
 * 4. wasmts.chain RPC ------------>     5. PHASE 1: decode PBFs, group
 *    (tile bytes + PJ pointers             fragments by feature ID, stitch,
 *     + phase2 params)                     adaptive densify, extract flat
 *                                          coord arrays.
 *                                       6. TRANSFORM: proj_trans_array on
 *                                          the co-resident proj handler,
 *                                          direct call, no RPC hop.
 *                                       7. PHASE 2: apply transformed
 *                                          coords, repair, clip, snap,
 *                                          encode.
 *    <----- encoded PBF
 *
 * The transformer pool ties tile dispatch to worker affinity: each
 * transformer's PJ was created on a specific worker (by proj-wasm's
 * context_create claim), and the chain RPC targets that worker, where
 * the PJ pointer is valid and the proj handler is co-resident.
 */
import type { LRUCache } from 'lru-cache';
import {
  Transformer, transformCoordsF64, MAX_MERC_LAT,
  initProj, shutdownProj, projPoolMismatch,
} from './proj.js';
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
import {
  isCaptureEnabled, recordInputRequest, recordTileBytes,
} from './capture.js';
import { worker_call, pool_size } from 'ffi-wasm/pool';
import {
  register_handler_BANG_, make_wiring_BANG_, ensure_wired_BANG_,
  wiring_pool, shutdown_wiring_BANG_,
} from 'ffi-wasm/workload-pool';
import { handlerSpec, handlerDefaultInitArgs } from 'proj-wasm';

export interface TileProcessor {
  reprojectTile(
    z: number, x: number, y: number,
    transformer: Transformer,
    fetchTile: FetchTileFn,
    cache?: LRUCache<string, ArrayBuffer>,
    signal?: AbortSignal,
    outputRequestId?: string,
  ): Promise<ArrayBuffer>;
  setTransformerPool(transformers: Transformer[]): void;
  /** Resolves when the pool and proj-wasm teardown have completed; a
   *  caller that rebuilds immediately must await it, or the late
   *  teardown races the next pool's init. */
  shutdown(): Promise<void>;
  readonly poolSize: number;
  /** The underlying worker-router pool. Observability for the lifecycle
   *  test (pool goes null after shutdown); reads through the registry. */
  readonly pool: any;
}

const WASMTS_HANDLER_KEY = 'net.willcohen.wasmts';

const isNode = (() => {
  const p = (globalThis as any).process;
  return !!(p && p.versions && p.versions.node);
})();

/**
 * proj-wasm tags returned PJ objects with the worker they were created on;
 * _tFwd covers the compound-CRS case where _tPipeline is undefined. A null
 * return is a broken state, not a graceful one: the chain RPC would land
 * on an arbitrary worker where the transformer's PJ pointer is not valid.
 */
function workerIdxFromTransformer(t: Transformer): number | null {
  const tp: any = t._tPipeline;
  if (tp && typeof tp.worker_idx === 'number') return tp.worker_idx;
  const fwd: any = t._tFwd;
  if (fwd && typeof fwd.worker_idx === 'number') return fwd.worker_idx;
  return null;
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

export interface CreateTileProcessorOpts {
  wasmtsUrl?: string;
  /** Worker count; defaults to navigator.hardwareConcurrency. Only honored
   *  on the first createTileProcessor call. A different knob from tiles in
   *  flight: shrinking the pool does not bound fan-out; queued chain calls
   *  hold their tile bytes in the worker inbox until they run. */
  poolSize?: number;
}

class JointPoolClient {
  /** One clj-native wiring per client: it owns the registry of the
   *  current lifecycle and the memo that makes the wiring pass run once. */
  private wiring: any = make_wiring_BANG_();
  private profilingSynced = false;
  private debugLabelsSynced = false;
  private workerCount = 0;
  private projAdopted = false;

  /** Live pool via wiring_pool (TS cannot deref squint atoms directly).
   *  Null before init and after shutdown. */
  get pool(): any {
    return wiring_pool(this.wiring);
  }

  /**
   * Run the wiring pass with every handler spec registered, then hand
   * the one pool to proj-wasm via proj.init({pool}) so proj-wasm adopts
   * it instead of spawning its own. Returns the pool size after init.
   */
  async init(
    poolSize: number,
    wasmtsHandlerOpts: WasmtsHandlerOpts,
  ): Promise<number> {
    // The wiring pass folds every handler spec into one worker-router
    // pool. handlerDefaultInitArgs reads proj's db/ini assets, an async
    // read, which is why registration happens inside the pass.
    const pool = await ensure_wired_BANG_(this.wiring, {
      'registry-opts': { size: poolSize },
      'register!': async (registry: any) => {
        // The proj handler registers THROUGH the bridge so the created
        // instance is reachable by the co-resident wasmts handler (chain
        // fusion). Spread keeps proj's pre-terminate hook on the entry.
        const projSpec: any = handlerSpec(await handlerDefaultInitArgs({}));
        const bridgeUrl = new URL('./proj-handler-bridge.mjs', import.meta.url).href;
        register_handler_BANG_(registry, 'compute', 'net.willcohen.proj', {
          ...projSpec,
          module: bridgeUrl,
          args: { projHandlerUrl: projSpec.module, projArgs: projSpec.args },
        });

        // wasmts-handler.mjs ships in backproj's own dist next to backproj.mjs.
        const wasmtsHandlerUrl = new URL('./wasmts-handler.mjs', import.meta.url).href;
        register_handler_BANG_(registry, 'compute', WASMTS_HANDLER_KEY,
          { module: wasmtsHandlerUrl, args: { ...wasmtsHandlerOpts, projBridgeUrl: bridgeUrl } });
      },
    });
    this.workerCount = pool_size(pool);

    // proj.init({pool}) adopts (owned=false) instead of spawning its own
    // pool. A bare initProj() before createTileProcessor leaves proj-wasm
    // on its own workers, and its init memo swallows the adoption below:
    // every PJ then lives on workers the fused chain never targets, and
    // each chain traps with "memory access out of bounds" on the foreign
    // pointer. Tear the standalone init down and re-init onto this pool.
    if (projPoolMismatch(pool)) {
      await shutdownProj();
    }
    await initProj({ pool });
    this.projAdopted = true;

    return this.workerCount;
  }

  async syncConfig(): Promise<void> {
    if (__DEV__) {
      const wantProfiling = profiling.enabled;
      if (wantProfiling !== this.profilingSynced) {
        await this.broadcastSetConfig({ profilingEnabled: wantProfiling });
        this.profilingSynced = wantProfiling;
      }
    }
    const wantDebug = debugConfig.labels;
    if (wantDebug !== this.debugLabelsSynced) {
      await this.broadcastSetConfig({ debugLabels: wantDebug });
      this.debugLabelsSynced = wantDebug;
    }
  }

  private async broadcastSetConfig(args: any): Promise<void> {
    const promises: Promise<any>[] = [];
    for (let i = 0; i < this.workerCount; i++) {
      promises.push(worker_call(this.pool, WASMTS_HANDLER_KEY, 'setConfig',
        [{ ...args, workerIdx: i }], i));
    }
    await Promise.all(promises);
  }

  chain(args: any, workerIdx: number | null): Promise<{
    data: ArrayBuffer | Uint8Array;
    coordCount: number;
    transformMs?: number;
    phase1Profile?: any;
    phase2Profile?: any;
  }> {
    return worker_call(this.pool, WASMTS_HANDLER_KEY, 'chain', [args], workerIdx);
  }

  get size(): number { return this.workerCount; }

  /**
   * shutdownProj() BEFORE this client's teardown, and the order is
   * load-bearing: proj-wasm holds its own wiring, and only shutdownProj
   * clears its memo. A stale memo would hand the next initProj the cached
   * pool and route every transform to dead workers. Pinned by
   * pool-lifecycle.test.mjs.
   */
  async shutdown(): Promise<void> {
    if (this.projAdopted) {
      this.projAdopted = false;
      await shutdownProj();
    }
    // Resolves to null and does nothing when this client never wired.
    await shutdown_wiring_BANG_(this.wiring);
    this.workerCount = 0;
  }
}

interface WasmtsHandlerOpts {
  wasmtsJsUrl: string;
  wasmtsWasmBinary?: ArrayBuffer | Uint8Array;
}

async function buildWasmtsHandlerOpts(wasmtsUrl?: string): Promise<WasmtsHandlerOpts> {
  if (isNode) {
    // Resolve @wcohen/wasmts main + sibling .wasm. Dynamic-import 'fs' and
    // 'url' here so the browser bundle doesn't pull node-only modules at
    // static-import time.
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    // @ts-ignore -- import.meta.resolve is sync stable in Node 20.6+
    const wasmtsJsUrl: string = (import.meta as any).resolve('@wcohen/wasmts');
    const wasmtsWasmUrl = new URL('./wasmts.js.wasm', wasmtsJsUrl).href;
    const wasmtsWasmBinary = readFileSync(fileURLToPath(wasmtsWasmUrl));
    return { wasmtsJsUrl, wasmtsWasmBinary };
  }
  // Browser: use the caller-provided URL or detect from the page; native fetch
  // handles the .wasm sibling.
  const resolved = wasmtsUrl ?? detectWasmtsUrl();
  if (!resolved) {
    throw new Error(
      'Could not detect wasmts URL. Include a <script src="...wasmts.js"> tag, ' +
      'an importmap entry for @wcohen/wasmts, or pass wasmtsUrl to createTileProcessor().',
    );
  }
  return { wasmtsJsUrl: resolved };
}

export const debugConfig = { labels: false };

let sharedPool: JointPoolClient | null = null;
let sharedPoolPromise: Promise<JointPoolClient> | null = null;

async function buildSharedPool(opts: CreateTileProcessorOpts): Promise<JointPoolClient> {
  const wasmtsOpts = await buildWasmtsHandlerOpts(opts.wasmtsUrl);
  const poolSize = opts.poolSize ?? (typeof navigator !== 'undefined'
    ? (navigator.hardwareConcurrency || 4)
    : 4);
  const client = new JointPoolClient();
  await client.init(poolSize, wasmtsOpts);
  sharedPool = client;
  if (__DEV__) setProfilingMetadata({ poolSize: client.size });
  return client;
}

/**
 * Memoize the promise, assigned before the first await: checking
 * `sharedPool` instead would let two concurrent callers each build a pool
 * and orphan one with its workers' heaps. A failed build clears the memo
 * so the next caller retries. This latches the CLIENT (wiring + wasmts
 * asset read + proj adoption), not the wiring alone.
 */
function acquireSharedPool(opts: CreateTileProcessorOpts): Promise<JointPoolClient> {
  if (!sharedPoolPromise) {
    sharedPoolPromise = buildSharedPool(opts).catch((err) => {
      sharedPoolPromise = null;
      throw err;
    });
  }
  return sharedPoolPromise;
}
let nextRequestId = 0;

export async function createTileProcessor(
  wasmtsUrlOrOpts?: string | CreateTileProcessorOpts,
): Promise<TileProcessor> {
  // Accept a bare wasmtsUrl string (legacy positional) or an opts object.
  const opts: CreateTileProcessorOpts = typeof wasmtsUrlOrOpts === 'string'
    ? { wasmtsUrl: wasmtsUrlOrOpts }
    : (wasmtsUrlOrOpts ?? {});
  const pool = await acquireSharedPool(opts);
  let transformerPool: Transformer[] | null = null;
  let nextTransformerIdx = 0;

  return {
    async reprojectTile(
      z: number, x: number, y: number,
      transformer: Transformer,
      fetchTile: FetchTileFn,
      cache?: LRUCache<string, ArrayBuffer>,
      signal?: AbortSignal,
      outputRequestId?: string,
    ): Promise<ArrayBuffer> {
      const effectiveTransformer = transformerPool
        ? transformerPool[nextTransformerIdx++ % transformerPool.length]
        : transformer;
      const workerIdx = workerIdxFromTransformer(effectiveTransformer);
      if (workerIdx == null) {
        throw new Error(
          'reprojectTile: transformer carries no worker index; its PJ pointers '
          + 'are only valid on the worker that created them, so an unpinned '
          + 'chain dispatch would transform through a foreign proj heap');
      }
      const requestId = String(nextRequestId++);
      const captureRequestId = outputRequestId ?? requestId;

      await pool.syncConfig();
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
        // Clamp to area of use to prevent fetching the entire globe.
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
        const captureOn = isCaptureEnabled();
        if (!cache) {
          if (__DEV__ && enabled) cacheMisses++;
          const data = await fetchTile(fz, fx, fy);
          if (captureOn) {
            recordInputRequest({ outputRequestId: captureRequestId, z: fz, x: fx, y: fy, cacheHit: false });
            recordTileBytes(fz, fx, fy, data);
          }
          return data;
        }
        const key = `${fz}/${fx}/${fy}`;
        const cached = cache.get(key);
        if (cached) {
          if (__DEV__ && enabled) cacheHits++;
          if (captureOn) {
            recordInputRequest({ outputRequestId: captureRequestId, z: fz, x: fx, y: fy, cacheHit: true });
          }
          return cached;
        }
        if (__DEV__ && enabled) cacheMisses++;
        const data = await fetchTile(fz, fx, fy);
        cache.set(key, data);
        if (captureOn) {
          recordInputRequest({ outputRequestId: captureRequestId, z: fz, x: fx, y: fy, cacheHit: false });
          recordTileBytes(fz, fx, fy, data);
        }
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

      if (signal?.aborted) {
        return new ArrayBuffer(0);
      }

      if (validTiles.length === 0) {
        return new ArrayBuffer(0);
      }

      const tileData = validTiles.map(t => t.data);
      const tileCoords = validTiles.map(t => t.coord);

      const fakeBounds = fakeBoundsForTile(z, x, y);
      const scale = 4096 / (fakeBounds.east - fakeBounds.west);

      let debugInputBounds: number[][][] | undefined;
      let debugInputLabels: { label: string; cx: number; cy: number }[] | undefined;
      if (debugConfig.labels) {
        const EDGE_PTS = 16;
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
            pts.push([w + t * (e - w), clampS]);
          }
          for (let i = 0; i <= EDGE_PTS; i++) {
            const t = i / EDGE_PTS;
            pts.push([e, clampS + t * (clampN - clampS)]);
          }
          for (let i = 0; i <= EDGE_PTS; i++) {
            const t = i / EDGE_PTS;
            pts.push([e - t * (e - w), clampN]);
          }
          for (let i = 0; i <= EDGE_PTS; i++) {
            const t = i / EDGE_PTS;
            pts.push([w, clampN - t * (clampN - clampS)]);
          }
          tilePtCounts.push(pts.length);
          allBoundaryPts.push(...pts);
          tileCenters.push([(w + e) / 2, (clampS + clampN) / 2]);
          tileLabels.push(`${tc.z}/${tc.x}/${tc.y}`);
        }
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

      // Raw PJ pointers are valid only on the worker that created them
      // (the chain RPC targets it) and only while the transformer stays
      // alive across the call.
      const tp: any = effectiveTransformer._tPipeline;
      const transformDesc = tp
        ? { pipelinePtr: tp.ptr }
        : {
            fwdPtr: (effectiveTransformer._tFwd as any).ptr,
            invMercPtr: (effectiveTransformer._tInvMerc as any).ptr,
            affine: [
              effectiveTransformer._Sx, effectiveTransformer._Sy,
              effectiveTransformer._Ox, effectiveTransformer._Oy,
            ],
          };

      if (__DEV__ && enabled) t0 = performance.now();
      const chainResult = await pool.chain({
        tileData, tileCoords, outputZ: z,
        transform: transformDesc,
        fakeBounds, scale, outputX: x, outputY: y,
        debugInputBounds, debugInputLabels,
      }, workerIdx);
      let chainRoundtripMs = 0;
      if (__DEV__ && enabled) chainRoundtripMs = performance.now() - t0;

      const data = chainResult.data instanceof Uint8Array
        ? (chainResult.data.buffer as ArrayBuffer).slice(
            chainResult.data.byteOffset,
            chainResult.data.byteOffset + chainResult.data.byteLength,
          )
        : chainResult.data;
      const phase1WorkerProfile = chainResult.phase1Profile;
      const phase2WorkerProfile = chainResult.phase2Profile;

      if (__DEV__ && enabled) {
        const workerProfile: WorkerProfile = {
          workerId: phase1WorkerProfile?.workerId ?? -1,
          phase1Ms: phase1WorkerProfile?.phase1Ms ?? chainRoundtripMs,
          phase1Detail: phase1WorkerProfile?.phase1Detail ?? emptyPhase1Detail(),
          phase2Ms: phase2WorkerProfile?.phase2Ms ?? 0,
          phase2Detail: phase2WorkerProfile?.phase2Detail ?? emptyPhase2Detail(),
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
          transformCoordsMs: chainResult.transformMs ?? 0,
          coordCount: chainResult.coordCount,
          chainRoundtripMs,
          worker: workerProfile,
        });

        performance.measure(`bp:tile:${z}/${x}/${y}`, `bp:tile:start:${requestId}`);
      }

      return data as ArrayBuffer;
    },

    get poolSize(): number {
      return pool.size;
    },

    get pool(): any {
      return pool.pool;
    },


    setTransformerPool(transformers: Transformer[]): void {
      transformerPool = transformers;
      nextTransformerIdx = 0;
    },

    shutdown(): Promise<void> {
      if (sharedPool === pool) {
        sharedPool = null;
        sharedPoolPromise = null;
        return pool.shutdown();
      }
      return Promise.resolve();
    },
  };
}

export function shutdownTileWorkers(): Promise<void> {
  if (sharedPool) {
    const pool = sharedPool;
    sharedPool = null;
    sharedPoolPromise = null;
    return pool.shutdown();
  }
  return Promise.resolve();
}

function emptyPhase1Detail(): import('./profiling.js').Phase1Detail {
  return {
    decodeMs: 0, decodeCacheHits: 0, decodeCacheMisses: 0,
    featureCount: 0, fragmentCount: 0,
    stitchMs: 0, stitchCount: 0,
    densifyMs: 0, coordExtractMs: 0, coordsProduced: 0, constructMs: 0,
    preDensifyCoords: 0, postDensifyCoords: 0,
  };
}

function emptyPhase2Detail(): import('./profiling.js').Phase2Detail {
  return {
    applyMs: 0, isValidMs: 0, fixRepairMs: 0, fixRepairCount: 0, clipMs: 0, clipEmptyCount: 0, skipClipCount: 0,
    precisionMs: 0, encodeMs: 0, outputFeatureCount: 0, outputBytes: 0, geojsonWriteMs: 0,
  };
}
