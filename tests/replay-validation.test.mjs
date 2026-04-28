// replay-validation.test.mjs -- ManifestPinning + hard-gate staleness +
// FixtureCoverage. Pure-Node tests against the validation library shared
// with bench-replay.mjs. No Playwright, no browser. Synthesizes minimal
// fixtures in temp dirs and exhausts each required-field / hard-gate
// branch independently.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MANIFEST_REQUIRED_FIELDS,
  scenarioNameFor, waypointsHashFor,
  validateManifestPinning, validateHardGate, validateFixtureCoverage,
  TILE_SOURCE_URL_DEFAULT,
} from './lib/fixture-validation.mjs';

const SCENARIO_FIXTURE = {
  crs: 'EPSG:2249',
  waypoints: [
    { lon: -71.058, lat: 42.360, zoom: 10, durationMs: 0, label: 'Boston' },
    { lon: -71.094, lat: 42.360, zoom: 12, durationMs: 1500, label: 'Cambridge' },
  ],
};

function buildManifest(overrides = {}) {
  return {
    scenario_name: scenarioNameFor(SCENARIO_FIXTURE.crs),
    crs: SCENARIO_FIXTURE.crs,
    waypoints_hash: waypointsHashFor(SCENARIO_FIXTURE.waypoints),
    tile_source_url: TILE_SOURCE_URL_DEFAULT,
    backproj_version: '0.0.4',
    proj_wasm_version: '0.1.0-alpha8',
    wasmts_version: '0.1.0-alpha4',
    worker_router_version: '0.0.1',
    maplibre_version: '5.20.0',
    captured_at: '2026-04-28T00:00:00.000Z',
    captured_commit_sha: 'deadbeef',
    captured_by: 'test-host',
    ...overrides,
  };
}

function makeTmpFixture(opts = {}) {
  const root = mkdtempSync(join(tmpdir(), 'replay-validation-'));
  mkdirSync(join(root, 'tiles'), { recursive: true });
  const inputRequests = opts.inputRequests || [];
  for (const r of inputRequests) {
    if (r._noFile) continue; // skip writing — exercise FixtureCoverage failure
    const dir = join(root, 'tiles', `${r.z}`, `${r.x}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${r.y}.mvt`), Buffer.from([0xff]));
  }
  return root;
}

// validateManifestPinning

test('validateManifestPinning passes when all required fields present', () => {
  const manifest = buildManifest();
  validateManifestPinning(manifest); // no throw
});

// Required fields: '' triggers refusal.
for (const field of MANIFEST_REQUIRED_FIELDS) {
  test(`validateManifestPinning refuses when ${field} is empty`, () => {
    const manifest = buildManifest({ [field]: '' });
    assert.throws(
      () => validateManifestPinning(manifest),
      err => err.message.includes('manifest missing required fields') && err.message.includes(field),
      `expected refusal naming the empty field "${field}"`,
    );
  });
}

test('validateManifestPinning refuses when a required field is null', () => {
  const manifest = buildManifest({ backproj_version: null });
  assert.throws(
    () => validateManifestPinning(manifest),
    /backproj_version/,
  );
});

// validateHardGate

test('validateHardGate passes against current scenarios.json + tile source URL', () => {
  const manifest = buildManifest();
  validateHardGate(manifest, [SCENARIO_FIXTURE]); // no throw
});

test('validateHardGate refuses when scenario_name does not match recomputed', () => {
  const manifest = buildManifest({ scenario_name: 'WRONG' });
  assert.throws(
    () => validateHardGate(manifest, [SCENARIO_FIXTURE]),
    /scenario_name mismatch/,
  );
});

test('validateHardGate refuses when waypoints_hash does not match', () => {
  const manifest = buildManifest({ waypoints_hash: 'deadbeefdeadbeef' });
  assert.throws(
    () => validateHardGate(manifest, [SCENARIO_FIXTURE]),
    /waypoints_hash mismatch.*scenarios\.json have changed/s,
  );
});

