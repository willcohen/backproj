// Registered under the proj handler key IN PLACE of proj-wasm's
// proj-handler.mjs, so the created instance is reachable by the
// co-resident wasmts handler (chain fusion: worker-side proj_trans_array
// with no RPC hop). The real module is imported by URL from init args,
// keeping proj-wasm's layout its own concern. Must stay an esbuild entry
// of its own and be imported dynamically by URL from wasmts-handler --
// a bundled static import would inline a second module instance and the
// shared state would silently split.
let realModule = null;
let instance = null;

export default async function create(init) {
  realModule = await import(/* @vite-ignore */ init.projHandlerUrl);
  const make = realModule.default ?? realModule.handler ?? realModule.create;
  instance = await make(init.projArgs);
  return instance;
}

export async function destroy(args) {
  if (realModule && typeof realModule.destroy === 'function') {
    return realModule.destroy(args);
  }
}

// The proj handler registers before wasmts, so wasmts init and every
// later call on this worker see the instance.
export function getProjHandler() {
  if (!instance) throw new Error('proj-handler-bridge: instance not created yet');
  return instance;
}
