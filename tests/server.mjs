import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');

const MIME = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.mjs':  'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.pbf':  'application/x-protobuf',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let filePath = join(ROOT, 'docs', url.pathname === '/' ? 'index.html' : url.pathname);

  // Serve packages/ and node_modules/ from repo root
  if (url.pathname.startsWith('/packages/') || url.pathname.startsWith('/node_modules/') || url.pathname.startsWith('/tests/')) {
    filePath = join(ROOT, url.pathname);
  }

  // COEP/COOP headers for SharedArrayBuffer
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    await stat(filePath);
    const data = await readFile(filePath);
    const ext = extname(filePath);

    // Rewrite CDN-pinned importmap entries to local paths when serving
    // HTML. The published demo pulls from jsdelivr; running locally, you
    // want to exercise the current source. CommonJS deps (pbf, vt-pbf,
    // @mapbox/vector-tile) stay on esm.sh because the local node_modules
    // tree doesn't ship ESM versions. Additional entries (clj-native/*,
    // worker-router, comlink) extend the importmap with bare specifiers
    // that proj-wasm and backproj transitively need.
    if (ext === '.html') {
      let text = data.toString('utf8')
        .replace(
          /https:\/\/cdn\.jsdelivr\.net\/npm\/backproj@[^/]+\/dist\/backproj\.mjs/g,
          '/packages/backproj/dist/backproj.mjs',
        )
        .replace(
          /https:\/\/cdn\.jsdelivr\.net\/npm\/maplibre-proj@[^/]+\/dist\/maplibre-proj\.mjs/g,
          '/packages/maplibre-proj/dist/maplibre-proj.mjs',
        )
        .replace(
          /https:\/\/cdn\.jsdelivr\.net\/npm\/proj-wasm@[^/]+\/dist\/proj\.mjs/g,
          '/node_modules/proj-wasm/dist/proj.mjs',
        )
        .replace(
          /https:\/\/cdn\.jsdelivr\.net\/npm\/@wcohen\/wasmts@[^/]+\/dist\/wasmts\.js/g,
          '/node_modules/@wcohen/wasmts/dist/wasmts.js',
        )
        .replace(
          /https:\/\/cdn\.jsdelivr\.net\/npm\/squint-cljs@[^/]+\/core\.js/g,
          '/node_modules/squint-cljs/core.js',
        )
        .replace(
          /https:\/\/cdn\.jsdelivr\.net\/npm\/squint-cljs@[^/]+\/src\/squint\/string\.js/g,
          '/node_modules/squint-cljs/src/squint/string.js',
        )
        .replace(
          /https:\/\/cdn\.jsdelivr\.net\/npm\/resource-tracker@[^/]+\/resource\.mjs/g,
          '/node_modules/resource-tracker/resource.mjs',
        )
        .replace(
          /https:\/\/cdn\.jsdelivr\.net\/npm\/lru-cache@[^/]+\/dist\/esm\/index\.js/g,
          '/node_modules/lru-cache/dist/esm/index.js',
        )
        .replace(
          /https:\/\/cdn\.jsdelivr\.net\/npm\/ffi-wasm@[^/]+\//g,
          '/node_modules/ffi-wasm/',
        )
        // The npm alias installs @wcohen/worker-router at
        // node_modules/worker-router, so the local dir drops the scope.
        .replace(
          /https:\/\/cdn\.jsdelivr\.net\/npm\/@wcohen\/worker-router@[^/]+\//g,
          '/node_modules/worker-router/',
        )
        .replace(
          /https:\/\/cdn\.jsdelivr\.net\/npm\/comlink@[^/]+\//g,
          '/node_modules/comlink/',
        );

      // Inject local importmap additions (clj-native/*, worker-router,
      // proj-wasm/proj-handler) into any importmap whose entries weren't
      // already extended. The published demo importmap doesn't list these
      // because they're internal transitive deps. Only inject when an
      // importmap is present.
      const IMPORTMAP_INJECTIONS = {
        'proj-wasm/proj-handler': '/node_modules/proj-wasm/dist/proj-handler.mjs',
        'ffi-wasm': '/node_modules/ffi-wasm/src/cljc/net/willcohen/native/handler_runtime.mjs',
        'ffi-wasm/handler-runtime': '/node_modules/ffi-wasm/src/cljc/net/willcohen/native/handler_runtime.mjs',
        'ffi-wasm/pool': '/node_modules/ffi-wasm/src/cljc/net/willcohen/native/pool.mjs',
        'ffi-wasm/workload-pool': '/node_modules/ffi-wasm/src/cljc/net/willcohen/native/workload_pool.mjs',
        'ffi-wasm/dispatch': '/node_modules/ffi-wasm/src/cljc/net/willcohen/native/dispatch.mjs',
        'ffi-wasm/platform-state': '/node_modules/ffi-wasm/src/cljc/net/willcohen/native/platform_state.mjs',
        'comlink': '/node_modules/comlink/dist/esm/comlink.mjs',
        'worker-router': '/node_modules/worker-router/dist/index.mjs',
        'worker-router/worker-bootstrap': '/node_modules/worker-router/dist/worker-bootstrap.mjs',
      };
      text = text.replace(/<script\s+type="importmap">\s*\{([\s\S]*?)\}\s*<\/script>/, (full, body) => {
        // Find the imports object inside; append any missing entries.
        // Keep this string-level so we don't have to fully parse JSON5
        // (the importmap is strict JSON though; could parse if needed).
        let imports = body;
        for (const [key, target] of Object.entries(IMPORTMAP_INJECTIONS)) {
          if (!imports.includes(`"${key}"`)) {
            // Find the imports map (last `{...}` before the closing `}`)
            // and append our entry. Simplest: insert after the last
            // existing entry (look for the last `,` followed by a line
            // break + indent before the closing `}` of imports).
            imports = imports.replace(
              /("imports"\s*:\s*\{)/,
              `$1\n    "${key}": "${target}",`,
            );
          }
        }
        return `<script type="importmap">{${imports}}</script>`;
      });

      res.writeHead(200, { 'Content-Type': MIME[ext] });
      res.end(text);
      return;
    }

    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});

const PORT = 8973;
server.listen(PORT, () => {
  console.log(`Benchmark server listening on http://localhost:${PORT}`);
});
