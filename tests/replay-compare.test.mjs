// replay-compare.test.mjs -- subprocess tests of the replay-compare CLI
// against synthetic reports. Covers the four branches: happy-path PASS,
// hard-fail refusal (crs/cache_mode mismatch), soft-gate SKIP (manifest
// field drift), and regression FAIL (p50 anchor, threshold override).

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASELINE_COMPARISON_FIELDS } from './lib/fixture-validation.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const COMPARE_SCRIPT = join(REPO_ROOT, 'tests', 'replay-compare.mjs');

// Reports are built here rather than read from fixtures/, which is gitignored:
// keying off a captured fixture meant every test below skipped, and reported
// green, on any tree that had not run the live bench. Synthesising also lets a
// test move one stat at a time, which is what makes the gate assertions mean
// anything -- the gate reads pass_wall_stats.p50 and nothing else.
const stats = (p50) => ({
  min: p50 * 0.9, max: p50 * 1.1, mean: p50, p50, p99: p50 * 1.08,
  mad: p50 * 0.05, samples: 5,
});

function makeReport({ wallP50 = 20000, tileP50 = 500, crs = 'EPSG:2249',
                      cacheMode = 'lru', manifest = {} } = {}) {
  return {
    manifest: {
      scenario_name: 'EPSG2249', crs, waypoints_hash: 'abc123',
      tile_source_url: 'https://example.invalid/{z}/{x}/{y}.mvt',
      backproj_version: '0.0.4', proj_wasm_version: '0.1.0-alpha8',
      wasmts_version: '0.1.0-alpha5', worker_router_version: '0.0.1',
      maplibre_version: '5.20.0',
      captured_at: '2026-05-20T17:32:29.258Z',
      captured_commit_sha: 'deadbeef', captured_by: 'test',
      ...manifest,
    },
    crs,
    cache_mode: cacheMode,
    tile_count: 39,
    tile_summary: {
      total_ms: stats(tileP50), phase1_ms: stats(tileP50 * 0.5),
      phase2_ms: stats(tileP50 * 0.4), transform_coords_ms: stats(tileP50 * 0.1),
      inverse_bounds_ms: stats(1), input_tile_enum_ms: stats(1),
      fetch_ms: stats(5), marshal_ms: stats(2), inter_phase_idle_ms: stats(1),
      phase1_roundtrip_ms: stats(tileP50 * 0.5),
      phase2_roundtrip_ms: stats(tileP50 * 0.4),
    },
    cache_hits: 100,
    cache_misses: 39,
    replay_metadata: {
      warmup_passes: 2, measure_passes: 5, pass_wall_stats: stats(wallP50),
      mitata_version: '1.0.34', replayed_at: '2026-05-21T16:46:36.615Z',
    },
  };
}

function writeReport(dir, name, report) {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(report));
  return p;
}

function runCompare(baseline, candidate, env = {}) {
  return spawnSync(
    'node',
    [COMPARE_SCRIPT, baseline, candidate],
    { encoding: 'utf8', env: { ...process.env, ...env } },
  );
}

function tmpReport() {
  return mkdtempSync(join(tmpdir(), 'replay-compare-'));
}

