#!/usr/bin/env node

// bench.mjs -- live-network run against a real tile server.
//
// This exercises the one path the offline replay cannot: real fetches over the
// network, against whatever the upstream tile server currently serves. Treat it
// as an integration check.
//
// It deliberately does NOT gate on timings. Network variance dwarfs anything
// worth measuring here, and a developer box benchmarks the same code 13-25%
// apart on its own. For performance work use the offline replay, which pins the
// input bytes:
//
//   npm run bench:replay          -- reproducible, fixture-backed
//   npm run bench:replay:compare  -- build-vs-build, mirrored and paired
//
// Capture (tests/benchmark.spec.ts) is what turns a live run into those
// fixtures.

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { TILE_SOURCE_URL_DEFAULT } from './lib/fixture-validation.mjs';

const FIXTURE_ROOT_DEFAULT = 'fixtures';

function readPackageVersion(pkgPath) {
  try {
    const p = JSON.parse(readFileSync(pkgPath, 'utf8'));
    return p.version || '';
  } catch {
    return '';
  }
}

function gatherVersions(cwd) {
  return {
    backproj_version: readPackageVersion(join(cwd, 'packages/backproj/package.json')),
    proj_wasm_version: readPackageVersion(join(cwd, 'node_modules/proj-wasm/package.json')),
    wasmts_version: readPackageVersion(join(cwd, 'node_modules/@wcohen/wasmts/package.json')),
    maplibre_version: readPackageVersion(join(cwd, 'node_modules/maplibre-gl/package.json')),
    // backproj depends on worker-router directly via the joint-pool wiring
    // (tile-processor builds the pool with both proj + wasmts handlers).
    worker_router_version: readPackageVersion(join(cwd, 'node_modules/worker-router/package.json')) || 'n/a',
  };
}

const args = process.argv.slice(2);

function usage() {
  console.log(`Usage:
  node tests/bench.mjs                    Live-network run against a real tile server
  node tests/bench.mjs --scenario <CRS>   Single scenario (e.g. EPSG:2249)

Saves results and exits 0. Does not gate on timings; see the header.
`);
  process.exit(1);
}

let scenarioFilter = null;
const remaining = [...args];

while (remaining.length > 0) {
  const flag = remaining.shift();
  if (flag === '--scenario') {
    scenarioFilter = remaining.shift();
  } else {
    console.error(`Unknown flag: ${flag}`);
    usage();
  }
}

console.log('Building packages...');
try {
  execSync('npm run build:dev --workspaces', { stdio: 'inherit', cwd: process.cwd() });
} catch (e) {
  console.error('Build failed');
  process.exit(1);
}

console.log('');
console.log('Running benchmarks...');
const env = { ...process.env };

const sha = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
const fullSha = (() => {
  try { return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim(); }
  catch { return sha; }
})();
const date = new Date().toISOString().slice(0, 10);
const resultsDir = join(process.cwd(), 'results', `bench-${date}-${sha}`);
env.BENCH_RESULTS_DIR = resultsDir;

// waypoints_hash is computed in benchmark.spec.ts, which reads scenarios.json.
const versions = gatherVersions(process.cwd());
env.BENCH_FIXTURE_ROOT = process.env.BENCH_FIXTURE_ROOT || FIXTURE_ROOT_DEFAULT;
env.BENCH_TILE_SOURCE_URL = process.env.BENCH_TILE_SOURCE_URL || TILE_SOURCE_URL_DEFAULT;
env.BENCH_VERSION_BACKPROJ = versions.backproj_version;
env.BENCH_VERSION_PROJ_WASM = versions.proj_wasm_version;
env.BENCH_VERSION_WASMTS = versions.wasmts_version;
env.BENCH_VERSION_WORKER_ROUTER = versions.worker_router_version;
env.BENCH_VERSION_MAPLIBRE = versions.maplibre_version;
env.BENCH_GIT_SHA = fullSha;
env.BENCH_CAPTURED_BY = hostname();
env.BENCH_CAPTURED_AT = new Date().toISOString();

let pwArgs = 'npx playwright test tests/benchmark.spec.ts --reporter=list';
if (scenarioFilter) {
  pwArgs += ` --grep "${scenarioFilter}"`;
}

try {
  execSync(pwArgs, { stdio: 'inherit', cwd: process.cwd(), env });
} catch (e) {
  console.error('Benchmark run failed');
  process.exit(1);
}

console.log('');
console.log(`Results saved to: ${resultsDir}`);
