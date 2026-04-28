// chain.test.mjs -- the fused reprojectTile chain end to end in Node,
// with synthetic input tiles. This is the only pure-Node lane that
// exercises phase1 -> worker-side proj_trans_array -> phase2, so it is
// where cross-worker pointer bugs surface: a PJ created on a pool the
// chain does not target traps inside proj's wasm ("memory access out
// of bounds"), which no main-thread transform test can catch.
//
// The bare initProj() before createTileProcessor reproduces the demo
// page's boot order. Without the pool-mismatch guard in
// JointPoolClient.init, proj-wasm stays on its own spawned pool, every
// PJ lands there, and both reprojectTile calls below reject.

import test from 'node:test';
import assert from 'node:assert/strict';
import { fromGeojsonVt } from 'vt-pbf';
import {
  createTileProcessor, shutdownTileWorkers, buildTransformer,
  transformCoords, initProj, createTileCache,
} from '../packages/backproj/dist/backproj.mjs';

// One polygon spanning the full tile extent, so every decoded input
// covers its whole geographic footprint and the output cannot be empty.
function syntheticTile() {
  const E = 4096;
  const pbf = fromGeojsonVt({
    land: {
      features: [{
        geometry: [[[0, 0], [E, 0], [E, E], [0, E], [0, 0]]],
        type: 3,
        tags: { kind: 'land' },
      }],
    },
  }, { version: 2, extent: E });
  return pbf.buffer.slice(pbf.byteOffset, pbf.byteOffset + pbf.byteLength);
}

test('fused chain end to end, after a bare initProj()', { timeout: 120_000 }, async () => {
  // The demo page's boot order: proj first, processor second.
  await initProj();

  const proc = await createTileProcessor({ poolSize: 2 });
  const t = await buildTransformer('EPSG:2249');

  // The output tile containing Boston in fake space at z10.
  const [[fx, fy]] = await transformCoords([[-71.06, 42.36]], t);
  const z = 10;
  const tx = Math.floor((fx + 180) / 360 * 2 ** z);
  const latRad = fy * Math.PI / 180;
  const ty = Math.floor(
    (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * 2 ** z);

  const tileBytes = syntheticTile();
  const fetchTile = async () => tileBytes.slice(0);

  const out = await proc.reprojectTile(z, tx, ty, t, fetchTile, createTileCache());
  assert.ok(out.byteLength > 0,
    `output tile ${z}/${tx}/${ty} carries no features; the chain dropped everything`);

  await shutdownTileWorkers();
});
