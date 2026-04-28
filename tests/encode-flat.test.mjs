// encode-flat.test.mjs -- differentials mvt-encode's toFlat walk against the
// GeoJSON walk it replaced.
//
// mvt-encode used to do GeoJsonWriter.write(geom) + JSON.parse and walk the
// parsed coordinates; it now calls wasmts.geom.toFlat(geom) and walks offsets.
// The replay bench cannot catch a mistake here: a wrong winding order still
// produces perfectly valid, non-empty tiles, so ok/empty/fail stays green while
// the output is wrong.
//
// coordsToTileLocal below is the retired implementation, kept here as the
// reference. It is deliberately a copy rather than an import: the point is to
// compare the new walk against the old behavior, so the reference must not
// change when the implementation does.
//
// One case deliberately disagrees: an empty LineString. The reference returns
// [[]], which vt-pbf encodes as a stray vertex; the implementation drops it.
// That bug predates the flat walk and was fixed on the way past, so the empty
// line is covered by its own test below rather than by a fixture here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { buildTileMapping, flatToTileLocal } from '../packages/backproj/src/mvt-encode.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WASMTS_DIR = join(__dirname, '..', 'node_modules', '@wcohen', 'wasmts', 'dist');

// The reference implementation: the retired GeoJSON walk.

const EXTENT = 4096;

function latToMercY(latDeg) {
  return Math.log(Math.tan(Math.PI / 4 + (latDeg * Math.PI) / 360));
}

function lonLatToTile(lon, lat, tm) {
  return [
    Math.round((lon - tm.west) * tm.invLonSpan),
    Math.round((tm.mercNorth - latToMercY(lat)) * tm.invMercSpan),
  ];
}

function ringSignedArea(ring) {
  let area = 0;
  for (let i = 0, len = ring.length, j = len - 1; i < len; j = i++) {
    area += (ring[j][0] - ring[i][0]) * (ring[i][1] + ring[j][1]);
  }
  return area;
}

function enforceWindingOrder(rings) {
  for (let i = 0; i < rings.length; i++) {
    const area = ringSignedArea(rings[i]);
    const shouldBeCW = i === 0;
    if (shouldBeCW ? area < 0 : area > 0) rings[i].reverse();
  }
  return rings;
}

function coordsToTileLocal(geojson, tm) {
  const t = geojson.type;
  const c = geojson.coordinates;
  const pt = p => lonLatToTile(p[0], p[1], tm);

  if (t === 'Point') return [pt(c)];
  if (t === 'MultiPoint') return c.map(pt);
  if (t === 'LineString') return [c.map(pt)];
  if (t === 'MultiLineString') return c.map(line => line.map(pt));
  if (t === 'Polygon') return enforceWindingOrder(c.map(ring => ring.map(pt)));
  if (t === 'MultiPolygon') {
    const all = [];
    for (const poly of c) all.push(...enforceWindingOrder(poly.map(ring => ring.map(pt))));
    return all;
  }
  return null;
}


const wasmBinary = readFileSync(join(WASMTS_DIR, 'wasmts.js.wasm'));
globalThis.__filename = join(WASMTS_DIR, 'wasmts.js');
const originalFetch = globalThis.fetch;
globalThis.fetch = (url, ...rest) =>
  (url && String(url).includes('.wasm'))
    ? Promise.resolve({ ok: true, arrayBuffer: () =>
        Promise.resolve(wasmBinary.buffer.slice(wasmBinary.byteOffset, wasmBinary.byteOffset + wasmBinary.byteLength)) })
    : originalFetch(url, ...rest);

await import(join(WASMTS_DIR, 'wasmts.js'));
for (let i = 0; i < 300 && !globalThis.wasmts?.geom?.toFlat; i++) {
  await new Promise(r => setTimeout(r, 50));
}
const W = globalThis.wasmts;
// wasmts is a hard dependency in node_modules; a load failure here must
// fail the suite, not skip it -- a silent skip hid drift once already.
if (!W?.geom?.toFlat) {
  throw new Error('wasmts failed to load from node_modules; the flat-encode parity suite cannot run');
}

