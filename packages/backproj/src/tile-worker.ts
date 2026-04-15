/**
 * tile-worker.ts — Web Worker entry point for MVT reprojection.
 *
 * Loaded as a blob URL worker by WorkerPool (tile-processor.ts). On init,
 * imports wasmts (JTS transpiled to WASM) and signals readiness. Then handles
 * three message types:
 *
 *   phase1: Decode input MVT PBFs, group fragments by feature ID, stitch
 *           cross-tile geometries, adaptive densify (skip when all edges
 *           < tolerance), and extract flat coordinate arrays. Returns
 *           arrays to the main thread for proj-wasm transformation.
 *           Retains intermediate geometry state (StoredPhase1).
 *
 *   phase2: Receives transformed coordinates from the main thread. Applies
 *           them back onto the retained geometries, repairs topology,
 *           clips to the output tile envelope (skipping clip for features
 *           fully inside via bbox check), snaps to the MVT integer grid,
 *           and encodes the final PBF.
 *
 *   cleanup: Removes retained phase1 state for an aborted request.
 *
 * WORKER INITIALIZATION
 * - COEP requires blob URL workers (not direct `new Worker(url)`)
 * - wasmts WASM resolution needs `self.__filename = wasmtsUrl` before importScripts
 * - Worker polls for `self.wasmts.geom` availability after importScripts
 *
 * See tile-processor.ts for the full end-to-end data flow diagram.
 */
import { decodeAndGroupTiles } from './mvt-decode.js';
import { encodeTilePbf } from './mvt-encode.js';
import { processFeaturePhase1, processFeaturePhase2, createPhase1Accumulator, createPhase2Accumulator } from './mvt-pipeline.js';
import type { OutputLayers } from './mvt-pipeline.js';
import type { TileCoord } from './tiling.js';

declare const self: Worker & typeof globalThis;
declare function importScripts(...urls: string[]): void;

type Wts = typeof import('@wcohen/wasmts');

interface StoredPhase1 {
  geoms: (import('@wcohen/wasmts').Geometry | null)[];
  featureKeys: { layerName: string; featureId: string; properties: Record<string, any> }[];
}

const pending = new Map<string, StoredPhase1>();

let wts: Wts | null = null;
let workerProfilingEnabled = false;
let workerDebugLabels = false;
let myWorkerIdx = -1;

self.onmessage = (e: MessageEvent) => {
  const msg = e.data;
  switch (msg.cmd) {
    case 'init':
      if (msg.workerIdx !== undefined) myWorkerIdx = msg.workerIdx;
      handleInit(msg.wasmtsUrl);
      break;
    case 'setConfig':
      if (__DEV__) {
        if (msg.profilingEnabled !== undefined) {
          workerProfilingEnabled = msg.profilingEnabled;
        }
      }
      if (msg.debugLabels !== undefined) {
        workerDebugLabels = msg.debugLabels;
      }
      break;
    case 'phase1':
      handlePhase1(msg);
      break;
    case 'phase2':
      handlePhase2(msg);
      break;
    case 'cleanup':
      pending.delete(msg.requestId);
      break;
  }
};

function handleInit(wasmtsUrl: string) {
  try {
    (self as any).__filename = wasmtsUrl;
    importScripts(wasmtsUrl);
  } catch (err: any) {
    const msg = err?.message || String(err);
    console.error('[tile-worker] importScripts failed:', msg);
    self.postMessage({ cmd: 'error', error: `importScripts failed: ${msg}` });
    return;
  }
  let attempts = 0;
  const MAX_POLL_ATTEMPTS = 200; // 10 seconds at 50ms intervals
  function poll() {
    if ((self as any).wasmts?.geom) {
      wts = (self as any).wasmts as Wts;
      self.postMessage({ cmd: 'ready' });
    } else if (++attempts >= MAX_POLL_ATTEMPTS) {
      self.postMessage({ cmd: 'error', error: 'wasmts.geom not available after 10s' });
    } else {
      setTimeout(poll, 50);
    }
  }
  poll();
}

