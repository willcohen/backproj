import { initProj, buildTransformer, transformCoords, inverseTransformCoords } from '../packages/backproj/dist/backproj.mjs';

await initProj();

async function test(crsString, testPoints) {
  console.log(`\n=== ${crsString} ===`);

  const t = await buildTransformer(crsString);
  console.log(`Pipeline: ${t._tPipeline ? 'YES' : 'NO'}`);
  console.log(`Affine: Sx=${t._Sx} Sy=${t._Sy} Ox=${t._Ox} Oy=${t._Oy}`);

  for (const [lon, lat] of testPoints) {
    // Forward
    const fwd = await transformCoords([[lon, lat]], t);
    const [fakeLon, fakeLat] = fwd[0];

    // Inverse (round-trip)
    const inv = await inverseTransformCoords(fwd, t);
    const [rtLon, rtLat] = inv[0];

    const lonErr = Math.abs(rtLon - lon);
    const latErr = Math.abs(rtLat - lat);

    const fakeOk = isFinite(fakeLon) && isFinite(fakeLat);
    const rtOk = lonErr < 0.001 && latErr < 0.001;

    console.log(
      `  (${lon}, ${lat}) -> fake(${fakeLon.toFixed(6)}, ${fakeLat.toFixed(6)}) -> rt(${rtLon.toFixed(6)}, ${rtLat.toFixed(6)}) ` +
      `err=(${lonErr.toExponential(2)}, ${latErr.toExponential(2)}) ${fakeOk && rtOk ? 'OK' : 'FAIL'}`
    );

    if (!fakeOk) console.error('    FAIL: non-finite forward output');
    if (!rtOk) console.error(`    FAIL: round-trip error too large`);
  }
}

await test('EPSG:2249', [
  [-71.058, 42.360],
  [-71.680, 42.175],
  [-73.5, 41.46],
  [-69.86, 42.89],
]);

await test('EPSG:5070', [
  [-98.5, 39.8],
  [-95.85, 36.895],
  [-124.79, 24.41],
  [-66.91, 49.38],
]);

await test('ESRI:54030', [
  [10, 20],
  [-90, -44.5],
  [180, 89],
  [0, 0],
]);

// Compound CRS: coordoperation extraction fails, must use two-call fallback.
// EPSG:7415 = Amersfoort/RD New (projected) + NAP height (vertical).
await test('EPSG:7415', [
  [5.387, 52.156],   // Amsterdam
  [4.300, 52.070],   // The Hague
  [5.121, 52.093],   // Utrecht
]);

// Geographic CRS must be rejected.
const geographicCases = ['EPSG:4326', '+proj=longlat +datum=WGS84'];
console.log('\n=== Geographic CRS rejection ===');
let geoPassed = true;
for (const crs of geographicCases) {
  try {
    await buildTransformer(crs);
    console.error(`  FAIL: ${crs} was not rejected`);
    geoPassed = false;
  } catch (e) {
    console.log(`  ${crs}: rejected OK (${e.message.slice(0, 60)}...)`);
  }
}
if (!geoPassed) process.exit(1);

console.log('\nDone.');
process.exit(0);
