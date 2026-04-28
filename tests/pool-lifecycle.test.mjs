// Joint-pool lifecycle through clj-native's workload-pool registry.
// The only node lane that drives createTileProcessor/shutdownTileWorkers;
// the other node tests use proj-wasm's own pool or pure functions.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTileProcessor, shutdownTileWorkers, buildTransformer, transformCoords,
} from '../packages/backproj/dist/backproj.mjs';
import { worker_call } from 'ffi-wasm/pool';

// A fresh transformer + one forward transform. Routes through the proj
// handler on the joint pool: finite output proves proj-wasm adopted the
// registry-built pool and its handler answers.
async function roundTrip() {
  const t = await buildTransformer('EPSG:2249');
  const out = await transformCoords([[-71.058, 42.36]], t);
  assert.ok(Number.isFinite(out[0][0]) && Number.isFinite(out[0][1]),
    'transform through the joint pool returns finite coords');
}

// Bounded timeout: a lifecycle regression (e.g. a transform routed to a
// terminated pool) can hang instead of rejecting, and node:test's default
// timeout is infinite — without this the lane wedges instead of going red.
test('joint-pool lifecycle through the workload-pool registry',
     { timeout: 60_000 }, async () => {
  const proc = await createTileProcessor({ poolSize: 2 });
  assert.equal(proc.poolSize, 2, 'pool spawned at requested size');
  assert.ok(proc.pool, 'processor reads the live pool through the registry');
  // A wasmts-handler call through the registry-read pool: proves the
  // second co-resident handler answers, not only proj.
  await worker_call(proc.pool, 'net.willcohen.wasmts', 'setConfig',
    [{ debugLabels: false }], 0);
  await roundTrip();

  await proc.shutdown();
  assert.equal(proc.pool, null, 'registry read-through goes null after shutdown');

  // Re-init must yield a WORKING pool: shutdown ran shutdownProj (clearing
  // proj-wasm's memoized init promise) BEFORE the registry terminated the
  // workers. A stale memo would hand initProj the cached promise and route
  // this transform to the terminated pool.
  const proc2 = await createTileProcessor({ poolSize: 2 });
  assert.equal(proc2.poolSize, 2, 'second lifecycle spawns a fresh pool');
  await roundTrip();

  await shutdownTileWorkers();
  assert.equal(proc2.pool, null, 'second pool also goes null after shutdown');
});
