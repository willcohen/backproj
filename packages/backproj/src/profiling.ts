export interface ProfilingConfig {
  enabled: boolean;
}

export const profiling: ProfilingConfig = { enabled: false };

export function enableProfiling(): void {
  profiling.enabled = true;
}

export function disableProfiling(): void {
  profiling.enabled = false;
  clearProfilingData();
}

export interface StageStats {
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
  count: number;
}

export interface Phase1Detail {
  decodeMs: number;
  featureCount: number;
  fragmentCount: number;
  stitchMs: number;
  stitchCount: number;
  densifyMs: number;
  coordExtractMs: number;
  coordsProduced: number;
  geojsonReadMs: number;
  preDensifyCoords: number;
  postDensifyCoords: number;
}

export interface Phase2Detail {
  applyMs: number;
  isValidMs: number;
  fixRepairMs: number;
  fixRepairCount: number;
  clipMs: number;
  clipEmptyCount: number;
  skipClipCount: number;
  precisionMs: number;
  encodeMs: number;
  outputFeatureCount: number;
  outputBytes: number;
  geojsonWriteMs: number;
}

export interface WorkerProfile {
  workerId: number;
  phase1Ms: number;
  phase1Detail: Phase1Detail;
  phase2Ms: number;
  phase2Detail: Phase2Detail;
  idleBeforePhase1Ms: number;
  interPhaseIdleMs: number;
}

export interface TileProfile {
  tileKey: string;
  requestId: string;
  totalMs: number;
  inverseBoundsMs: number;
  inputTileEnumMs: number;
  fetchMs: number;
  fetchCount: number;
  cacheHits: number;
  cacheMisses: number;
  transformCoordsMs: number;
  coordCount: number;
  marshalMs: number;
  worker: WorkerProfile;
}

export interface ProfilingReport {
  tiles: TileProfile[];
  tileSummary: {
    count: number;
    totalMs: StageStats;
    transformCoordsMs: StageStats;
    phase1Ms: StageStats;
    phase2Ms: StageStats;
    fetchMs: StageStats;
  };
  stageBreakdown: Record<string, number>;
  workerStats: {
    workerId: number;
    tilesProcessed: number;
    totalActiveMs: number;
    totalIdleMs: number;
    utilization: number;
  }[];
  cacheStats: {
    totalFetches: number;
    hits: number;
    misses: number;
    hitRate: number;
  };
  metadata: {
    timestamp: number;
    poolSize: number;
    crs: string;
    userAgent: string;
  };
}

const collectedTiles: TileProfile[] = [];
let reportMetadata: ProfilingReport['metadata'] = {
  timestamp: 0, poolSize: 0, crs: '', userAgent: '',
};

export function setProfilingMetadata(
  meta: Partial<ProfilingReport['metadata']>,
): void {
  Object.assign(reportMetadata, meta);
}

export function recordTileProfile(profile: TileProfile): void {
  if (!profiling.enabled) return;
  collectedTiles.push(profile);
}

function computeStats(values: number[]): StageStats {
  if (values.length === 0) {
    return { min: 0, max: 0, mean: 0, p50: 0, p95: 0, count: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: sum / sorted.length,
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.floor(sorted.length * 0.95)],
    count: sorted.length,
  };
}

