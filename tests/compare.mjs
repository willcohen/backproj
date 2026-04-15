#!/usr/bin/env node

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REGRESSION_THRESHOLD = 0.10;

function loadReports(dir) {
  const files = readdirSync(dir).filter(f => f.endsWith('.json') && f.startsWith('bench-'));
  const reports = new Map();
  for (const f of files) {
    const data = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    const crs = data.metadata?.crs;
    if (crs) reports.set(crs, { file: f, data });
  }
  return reports;
}

function delta(baseline, candidate) {
  return baseline === 0 ? 0 : (candidate - baseline) / baseline;
}

function fmtDelta(d) {
  const pct = (d * 100).toFixed(1);
  const sign = d > 0 ? '+' : '';
  return `${sign}${pct}%`;
}

function fmtMs(ms) {
  return `${Math.round(ms)}ms`;
}

export function compare(baselineDir, candidateDir) {
  const baseReports = loadReports(baselineDir);
  const candReports = loadReports(candidateDir);

  const allCrs = new Set([...baseReports.keys(), ...candReports.keys()]);
  let hasRegression = false;

  console.log('');
  console.log(`Baseline:  ${baselineDir}`);
  console.log(`Candidate: ${candidateDir}`);
  console.log(`Threshold: ${(REGRESSION_THRESHOLD * 100).toFixed(0)}%`);
  console.log('');

  const header = [
    'CRS'.padEnd(14),
    'Metric'.padEnd(18),
    'Baseline'.padStart(10),
    'Candidate'.padStart(10),
    'Delta'.padStart(10),
    'Status'.padStart(8),
  ].join('  ');
  console.log(header);
  console.log('-'.repeat(header.length));

  for (const crs of [...allCrs].sort()) {
    const base = baseReports.get(crs);
    const cand = candReports.get(crs);

    if (!base) {
      console.log(`${crs.padEnd(14)}  (no baseline)`);
      continue;
    }
    if (!cand) {
      console.log(`${crs.padEnd(14)}  (no candidate)`);
      continue;
    }

    const bPool = base.data.metadata?.poolSize;
    const cPool = cand.data.metadata?.poolSize;
    if (bPool !== cPool) {
      console.log(`${crs.padEnd(14)}  SKIP: pool size mismatch (${bPool} vs ${cPool})`);
      continue;
    }

    const metrics = [
      { name: 'p50 total', b: base.data.tileSummary.totalMs.p50, c: cand.data.tileSummary.totalMs.p50 },
      { name: 'p50 phase1', b: base.data.tileSummary.phase1Ms.p50, c: cand.data.tileSummary.phase1Ms.p50 },
      { name: 'p50 phase2', b: base.data.tileSummary.phase2Ms.p50, c: cand.data.tileSummary.phase2Ms.p50 },
      { name: 'p50 transform', b: base.data.tileSummary.transformCoordsMs.p50, c: cand.data.tileSummary.transformCoordsMs.p50 },
    ];

    for (const m of metrics) {
      const d = delta(m.b, m.c);
      const regressed = m.name === 'p50 total' && d > REGRESSION_THRESHOLD;
      if (regressed) hasRegression = true;

      const status = regressed ? 'REGRESS' : d < -0.05 ? 'faster' : 'ok';
      const row = [
        (m === metrics[0] ? crs : '').padEnd(14),
        m.name.padEnd(18),
        fmtMs(m.b).padStart(10),
        fmtMs(m.c).padStart(10),
        fmtDelta(d).padStart(10),
        status.padStart(8),
      ].join('  ');
      console.log(row);
    }
    console.log('');
  }

  if (hasRegression) {
    console.log(`FAIL: one or more scenarios exceeded ${(REGRESSION_THRESHOLD * 100).toFixed(0)}% regression threshold`);
  } else {
    console.log('PASS: no regressions detected');
  }

  return hasRegression ? 1 : 0;
}

// Run standalone
if (process.argv[1] && process.argv[1].endsWith('compare.mjs')) {
  const args = process.argv.slice(2);
  if (args.length !== 2) {
    console.error('Usage: node tests/compare.mjs <baseline-dir> <candidate-dir>');
    process.exit(1);
  }
  process.exit(compare(args[0], args[1]));
}
