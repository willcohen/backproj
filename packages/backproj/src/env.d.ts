/** false in prod builds; esbuild eliminates guarded branches. */
declare const __DEV__: boolean;

declare module 'ffi-wasm/handler-runtime' {
  export function makeHandler(spec: {
    init: (initArgs: any) => Promise<any> | any;
    fingerprint?: (initArgs: any) => string;
    methods: Record<string, (...args: any[]) => any>;
    busyMethods?: string[];
    destroyMethods?: string[];
  }): (initArgs?: any) => Promise<any>;
  /** Fingerprint over named init-arg fields; byte carriers reduce to
   *  byteLength, everything else stringifies. */
  export function byteLengthFingerprint(
    fields: string[], prefix?: string | null,
  ): (initArgs: any) => string;
  const _default: typeof makeHandler;
  export default _default;
}

declare module 'ffi-wasm/workload-pool' {
  /** Joint-pool wiring (clj-native workload-pool, CLJS half). The
   *  wiring's atoms belong to ffi-wasm's own squint-cljs instance, so
   *  TS must read the pool through wiring_pool, never by touching the
   *  atoms itself (squint protocols are per-instance symbols). */
  export function register_handler_BANG_(
    registry: any, workload: string, libKey: string,
    spec: { module?: string; args?: any; 'pre-terminate'?: () => any },
  ): any;
  /** A wiring holds the registry of the current lifecycle plus the memo
   *  that makes the wiring pass run once. The pass BUILDS the registry,
   *  so the registry's own latch cannot guard it. */
  export function make_wiring_BANG_(): any;
  export function ensure_wired_BANG_(wiring: any, opts: {
    'registry-opts'?: { size?: number; 'handler-runtime'?: any };
    'register!'?: (registry: any) => any;
    pool?: any;
  }): Promise<any>;
  export function wiring_pool(wiring: any): any;
  export function shutdown_wiring_BANG_(wiring: any): Promise<any>;
}

declare module 'ffi-wasm/pool' {
  export function worker_call(
    pool: any, handlerKey: string, methodName: string,
    args: any, workerIdx?: number | null,
  ): Promise<any>;
  export function pool_size(pool: any): number;
}
