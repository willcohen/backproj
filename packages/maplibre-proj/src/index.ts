import type { FeatureCollection } from 'geojson';
import {
  initProj,
  buildTransformer,
  getWorldBounds,
  reprojectGeoJSON,
} from 'backproj';
import type { Transformer } from 'backproj';

export type { Transformer } from 'backproj';

/**
 * A MapLibre style specification (subset of relevant fields).
 * Using a minimal type here to avoid a hard dependency on maplibre-gl's types.
 */
interface StyleSpecification {
  sources: Record<string, any>;
  layers: any[];
  [key: string]: any;
}

export interface ReprojectResult {
  style: StyleSpecification;
  bounds: [[number, number], [number, number]];
  transformer: Transformer;
}

/**
 * Reproject a MapLibre style to a target CRS.
 *
 * For each GeoJSON source with inline data, reprojects the coordinates through
 * backproj. Sets projection to 'mercator' and renderWorldCopies to false.
 * Returns the modified style, fake bounds for fitBounds, and the transformer
 * handle for manual use.
 */
export async function reprojectStyle(options: {
  style: StyleSpecification;
  crs: string;
}): Promise<ReprojectResult> {
  const { crs } = options;
  const style: StyleSpecification = JSON.parse(JSON.stringify(options.style));

  await initProj();
  const transformer = await buildTransformer(crs);

  for (const [name, source] of Object.entries(style.sources)) {
    if (source.type === 'geojson' && source.data && typeof source.data === 'object') {
      const fc = source.data as FeatureCollection;
      if (fc.type === 'FeatureCollection') {
        style.sources[name] = { ...source, data: await reprojectGeoJSON(fc, transformer) };
      }
    }
  }

  (style as any).projection = { type: 'mercator' };

  const bounds = await getWorldBounds(transformer);

  return { style, bounds, transformer };
}
