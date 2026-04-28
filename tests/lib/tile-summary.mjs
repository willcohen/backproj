// tile-summary.mjs -- the replay report's per-tile stats block.
//
// Lives here rather than in bench-replay.mjs so tests can import it: that
// script parses argv and launches a browser at module scope, so importing it
// runs the bench. Keeping the shape and the math here lets replay-structural
// assert the field set against the code that produces it, instead of against
// whatever a past run happened to leave in the (gitignored) fixture.

// Sample-array key -> report field. fetchMs is deliberately absent: replay
// serves tiles from the fixture on disk, so a fetch stat would report disk and
// LRU speed while looking like a pipeline number. Cache behavior is reported
// by cache_hits / cache_misses instead.
export const TILE_SUMMARY_SAMPLE_KEYS = {
  total_ms: 'totalMs',
  phase1_ms: 'phase1Ms',
  phase2_ms: 'phase2Ms',
  transform_coords_ms: 'transformCoordsMs',
  inverse_bounds_ms: 'inverseBoundsMs',
  input_tile_enum_ms: 'inputTileEnumMs',
  chain_roundtrip_ms: 'chainRoundtripMs',
  decode_ms: 'decodeMs',
  construct_ms: 'constructMs',
  densify_ms: 'densifyMs',
  coord_extract_ms: 'coordExtractMs',
  apply_ms: 'applyMs',
  is_valid_ms: 'isValidMs',
  clip_ms: 'clipMs',
  precision_ms: 'precisionMs',
  encode_ms: 'encodeMs',
  geojson_write_ms: 'geojsonWriteMs',
};

export function statsFromSamples(values) {
  if (values.length === 0) {
    return { min: 0, max: 0, mean: 0, p50: 0, p99: 0, mad: 0, samples: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const mean = sum / sorted.length;
  const p50 = sorted[Math.floor(sorted.length * 0.5)];
  const p99Idx = Math.floor(sorted.length * 0.99);
  const p99 = sorted[Math.min(p99Idx, sorted.length - 1)];
  const absDevs = sorted.map(v => Math.abs(v - p50)).sort((a, b) => a - b);
  const mad = absDevs[Math.floor(absDevs.length * 0.5)];
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean,
    p50,
    p99,
    mad,
    samples: sorted.length,
  };
}

export function buildTileSummary(merged) {
  const out = {};
  for (const [field, key] of Object.entries(TILE_SUMMARY_SAMPLE_KEYS)) {
    out[field] = statsFromSamples(merged[key] ?? []);
  }
  return out;
}
