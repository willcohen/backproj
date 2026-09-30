// The wasmts handler loads ffi-wasm's handler runtime from the URL that
// init-pool! gives each handler, the same file that the proj handler in the
// worker loads. A copy built into dist/wasmts-handler.mjs is a second runtime
// in each worker, with its own queue and log config.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('dist/wasmts-handler.mjs holds no copy of the ffi-wasm handler runtime', async () => {
  const text = await readFile(new URL('../packages/backproj/dist/wasmts-handler.mjs', import.meta.url), 'utf8');
  assert.ok(!text.includes('makeHandler: `methods` is required'));
});
