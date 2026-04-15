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
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});

const PORT = parseInt(process.env.PORT || '8973', 10);
server.listen(PORT, () => {
  console.log(`Benchmark server listening on http://localhost:${PORT}`);
});
