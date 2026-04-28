/**
 * wasmts-handler.ts -- Joint-pool worker-router handler for wasmts (JTS WASM).
 *
 * Loaded into a worker-router worker alongside proj-wasm's proj-handler so a
 * single tile's phase1 -> proj_trans_array -> phase2 chain runs entirely
 * on one worker in one RPC (the `chain` method).
 *
 * Loads wasmts via dynamic `import(wasmtsJsUrl)` (not importScripts -- the
 * worker bootstrap is module-mode in both Node worker_threads and browser
 * Workers). The wasmts script is GraalVM-compiled with side-effect init that
 * mutates `globalThis.wasmts`; we poll for `globalThis.wasmts.geom` after the
 * import settles.
 *
 * In Node, `fetch()` does not serve `file://` URLs, so the caller passes the
 * .wasm binary as `initArgs.wasmtsWasmBinary` and we patch `globalThis.fetch`
 * to return it for any URL ending in `.wasm`. In browser, native fetch handles
 * the sibling .wasm file the loader requests; binary may be null.
 *
 * This handler registers as `:net.willcohen.wasmts` (reverse-DNS namespacing
 * to avoid collisions when multiple JTS-on-WASM bindings ship handlers).
 */
import { decodeTile, groupDecodedFeatures } from './mvt-decode.js';
import type { DecodedFeature } from './mvt-decode.js';
import { encodeTilePbf } from './mvt-encode.js';
import {
  processFeaturePhase1, processFeaturePhase2,
  createPhase1Accumulator, createPhase2Accumulator,
} from './mvt-pipeline.js';
import type { OutputLayers } from './mvt-pipeline.js';
import type { TileCoord } from './tiling.js';
import { makeHandler, byteLengthFingerprint } from 'ffi-wasm/handler-runtime';

declare const __DEV__: boolean;

type Wts = typeof wasmts;

interface StoredPhase1 {
  geoms: (import('@wcohen/wasmts').Geometry | null)[];
  featureKeys: { layerName: string; featureId: string; properties: Record<string, any> }[];
}

let wts: Wts | null = null;
let workerProfilingEnabled = false;
let workerDebugLabels = false;
let myWorkerIdx = -1;

const isNode = (() => {
  const p = (globalThis as any).process;
  return !!(p && p.versions && p.versions.node);
})();

interface InitArgs {
  wasmtsJsUrl: string;
  wasmtsWasmBinary?: ArrayBuffer | Uint8Array;
  /** URL of proj-handler-bridge.mjs, the module registered under the proj
   *  handler key. Imported dynamically so the bundler cannot inline a
   *  second instance; the bridge memoizes the proj handler this worker
   *  created, which chain() calls without an RPC hop. */
  projBridgeUrl?: string;
}

/** The co-resident proj handler instance, via the bridge. Null when the
 *  pool was wired without the bridge (chain() then refuses). */
let projHandler: any = null;

/**
 * Per-worker LRU of decodeTile output. Neighboring output tiles share
 * input tiles, so each worker decodes the same input several times per
 * pan; the cache trades a byte hash (~0.1ms) for a decode (~26-46ms).
 * The z/x/y key alone is not sound -- the pool is a singleton and can
 * serve several tile sources -- so entries also carry byteLength plus
 * an FNV-1a hash and re-decode on mismatch. Cached features are shared
 * across chain calls: everything downstream reads them without
 * mutating (see groupDecodedFeatures).
 */
const DECODE_CACHE_MAX = 16;
interface DecodeCacheEntry {
  byteLength: number;
  hash: number;
  features: DecodedFeature[];
}
const decodeCache = new Map<string, DecodeCacheEntry>();

