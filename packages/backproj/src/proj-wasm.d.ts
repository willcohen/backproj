declare module 'proj-wasm' {
  export function init(): Promise<void>;
  export function coordArray(n: number): Promise<any>;
  export function setCoords(buf: any, coords: [number, number, number, number][]): Promise<void>;
  export function getCoords(buf: any, i: number): Promise<[number, number, number, number]>;
  export function projCreateCrsToCrs(opts: { source_crs: string; target_crs: string }): Promise<any>;
  export function projTransArray(opts: { p: any; direction: number; n: number; coord: any }): Promise<void>;
  export function getCrsInfoListFromDatabase(opts: { auth_name?: string; types?: number[] }): Promise<any[]>;
}
