#!/usr/bin/env node
// Starts the Chroma platform server.
//   PORT=3000 HOST=0.0.0.0 DATA_DIR=./data node server/index.js
// Environment:
//   PORT, HOST            listen address (default 3000, 127.0.0.1)
//   DATA_DIR              where the database and uploaded files live
//   CHROMA_HTTPS=1        set when behind TLS: Secure cookies, HSTS, upgrade-insecure-requests
//   TRUST_PROXY=1         trust X-Forwarded-For from a reverse proxy (for rate limits / audit)
//   CHROMA_DOMAIN=x.com   also serve projects at <project>.x.com
//   ALLOW_SIGNUP=0        disable open registration
//   ALLOW_JS_FUNCTIONS=1  run api/*.js server functions (sandboxed child processes)
import http from 'node:http';
import { createApp, VERSION } from './app.js';

export function startServer(opts = {}) {
  const app = createApp({
    dataDir: opts.dataDir || process.env.DATA_DIR,
    https: opts.https ?? process.env.CHROMA_HTTPS === '1',
    trustProxy: opts.trustProxy ?? process.env.TRUST_PROXY === '1',
    domain: opts.domain || process.env.CHROMA_DOMAIN,
    allowSignup: opts.allowSignup ?? process.env.ALLOW_SIGNUP !== '0',
    allowJsFunctions: opts.allowJsFunctions ?? process.env.ALLOW_JS_FUNCTIONS === '1',
    log: opts.log,
    dev: opts.dev,
    rateLimits: opts.rateLimits,
  });
  const server = http.createServer(app.handle);
  server.headersTimeout = 30_000;
  server.requestTimeout = 120_000;
  server.keepAliveTimeout = 5_000;
  const port = opts.port ?? Number(process.env.PORT || 3000);
  const host = opts.host || process.env.HOST || '127.0.0.1';
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const addr = server.address();
      resolve({
        server,
        app,
        url: `http://${addr.address.includes(':') ? `[${addr.address}]` : addr.address}:${addr.port}`,
        close: () => new Promise((r) => { app.close(); server.close(r); server.closeAllConnections?.(); }),
      });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('server/index.js')) {
  const { url, close } = await startServer();
  console.log(`\n  ◆ Chroma ${VERSION} running at ${url}\n    dashboard: ${url}/dashboard · playground: ${url}/playground\n`);
  const stop = async () => { await close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