function handlePhase1(msg: {
  requestId: string;
  tileData: ArrayBuffer[];
  tileCoords: TileCoord[];
  outputZ: number;
}) {
  try {
    if (!wts) throw new Error('worker not initialized');

    const enabled = __DEV__ && workerProfilingEnabled;
    let tPhase1 = 0;
    if (__DEV__ && enabled) tPhase1 = performance.now();

    let tDecode = 0;
    if (__DEV__ && enabled) tDecode = performance.now();
    const tiles = msg.tileData.map((data, i) => ({
      data,
      coord: msg.tileCoords[i],
    }));
    const groups = decodeAndGroupTiles(tiles);
    let decodeMs = 0;
    if (__DEV__ && enabled) decodeMs = performance.now() - tDecode;

    const acc = __DEV__ && enabled ? createPhase1Accumulator() : null;

    const coordArrays: Float64Array[] = [];
    const geoms: (import('@wcohen/wasmts').Geometry | null)[] = [];
    const featureKeys: StoredPhase1['featureKeys'] = [];

    for (const [layerName, features] of Object.entries(groups)) {
      for (const [featureId, fragments] of Object.entries(features)) {
        try {
          const results = processFeaturePhase1(fragments, wts, msg.outputZ, acc);
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

    pending.set(msg.requestId, { geoms, featureKeys });

    const transfer = coordArrays.map(a => a.buffer);
    const profileData = __DEV__ && enabled ? {
      workerId: myWorkerIdx,
      phase1Ms: performance.now() - tPhase1,
      phase1Detail: {
        decodeMs,
        featureCount: acc!.featureCount,
        fragmentCount: acc!.fragmentCount,
        stitchMs: acc!.stitchMs,
        stitchCount: acc!.stitchCount,
        densifyMs: acc!.densifyMs,
        coordExtractMs: acc!.coordExtractMs,
        coordsProduced: acc!.coordsProduced,
        geojsonReadMs: acc!.geojsonReadMs,
        preDensifyCoords: acc!.preDensifyCoords,
        postDensifyCoords: acc!.postDensifyCoords,
      },
    } : undefined;

    // Transfers detach backing ArrayBuffers — coordArrays are unusable after this.
    self.postMessage(
      { cmd: 'phase1Result', requestId: msg.requestId, coordArrays, profile: profileData },
      transfer as any,
    );
  } catch (err: any) {
    let errMsg = 'phase1 failed';
    try { errMsg = err?.message || String(err); } catch {}
    self.postMessage({
      cmd: 'phase1Result',
      requestId: msg.requestId,
      coordArrays: [],
      error: errMsg,
    });
  }
}

function handlePhase2(msg: {
  requestId: string;
  transformedCoords: Float64Array[];
  fakeBounds: { west: number; south: number; east: number; north: number };
  scale: number;
  outputZ: number;
  outputX: number;
  outputY: number;
  debugInputBounds?: number[][][];
  debugInputLabels?: { label: string; cx: number; cy: number }[];
}) {
  try {
    if (!wts) throw new Error('worker not initialized');

    const stored = pending.get(msg.requestId);
    if (!stored) throw new Error(`no stored state for requestId ${msg.requestId}`);
    pending.delete(msg.requestId);

    const enabled = __DEV__ && workerProfilingEnabled;
    let tPhase2 = 0;
    if (__DEV__ && enabled) tPhase2 = performance.now();
    const clipEnvelope = wts.geom.toGeometry(
      wts.geom.createEnvelope(
        msg.fakeBounds.west, msg.fakeBounds.east,
        msg.fakeBounds.south, msg.fakeBounds.north,
      )
    );
    const pm = wts.geom.PrecisionModel.createFixed(msg.scale);
    const clipEnv = wts.geom.getEnvelopeInternal(clipEnvelope);
    const clipMinX = clipEnv.getMinX(), clipMaxX = clipEnv.getMaxX();
    const clipMinY = clipEnv.getMinY(), clipMaxY = clipEnv.getMaxY();

    const acc = __DEV__ && enabled ? createPhase2Accumulator() : null;
    const layers: OutputLayers = {};
    let outputFeatureCount = 0;

    for (let i = 0; i < stored.geoms.length; i++) {
      const geom = stored.geoms[i];
      if (!geom) continue;

      const flat = msg.transformedCoords[i];

      const { layerName, featureId, properties } = stored.featureKeys[i];

      try {
        const result = processFeaturePhase2(geom, flat, 4, clipEnvelope, clipMinX, clipMaxX, clipMinY, clipMaxY, pm, wts, acc);
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
      }
    }

    let tEncode = 0;
    if (__DEV__ && enabled) tEncode = performance.now();
    const debugTile = workerDebugLabels
      ? { z: msg.outputZ, x: msg.outputX, y: msg.outputY }
      : null;
    const writeAcc = __DEV__ && enabled ? { ms: 0 } : null;
    const data = encodeTilePbf(layers, msg.fakeBounds, wts, debugTile, msg.debugInputBounds, msg.debugInputLabels, writeAcc);
    let encodeMs = 0;
    if (__DEV__ && enabled) encodeMs = performance.now() - tEncode;

    const profileData = __DEV__ && enabled ? {
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

    self.postMessage(
      { cmd: 'phase2Result', requestId: msg.requestId, data, profile: profileData },
      [data] as any,
    );
  } catch (err: any) {
    let errMsg = 'phase2 failed';
    try { errMsg = err?.message || String(err); } catch {}
    pending.delete(msg.requestId);
    self.postMessage({
      cmd: 'phase2Result',
      requestId: msg.requestId,
      data: new ArrayBuffer(0),
      error: errMsg,
    });
  }
}
