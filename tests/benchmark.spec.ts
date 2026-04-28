import { test } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
// The same hashers the replay staleness gate recomputes; importing them
// keeps producer and gate from drifting apart.
import { scenarioNameFor, waypointsHashFor } from './lib/fixture-validation.mjs';

const BASE_URL = 'http://localhost:8973';
const RUNS_PER_SCENARIO = 3;

// Tap A / B / C / D: capture writes a ScenarioFixture per scenario at
// <BENCH_FIXTURE_ROOT>/<scenario_name>/. Capture is active during run 0
// only; runs 1..N run with capture disabled to avoid duplicate logs.
function fixtureRoot(): string {
  return process.env.BENCH_FIXTURE_ROOT || 'fixtures';
}

function buildManifest(scenario: Scenario): Record<string, string> {
  return {
    scenario_name: scenarioNameFor(scenario.crs),
    crs: scenario.crs,
    waypoints_hash: waypointsHashFor(scenario.waypoints),
    tile_source_url: process.env.BENCH_TILE_SOURCE_URL || '',
    backproj_version: process.env.BENCH_VERSION_BACKPROJ || '',
    proj_wasm_version: process.env.BENCH_VERSION_PROJ_WASM || '',
    wasmts_version: process.env.BENCH_VERSION_WASMTS || '',
    worker_router_version: process.env.BENCH_VERSION_WORKER_ROUTER || '',
    maplibre_version: process.env.BENCH_VERSION_MAPLIBRE || '',
    captured_at: process.env.BENCH_CAPTURED_AT || new Date().toISOString(),
    captured_commit_sha: process.env.BENCH_GIT_SHA || '',
    captured_by: process.env.BENCH_CAPTURED_BY || '',
  };
}

function writeFixture(scenario: Scenario, capture: { inputRequests: any[]; outputRequests: any[]; tileKeys: string[]; tilesBase64: Record<string, string> }): void {
  const dir = join(fixtureRoot(), scenarioNameFor(scenario.crs));
  mkdirSync(dir, { recursive: true });

  // manifest.json
  const manifest = buildManifest(scenario);
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  // request-log.jsonl (input-tile fetches in order)
  const inputLines = capture.inputRequests.map((r: any) => JSON.stringify(r)).join('\n');
  writeFileSync(join(dir, 'request-log.jsonl'), inputLines + (inputLines ? '\n' : ''));

  // output-log.jsonl (MapLibre output requests in order)
  const outputLines = capture.outputRequests.map((r: any) => JSON.stringify(r)).join('\n');
  writeFileSync(join(dir, 'output-log.jsonl'), outputLines + (outputLines ? '\n' : ''));

  // tiles/<z>/<x>/<y>.mvt -- byte cache, deduplicated by key.
  for (const key of capture.tileKeys) {
    const path = join(dir, 'tiles', key + '.mvt');
    mkdirSync(dirname(path), { recursive: true });
    const bytes = Buffer.from(capture.tilesBase64[key], 'base64');
    writeFileSync(path, bytes);
  }

  console.log(`--- ${scenario.crs}: fixture written to ${dir}`);
  console.log(`    output_requests=${capture.outputRequests.length}, input_requests=${capture.inputRequests.length}, tiles=${capture.tileKeys.length}`);
}

interface Waypoint {
  lon: number;
  lat: number;
  zoom: number;
  durationMs: number;
  label: string;
}

interface Scenario {
  crs: string;
  waypoints: Waypoint[];
}

const SCENARIOS: Scenario[] = JSON.parse(
  readFileSync(new URL('scenarios.json', import.meta.url), 'utf8'),
);

