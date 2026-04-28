declare module 'proj-wasm' {
  /** {pool} adopts an existing worker-router pool (owned=false) instead
   *  of spawning one. */
  export function init(opts?: { pool?: any }): Promise<void>;
  // Squint keeps the Clojure name: shutdown! -> shutdown_BANG_.
  export function shutdown_BANG_(): Promise<void>;
  /** Joint-pool handler spec for the workload-pool registry. module
   *  resolves against dist/proj.mjs; 'pre-terminate' flushes pending
   *  async disposers before the pool dies. */
  export function handlerSpec(args?: any): {
    module: string; args: any; 'pre-terminate': () => Promise<void>;
  };
  /** Per-worker init payload for handlerSpec: proj.db/proj.ini read
   *  beside dist/proj.mjs on node, fetched in the browser. */
  export function handlerDefaultInitArgs(opts?: { 'log-level'?: number }): Promise<{
    dbBytes: Uint8Array; iniBytes: Uint8Array; logLevel: number;
  }>;
  export function coordArray(n: number): Promise<any>;
  export function setCoords(buf: any, coords: [number, number, number, number][]): Promise<void>;
  export function getCoords(buf: any, i: number): Promise<[number, number, number, number]>;
  export function projCreateCrsToCrs(opts: { source_crs: string; target_crs: string }): Promise<any>;
  export function projCreate(opts: { definition: string }): Promise<any>;
  export function projTransArray(opts: { p: any; direction: number; n: number; coord: any }): Promise<void>;
  export function projGetCrsInfoListFromDatabase(opts: { auth_name?: string; types?: number[] }): Promise<any[]>;
  export function projGetTargetCrs(opts: { pj: any }): Promise<any>;
  export function projCrsGetCoordoperation(opts: { crs: any }): Promise<any>;
  export function projAsProjString(opts: { pj: any; type: number }): Promise<string>;
}
