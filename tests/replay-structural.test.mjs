// replay-structural.test.mjs -- the two replay-report invariants not
// covered elsewhere. Log-row and manifest shapes are tested against the
// live capture module in capture.test.mjs and hard-gated at replay time
// by validateManifestPinning (see replay-validation.test.mjs).

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTileSummary, TILE_SUMMARY_SAMPLE_KEYS } from './lib/tile-summary.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE_DIR = join(REPO_ROOT, 'fixtures', 'EPSG2249');
const REPORT_LRU = join(FIXTURE_DIR, 'replay-report-lru.json');
const REPORT_LRU_AVAILABLE = existsSync(REPORT_LRU);

const MANIFEST_FIELDS = [
  'scenario_name', 'crs', 'waypoints_hash', 'tile_source_url',
  'backproj_version', 'proj_wasm_version', 'wasmts_version',
  'worker_router_version', 'maplibre_version',
  'captured_at', 'captured_commit_sha', 'captured_by',
];

// Asserted against the builder, not against a captured report: the fixture is
// gitignored and its report is whatever a past run left behind, so checking the
// artifact tested old code. This failed for months against a stale report while
// bench-replay went on emitting the field.
test('ReplayTileSummary has no fetch_ms field', () => {
  const summary = buildTileSummary({ totalMs: [1, 2, 3], fetchMs: [9, 9, 9] });
  assert.ok(
    !('fetch_ms' in summary),
    'replay should not surface fetch_ms (it would measure disk speed, not pipeline behavior)',
  );
  assert.ok(!('fetch_ms' in TILE_SUMMARY_SAMPLE_KEYS), 'nor should the field map carry it');
  assert.ok('total_ms' in summary, 'the rest of the summary still builds');
});

test('report.manifest equals the fixture manifest', { skip: !REPORT_LRU_AVAILABLE }, () => {
  const report = JSON.parse(readFileSync(REPORT_LRU, 'utf8'));
  const fixture = JSON.parse(readFileSync(join(FIXTURE_DIR, 'manifest.json'), 'utf8'));
  // Replay must NOT rewrite or stamp the manifest with current versions —
  // the captured pinning is what comparison gates against.
  for (const f of MANIFEST_FIELDS) {
    assert.equal(report.manifest[f], fixture[f], `report.manifest.${f} drifted from fixture manifest`);
  }
});
