#!/usr/bin/env node

// replay-compare.mjs -- replay-vs-replay regression check.
//
// This is the only comparison that cannot be done inside one process: two wasm
// builds both install to globalThis.wasmts, so they cannot coexist in a page.
// Every in-process A/B trick (bench-replay's --flat-construct ab) is unavailable
// across builds, which is what this exists for.
//
// That makes it vulnerable to the thing in-process A/B avoids: a developer box
// benchmarks the SAME code 13-25% apart depending on nothing but ambient load.
// One report per side cannot resolve anything smaller than that. Pass several
// per side instead, run in mirrored order, and this pairs them:
//
//   run order:  A1  B1  B2  A2          <- each A/B pair adjacent in time
//   invocation: --baseline A1,A2 --candidate B1,B2
//
// Pair i is (baseline[i], candidate[i]), so pair 1 is (A1,B1) and pair 2 is
// (A2,B2) -- adjacent in both cases. Drift cancels because B is later in pair 1
// and earlier in pair 2. The sign test across pairs is reported too: a mean that
// only half the pairs agree with is a coin flip, not a result.
//
// Gate metric is pass wall time (all output tiles, start to finish). Per-tile
// total_ms is NOT usable: replay dispatches every tile at once, worker calls run
// serially, so each tile's clock spans essentially the whole pass and per-tile
// figures track queueing rather than work.
//
// Two preconditions hard-fail:
//   - baseline.crs must equal candidate.crs
//   - baseline.cache_mode must equal candidate.cache_mode
// One soft-gate skips cleanly (exit 0):
//   - any baseline-comparison manifest field differing between the two
//     reports (replay numbers across version bumps aren't comparable).
//
// Soft-gate version check: mismatch on any
// baseline-comparison field skips the comparison cleanly. Replay numbers
// across version bumps aren't comparable; non-comparison is not a
// failure (exit 0).
//
// Selective opt-out: --allow-toggle <field> (repeatable) lets one or
// more baseline-comparison fields differ between the two reports
// without triggering the soft-gate skip. Toggled diffs are logged in
// the header so the operator can see they were skipped intentionally.
//
// Usage:
//   node tests/replay-compare.mjs <baseline-report.json> <candidate-report.json>
//                                  [--out <path>] [--allow-toggle <field>]

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { BASELINE_COMPARISON_FIELDS } from './lib/fixture-validation.mjs';

const REGRESSION_THRESHOLD = parseFloat(process.env.REGRESSION_THRESHOLD || '0.10');

// Measured floor for a single unpaired report pair on a developer box. Below
// this, a delta is indistinguishable from ambient drift, so a lone comparison
// gets a warning rather than a silent verdict.
const SINGLE_PAIR_NOISE_FLOOR = 0.25;

// `?` for undefined/null, the literal value otherwise ('' for empty,
// which validateManifestPinning would have already caught).
function fmtField(v) {
  return v === undefined || v === null ? '?' : String(v);
}

function usage() {
  console.log(`Usage: node tests/replay-compare.mjs <baseline-report(s)> <candidate-report(s)>
       [--out <path>] [--allow-toggle <field>]...

Each side takes one path, or several comma-separated. With several, reports are
paired by index and the per-pair deltas are averaged -- run them in mirrored
order so drift cancels:

  A1 B1 B2 A2   ->   replay-compare A1,A2 B1,B2

A single report per side cannot resolve a delta below roughly ${(SINGLE_PAIR_NOISE_FLOOR * 100).toFixed(0)}%; the same
code benchmarks that far apart run to run. You will be warned, not stopped.

--allow-toggle <field>   Permit a specific baseline-comparison field to
                         differ between baseline and candidate without
                         triggering the soft-gate skip. May be specified
                         multiple times. Toggled fields are still logged.

Exits 0 on pass or skip. Exits 1 on regression (mean paired wall delta >
REGRESSION_THRESHOLD, default 0.10) or hard-error.`);
  process.exit(1);
}

function loadReport(path) {
  if (!existsSync(path)) {
    console.error(`error: report not found at ${path}`);
    process.exit(1);
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    console.error(`error: failed to parse ${path}: ${err.message}`);
    process.exit(1);
  }
}

function delta(baseline, candidate) {
  return baseline === 0 ? 0 : (candidate - baseline) / baseline;
}

function fmtDelta(d) {
  const pct = (d * 100).toFixed(1);
  const sign = d > 0 ? '+' : '';
  return `${sign}${pct}%`;
}

function fmtMs(v) {
  return `${v.toFixed(1)}ms`;
}

function statusFor(d, regress) {
  if (regress) return 'REGRESS';
  if (d < -0.05) return 'faster';
  return 'ok';
}

