// The first reprojectStyle of a process. createTileProcessor moves proj-wasm
// onto the tile pool and terminates the pool proj-wasm started on
// (TileClient.init: shutdownProj, then initProj({pool})). A transformer built
// before that move holds PJ pointers into a heap that no longer exists, and a
// call with it runs on a tile worker's heap instead: a wasm trap, or garbage.
// reprojectStyle must therefore create the tile processor before it builds
// its transformer.
//
// A page that already used proj-wasm (cg-app reads the CRS catalog for its
// picker) is the case that shows it: the catalog query grows the heap, so a
// PJ built after it lies past the end of a fresh tile worker's heap.
import test from 'node:test';
import assert from 'node:assert/strict';
import { initProj } from 'backproj';
import * as proj from 'proj-wasm';
import { reprojectStyle, shutdownTileWorkers } from '../packages/maplibre-proj/dist/maplibre-proj.mjs';

const style = {
  version: 8,
  sources: {
    omt: { type: 'vector', tiles: ['https://tiles.invalid/{z}/{x}/{y}.mvt'], maxzoom: 14 },
  },
  layers: [],
};

const finite = (pairs) => pairs.flat().every(Number.isFinite);

// The process does not exit after teardown; run with --test-force-exit.
test('the first reprojectStyle after proj-wasm ran on its own pool',
     { timeout: 120_000 }, async () => {
  try {
    await initProj();
    const catalog = await proj.projGetCrsInfoListFromDatabase({ auth_name: '' });
    assert.ok(catalog.length > 1000, 'catalog query ran on proj-wasm\'s own pool');

    const first = await reprojectStyle({ style, crs: 'EPSG:2249' });
    assert.ok(finite(first.bounds), `EPSG:2249 bounds are finite: ${JSON.stringify(first.bounds)}`);
    assert.ok(first.maxBounds && finite(first.maxBounds), 'EPSG:2249 is regional and has maxBounds');
    first.cleanup();

    const second = await reprojectStyle({ style, crs: 'EPSG:5070' });
    assert.ok(finite(second.bounds), `EPSG:5070 bounds are finite: ${JSON.stringify(second.bounds)}`);
    second.cleanup();
  } finally {
    await shutdownTileWorkers();
    await proj.shutdown_BANG_();
  }
});
