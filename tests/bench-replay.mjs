#!/usr/bin/env node

// bench-replay.mjs -- offline fixture replay.
//
// Loads a captured ScenarioFixture, validates manifest pinning and the
// hard-gate staleness rules, then drives the browser-side TileProcessor
// through a minimal Playwright page (docs/replay.html) for each
// OutputTileRequest in the fixture.
//
// Playwright rather than plain Node because TileProcessor uses Web
// Workers and proj-wasm / wasmts target a browser realm; a Node walk of
// phase1/transform/phase2 would measure a different system than users hit.
//
// mitata drives the per-pass iteration (wall stats land in
// replay_metadata.pass_wall_stats). Its measure() in 1.0.34 does not
// accept precomputed sample arrays, so the per-phase taps aggregate via
// buildTileSummary (./lib/tile-summary.mjs), using mitata's stats shape:
// min/max/mean/p50/p99/mad/samples (MitataTrialStats). The mitata MIT
// license is reproduced below as courtesy attribution.
//
// The LRU cache is created once in initReplay and persists across all
// passes: lru reaches steady-state after warmup; cold passes undefined
// so every fetch misses against the disk-backed fixture.
//
// Usage:
//   node tests/bench-replay.mjs --fixture fixtures/EPSG2249 [--cache lru|cold]

import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildTileSummary, TILE_SUMMARY_SAMPLE_KEYS } from './lib/tile-summary.mjs';
import { chromium } from '@playwright/test';
import { measure } from 'mitata';
import {
  loadFixture,
  validateManifestPinning, validateHardGate, validateFixtureCoverage,
  readTileBytesAsBase64Map, TILE_SOURCE_URL_DEFAULT,
} from './lib/fixture-validation.mjs';

const REPLAY_PAGE = 'http://localhost:8973/replay.html';
const MITATA_VERSION = JSON.parse(
  readFileSync(new URL('../node_modules/mitata/package.json', import.meta.url), 'utf8'),
).version;

function usage() {
  console.log(`Usage:
  node tests/bench-replay.mjs --fixture <dir> [options]

Options:
  --cache lru|cold      Cache axis (default: lru). lru: shared LRU steady-state
                        across all passes. cold: no cache, every input fetch
                        is a miss against the disk-backed fixture.
  --warmup <n>          Cache-priming passes run before mitata (default: 1).
                        Discarded; their only purpose is to fill the LRU.
  --pool-size <n>       Worker count (default: 0 = navigator.hardwareConcurrency).
                        DIFFERENT knob from --concurrency: shrinking the pool
                        cuts CPU oversubscription but an unbounded caller still
                        queues every phase1 ahead of any phase2, so every tile's
                        geometry stays live regardless of pool size.
  --concurrency <n>     Max tiles in flight (default: 0 = unbounded, the live
                        maplibre fan-out). Worker calls run serially, so an
                        unbounded fan-out fills every worker queue with phase1s
                        before any transform is enqueued: the chain degenerates
                        to all-phase1s -> all-transforms -> all-phase2s and every
                        tile's clock spans the whole pass, making per-tile stage
                        timings unreadable. Use 1 to measure real per-tile work.
  --passes <n>          Measurement-pass count for mitata (default: 3). Passed
                        as both min_samples and max_samples so mitata runs
                        exactly this many iterations of the scenario closure.
  --out <path>          Replay report path (default: <fixture>/replay-report-<cache>.json)
`);
  process.exit(1);
}

// Reproduced verbatim from node_modules/mitata/LICENSE.md as courtesy
// attribution because mitata genuinely drives this harness's iteration
// (not because backproj imports it -- it doesn't).
//
//   mitata -- https://github.com/evanwashere/mitata
//
//   Copyright 2022 evanwashere
//
//   Permission is hereby granted, free of charge, to any person
//   obtaining a copy of this software and associated documentation
//   files (the "Software"), to deal in the Software without restriction,
//   including without limitation the rights to use, copy, modify, merge,
//   publish, distribute, sublicense, and/or sell copies of the Software,
//   and to permit persons to whom the Software is furnished to do so,
//   subject to the following conditions:
//
//   The above copyright notice and this permission notice shall be
//   included in all copies or substantial portions of the Software.
//
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
//   EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
//   MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
//   NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS
//   BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN
//   ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
//   CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
//   SOFTWARE.