// Bounds a reprojected tile might plausibly carry, so the Mercator math is
// exercised rather than short-circuited.
const tm = buildTileMapping({ west: -71.2, south: 42.2, east: -70.9, north: 42.5 });
const reader = W.io.geojson.GeoJsonReader.create0();
const writer = (() => {
  const w = W.io.geojson.GeoJsonWriter.create0();
  w.setEncodeCRS(false);
  return w;
})();

// Ring order matters and is the thing most likely to break, so the fixtures
// include both windings, holes, and a multipolygon whose parts differ in ring
// count (which is the case partOffsets exists for).
const ring = (cx, cy, r, ccw) => {
  const pts = [];
  for (let i = 0; i < 8; i++) {
    const t = 2 * Math.PI * (ccw ? i : 8 - i) / 8;
    pts.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]);
  }
  pts.push(pts[0]);
  return pts;
};

const FIXTURES = [
  ['Point', { type: 'Point', coordinates: [-71.05, 42.35] }],
  ['MultiPoint', { type: 'MultiPoint', coordinates: [[-71.1, 42.3], [-71.0, 42.4]] }],
  ['LineString', { type: 'LineString', coordinates: [[-71.1, 42.3], [-71.0, 42.4], [-70.95, 42.25]] }],
  ['MultiLineString', { type: 'MultiLineString', coordinates: [
    [[-71.1, 42.3], [-71.0, 42.4]],
    [[-71.05, 42.25], [-70.95, 42.45], [-70.92, 42.3]],
  ] }],
  ['Polygon CW shell', { type: 'Polygon', coordinates: [ring(-71.05, 42.35, 0.08, false)] }],
  ['Polygon CCW shell', { type: 'Polygon', coordinates: [ring(-71.05, 42.35, 0.08, true)] }],
  ['Polygon with hole', { type: 'Polygon', coordinates: [
    ring(-71.05, 42.35, 0.1, true),
    ring(-71.05, 42.35, 0.03, true),
  ] }],
  ['Polygon hole same winding as shell', { type: 'Polygon', coordinates: [
    ring(-71.05, 42.35, 0.1, false),
    ring(-71.05, 42.35, 0.03, false),
  ] }],
  ['MultiPolygon differing ring counts', { type: 'MultiPolygon', coordinates: [
    [ring(-71.15, 42.25, 0.04, true)],
    [ring(-70.95, 42.45, 0.06, true), ring(-70.95, 42.45, 0.02, true)],
  ] }],
  // The two representations spell "empty" differently: the writer emits zero
  // rings, toFlat emits one empty ring. Both must still yield zero rings here,
  // so that geomToGvtFeature drops the feature instead of encoding it.
  ['Polygon EMPTY', { type: 'Polygon', coordinates: [] }],
  ['MultiPolygon EMPTY', { type: 'MultiPolygon', coordinates: [] }],
];

for (const [name, gj] of FIXTURES) {
  test(`flatToTileLocal matches the GeoJSON walk: ${name}`, () => {
    const geom = reader.read(JSON.stringify(gj));

    // Reference goes through the writer, not the raw fixture, so both sides see
    // whatever normalisation JTS applied on the way in.
    const expected = coordsToTileLocal(JSON.parse(writer.write(geom)), tm);
    const actual = flatToTileLocal(W.geom.toFlat(geom, 2), tm);

    assert.deepEqual(actual, expected);
  });
}