function gitSha(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function dateStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

function resultsDir(): string {
  const dir = process.env.BENCH_RESULTS_DIR || join(process.cwd(), 'results', `bench-${dateStamp()}-${gitSha()}`);
  return dir;
}

function sanitizeCrs(crs: string): string {
  return crs.replace(':', '');
}

test.describe('Benchmark Suite', () => {
  test.setTimeout(600_000);

  for (const scenario of SCENARIOS) {
    test(`benchmark ${scenario.crs}`, async ({ page }) => {
      const dir = resultsDir();
      mkdirSync(dir, { recursive: true });

      page.on('console', msg => {
        if (msg.type() === 'error') {
          console.error(`[browser] ${msg.text()}`);
        }
      });

      page.on('pageerror', err => {
        console.error(`[browser page error] ${err.message}`);
      });

      // Redirect CDN-pinned backproj/maplibre-proj to the locally built
      // bundles so capture taps and any other in-flight changes are
      // exercised. The published page uses pinned versions; the bench
      // suite always runs against current source.
      await page.route(/cdn\.jsdelivr\.net\/npm\/backproj@[^/]+\/dist\/backproj\.mjs/, async route => {
        const body = readFileSync(join(process.cwd(), 'packages/backproj/dist/backproj.mjs'), 'utf8');
        await route.fulfill({ status: 200, contentType: 'application/javascript', body });
      });
      await page.route(/cdn\.jsdelivr\.net\/npm\/maplibre-proj@[^/]+\/dist\/maplibre-proj\.mjs/, async route => {
        const body = readFileSync(join(process.cwd(), 'packages/maplibre-proj/dist/maplibre-proj.mjs'), 'utf8');
        await route.fulfill({ status: 200, contentType: 'application/javascript', body });
      });

      console.log(`--- ${scenario.crs}: navigating to demo page ---`);
      await page.goto(`${BASE_URL}/#profile=1&crs=${scenario.crs}&data=mvt`, {
        waitUntil: 'domcontentloaded',
      });

      // Wait for PROJ init and map ready
      console.log(`--- ${scenario.crs}: waiting for init ---`);
      await page.waitForFunction(
        () => window._state != null && window._state.transformer !== null && window._state.map !== null,
        { timeout: 120_000, polling: 1000 },
      );
      console.log(`--- ${scenario.crs}: init complete ---`);

      // Wait for initial idle
      await page.evaluate(() => new Promise<void>(resolve => {
        const map = window._state.map;
        if (!map.isMoving() && !map.isZooming()) {
          map.once('idle', () => resolve());
          // Trigger a re-render to ensure idle fires
          map.triggerRepaint();
        } else {
          map.once('idle', () => resolve());
        }
      }));

      const medianReports: string[] = [];

      for (let run = 0; run < RUNS_PER_SCENARIO; run++) {
        console.log(`--- ${scenario.crs}: run ${run + 1}/${RUNS_PER_SCENARIO} ---`);

        // Force fresh output tile cache by switching CRS and back
        if (run > 0) {
          const dummyCrs = scenario.crs === 'EPSG:2249' ? 'EPSG:5070' : 'EPSG:2249';
          await page.evaluate(async (crs: string) => {
            await window.updateMap(crs);
          }, dummyCrs);
          await page.waitForFunction(
            (crs: string) => window._state?.currentCRS === crs,
            dummyCrs,
            { timeout: 60_000 },
          );
          await page.evaluate(async (crs: string) => {
            await window.updateMap(crs);
          }, scenario.crs);
          await page.waitForFunction(
            (crs: string) => window._state?.currentCRS === crs,
            scenario.crs,
            { timeout: 60_000 },
          );
          await page.evaluate(() => new Promise<void>(r => {
            window._state.map.once('idle', () => r());
            window._state.map.triggerRepaint();
          }));
        }

        // Clear profiling, ensure enabled. Enable capture on run 0 only;
        // disable it for runs 1..N so the fixture reflects exactly one
        // pass through the scenario (no duplicate request log entries).
        const captureThisRun = run === 0;
        await page.evaluate((captureOn: boolean) => {
          window.clearProfilingData();
          window.enableProfiling();
          if (captureOn) {
            window.enableCapture({});
          } else {
            window.disableCapture();
            window.clearCapture();
          }
        }, captureThisRun);

        // Reset viewport to area-of-use
        await page.evaluate(() => {
          const map = window._state.map;
          map.fitBounds(window._state.lastBounds, { animate: false });
        });
        await page.evaluate(() => new Promise<void>(r => {
          window._state.map.once('idle', () => r());
        }));

        // Transform waypoints from WGS84 to fake Mercator
        const fakeWaypoints: number[][] = await page.evaluate(
          async (wps: Waypoint[]) => {
            const coords = wps.map(w => [w.lon, w.lat] as [number, number]);
            return window.transformCoords(coords, window._state.transformer);
          },
          scenario.waypoints,
        );

        // Execute flight plan
        for (let i = 0; i < scenario.waypoints.length; i++) {
          const wp = scenario.waypoints[i];
          const [lng, lat] = fakeWaypoints[i];
          console.log(`  waypoint ${i + 1}/${scenario.waypoints.length}: ${wp.label}`);

          await page.evaluate(
            ({ lng, lat, zoom, dur }: { lng: number; lat: number; zoom: number; dur: number }) => {
              const map = window._state.map;
              if (dur === 0) {
                map.jumpTo({ center: [lng, lat], zoom });
              } else {
                map.flyTo({ center: [lng, lat], zoom, duration: dur });
              }
            },
            { lng, lat, zoom: wp.zoom, dur: wp.durationMs },
          );
          await page.evaluate(() => new Promise<void>(r => {
            window._state.map.once('idle', () => r());
          }));
        }

        // Collect report
        const reportJson = await page.evaluate(() => window.exportProfilingJSON());
        medianReports.push(reportJson);
        console.log(`  run ${run + 1} complete, ${JSON.parse(reportJson).tileSummary.count} tiles`);

        // After run 0, extract the capture snapshot and write the
        // ScenarioFixture to disk. Disable capture so subsequent runs
        // don't accumulate duplicate state.
        if (captureThisRun) {
          const snapshot = await page.evaluate(() => window.exportCapture());
          await page.evaluate(() => { window.disableCapture(); window.clearCapture(); });
          writeFixture(scenario, snapshot);
        }
      }

      // Pick median run by p50 total
      const parsed = medianReports.map(r => JSON.parse(r));
      parsed.sort((a, b) => a.tileSummary.totalMs.p50 - b.tileSummary.totalMs.p50);
      const median = parsed[Math.floor(parsed.length / 2)];

      const filename = `bench-${dateStamp()}-${gitSha()}-${sanitizeCrs(scenario.crs)}.json`;
      const filepath = join(dir, filename);
      writeFileSync(filepath, JSON.stringify(median, null, 2));
      console.log(`--- ${scenario.crs}: saved to ${filepath} ---`);
      console.log(`  p50 total: ${median.tileSummary.totalMs.p50.toFixed(0)}ms`);
      console.log(`  p50 phase1: ${median.tileSummary.phase1Ms.p50.toFixed(0)}ms`);
      console.log(`  p50 phase2: ${median.tileSummary.phase2Ms.p50.toFixed(0)}ms`);
      console.log(`  p50 transform: ${median.tileSummary.transformCoordsMs.p50.toFixed(0)}ms`);
    });
  }
});

// Type declarations for window globals exposed by the demo page
declare global {
  interface Window {
    _state: {
      map: any;
      transformer: any;
      currentCRS: string;
      lastBounds: any;
    };
    exportProfilingJSON: () => string;
    clearProfilingData: () => void;
    enableProfiling: () => void;
    transformCoords: (coords: [number, number][], transformer: any) => Promise<number[][]>;
    updateMap: (crs: string) => Promise<void>;
    enableCapture: (opts: { sceneStartMs?: number }) => void;
    disableCapture: () => void;
    clearCapture: () => void;
    exportCapture: () => {
      inputRequests: any[];
      outputRequests: any[];
      tileKeys: string[];
      tilesBase64: Record<string, string>;
    };
  }
}