// Reshape mitata's measure() return into a MitataTrialStats so the
// per-pass-wall block matches the per-phase blocks. mitata's `avg` is
// the arithmetic mean; samples count is the array length; mad is
// computed against p50. mitata's now() returns nanoseconds, so divide
// by 1e6 to land in milliseconds (the unit the per-phase blocks use,
// since they come from in-pipeline performance.now() deltas).
function mitataStatsToTrialStats(m) {
  const samples = m.samples;
  const p50ns = m.p50;
  const absDevs = samples.map(v => Math.abs(v - p50ns)).sort((a, b) => a - b);
  const madNs = absDevs.length === 0
    ? 0
    : absDevs[Math.floor(absDevs.length * 0.5)];
  const NS_PER_MS = 1e6;
  return {
    min: m.min / NS_PER_MS,
    max: m.max / NS_PER_MS,
    mean: m.avg / NS_PER_MS,
    p50: p50ns / NS_PER_MS,
    p99: m.p99 / NS_PER_MS,
    mad: madNs / NS_PER_MS,
    samples: samples.length,
  };
}

let fixturePath = null;
let cacheMode = 'lru';
let warmupPasses = 1;
let measurePasses = 3;
let outputPath = null;
let concurrency = 0;
let poolSize = 0;
const args = process.argv.slice(2);
while (args.length) {
  const flag = args.shift();
  if (flag === '--fixture') fixturePath = resolve(args.shift());
  else if (flag === '--cache') cacheMode = args.shift();
  else if (flag === '--warmup') warmupPasses = parseInt(args.shift(), 10);
  else if (flag === '--passes') measurePasses = parseInt(args.shift(), 10);
  else if (flag === '--out') outputPath = resolve(args.shift());
  else if (flag === '--concurrency') concurrency = parseInt(args.shift(), 10);
  else if (flag === '--pool-size') poolSize = parseInt(args.shift(), 10);
  else if (flag === '--help' || flag === '-h') usage();
  else { console.error(`unknown flag: ${flag}`); usage(); }
}
if (!fixturePath) usage();
if (cacheMode !== 'lru' && cacheMode !== 'cold') {
  console.error(`--cache must be 'lru' or 'cold', got '${cacheMode}'`);
  process.exit(1);
}
if (!Number.isInteger(poolSize) || poolSize < 0) {
  console.error(`--pool-size must be a non-negative integer (0 = navigator.hardwareConcurrency)`);
  process.exit(1);
}
if (!Number.isInteger(concurrency) || concurrency < 0) {
  console.error(`--concurrency must be a non-negative integer (0 = unbounded)`);
  process.exit(1);
}
if (!Number.isInteger(measurePasses) || measurePasses < 1) {
  console.error(`--passes must be a positive integer`);
  process.exit(1);
}
if (!Number.isInteger(warmupPasses) || warmupPasses < 0) {
  console.error(`--warmup must be a non-negative integer`);
  process.exit(1);
}

async function ensureServer() {
  const probe = await fetch('http://localhost:8973/replay.html').catch(() => null);
  if (probe && probe.ok) return null;
  const child = (await import('node:child_process')).spawn('node', ['tests/server.mjs'], {
    detached: false, stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 100));
    const r = await fetch('http://localhost:8973/replay.html').catch(() => null);
    if (r && r.ok) return child;
  }
  child.kill();
  throw new Error('server failed to start on port 8973');
}

