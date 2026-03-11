declare module 'vt-pbf' {
  function fromVectorTileJs(tile: any): Uint8Array;
  function fromGeojsonVt(
    layers: Record<string, any>,
    options?: { version?: number; extent?: number },
  ): Uint8Array;

  export default fromVectorTileJs;
  export { fromVectorTileJs, fromGeojsonVt };
}
