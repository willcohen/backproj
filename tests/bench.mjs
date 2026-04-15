#!/usr/bin/env node

import { execSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { compare } from './compare.mjs';

const args = process.argv.slice(2);

function usage() {
  console.log(`Usage:
  node tests/bench.mjs                              Run suite, save results
  node tests/bench.mjs --baseline <dir>             Run suite + compare against baseline
  node tests/bench.mjs --compare <dir-a> <dir-b>    Compare two result dirs only
  node tests/bench.mjs --scenario <CRS>             Run single scenario (e.g. EPSG:2249)
`);
  process.exit(1);
}

function findLatestResults() {
  const resultsRoot = join(process.cwd(), 'results');
  if (!existsSync(resultsRoot)) return null;
  const dirs = readdirSync(resultsRoot)
    .filter(d => d.startsWith('bench-'))
    .sort()
    .reverse();
  return dirs.length > 0 ? join(resultsRoot, dirs[0]) : null;
}

// --compare mode: no Playwright, just diff two dirs
if (args[0] === '--compare') {
  if (args.length !== 3) usage();
  const code = compare(resolve(args[1]), resolve(args[2]));
  process.exit(code);
}

// Parse flags
let baselineDir = null;
let scenarioFilter = null;
const remaining = [...args];

while (remaining.length > 0) {
  const flag = remaining.shift();
  if (flag === '--baseline') {
    baselineDir = resolve(remaining.shift());
  } else if (flag === '--scenario') {
    scenarioFilter = remaining.shift();
  } else {
    console.error(`Unknown flag: ${flag}`);
    usage();
  }
}

// Build packages first
console.log('Building packages...');
try {
  execSync('npm run build:dev --workspaces', { stdio: 'inherit', cwd: process.cwd() });
} catch (e) {
  console.error('Build failed');
  process.exit(1);
}

// Run Playwright benchmarks
console.log('');
console.log('Running benchmarks...');
const env = { ...process.env };

// Use a consistent results dir for this run
const sha = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
const date = new Date().toISOString().slice(0, 10);
const resultsDir = join(process.cwd(), 'results', `bench-${date}-${sha}`);
env.BENCH_RESULTS_DIR = resultsDir;

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

// Compare if --baseline provided
if (baselineDir) {
  console.log('');
  const code = compare(baselineDir, resultsDir);
  process.exit(code);
}