test('the reference would catch a dropped enforceWindingOrder', () => {
  // The differentials above are only worth anything if deepEqual actually fails
  // when winding is wrong, so reproduce the mutation and check the reference
  // rejects it: walk toFlat's rings with no winding step, the way
  // flatToTileLocal would if enforceWindingOrder were removed.
  const gj = { type: 'Polygon', coordinates: [ring(-71.05, 42.35, 0.08, true)] };
  const geom = reader.read(JSON.stringify(gj));
  const f = W.geom.toFlat(geom, 2);

  const unwound = [];
  for (let r = 0; r < f.ringOffsets.length - 1; r++) {
    const out = [];
    for (let i = f.ringOffsets[r]; i < f.ringOffsets[r + 1]; i++) {
      out.push(lonLatToTile(f.coords[i * f.dim], f.coords[i * f.dim + 1], tm));
    }
    unwound.push(out);
  }

  const expected = coordsToTileLocal(JSON.parse(writer.write(geom)), tm);
  assert.notDeepEqual(unwound, expected, 'the mutant must not match the reference');
  assert.deepEqual(flatToTileLocal(f, tm), expected, 'the real walk must match it');
});

test('an empty line yields no rings, unlike the retired walk', () => {
  // Deliberate divergence from the reference, which returns [[]] here and makes
  // vt-pbf emit a stray vertex. Reachable the same way the polygon case is: a
  // sub-tile-unit line collapses in phase2's precision reduction.
  const d = 0.00002;
  const x = -71.05, y = 42.35;
  const geom = reader.read(JSON.stringify({
    type: 'LineString', coordinates: [[x, y], [x + d, y + d]],
  }));
  const pm = W.geom.PrecisionModel.fromScale(EXTENT / 0.3);
  const reduced = W.precision.GeometryPrecisionReducer.reduce(geom, pm);

  assert.ok(W.geom.isEmpty(reduced), 'fixture must collapse, or this proves nothing');
  assert.deepEqual(flatToTileLocal(W.geom.toFlat(reduced, 2), tm), []);
  assert.deepEqual(
    coordsToTileLocal(JSON.parse(writer.write(reduced)), tm), [[]],
    'reference still carries the old behavior, so the divergence is intentional',
  );
});

test('a polygon collapsed by precision reduction yields no rings', () => {
  // The live arrival path, not a synthetic EMPTY: phase2 reduces precision after
  // its last isEmpty guard, so a sub-tile-unit polygon reaches encode as
  // POLYGON EMPTY. Asserting the collapse first keeps this from going vacuous if
  // the fixture ever stops collapsing.
  const d = 0.00002; // ~2m, well under one tile unit at this mapping
  const x = -71.05, y = 42.35;
  const gj = { type: 'Polygon', coordinates: [[
    [x, y], [x + d, y], [x + d, y + d], [x, y + d], [x, y],
  ]] };
  const geom = reader.read(JSON.stringify(gj));
  const pm = W.geom.PrecisionModel.fromScale(EXTENT / 0.3);
  const reduced = W.precision.GeometryPrecisionReducer.reduce(geom, pm);

  assert.ok(W.geom.isEmpty(reduced), 'fixture must collapse, or this proves nothing');
  assert.deepEqual(flatToTileLocal(W.geom.toFlat(reduced, 2), tm), []);
});

test('MultiPolygon winding is enforced per part, not across all rings', () => {
  // Running enforceWindingOrder over every ring at once would treat the second
  // polygon's shell as a hole and reverse it. partOffsets is what prevents that.
  const gj = { type: 'MultiPolygon', coordinates: [
    [ring(-71.15, 42.25, 0.04, true)],
    [ring(-70.95, 42.45, 0.06, true), ring(-70.95, 42.45, 0.02, true)],
  ] };
  const geom = reader.read(JSON.stringify(gj));
  const rings = flatToTileLocal(W.geom.toFlat(geom, 2), tm);

  assert.equal(rings.length, 3, 'two polygons, three rings total');
  // Shells CW (positive area in Y-down tile coords), the one hole CCW.
  assert.ok(ringSignedArea(rings[0]) > 0, 'part 1 shell is CW');
  assert.ok(ringSignedArea(rings[1]) > 0, 'part 2 shell is CW, not treated as a hole');
  assert.ok(ringSignedArea(rings[2]) < 0, 'part 2 hole is CCW');
});
