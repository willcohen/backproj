/**
 * capture.ts -- in-browser capture taps for bench fixtures.
 *
 * Records the data needed to replay a benchmark scenario offline:
 *   - input-tile request log (every cachedFetch call, in order)
 *   - output-tile request log (every output tile MapLibre asks for)
 *   - input-tile byte cache (raw bytes, deduplicated by (z,x,y))
 *   - manifest assembled and written by the Node-side bench harness
 *
 * Capture is OFF by default. Call enableCapture() to start a window;
 * call disableCapture() (or simply stop calling record*) to end one.
 * In normal pipeline use nothing turns capture on — the bench harness
 * does it for one scenario pass on each `npm run bench` invocation.
 * When disabled, every record function is a single boolean check that
 * returns immediately with zero allocation, so leaving the imports in
 * place imposes no hot-path cost.
 *
 * Capture state is module-scoped and runs in the same realm as
 * tile-processor.ts (the main browser thread). Bytes deduplicate by
 * (z,x,y) -- first write wins; subsequent writes for the same key are
 * dropped to keep the byte cache idempotent across re-fetches.
 *
 * exportCapture() returns a JSON-safe snapshot that the Playwright
 * harness extracts via page.evaluate(). Tile bytes are base64-encoded
 * so they survive the CDP serialization boundary.
 */

export interface RequestLogEntry {
  outputRequestId: string;
  z: number;
  x: number;
  y: number;
  timestampMs: number;
  cacheHit: boolean;
}

export interface OutputTileRequest {
  requestId: string;
  z: number;
  x: number;
  y: number;
  timestampMs: number;
}

export interface CaptureSnapshot {
  inputRequests: RequestLogEntry[];
  outputRequests: OutputTileRequest[];
  tileKeys: string[];
  tilesBase64: Record<string, string>;
}

interface CaptureState {
  enabled: boolean;
  sceneStartMs: number;
  inputRequests: RequestLogEntry[];
  outputRequests: OutputTileRequest[];
  tileBytes: Map<string, ArrayBuffer>;
}

const state: CaptureState = {
  enabled: false,
  sceneStartMs: 0,
  inputRequests: [],
  outputRequests: [],
  tileBytes: new Map(),
};

function nowRelative(): number {
  if (typeof performance !== 'undefined') {
    return performance.now() - state.sceneStartMs;
  }
  return Date.now() - state.sceneStartMs;
}

export function enableCapture(opts: { sceneStartMs?: number } = {}): void {
  state.enabled = true;
  state.sceneStartMs = opts.sceneStartMs ?? (typeof performance !== 'undefined' ? performance.now() : Date.now());
  state.inputRequests = [];
  state.outputRequests = [];
  state.tileBytes = new Map();
}

export function disableCapture(): void {
  state.enabled = false;
}

export function clearCapture(): void {
  state.inputRequests = [];
  state.outputRequests = [];
  state.tileBytes = new Map();
}

export function isCaptureEnabled(): boolean {
  return state.enabled;
}

export function recordInputRequest(entry: {
  outputRequestId: string;
  z: number;
  x: number;
  y: number;
  cacheHit: boolean;
}): void {
  if (!state.enabled) return;
  state.inputRequests.push({
    outputRequestId: entry.outputRequestId,
    z: entry.z,
    x: entry.x,
    y: entry.y,
    timestampMs: nowRelative(),
    cacheHit: entry.cacheHit,
  });
}

export function recordOutputRequest(entry: {
  requestId: string;
  z: number;
  x: number;
  y: number;
}): void {
  if (!state.enabled) return;
  state.outputRequests.push({
    requestId: entry.requestId,
    z: entry.z,
    x: entry.x,
    y: entry.y,
    timestampMs: nowRelative(),
  });
}

export function recordTileBytes(z: number, x: number, y: number, bytes: ArrayBuffer): void {
  if (!state.enabled) return;
  const key = `${z}/${x}/${y}`;
  if (state.tileBytes.has(key)) return;
  // Defensive copy: the caller may reuse the buffer. ArrayBuffer.slice
  // produces a fresh buffer of the same byte content.
  state.tileBytes.set(key, bytes.slice(0));
}

export function exportCapture(): CaptureSnapshot {
  const tilesBase64: Record<string, string> = {};
  const tileKeys: string[] = [];
  for (const [key, buf] of state.tileBytes) {
    tileKeys.push(key);
    tilesBase64[key] = arrayBufferToBase64(buf);
  }
  return {
    inputRequests: [...state.inputRequests],
    outputRequests: [...state.outputRequests],
    tileKeys,
    tilesBase64,
  };
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const u8 = new Uint8Array(buf);
  // Chunk to avoid String.fromCharCode argument-count limits on large tiles.
  const CHUNK = 8192;
  let binary = '';
  for (let i = 0; i < u8.length; i += CHUNK) {
    const end = Math.min(i + CHUNK, u8.length);
    binary += String.fromCharCode.apply(null, u8.subarray(i, end) as unknown as number[]);
  }
  return btoa(binary);
}
