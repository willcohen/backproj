// fixture-validation.mjs -- pure helpers for ScenarioFixture validation.
//
// Shared between tests/bench-replay.mjs (the CLI) and the bench test
// suite. All functions are deterministic given their inputs; I/O is
// limited to reading manifest.json / *.jsonl / probing tile-byte files.
// Throws on any precondition failure with the offending field/key in
// the message.
//
// The three identity functions replay pins a fixture against:
//
//   scenarioNameFor()         sanitize EPSG: colon
//   waypointsHashFor()        sha1 of stable JSON, 16 chars
//   TILE_SOURCE_URL_DEFAULT   or BENCH_TILE_SOURCE_URL env
//
// MANIFEST_REQUIRED_FIELDS is the union of fixture-invalidating
// (hard-gate) and baseline-comparison (soft-gate) fields; all are
// non-empty strings.
// BASELINE_COMPARISON_FIELDS is the soft-gate subset, used by
// replay-compare.mjs to decide whether to skip cleanly when two
// reports come from different code versions.

import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export const MANIFEST_REQUIRED_FIELDS = [
  'scenario_name',
  'crs',
  'waypoints_hash',
  'tile_source_url',
  'backproj_version',
  'proj_wasm_version',
  'wasmts_version',
  'worker_router_version',
  'maplibre_version',
];

export const BASELINE_COMPARISON_FIELDS = [
  'backproj_version',
  'proj_wasm_version',
  'wasmts_version',
  'worker_router_version',
  'maplibre_version',
];

export const TILE_SOURCE_URL_DEFAULT = 'https://tiles.openstreetmap.us/vector/openmaptiles/{z}/{x}/{y}.mvt';

export function scenarioNameFor(crs) {
  return crs.replace(':', '');
}

export function waypointsHashFor(waypoints) {
  const stable = JSON.stringify(waypoints.map(w => ({
    lon: w.lon, lat: w.lat, zoom: w.zoom, durationMs: w.durationMs, label: w.label,
  })));
  return createHash('sha1').update(stable).digest('hex').slice(0, 16);
}

export function loadJsonl(path) {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf8');
  return text.split('\n').filter(Boolean).map(l => JSON.parse(l));
}

export function loadFixture(dir) {
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`fixture missing manifest.json at ${manifestPath}`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const outputRequests = loadJsonl(join(dir, 'output-log.jsonl'));
  const inputRequests = loadJsonl(join(dir, 'request-log.jsonl'));
  return { dir, manifest, outputRequests, inputRequests };
}

export function validateManifestPinning(manifest) {
  const missing = MANIFEST_REQUIRED_FIELDS.filter(f => {
    const v = manifest[f];
    return v === undefined || v === null || v === '';
  });
  if (missing.length) {
    throw new Error(`manifest missing required fields: ${missing.join(', ')}`);
  }
}

export function validateHardGate(manifest, scenarios, opts = {}) {
  const tileSourceUrl = opts.tileSourceUrl ?? TILE_SOURCE_URL_DEFAULT;
  const scenario = scenarios.find(s => s.crs === manifest.crs);
  if (!scenario) {
    throw new Error(`fixture scenario_name=${manifest.scenario_name} crs=${manifest.crs} no longer exists in scenarios.json`);
  }
  const expectedScenarioName = scenarioNameFor(scenario.crs);
  if (manifest.scenario_name !== expectedScenarioName) {
    throw new Error(`scenario_name mismatch: fixture=${manifest.scenario_name} current=${expectedScenarioName}`);
  }
  const expectedWaypointsHash = waypointsHashFor(scenario.waypoints);
  if (manifest.waypoints_hash !== expectedWaypointsHash) {
    throw new Error(`waypoints_hash mismatch: fixture=${manifest.waypoints_hash} current=${expectedWaypointsHash} (waypoints in scenarios.json have changed since capture)`);
  }
  if (manifest.tile_source_url !== tileSourceUrl) {
    throw new Error(`tile_source_url mismatch: fixture=${manifest.tile_source_url} current=${tileSourceUrl}`);
  }
}

export function validateFixtureCoverage(dir, inputRequests) {
  const requested = new Set(inputRequests.map(r => `${r.z}/${r.x}/${r.y}`));
  const missing = [];
  for (const key of requested) {
    const path = join(dir, 'tiles', key + '.mvt');
    if (!existsSync(path)) missing.push(key);
  }
  if (missing.length) {
    const head = missing.slice(0, 5).join(', ');
    throw new Error(`fixture coverage violation: ${missing.length} input tile(s) referenced by request-log.jsonl have no byte cache file (first: ${head}). Capture is incomplete or tiles were deleted.`);
  }
}

export function readTileBytesAsBase64Map(dir, inputRequests) {
  const keys = new Set(inputRequests.map(r => `${r.z}/${r.x}/${r.y}`));
  const out = {};
  for (const key of keys) {
    const path = join(dir, 'tiles', key + '.mvt');
    const buf = readFileSync(path);
    out[key] = buf.toString('base64');
  }
  return out;
}