export function getProfilingData(): ProfilingReport {
  const tiles = [...collectedTiles];

  const tileSummary = {
    count: tiles.length,
    totalMs: computeStats(tiles.map(t => t.totalMs)),
    transformCoordsMs: computeStats(tiles.map(t => t.transformCoordsMs)),
    phase1Ms: computeStats(tiles.map(t => t.worker.phase1Ms)),
    phase2Ms: computeStats(tiles.map(t => t.worker.phase2Ms)),
    fetchMs: computeStats(tiles.map(t => t.fetchMs)),
  };

  const avgTotal = tileSummary.totalMs.mean || 1;
  const stageBreakdown: Record<string, number> = {};
  if (tiles.length > 0) {
    const avgOf = (fn: (t: TileProfile) => number) =>
      tiles.reduce((s, t) => s + fn(t), 0) / tiles.length;
    stageBreakdown['inverseBounds'] = avgOf(t => t.inverseBoundsMs) / avgTotal * 100;
    stageBreakdown['inputTileEnum'] = avgOf(t => t.inputTileEnumMs) / avgTotal * 100;
    stageBreakdown['fetch'] = avgOf(t => t.fetchMs) / avgTotal * 100;
    stageBreakdown['phase1'] = avgOf(t => t.worker.phase1Ms) / avgTotal * 100;
    stageBreakdown['transformCoords'] = avgOf(t => t.transformCoordsMs) / avgTotal * 100;
    stageBreakdown['phase2'] = avgOf(t => t.worker.phase2Ms) / avgTotal * 100;
    stageBreakdown['marshal'] = avgOf(t => t.marshalMs) / avgTotal * 100;
  }

  const workerMap = new Map<number, { active: number; idle: number; count: number }>();
  for (const t of tiles) {
    const w = t.worker;
    const existing = workerMap.get(w.workerId) || { active: 0, idle: 0, count: 0 };
    existing.active += w.phase1Ms + w.phase2Ms;
    existing.idle += w.idleBeforePhase1Ms + w.interPhaseIdleMs;
    existing.count++;
    workerMap.set(w.workerId, existing);
  }
  const workerStats = [...workerMap.entries()].map(([workerId, s]) => ({
    workerId,
    tilesProcessed: s.count,
    totalActiveMs: s.active,
    totalIdleMs: s.idle,
    utilization: s.active / ((s.active + s.idle) || 1),
  }));

  let totalFetches = 0, hits = 0, misses = 0;
  for (const t of tiles) {
    totalFetches += t.fetchCount;
    hits += t.cacheHits;
    misses += t.cacheMisses;
  }

  return {
    tiles,
    tileSummary,
    stageBreakdown,
    workerStats,
    cacheStats: { totalFetches, hits, misses, hitRate: hits / (totalFetches || 1) },
    metadata: { ...reportMetadata, timestamp: Date.now() },
  };
}

export function clearProfilingData(): void {
  collectedTiles.length = 0;
}

export function exportProfilingJSON(): string {
  return JSON.stringify(getProfilingData(), null, 2);
}

function barChart(pct: number, width: number = 40): string {
  const filled = Math.round(pct / 100 * width);
  return '\u2588'.repeat(filled) + '\u2591'.repeat(width - filled);
}

function fmtMs(ms: number): string {
  return ms < 1 ? '<1' : String(Math.round(ms));
}