function withReports(setup, fn) {
  const dir = tmpReport();
  try {
    fn(setup(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('identical reports -> PASS, exit 0', () => {
  withReports(
    dir => [writeReport(dir, 'baseline.json', makeReport()),
            writeReport(dir, 'candidate.json', makeReport())],
    ([bp, cp]) => {
      const r = runCompare(bp, cp);
      assert.equal(r.status, 0, `expected exit 0, got ${r.status}\n${r.stdout}\n${r.stderr}`);
      assert.match(r.stdout, /PASS: no regressions detected/);
      assert.match(r.stdout, /total \(per-tile\)\s+\S+ms\s+\S+ms\s+0\.0%/);
      // The gate is pass wall time, not the per-tile total, which tracks queueing.
      assert.match(r.stdout, /wall\/pass\s+\S+ms\s+\S+ms\s+0\.0%/);
    },
  );
});

test('CRS mismatch refuses, exit 1', () => {
  withReports(
    dir => [writeReport(dir, 'baseline.json', makeReport()),
            writeReport(dir, 'candidate.json', makeReport({ crs: 'EPSG:5070' }))],
    ([bp, cp]) => {
      const r = runCompare(bp, cp);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /crs mismatch/s);
    },
  );
});

test('cache_mode mismatch refuses, exit 1', () => {
  withReports(
    dir => [writeReport(dir, 'baseline.json', makeReport()),
            writeReport(dir, 'candidate.json', makeReport({ cacheMode: 'cold' }))],
    ([bp, cp]) => {
      const r = runCompare(bp, cp);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /cache_mode mismatch/s);
    },
  );
});

// Drift mutation: for string fields, append a suffix; for booleans, flip the
// value. Both produce a baseline != candidate diff that should soft-gate.
function driftValue(v) {
  if (typeof v === 'boolean') return !v;
  return v + '-test-drift';
}

function driftedPair(dir, field, extra = {}) {
  const base = makeReport();
  const drift = { [field]: driftValue(base.manifest[field]), ...extra };
  return [writeReport(dir, 'baseline.json', base),
          writeReport(dir, 'candidate.json', makeReport({ manifest: drift }))];
}

test('soft-gate: drift on any baseline-comparison field -> SKIP, exit 0', () => {
  for (const field of BASELINE_COMPARISON_FIELDS) {
    withReports(
      dir => driftedPair(dir, field),
      ([bp, cp]) => {
        const r = runCompare(bp, cp);
        assert.equal(r.status, 0, `${field}: expected exit 0 (skip is not a failure), got ${r.status}\n${r.stdout}\n${r.stderr}`);
        assert.match(r.stdout, /SKIP: manifest version mismatch/, `${field}: no SKIP banner`);
        assert.match(r.stdout, new RegExp(field));
      },
    );
  }
});

function runCompareWithArgs(extraArgs, baseline, candidate, env = {}) {
  return spawnSync(
    'node',
    [COMPARE_SCRIPT, baseline, candidate, ...extraArgs],
    { encoding: 'utf8', env: { ...process.env, ...env } },
  );
}

test('--allow-toggle: drift on the toggled field alone -> comparison runs (PASS), exit 0', () => {
  for (const field of BASELINE_COMPARISON_FIELDS) {
    withReports(
      dir => driftedPair(dir, field),
      ([bp, cp]) => {
        const r = runCompareWithArgs(['--allow-toggle', field], bp, cp);
        assert.equal(r.status, 0, `${field}: expected exit 0, got ${r.status}\n${r.stdout}\n${r.stderr}`);
        assert.match(r.stdout, /PASS: no regressions detected/, `${field}: no PASS banner`);
        // Toggled diff is logged in the header so the operator sees it.
        assert.match(r.stdout, new RegExp(`Toggles:[\\s\\S]*${field}`));
      },
    );
  }
});

test('--allow-toggle on one field does NOT mask drift on a different field (still skips)', () => {
  withReports(
    dir => driftedPair(dir, 'maplibre_version', { proj_wasm_version: '0.1.0-alpha8-bumped' }),
    ([bp, cp]) => {
      const r = runCompareWithArgs(['--allow-toggle', 'maplibre_version'], bp, cp);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /SKIP: manifest version mismatch/);
      assert.match(r.stdout, /proj_wasm_version/);
      // maplibre_version lands in the toggled section, not the version_diffs.
      assert.match(r.stdout, /allow-toggled[\s\S]*maplibre_version/);
    },
  );
});

test('--allow-toggle rejects unknown field names with a clear error', () => {
  const r = runCompareWithArgs(['--allow-toggle', 'not_a_real_field'], '/tmp/nope1', '/tmp/nope2');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not a baseline-comparison field/);
});

test('pass wall regression -> exit 1', () => {
  withReports(
    dir => [writeReport(dir, 'baseline.json', makeReport({ wallP50: 20000 })),
            writeReport(dir, 'candidate.json', makeReport({ wallP50: 25000 }))],
    ([bp, cp]) => {
      const r = runCompare(bp, cp);
      assert.equal(r.status, 1, `expected exit 1, got ${r.status}\n${r.stdout}\n${r.stderr}`);
      assert.match(r.stdout, /FAIL.*pass_wall_p50 delta.*exceeds threshold/s);
      assert.match(r.stdout, /wall\/pass\s+\S+\s+\S+\s+\+25\.0%/);
    },
  );
});

// Replay dispatches every tile at once and worker calls run serially, so each
// tile's clock spans the whole pass: those numbers track queueing, not work. A
// change that moves them without moving wall time is not a regression.
test('per-tile drift alone does not regress', () => {
  withReports(
    dir => [writeReport(dir, 'baseline.json', makeReport({ tileP50: 500 })),
            writeReport(dir, 'candidate.json', makeReport({ tileP50: 5000 }))],
    ([bp, cp]) => {
      const r = runCompare(bp, cp);
      assert.equal(r.status, 0, `10x per-tile drift must not regress when wall is flat\n${r.stdout}`);
      assert.match(r.stdout, /PASS: no regressions detected/);
    },
  );
});

test('pass wall regression below threshold -> PASS, exit 0', () => {
  withReports(
    dir => [writeReport(dir, 'baseline.json', makeReport({ wallP50: 20000 })),
            writeReport(dir, 'candidate.json', makeReport({ wallP50: 21000 }))],
    ([bp, cp]) => {
      const r = runCompare(bp, cp);
      assert.equal(r.status, 0, `5% is under the 10% default threshold\n${r.stdout}`);
      assert.match(r.stdout, /PASS/);
    },
  );
});

test('REGRESSION_THRESHOLD env override raises the bar', () => {
  withReports(
    dir => [writeReport(dir, 'baseline.json', makeReport({ wallP50: 20000 })),
            writeReport(dir, 'candidate.json', makeReport({ wallP50: 25000 }))],
    ([bp, cp]) => {
      // The same 25% pass-wall bump: FAIL at the 10% default, PASS at 30%.
      const strict = runCompare(bp, cp);
      assert.equal(strict.status, 1, `25% must fail the default threshold\n${strict.stdout}`);

      const lax = runCompare(bp, cp, { REGRESSION_THRESHOLD: '0.30' });
      assert.equal(lax.status, 0, `25% must pass a 30% threshold\n${lax.stdout}`);
      assert.match(lax.stdout, /Threshold: 30%/);
      assert.match(lax.stdout, /PASS/);
    },
  );
});
