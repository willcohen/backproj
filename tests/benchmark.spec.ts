import { test } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const BASE_URL = 'http://localhost:8973';
const RUNS_PER_SCENARIO = 3;

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

      console.log(`--- ${scenario.crs}: navigating to demo page ---`);
      await page.goto(`${BASE_URL}/#profile=1&crs=${scenario.crs}&data=mvt`, {
        waitUntil: 'domcontentloaded',
      });

      // Wait for PROJ init and map ready
      console.log(`--- ${scenario.crs}: waiting for init ---`);
      await page.waitForFunction(
        () => window._state?.transformer !== null && window._state?.map !== null,
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

        // Clear profiling, ensure enabled
        await page.evaluate(() => {
          window.clearProfilingData();
          window.enableProfiling();
        });

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
  }
}