// Parse args
let baselineArg = null, candidateArg = null, outPath = null;
const allowToggle = new Set();
const args = process.argv.slice(2);
while (args.length) {
  const flag = args.shift();
  if (flag === '--out') outPath = resolve(args.shift());
  else if (flag === '--allow-toggle') {
    const field = args.shift();
    if (!field) { console.error('error: --allow-toggle requires a field name'); usage(); }
    if (!BASELINE_COMPARISON_FIELDS.includes(field)) {
      console.error(`error: --allow-toggle field '${field}' is not a baseline-comparison field. Valid: ${BASELINE_COMPARISON_FIELDS.join(', ')}`);
      process.exit(1);
    }
    allowToggle.add(field);
  }
  else if (flag === '--help' || flag === '-h') usage();
  else if (!baselineArg) baselineArg = flag;
  else if (!candidateArg) candidateArg = flag;
  else { console.error(`unknown arg: ${flag}`); usage(); }
}
if (!baselineArg || !candidateArg) usage();

const baselinePaths = baselineArg.split(',').map(p => resolve(p.trim()));
const candidatePaths = candidateArg.split(',').map(p => resolve(p.trim()));
if (baselinePaths.length !== candidatePaths.length) {
  console.error(`error: ${baselinePaths.length} baseline report(s) but ${candidatePaths.length} candidate(s).`
    + ` Pairing is by index, so the sides must match.`);
  process.exit(1);
}

const baselines = baselinePaths.map(loadReport);
const candidates = candidatePaths.map(loadReport);
const baseline = baselines[0];
const candidate = candidates[0];
const baselinePath = baselinePaths[0];
const candidatePath = candidatePaths[0];

// Pass wall time is the gate metric. Fall back to the per-tile total only if an
// older report predates pass_wall_stats, and say so -- that number tracks
// queueing, not work.
function wallP50(r) {
  return r.replay_metadata?.pass_wall_stats?.p50 ?? null;
}
const haveWall = baselines.every(wallP50) && candidates.every(wallP50);

// Every pair must agree on crs/cache_mode, not just the first.
for (let i = 0; i < baselines.length; i++) {
  for (const [f, label] of [['crs', 'crs'], ['cache_mode', 'cache_mode']]) {
    if (baselines[i][f] !== candidates[i][f]) {
      console.error(`error: ${label} mismatch in pair ${i + 1} — `
        + `baseline=${baselines[i][f]} candidate=${candidates[i][f]}`);
      process.exit(1);
    }
  }
}

// Soft-gate version check. Diffs on allow-toggled fields are partitioned
// off; only diffs on non-allowed fields trigger the soft-gate skip.
const versionDiffs = [];
const toggledDiffs = [];
for (const f of BASELINE_COMPARISON_FIELDS) {
  if (baseline.manifest?.[f] !== candidate.manifest?.[f]) {
    const entry = `${f}: ${fmtField(baseline.manifest?.[f])} -> ${fmtField(candidate.manifest?.[f])}`;
    if (allowToggle.has(f)) toggledDiffs.push(entry);
    else versionDiffs.push(entry);
  }
}