function fnv1a(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function decodedFeaturesFor(
  data: ArrayBuffer, coord: TileCoord,
  counts: { hits: number; misses: number },
): DecodedFeature[] {
  const key = `${coord.z}/${coord.x}/${coord.y}`;
  const bytes = new Uint8Array(data);
  const hash = fnv1a(bytes);
  const entry = decodeCache.get(key);
  if (entry && entry.byteLength === bytes.length && entry.hash === hash) {
    // Map iteration order is insertion order; delete+set is the LRU touch.
    decodeCache.delete(key);
    decodeCache.set(key, entry);
    counts.hits++;
    return entry.features;
  }
  const features = decodeTile(data, coord);
  decodeCache.delete(key);
  decodeCache.set(key, { byteLength: bytes.length, hash, features });
  if (decodeCache.size > DECODE_CACHE_MAX) {
    decodeCache.delete(decodeCache.keys().next().value!);
  }
  counts.misses++;
  return features;
}

async function init(args: InitArgs): Promise<void> {
  const a = args ?? ({} as InitArgs);
  if (!a.wasmtsJsUrl) {
    throw new Error('wasmts-handler.init: missing required initArgs.wasmtsJsUrl');
  }

  if (a.projBridgeUrl) {
    const bridge = await import(/* @vite-ignore */ a.projBridgeUrl);
    projHandler = bridge.getProjHandler();
  }

  // Node: patch fetch to serve the bundled .wasm bytes while the loader
  // initializes, restored once init settles -- the proj handler is
  // co-resident on this worker and a permanent patch would hijack any
  // later .wasm fetch of its own. Browser native fetch is left untouched.
  let restoreFetch: (() => void) | null = null;
  if (isNode && a.wasmtsWasmBinary) {
    const bin = a.wasmtsWasmBinary;
    const buf: ArrayBuffer = bin instanceof Uint8Array
      ? (bin.buffer as ArrayBuffer).slice(bin.byteOffset, bin.byteOffset + bin.byteLength)
      : bin;
    const origFetch = (globalThis as any).fetch;
    restoreFetch = () => { (globalThis as any).fetch = origFetch; };
    (globalThis as any).fetch = function patchedFetch(url: any, ...rest: any[]) {
      const urlStr = String(url);
      if (urlStr.includes('wasmts') && urlStr.endsWith('.wasm')) {
        return Promise.resolve({
          ok: true,
          arrayBuffer: () => Promise.resolve(buf),
        });
      }
      return origFetch ? origFetch(url, ...rest) : Promise.reject(new Error('no fetch'));
    };
  }

  // wasmts loader resolves its companion .wasm via __filename relative to the
  // .js URL in some paths; setting it pre-import keeps both Node and browser
  // happy.
  (globalThis as any).__filename = a.wasmtsJsUrl;

  try {
    await import(/* @vite-ignore */ a.wasmtsJsUrl);

    // Poll for wasmts namespace mutation. The loader runs WASM init async
    // after module evaluation completes. 10s budget at 50ms. The .wasm
    // fetch has completed by the time geom appears, so the finally-restore
    // never races the loader.
    const MAX_POLL_ATTEMPTS = 200;
    for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
      if ((globalThis as any).wasmts?.geom) {
        wts = (globalThis as any).wasmts as Wts;
        return;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('wasmts.geom not available after 10s');
  } finally {
    if (restoreFetch) restoreFetch();
  }
}

const fingerprint = byteLengthFingerprint(['wasmtsJsUrl', 'wasmtsWasmBinary'], 'wasmts');

interface SetConfigArgs {
  profilingEnabled?: boolean;
  debugLabels?: boolean;
  workerIdx?: number;
}

/** Either a single CRS-to-CRS pipeline, or the compound-CRS fallback:
 *  forward transform, affine, inverse-mercator. Raw wasm pointers into
 *  the proj heap: valid only on the worker whose PJ they name, and only
 *  while the transformer that owns them stays alive. */
interface TransformDescriptor {
  pipelinePtr?: number;
  fwdPtr?: number;
  invMercPtr?: number;
  affine?: [number, number, number, number];
}

interface ChainArgs {
  tileData: ArrayBuffer[];
  tileCoords: TileCoord[];
  outputZ: number;
  transform: TransformDescriptor;
  fakeBounds: { west: number; south: number; east: number; north: number };
  scale: number;
  outputX: number;
  outputY: number;
  debugInputBounds?: number[][][];
  debugInputLabels?: { label: string; cx: number; cy: number }[];
}

interface ChainResult {
  data: ArrayBuffer | Uint8Array;
  coordCount: number;
  transformMs?: number;
  phase1Profile?: any;
  phase2Profile?: any;
}

const PROJ_TRANS_ARGTYPES = ['number', 'number', 'number', 'number'];

/** The nonzero return code is deliberately ignored, matching proj-wasm's
 *  projTransArray (the pre-fusion path): proj_trans_array reports the
 *  LAST error but still transforms every point it can, writing HUGE_VAL
 *  into the ones it cannot (e.g. outside the projection domain, common
 *  for tiles clamped to the area-of-use edge). Throwing here fails the
 *  whole tile; the huge coords are clipped away in phase2 instead. */
async function projTransInPlace(ptr: number, pjPtr: number, n: number): Promise<void> {
  await projHandler.ccall(
    'proj_trans_array', 'number', PROJ_TRANS_ARGTYPES, [pjPtr, 1, n, ptr]);
}

/** heapf64_set/get take ELEMENT offsets into HEAPF64, not byte offsets. */
async function transformOnWorker(all: Float64Array, n: number, t: TransformDescriptor): Promise<Float64Array> {
  if (!projHandler) {
    throw new Error('wasmts-handler.chain: no proj bridge (pool wired without projBridgeUrl)');
  }
  const ptr = await projHandler.malloc(n * 4 * 8);
  try {
    const elemOff = ptr / 8;
    await projHandler.heapf64_set(elemOff, all);
    if (t.pipelinePtr != null) {
      await projTransInPlace(ptr, t.pipelinePtr, n);
      return await projHandler.heapf64_get(elemOff, n * 4);
    }
    await projTransInPlace(ptr, t.fwdPtr!, n);
    const mid: Float64Array = await projHandler.heapf64_get(elemOff, n * 4);
    const [sx, sy, ox, oy] = t.affine!;
    for (let i = 0; i < n; i++) {
      const off = i * 4;
      mid[off] = mid[off] * sx + ox;
      mid[off + 1] = mid[off + 1] * sy + oy;
      mid[off + 2] = 0;
      mid[off + 3] = 0;
    }
    await projHandler.heapf64_set(elemOff, mid);
    await projTransInPlace(ptr, t.invMercPtr!, n);
    return await projHandler.heapf64_get(elemOff, n * 4);
  } finally {
    await projHandler.free(ptr);
  }
}

const methods = {
  setConfig(args: SetConfigArgs): void {
    if (__DEV__ && args.profilingEnabled !== undefined) {
      workerProfilingEnabled = args.profilingEnabled;
    }
    if (args.debugLabels !== undefined) workerDebugLabels = args.debugLabels;
    if (typeof args.workerIdx === 'number') myWorkerIdx = args.workerIdx;
  },

  /** Fused phase1 -> transform -> phase2 in one worker call. Phase1
   *  state passes straight to phase2 as a local, so the worker keeps no
   *  per-request bookkeeping. */
  async chain(args: ChainArgs): Promise<ChainResult> {
    const enabled = __DEV__ && workerProfilingEnabled;
    const p1 = runPhase1(args);
    const { coordArrays, stored } = p1;
    if (coordArrays.length === 0) {
      return { data: new ArrayBuffer(0), coordCount: 0, phase1Profile: p1.profile };
    }
    let total = 0;
    for (const flat of coordArrays) total += flat.length;
    // z/t slots stay zero from Float64Array allocation (both here and in
    // each source array); heapf64_set copies them into the malloc'd heap.
    const all = new Float64Array(total);
    let w = 0;
    for (const flat of coordArrays) { all.set(flat, w); w += flat.length; }
    const n = total / 4;

    let tTrans = 0;
    if (__DEV__ && enabled) tTrans = performance.now();
    const transformed = await transformOnWorker(all, n, args.transform);
    const transformMs = __DEV__ && enabled ? performance.now() - tTrans : undefined;

    const transformedArrays: Float64Array[] = [];
    let r = 0;
    for (const flat of coordArrays) {
      transformedArrays.push(transformed.subarray(r, r + flat.length));
      r += flat.length;
    }
    const p2 = runPhase2(stored, transformedArrays, args);
    return {
      data: p2.data,
      coordCount: n,
      transformMs,
      phase1Profile: p1.profile,
      phase2Profile: p2.profile,
    };
  },
};

function runPhase1(args: ChainArgs): {
  coordArrays: Float64Array[]; stored: StoredPhase1; profile?: any;
} {
  if (!wts) throw new Error('wasmts handler not initialized');

  const enabled = __DEV__ && workerProfilingEnabled;
  let tPhase1 = 0;
  if (__DEV__ && enabled) tPhase1 = performance.now();

  let tDecode = 0;
  if (__DEV__ && enabled) tDecode = performance.now();
  const decodeCounts = { hits: 0, misses: 0 };
  const groups = groupDecodedFeatures(args.tileData.map(
    (data, i) => decodedFeaturesFor(data, args.tileCoords[i], decodeCounts),
  ));
  let decodeMs = 0;
  if (__DEV__ && enabled) decodeMs = performance.now() - tDecode;

  const acc = __DEV__ && enabled ? createPhase1Accumulator() : null;

  const coordArrays: Float64Array[] = [];
  const geoms: (import('@wcohen/wasmts').Geometry | null)[] = [];
  const featureKeys: StoredPhase1['featureKeys'] = [];

  for (const [layerName, features] of Object.entries(groups)) {
    for (const [featureId, fragments] of Object.entries(features)) {
      try {
        const results = processFeaturePhase1(fragments, wts, args.outputZ, acc);
        if (results) {
          for (const result of results) {
            const flat = new Float64Array(result.coords.length * 4);
            for (let i = 0; i < result.coords.length; i++) {
              const off = i * 4;
              flat[off] = result.coords[i][0];
              flat[off + 1] = result.coords[i][1];
            }
            coordArrays.push(flat);
            geoms.push(result.geom);
            featureKeys.push({
              layerName,
              featureId,
              properties: fragments[0].properties || {},
            });
          }
        }
      } catch {
        // wasmts can throw non-Error objects (GraalVM Proxy);
        // catch without binding avoids interacting with the proxy.
      }
    }
  }

  const profile = __DEV__ && enabled ? {
    workerId: myWorkerIdx,
    phase1Ms: performance.now() - tPhase1,
    phase1Detail: {
      decodeMs,
      decodeCacheHits: decodeCounts.hits,
      decodeCacheMisses: decodeCounts.misses,
      featureCount: acc!.featureCount,
      fragmentCount: acc!.fragmentCount,
      stitchMs: acc!.stitchMs,
      stitchCount: acc!.stitchCount,
      densifyMs: acc!.densifyMs,
      coordExtractMs: acc!.coordExtractMs,
      coordsProduced: acc!.coordsProduced,
      constructMs: acc!.constructMs,
      preDensifyCoords: acc!.preDensifyCoords,
      postDensifyCoords: acc!.postDensifyCoords,
    },
  } : undefined;

  return { coordArrays, stored: { geoms, featureKeys }, profile };
}

function runPhase2(
  stored: StoredPhase1, transformedCoords: Float64Array[], args: ChainArgs,
): { data: ArrayBuffer | Uint8Array; profile?: any } {
  if (!wts) throw new Error('wasmts handler not initialized');

  const enabled = __DEV__ && workerProfilingEnabled;
  let tPhase2 = 0;
  if (__DEV__ && enabled) tPhase2 = performance.now();
  const factory = wts.geom.GeometryFactory.create0();
  const clipEnvelope = wts.geom.GeometryFactory.toGeometry(
    factory,
    wts.geom.Envelope.create4(
      args.fakeBounds.west, args.fakeBounds.east,
      args.fakeBounds.south, args.fakeBounds.north,
    ),
  );
  const pm = wts.geom.PrecisionModel.fromScale(args.scale);
  const clipEnv = wts.geom.getEnvelopeInternal(clipEnvelope);
  const clipMinX = clipEnv.getMinX(), clipMaxX = clipEnv.getMaxX();
  const clipMinY = clipEnv.getMinY(), clipMaxY = clipEnv.getMaxY();

  const acc = __DEV__ && enabled ? createPhase2Accumulator() : null;
  const layers: OutputLayers = {};
  let outputFeatureCount = 0;

  for (let i = 0; i < stored.geoms.length; i++) {
    const geom = stored.geoms[i];
    if (!geom) continue;

    const flat = transformedCoords[i];
    const { layerName, featureId, properties } = stored.featureKeys[i];

    try {
      const result = processFeaturePhase2(
        geom, flat, 4, clipEnvelope,
        clipMinX, clipMaxX, clipMinY, clipMaxY,
        pm, wts, acc,
      );
      if (result) {
        if (!layers[layerName]) layers[layerName] = [];
        layers[layerName].push({
          id: featureId,
          properties,
          geometries: result,
        });
        outputFeatureCount++;
      }
    } catch {
      // see phase1 catch note
    }
  }

  let tEncode = 0;
  if (__DEV__ && enabled) tEncode = performance.now();
  const debugTile = workerDebugLabels
    ? { z: args.outputZ, x: args.outputX, y: args.outputY }
    : null;
  const writeAcc = __DEV__ && enabled ? { ms: 0 } : null;
  const data = encodeTilePbf(
    layers, args.fakeBounds, wts, debugTile,
    args.debugInputBounds, args.debugInputLabels, writeAcc,
  );
  let encodeMs = 0;
  if (__DEV__ && enabled) encodeMs = performance.now() - tEncode;

  const profile = __DEV__ && enabled ? {
    phase2Ms: performance.now() - tPhase2,
    phase2Detail: {
      applyMs: acc!.applyMs,
      isValidMs: acc!.isValidMs,
      fixRepairMs: acc!.fixRepairMs,
      fixRepairCount: acc!.fixRepairCount,
      clipMs: acc!.clipMs,
      clipEmptyCount: acc!.clipEmptyCount,
      skipClipCount: acc!.skipClipCount,
      precisionMs: acc!.precisionMs,
      encodeMs,
      outputFeatureCount,
      outputBytes: data.byteLength,
      geojsonWriteMs: writeAcc ? writeAcc.ms : 0,
    },
  } : undefined;

  return { data, profile };
}

// init/setConfig run before any busy work; chain is the only busy method.
const busyMethods = ['chain'];

const create = makeHandler({
  init,
  methods,
  busyMethods,
  fingerprint,
});

export default create;