async function main() {
  console.log(`fixture: ${fixturePath}`);
  console.log(`cache mode: ${cacheMode}`);

  const fixture = loadFixture(fixturePath);

  validateManifestPinning(fixture.manifest);
  console.log(`manifest: ${fixture.manifest.scenario_name} / ${fixture.manifest.crs} / backproj=${fixture.manifest.backproj_version} proj-wasm=${fixture.manifest.proj_wasm_version} wasmts=${fixture.manifest.wasmts_version} maplibre=${fixture.manifest.maplibre_version}`);

  const scenarios = JSON.parse(readFileSync(new URL('scenarios.json', import.meta.url), 'utf8'));
  validateHardGate(fixture.manifest, scenarios, {
    tileSourceUrl: process.env.BENCH_TILE_SOURCE_URL || TILE_SOURCE_URL_DEFAULT,
  });
  console.log(`staleness gate: pass`);

  validateFixtureCoverage(fixture.dir, fixture.inputRequests);
  console.log(`coverage: ${fixture.outputRequests.length} output, ${fixture.inputRequests.length} input, ${new Set(fixture.inputRequests.map(r => `${r.z}/${r.x}/${r.y}`)).size} unique tiles`);

  const serverChild = await ensureServer();

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    page.on('pageerror', err => console.error(`[browser] ${err.message}`));
    page.on('console', msg => {
      if (msg.type() === 'error') console.error(`[browser] ${msg.text()}`);
    });

    await page.goto(REPLAY_PAGE, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.initReplay === 'function', null, { timeout: 30_000 });

    console.log(`init: building transformer for ${fixture.manifest.crs} (cache=${cacheMode}`
      + `, pool=${poolSize || 'hardwareConcurrency'}, in-flight=${concurrency || 'unbounded'})...`);
    await page.evaluate(
      async ({ crs, mode, poolSize }) => { await window.initReplay(crs, mode, poolSize || undefined); },
      { crs: fixture.manifest.crs, mode: cacheMode, poolSize },
    );

    const tilesBase64 = readTileBytesAsBase64Map(fixture.dir, fixture.inputRequests);
    const entries = Object.entries(tilesBase64);
    console.log(`loading ${entries.length} tiles into page...`);
    const BATCH = 50;
    for (let i = 0; i < entries.length; i += BATCH) {
      const slice = entries.slice(i, i + BATCH);
      await page.evaluate(batch => {
        for (const [k, b] of batch) window.loadFixtureTile(k, b);
      }, slice);
    }
    const loaded = await page.evaluate(() => window.fixtureSize());
    if (loaded !== entries.length) {
      throw new Error(`tile load count mismatch: expected ${entries.length}, page has ${loaded}`);
    }

    // Cache-priming passes run BEFORE mitata so the LRU is already
    // warm when mitata begins measuring. Mitata's own warmup_samples
    // (default 2) is meant for JIT warm-up, not cache fill, so the
    // explicit prime stays.
    for (let i = 0; i < warmupPasses; i++) {
      console.log(`warmup ${i + 1}/${warmupPasses}...`);
      const r = await page.evaluate(
        async ({ outputRequests, label, concurrency }) => window.runReplay(outputRequests, label, concurrency),
        { outputRequests: fixture.outputRequests, label: `warmup ${i + 1}`, concurrency },
      );
      if (r.failed > 0) {
        throw new Error(`warmup pass ${i + 1} had ${r.failed} failures: ${r.lastError}`);
      }
      if (r.ok === 0) {
        throw new Error(`warmup pass ${i + 1} produced 0 ok tiles (${r.empty} empty): ` +
          'no output tile carries features, the pipeline is broken');
      }
    }

    // Measurement: one mitata.measure() call, scenario-pass closure.
    // Each iteration walks the full output_requests list once and
    // appends per-phase samples to `merged`. min_samples ==
    // max_samples == measurePasses pins iteration count to the user
    // flag; min_cpu_time: 0 disables mitata's "keep going until 642ms
    // CPU" floor since each pass is multi-second already.
    //
    // mitata calls the closure once before its measurement loop for
    // an internal timing/warmup probe (lib.mjs `warmup:` block). The
    // probe's samples shouldn't pollute per-phase aggregation, so
    // after measure() returns we trim merged arrays to the last
    // measurePasses × tilesPerPass entries (whatever mitata produced
    // beyond the expected count is the probe overflow). mitata's
    // own pass_wall_stats already excludes the probe -- it tracks
    // exactly samples.length = measurePasses iterations.
    //
    // Cache state and counters (cacheHits, ok, etc.) DO accumulate
    // probe-call traffic because there's no way to know which call
    // is the probe; the over-counting is small relative to the
    // warmup pass already run before mitata.
    // One entry per report field; the page emits sample arrays under the
    // same key set, so the two sides cannot drift.
    const merged = Object.fromEntries(
      Object.values(TILE_SUMMARY_SAMPLE_KEYS).map(k => [k, []]));
    let okSum = 0, emptySum = 0, failedSum = 0, lastError = null;
    let cacheHits = 0, cacheMisses = 0, tilesPerPass = 0;
    let decodeCacheHits = 0, decodeCacheMisses = 0;
    let iterIdx = 0;

    const passWallStats = await measure(async () => {
      iterIdx += 1;
      console.log(`mitata iter ${iterIdx} (closure call ${iterIdx} of ${measurePasses}+probe)...`);
      const r = await page.evaluate(
        async ({ outputRequests, label, concurrency }) => window.runReplay(outputRequests, label, concurrency),
        { outputRequests: fixture.outputRequests, label: `iter ${iterIdx}`, concurrency },
      );
      okSum += r.ok; emptySum += r.empty; failedSum += r.failed;
      if (r.lastError) lastError = r.lastError;
      cacheHits += r.cacheHits || 0;
      cacheMisses += r.cacheMisses || 0;
      decodeCacheHits += r.decodeCacheHits || 0;
      decodeCacheMisses += r.decodeCacheMisses || 0;
      tilesPerPass = r.tileCount;
      for (const k of Object.keys(merged)) merged[k].push(...r.samples[k]);
    }, {
      min_samples: measurePasses,
      max_samples: measurePasses,
      min_cpu_time: 0,
    });

    const expectedPerPhase = measurePasses * tilesPerPass;
    for (const k of Object.keys(merged)) {
      if (merged[k].length > expectedPerPhase) {
        merged[k] = merged[k].slice(merged[k].length - expectedPerPhase);
      }
    }

    if (failedSum > 0) {
      console.error(`replay had ${failedSum} failures across measurement passes${lastError ? ': ' + lastError : ''}`);
      process.exitCode = 1;
    }
    if (okSum === 0) {
      console.error(`replay produced 0 ok tiles across measurement passes (${emptySum} empty): ` +
        'no output tile carries features, the pipeline is broken');
      process.exitCode = 1;
    }

    const tileSummary = buildTileSummary(merged);
    const report = {
      manifest: fixture.manifest,
      crs: fixture.manifest.crs,
      cache_mode: cacheMode,
      tile_count: tilesPerPass,
      tile_summary: tileSummary,
      cache_hits: cacheHits,
      cache_misses: cacheMisses,
      decode_cache_hits: decodeCacheHits,
      decode_cache_misses: decodeCacheMisses,
      replay_metadata: {
        warmup_passes: warmupPasses,
        measure_passes: measurePasses,
        // Mitata's stats over wall-time-per-scenario-pass, reshaped to
        // the MitataTrialStats field set so it matches the per-phase
        // blocks. This is the block mitata actually produces; the
        // per-phase blocks are samples merged inside the closure.
        pass_wall_stats: mitataStatsToTrialStats(passWallStats),
        mitata_version: MITATA_VERSION,
        replayed_at: new Date().toISOString(),
      },
    };

    const reportPath = outputPath || join(fixture.dir, `replay-report-${cacheMode}.json`);
    writeFileSync(reportPath, JSON.stringify(report, null, 2));

    console.log('');
    console.log(`replay summary (${measurePasses} passes, cache=${cacheMode}):`);
    console.log(`  tiles per pass:   ${tilesPerPass}`);
    console.log(`  total samples:    ${tileSummary.total_ms.samples}`);
    console.log(`  ok / empty / fail: ${okSum} / ${emptySum} / ${failedSum}`);
    console.log(`  cache hits/miss:  ${cacheHits} / ${cacheMisses}`);
    console.log(`  decode cache h/m: ${decodeCacheHits} / ${decodeCacheMisses}  (worker-side, dev builds only)`);
    console.log(`  pass wall p50:    ${report.replay_metadata.pass_wall_stats.p50.toFixed(0)}ms  (p99 ${report.replay_metadata.pass_wall_stats.p99.toFixed(0)}, n=${report.replay_metadata.pass_wall_stats.samples})`);
    console.log(`  total p50:        ${tileSummary.total_ms.p50.toFixed(1)}ms  (p99 ${tileSummary.total_ms.p99.toFixed(1)}, mad ${tileSummary.total_ms.mad.toFixed(2)})`);
    console.log(`  phase1 body p50:  ${tileSummary.phase1_ms.p50.toFixed(1)}ms  (p99 ${tileSummary.phase1_ms.p99.toFixed(1)})  [WORKER BODY, not main-thread wall]`);
    console.log(`  phase2 body p50:  ${tileSummary.phase2_ms.p50.toFixed(1)}ms  (p99 ${tileSummary.phase2_ms.p99.toFixed(1)})  [WORKER BODY]`);
    console.log(`  chain wall p50:   ${tileSummary.chain_roundtrip_ms.p50.toFixed(1)}ms  (p99 ${tileSummary.chain_roundtrip_ms.p99.toFixed(1)})  [MAIN-THREAD WALL: queue wait + all three stages]`);
    console.log(`  transform p50:    ${tileSummary.transform_coords_ms.p50.toFixed(1)}ms  (p99 ${tileSummary.transform_coords_ms.p99.toFixed(1)})`);
    console.log(`  inverseBounds p50:${tileSummary.inverse_bounds_ms.p50.toFixed(1)}ms  (p99 ${tileSummary.inverse_bounds_ms.p99.toFixed(1)})`);
    console.log(`  inputTileEnum p50:${tileSummary.input_tile_enum_ms.p50.toFixed(1)}ms  (p99 ${tileSummary.input_tile_enum_ms.p99.toFixed(1)})`);
    const p1 = tileSummary.phase1_ms.p50 || 1, p2 = tileSummary.phase2_ms.p50 || 1;
    const pctRow = (label, s, denom) => `  ${label.padEnd(16)} ${s.p50.toFixed(2).padStart(7)}ms  (${(s.p50 / denom * 100).toFixed(1).padStart(4)}% of phase)`;
    console.log(`  --- phase1 detail (p50 per tile, % of phase1 body) ---`);
    console.log(pctRow('decode', tileSummary.decode_ms, p1));
    console.log(pctRow('construct', tileSummary.construct_ms, p1));
    console.log(pctRow('coordExtract', tileSummary.coord_extract_ms, p1));
    console.log(pctRow('densify', tileSummary.densify_ms, p1));
    console.log(`  --- phase2 detail (p50 per tile, % of phase2 body) ---`);
    console.log(pctRow('apply', tileSummary.apply_ms, p2));
    console.log(pctRow('isValid', tileSummary.is_valid_ms, p2));
    console.log(pctRow('clip', tileSummary.clip_ms, p2));
    console.log(pctRow('precision', tileSummary.precision_ms, p2));
    console.log(pctRow('encode', tileSummary.encode_ms, p2));
    console.log(pctRow('  ^ geojsonWrite', tileSummary.geojson_write_ms, p2));
    console.log(`  report:           ${reportPath}`);
  } finally {
    await browser.close();
    if (serverChild) serverChild.kill();
  }
}

main().catch(err => {
  console.error(`replay failed: ${err.message}`);
  process.exit(1);
});