let result;
if (versionDiffs.length > 0) {
  result = {
    baseline_path: baselinePath,
    candidate_path: candidatePath,
    crs: baseline.crs,
    cache_mode: baseline.cache_mode,
    total_delta: 0,
    phase1_delta: 0,
    phase2_delta: 0,
    transform_delta: 0,
    regressed: false,
    skipped: true,
    skip_reason: 'manifest version mismatch',
    version_diffs: versionDiffs,
    toggled_diffs: toggledDiffs,
  };
  console.log('');
  console.log(`Baseline:  ${baselinePath}`);
  console.log(`Candidate: ${candidatePath}`);
  console.log(`CRS:       ${baseline.crs}`);
  console.log(`Cache:     ${baseline.cache_mode}`);
  console.log('');
  console.log(`SKIP: manifest version mismatch (replay numbers not comparable across version bumps)`);
  for (const d of versionDiffs) console.log(`  ${d}`);
  if (toggledDiffs.length) {
    console.log(`  (allow-toggled, would not trigger skip on its own:)`);
    for (const d of toggledDiffs) console.log(`    ${d}`);
  }
  console.log('');
} else {
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  const pairDelta = (get) => baselines.map((b, i) => delta(get(b), get(candidates[i])));

  // Gate on pass wall. The per-tile figures come along for diagnosis only.
  const wallDeltas = haveWall ? pairDelta(wallP50) : pairDelta(r => r.tile_summary.total_ms.p50);
  const gate = mean(wallDeltas);
  const total = mean(pairDelta(r => r.tile_summary.total_ms.p50));
  const phase1 = mean(pairDelta(r => r.tile_summary.phase1_ms.p50));
  const phase2 = mean(pairDelta(r => r.tile_summary.phase2_ms.p50));
  const transform = mean(pairDelta(r => r.tile_summary.transform_coords_ms.p50));
  const regressed = gate > REGRESSION_THRESHOLD;

  // How many pairs agree with the mean's sign. Half is a coin flip.
  const agreeing = wallDeltas.filter(d => Math.sign(d) === Math.sign(gate)).length;

  result = {
    baseline_paths: baselinePaths,
    candidate_paths: candidatePaths,
    baseline_path: baselinePath,
    candidate_path: candidatePath,
    crs: baseline.crs,
    cache_mode: baseline.cache_mode,
    pairs: wallDeltas.length,
    gate_metric: haveWall ? 'pass_wall_p50' : 'tile_total_p50',
    wall_delta: gate,
    wall_deltas: wallDeltas,
    pairs_agreeing: agreeing,
    total_delta: total,
    phase1_delta: phase1,
    phase2_delta: phase2,
    transform_delta: transform,
    regressed,
    skipped: false,
    skip_reason: null,
    threshold: REGRESSION_THRESHOLD,
    toggled_diffs: toggledDiffs,
  };

  if (!haveWall) {
    console.log('');
    console.log('WARNING: reports predate pass_wall_stats; gating on per-tile total_ms,');
    console.log('         which tracks queueing rather than work. Recapture to fix.');
  }
  if (wallDeltas.length === 1 && Math.abs(gate) < SINGLE_PAIR_NOISE_FLOOR) {
    console.log('');
    console.log(`WARNING: one report per side and |delta| ${fmtDelta(gate)} is under the`);
    console.log(`         ~${(SINGLE_PAIR_NOISE_FLOOR * 100).toFixed(0)}% ambient drift floor. This does not distinguish a real`);
    console.log('         change from the box being busier. Run mirrored (A B B A) and pass');
    console.log('         --baseline A1,A2 --candidate B1,B2.');
  } else if (wallDeltas.length > 1) {
    console.log('');
    console.log(`paired wall deltas (${wallDeltas.length} pairs, ${agreeing}/${wallDeltas.length} agree with the mean):`);
    wallDeltas.forEach((d, i) => console.log(`  pair ${i + 1}: ${fmtDelta(d)}`));
    if (agreeing * 2 <= wallDeltas.length) {
      console.log('  the pairs do not agree on a direction; treat the mean as unresolved');
    }
  }

  console.log('');
  console.log(`Baseline:  ${baselinePath}`);
  console.log(`Candidate: ${candidatePath}`);
  console.log(`CRS:       ${baseline.crs}    Cache: ${baseline.cache_mode}    Threshold: ${(REGRESSION_THRESHOLD * 100).toFixed(0)}%`);
  if (toggledDiffs.length) {
    console.log('Toggles:');
    for (const d of toggledDiffs) console.log(`  ${d}`);
  }
  console.log('');
  const header = [
    'Phase'.padEnd(22),
    'Baseline p50'.padStart(14),
    'Candidate p50'.padStart(14),
    'Δ p50'.padStart(10),
    'Status'.padStart(8),
    '+ p99 (b → c)'.padStart(20),
    '+ mad (b → c)'.padStart(18),
  ].join('  ');
  console.log(header);
  console.log('-'.repeat(header.length));

  // Only the wall row is gated. The rest are per-tile figures under concurrent
  // dispatch: a faster phase1 reshuffles queueing and moves all of them, in both
  // directions, so they diagnose rather than judge.
  const rows = [];
  if (haveWall) {
    rows.push(['wall/pass', baselines[0].replay_metadata.pass_wall_stats,
               candidates[0].replay_metadata.pass_wall_stats, gate, regressed]);
  }
  rows.push(
    ['total (per-tile)', baseline.tile_summary.total_ms, candidate.tile_summary.total_ms, total, !haveWall && regressed],
    ['phase1 (per-tile)', baseline.tile_summary.phase1_ms, candidate.tile_summary.phase1_ms, phase1, false],
    ['phase2 (per-tile)', baseline.tile_summary.phase2_ms, candidate.tile_summary.phase2_ms, phase2, false],
    ['transform (per-tile)', baseline.tile_summary.transform_coords_ms, candidate.tile_summary.transform_coords_ms, transform, false],
  );
  for (const [name, b, c, d, isRegress] of rows) {
    console.log([
      name.padEnd(22),
      fmtMs(b.p50).padStart(14),
      fmtMs(c.p50).padStart(14),
      fmtDelta(d).padStart(10),
      statusFor(d, isRegress).padStart(8),
      `${fmtMs(b.p99)} → ${fmtMs(c.p99)}`.padStart(20),
      `${b.mad.toFixed(1)} → ${c.mad.toFixed(1)}`.padStart(18),
    ].join('  '));
  }
  console.log('');
  if (regressed) {
    console.log(`FAIL: ${result.gate_metric} delta ${fmtDelta(gate)} exceeds threshold ${(REGRESSION_THRESHOLD * 100).toFixed(0)}%`);
  } else {
    console.log(`PASS: no regressions detected`);
  }
  console.log('');
}

if (outPath) {
  writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`result written to ${outPath}`);
}

process.exit(result.regressed ? 1 : 0);