export function printProfilingSummary(): void {
  const report = getProfilingData();
  const { tileSummary, stageBreakdown, workerStats, cacheStats, metadata } = report;

  const lines: string[] = [];
  lines.push('');
  lines.push(`backproj profiling: ${tileSummary.count} tiles, CRS=${metadata.crs}, ${workerStats.length} workers`);
  lines.push('');

  lines.push('Stage Breakdown (% of avg tile time):');
  const stages = Object.entries(stageBreakdown).sort((a, b) => b[1] - a[1]);
  for (const [name, pct] of stages) {
    lines.push(`  ${name.padEnd(20)} ${fmtMs(pct).padStart(5)}%  ${barChart(pct, 30)}`);
  }
  lines.push('');

  const tiles = report.tiles;
  if (tiles.length > 0) {
    const avgOf = (fn: (t: TileProfile) => number) =>
      tiles.reduce((s: number, t: TileProfile) => s + fn(t), 0) / tiles.length;

    const avgPhase1 = avgOf(t => t.worker.phase1Ms) || 1;
    lines.push('Phase 1 detail (% of phase1 time):');
    const p1ops: [string, number][] = [
      ['decode', avgOf(t => t.worker.phase1Detail.decodeMs)],
      ['stitch', avgOf(t => t.worker.phase1Detail.stitchMs)],
      ['densify', avgOf(t => t.worker.phase1Detail.densifyMs)],
      ['coordExtract', avgOf(t => t.worker.phase1Detail.coordExtractMs)],
      ['geojsonRead', avgOf(t => t.worker.phase1Detail.geojsonReadMs)],
    ];
    p1ops.sort((a, b) => b[1] - a[1]);
    for (const [name, ms] of p1ops) {
      const pct = ms / avgPhase1 * 100;
      lines.push(`  ${name.padEnd(20)} ${fmtMs(pct).padStart(5)}%  ${fmtMs(ms).padStart(5)}ms  ${barChart(pct, 20)}`);
    }
    const avgFeatures = avgOf(t => t.worker.phase1Detail.featureCount);
    const avgFragments = avgOf(t => t.worker.phase1Detail.fragmentCount);
    const avgStitches = avgOf(t => t.worker.phase1Detail.stitchCount);
    const avgCoords = avgOf(t => t.worker.phase1Detail.coordsProduced);
    const avgPreDensify = avgOf(t => t.worker.phase1Detail.preDensifyCoords);
    const avgPostDensify = avgOf(t => t.worker.phase1Detail.postDensifyCoords);
    const ratio = avgPreDensify > 0 ? (avgPostDensify / avgPreDensify).toFixed(1) : 'N/A';
    lines.push(`  counts: ${Math.round(avgFeatures)} features, ${Math.round(avgFragments)} fragments, ${Math.round(avgStitches)} stitches, ${Math.round(avgCoords)} coords, densify ratio: ${ratio}x`);
    lines.push('');

    const avgPhase2 = avgOf(t => t.worker.phase2Ms) || 1;
    lines.push('Phase 2 detail (% of phase2 time):');
    const p2ops: [string, number][] = [
      ['apply', avgOf(t => t.worker.phase2Detail.applyMs)],
      ['isValid', avgOf(t => t.worker.phase2Detail.isValidMs)],
      ['fixRepair', avgOf(t => t.worker.phase2Detail.fixRepairMs)],
      ['clip', avgOf(t => t.worker.phase2Detail.clipMs)],
      ['precision', avgOf(t => t.worker.phase2Detail.precisionMs)],
      ['encode', avgOf(t => t.worker.phase2Detail.encodeMs)],
      ['geojsonWrite', avgOf(t => t.worker.phase2Detail.geojsonWriteMs)],
    ];
    p2ops.sort((a, b) => b[1] - a[1]);
    for (const [name, ms] of p2ops) {
      const pct = ms / avgPhase2 * 100;
      lines.push(`  ${name.padEnd(20)} ${fmtMs(pct).padStart(5)}%  ${fmtMs(ms).padStart(5)}ms  ${barChart(pct, 20)}`);
    }
    const avgClipEmpty = avgOf(t => t.worker.phase2Detail.clipEmptyCount);
    const avgSkipClip = avgOf(t => t.worker.phase2Detail.skipClipCount);
    const avgOutFeatures = avgOf(t => t.worker.phase2Detail.outputFeatureCount);
    const avgOutBytes = avgOf(t => t.worker.phase2Detail.outputBytes);
    const avgFixRepairs = avgOf(t => t.worker.phase2Detail.fixRepairCount);
    lines.push(`  counts: ${Math.round(avgOutFeatures)} output features, ${Math.round(avgClipEmpty)} clipped empty, ${Math.round(avgSkipClip)} skip clip, ${Math.round(avgFixRepairs)} fix repairs, ${Math.round(avgOutBytes)} output bytes`);
    lines.push('');
  }

  lines.push('Per-tile stats (ms):');
  lines.push('                  min    p50    p95    max');
  const row = (label: string, s: StageStats) =>
    `  ${label.padEnd(16)} ${fmtMs(s.min).padStart(5)}  ${fmtMs(s.p50).padStart(5)}  ${fmtMs(s.p95).padStart(5)}  ${fmtMs(s.max).padStart(5)}`;
  lines.push(row('total', tileSummary.totalMs));
  lines.push(row('transformCoords', tileSummary.transformCoordsMs));
  lines.push(row('phase1', tileSummary.phase1Ms));
  lines.push(row('phase2', tileSummary.phase2Ms));
  lines.push(row('fetch', tileSummary.fetchMs));
  lines.push('');

  lines.push(`Cache: ${cacheStats.totalFetches} fetches, ${cacheStats.hits} hits (${Math.round(cacheStats.hitRate * 100)}%), ${cacheStats.misses} misses`);

  const wLines = workerStats.map(w =>
    `#${w.workerId} util=${Math.round(w.utilization * 100)}%`
  );
  lines.push(`Workers: ${wLines.join(', ')}`);

  const avgIdle = report.tiles.length > 0
    ? report.tiles.reduce((s, t) => s + t.worker.interPhaseIdleMs, 0) / report.tiles.length
    : 0;
  const avgTransform = tileSummary.transformCoordsMs.mean;
  if (avgIdle > avgTransform * 0.5 && report.tiles.length > 2) {
    lines.push('');
    lines.push(`NOTE: avg inter-phase idle = ${fmtMs(avgIdle)}ms, avg transformCoords = ${fmtMs(avgTransform)}ms`);
    lines.push('  -> Main thread coord transform may be the serialization bottleneck.');
  }

  console.log(lines.join('\n'));
}