test('validateHardGate refuses when tile_source_url does not match', () => {
  const manifest = buildManifest({ tile_source_url: 'https://other.example/{z}/{x}/{y}.pbf' });
  assert.throws(
    () => validateHardGate(manifest, [SCENARIO_FIXTURE]),
    /tile_source_url mismatch/,
  );
});

test('validateHardGate accepts an alternate tile_source_url passed via opts.tileSourceUrl', () => {
  const url = 'https://other.example/{z}/{x}/{y}.pbf';
  const manifest = buildManifest({ tile_source_url: url });
  validateHardGate(manifest, [SCENARIO_FIXTURE], { tileSourceUrl: url }); // no throw
});

test('validateHardGate refuses when scenario CRS no longer exists in scenarios.json', () => {
  const manifest = buildManifest({ crs: 'EPSG:99999' });
  assert.throws(
    () => validateHardGate(manifest, [SCENARIO_FIXTURE]),
    /no longer exists in scenarios\.json/,
  );
});

// validateFixtureCoverage

test('validateFixtureCoverage passes when every requested input tile has a byte file', () => {
  const inputRequests = [
    { outputRequestId: 'a', z: 10, x: 20, y: 30, timestampMs: 1, cacheHit: false },
    { outputRequestId: 'a', z: 10, x: 21, y: 30, timestampMs: 2, cacheHit: false },
  ];
  const dir = makeTmpFixture({ inputRequests });
  try {
    validateFixtureCoverage(dir, inputRequests); // no throw
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validateFixtureCoverage refuses when a referenced tile file is missing', () => {
  const inputRequests = [
    { outputRequestId: 'a', z: 10, x: 20, y: 30, timestampMs: 1, cacheHit: false, _noFile: true },
    { outputRequestId: 'a', z: 10, x: 21, y: 30, timestampMs: 2, cacheHit: false },
  ];
  const dir = makeTmpFixture({ inputRequests });
  try {
    assert.throws(
      () => validateFixtureCoverage(dir, inputRequests),
      err => /fixture coverage violation/.test(err.message) && /10\/20\/30/.test(err.message),
      'expected refusal naming the missing (z,x,y)',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validateFixtureCoverage refuses with the count of missing keys', () => {
  const inputRequests = [
    { outputRequestId: 'a', z: 10, x: 20, y: 30, timestampMs: 1, cacheHit: false, _noFile: true },
    { outputRequestId: 'a', z: 10, x: 21, y: 30, timestampMs: 2, cacheHit: false, _noFile: true },
    { outputRequestId: 'a', z: 10, x: 22, y: 30, timestampMs: 3, cacheHit: false },
  ];
  const dir = makeTmpFixture({ inputRequests });
  try {
    assert.throws(
      () => validateFixtureCoverage(dir, inputRequests),
      /2 input tile\(s\) referenced/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// scenarioNameFor / waypointsHashFor

test('scenarioNameFor sanitizes EPSG colon', () => {
  assert.equal(scenarioNameFor('EPSG:2249'), 'EPSG2249');
  assert.equal(scenarioNameFor('ESRI:54030'), 'ESRI54030');
});

test('waypointsHashFor is deterministic and 16 chars', () => {
  const h1 = waypointsHashFor(SCENARIO_FIXTURE.waypoints);
  const h2 = waypointsHashFor(SCENARIO_FIXTURE.waypoints);
  assert.equal(h1, h2);
  assert.equal(h1.length, 16);
});

test('waypointsHashFor changes when a single waypoint is altered', () => {
  const h1 = waypointsHashFor(SCENARIO_FIXTURE.waypoints);
  const altered = [...SCENARIO_FIXTURE.waypoints];
  altered[0] = { ...altered[0], lon: altered[0].lon + 0.0001 };
  const h2 = waypointsHashFor(altered);
  assert.notEqual(h1, h2);
});
