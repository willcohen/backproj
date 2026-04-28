// Structural tests for the in-browser capture module.
// Verifies the JSON shape of RequestLogEntry, OutputTileRequest, and
// exportCapture()'s output. Also exercises byte-cache dedup, the
// disabled no-op path, clearCapture's flag-vs-state separation, and
// the input/output request join-key invariant. Pure Node, no Playwright.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  enableCapture, disableCapture, clearCapture, isCaptureEnabled,
  recordInputRequest, recordOutputRequest, recordTileBytes,
  exportCapture,
} from '../packages/backproj/dist/backproj.mjs';

const REQUIRED_INPUT_FIELDS = ['outputRequestId', 'z', 'x', 'y', 'timestampMs', 'cacheHit'];
const REQUIRED_OUTPUT_FIELDS = ['requestId', 'z', 'x', 'y', 'timestampMs'];

function bytes(...vals) {
  return new Uint8Array(vals).buffer;
}

test('enableCapture toggles state and clears prior data', () => {
  enableCapture({ sceneStartMs: 0 });
  recordInputRequest({ outputRequestId: 'r1', z: 1, x: 2, y: 3, cacheHit: false });
  assert.equal(isCaptureEnabled(), true);
  enableCapture({ sceneStartMs: 0 }); // re-enable clears
  const cap = exportCapture();
  assert.equal(cap.inputRequests.length, 0);
  disableCapture();
  assert.equal(isCaptureEnabled(), false);
});

test('recordInputRequest produces RequestLogEntry shape', () => {
  enableCapture({ sceneStartMs: 0 });
  recordInputRequest({ outputRequestId: 'r1', z: 5, x: 9, y: 12, cacheHit: false });
  recordInputRequest({ outputRequestId: 'r1', z: 5, x: 9, y: 13, cacheHit: true });
  const cap = exportCapture();
  assert.equal(cap.inputRequests.length, 2);
  for (const entry of cap.inputRequests) {
    for (const f of REQUIRED_INPUT_FIELDS) {
      assert.ok(f in entry, `missing field ${f} in RequestLogEntry`);
    }
    assert.equal(typeof entry.outputRequestId, 'string');
    assert.equal(typeof entry.z, 'number');
    assert.equal(typeof entry.x, 'number');
    assert.equal(typeof entry.y, 'number');
    assert.equal(typeof entry.timestampMs, 'number');
    assert.equal(typeof entry.cacheHit, 'boolean');
  }
});

test('recordOutputRequest produces OutputTileRequest shape', () => {
  enableCapture({ sceneStartMs: 0 });
  recordOutputRequest({ requestId: 'o1', z: 5, x: 9, y: 12 });
  const cap = exportCapture();
  assert.equal(cap.outputRequests.length, 1);
  const entry = cap.outputRequests[0];
  for (const f of REQUIRED_OUTPUT_FIELDS) {
    assert.ok(f in entry, `missing field ${f} in OutputTileRequest`);
  }
  assert.equal(typeof entry.requestId, 'string');
  assert.equal(typeof entry.timestampMs, 'number');
});

test('records are dropped when capture is disabled', () => {
  disableCapture();
  clearCapture();
  recordInputRequest({ outputRequestId: 'r1', z: 1, x: 2, y: 3, cacheHit: false });
  recordOutputRequest({ requestId: 'o1', z: 1, x: 2, y: 3 });
  recordTileBytes(1, 2, 3, bytes(0xff, 0xee));
  const cap = exportCapture();
  assert.equal(cap.inputRequests.length, 0);
  assert.equal(cap.outputRequests.length, 0);
  assert.deepEqual(cap.tileKeys, []);
});

test('recordTileBytes deduplicates by (z,x,y) key', () => {
  enableCapture({ sceneStartMs: 0 });
  recordTileBytes(7, 11, 22, bytes(1, 2, 3));
  recordTileBytes(7, 11, 22, bytes(9, 9, 9)); // same key, second call ignored
  recordTileBytes(7, 11, 23, bytes(4, 5));
  const cap = exportCapture();
  assert.deepEqual(cap.tileKeys.sort(), ['7/11/22', '7/11/23'].sort());
  // First-write wins
  const decoded = atob(cap.tilesBase64['7/11/22']);
  assert.equal(decoded.charCodeAt(0), 1);
  assert.equal(decoded.charCodeAt(1), 2);
  assert.equal(decoded.charCodeAt(2), 3);
});

test('clearCapture wipes state but leaves enabled flag intact', () => {
  enableCapture({ sceneStartMs: 0 });
  recordInputRequest({ outputRequestId: 'r1', z: 1, x: 2, y: 3, cacheHit: false });
  recordTileBytes(1, 2, 3, bytes(7));
  clearCapture();
  assert.equal(isCaptureEnabled(), true);
  const cap = exportCapture();
  assert.equal(cap.inputRequests.length, 0);
  assert.deepEqual(cap.tileKeys, []);
});

test('every input outputRequestId resolves to some output requestId', () => {
  enableCapture({ sceneStartMs: 0 });
  recordOutputRequest({ requestId: 'o1', z: 5, x: 9, y: 12 });
  recordOutputRequest({ requestId: 'o2', z: 6, x: 10, y: 13 });
  recordInputRequest({ outputRequestId: 'o1', z: 5, x: 9, y: 12, cacheHit: false });
  recordInputRequest({ outputRequestId: 'o1', z: 5, x: 9, y: 13, cacheHit: false });
  recordInputRequest({ outputRequestId: 'o2', z: 6, x: 10, y: 13, cacheHit: false });
  const cap = exportCapture();
  const outputIds = new Set(cap.outputRequests.map(o => o.requestId));
  for (const ir of cap.inputRequests) {
    assert.ok(outputIds.has(ir.outputRequestId),
      `input request references unknown outputRequestId=${ir.outputRequestId}`);
  }
});
