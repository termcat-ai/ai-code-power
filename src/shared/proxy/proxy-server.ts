import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as zlib from 'zlib';
import { decompress as zstdDecompress } from 'fzstd';
import type { CaptureStore } from './capture-store';
import type { SseStrategy } from '../../adapters/types';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { v4: uuidv4 } = require('uuid') as { v4: () => string };

// Hop-by-hop headers must not be forwarded through a proxy.
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade',
  'accept-encoding', // avoid compressed responses we can't parse
]);

// Prefer Electron's net module (respects system proxy, e.g. Clash Verge) over
// Node.js https which bypasses system proxy settings.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const electronNet: null | { request(opts: unknown): any } = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const e = require('electron') as { net?: unknown };
    if (e.net && typeof (e.net as Record<string, unknown>).request === 'function') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return e.net as { request(opts: unknown): any };
    }
  } catch { /* not in Electron */ }
  return null;
})();

/**
 * Local HTTP reverse-proxy.
 *
 * Upstream requests use electron.net (Chromium network stack) which honours the
 * user's system proxy (Clash Verge, etc.).  Falls back to Node.js https in
 * non-Electron environments (tests, etc.).
 *
 * AI CLI → http://127.0.0.1:PORT → system proxy → real API
 */
export class ProxyServer {
  private server: http.Server | null = null;
  private port: number | null = null;

  constructor(
    private readonly captureStore: CaptureStore,
    private readonly getUpstreamBaseUrl: () => string,
    // Resolved per-request (like getUpstreamBaseUrl) so switching CLI while the
    // proxy stays running never leaves a stale strategy bound at start() time.
    private readonly getStrategy: () => SseStrategy,
  ) {}

  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      if (this.server) {
        resolve(this.port!);
        return;
      }

      const server = http.createServer((req, res) => {
        this.handleRequest(req, res).catch((err: Error) => {
          console.log(`[ai-code-power proxy] forward error for ${req.method} ${req.url}: ${err.message}`);
          if (!res.headersSent) {
            res.writeHead(502);
            res.end(JSON.stringify({ error: 'proxy_internal', message: err.message }));
          }
        });
      });

      // Immediately reject WebSocket upgrade attempts so the client (Codex) falls
      // back to HTTPS without waiting for a connection timeout.
      server.on('upgrade', (_req: http.IncomingMessage, socket: net.Socket) => {
        socket.write('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n');
        socket.destroy();
      });

      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number } | null;
        if (!addr) { reject(new Error('proxy: no address')); return; }
        this.port = addr.port;
        this.server = server;
        console.log(`[ai-code-power proxy] started on :${this.port} | electronNet=${electronNet != null}`);
        resolve(this.port);
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      const s = this.server;
      this.server = null;
      this.port = null;
      if (!s) { resolve(); return; }
      s.close(() => resolve());
    });
  }

  getPort(): number | null { return this.port; }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const requestId = uuidv4();
    const captureTs = Date.now();
    const strategy = this.getStrategy();
    const isCapture = (req.url ?? '').includes(strategy.captureEndpointPath);
    console.log(`[ai-code-power proxy] ${req.method} ${req.url} | isCapture=${isCapture} | capturePath=${strategy.captureEndpointPath}`);

    const bodyBuf = await readBody(req);

    if (isCapture) {
      // Codex compresses the request body (Content-Encoding: zstd / gzip / br).
      // Decode a copy for display; the original bytes are still forwarded as-is.
      const decoded = decodeBodyForDisplay(bodyBuf, req.headers['content-encoding']);
      let parsedReq: Record<string, unknown> = {};
      try {
        parsedReq = JSON.parse(decoded.text) as Record<string, unknown>;
      } catch {
        parsedReq = { _undecodable: `content-encoding=${decoded.encoding}, ${bodyBuf.length} bytes`, _preview: decoded.text.slice(0, 2000) };
      }
      this.captureStore.add({
        requestId,
        captureTs,
        request: parsedReq,
        upstreamUrl: this.getUpstreamBaseUrl(),
        responseMessageId: null,
        rawResponseSse: null,
        responseTs: null,
      });
    }

    const upstreamBase = this.getUpstreamBaseUrl().replace(/\/$/, '');
    const targetUrlStr = `${upstreamBase}${req.url ?? '/'}`;
    try { new URL(targetUrlStr); } catch {
      res.writeHead(400);
      res.end('proxy: invalid target URL');
      return;
    }

    // Strip hop-by-hop headers; set correct Content-Length for the assembled body.
    const forwardHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (HOP_BY_HOP.has(k.toLowerCase())) continue;
      if (Array.isArray(v)) forwardHeaders[k] = v.join(', ');
      else if (v != null) forwardHeaders[k] = v;
    }
    forwardHeaders['host'] = new URL(targetUrlStr).host;
    if (bodyBuf.length > 0) {
      forwardHeaders['content-length'] = String(bodyBuf.length);
    } else {
      delete forwardHeaders['content-length'];
    }

    if (electronNet) {
      await this.forwardWithElectronNet(
        targetUrlStr, req.method ?? 'GET', forwardHeaders, bodyBuf,
        res, isCapture, strategy, requestId,
      );
    } else {
      await this.forwardWithNodeHttps(
        targetUrlStr, req.method ?? 'GET', forwardHeaders, bodyBuf,
        res, isCapture, strategy, requestId,
      );
    }
  }

  private forwardWithElectronNet(
    url: string, method: string, headers: Record<string, string>, body: Buffer,
    res: http.ServerResponse, isCapture: boolean, strategy: SseStrategy, requestId: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      // Chromium manages 'host' and 'content-length' itself — passing either to
      // net.request causes ERR_INVALID_ARGUMENT. Drop both and let it recompute
      // Content-Length from the body we write below.
      const { host: _host, 'content-length': _cl, ...safeHeaders } = headers;
      void _host; void _cl;
      const eReq = electronNet!.request({ url, method });
      // Set headers individually; Electron net's setHeader is more permissive than options.headers.
      for (const [k, v] of Object.entries(safeHeaders)) {
        try { (eReq as { setHeader(k: string, v: string): void }).setHeader(k, v); } catch { /* skip */ }
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      eReq.on('response', (eRes: any) => {
        console.log(`[ai-code-power proxy] -> ${url} | status=${eRes.statusCode}`);
        // electron.net (Chromium) has already transparently decompressed the
        // body, so drop content-encoding/content-length — otherwise the client
        // tries to decompress plain bytes again (ZlibError) and the length lies.
        const outHeaders: Record<string, string | string[]> = {};
        for (const [k, v] of Object.entries(eRes.headers as Record<string, string | string[]>)) {
          const key = k.toLowerCase();
          if (HOP_BY_HOP.has(key) || key === 'content-encoding' || key === 'content-length') continue;
          outHeaders[k] = v;
        }
        res.writeHead(eRes.statusCode as number, outHeaders);

        const responseChunks: Buffer[] = [];
        eRes.on('data', (chunk: Buffer) => {
          if (isCapture) responseChunks.push(chunk);
          res.write(chunk);
        });
        eRes.on('end', () => {
          res.end();
          if (isCapture) {
            const rawSse = Buffer.concat(responseChunks).toString('utf-8');
            const msgId = strategy.parseMessageId(rawSse);
            this.captureStore.updateResponse(requestId, { rawResponseSse: rawSse, responseMessageId: msgId, responseTs: Date.now() });
            console.log(`[ai-code-power proxy] captured | sseLen=${rawSse.length} | store.size=${this.captureStore.size()}`);
          }
          resolve();
        });
        eRes.on('error', reject);
      });

      eReq.on('error', reject);
      if (body.length > 0) eReq.write(body);
      eReq.end();
    });
  }

  private forwardWithNodeHttps(
    targetUrlStr: string, method: string, headers: Record<string, string>, body: Buffer,
    res: http.ServerResponse, isCapture: boolean, strategy: SseStrategy, requestId: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const targetUrl = new URL(targetUrlStr);
      const isHttps = targetUrl.protocol === 'https:';
      const port = targetUrl.port ? Number(targetUrl.port) : (isHttps ? 443 : 80);
      const transport: typeof http | typeof https = isHttps ? https : http;

      const options: https.RequestOptions = {
        hostname: targetUrl.hostname,
        port,
        path: targetUrl.pathname + targetUrl.search,
        method,
        headers,
        timeout: 300_000,
      };

      const upstreamReq = transport.request(options, (upstreamRes) => {
        const outHeaders: http.OutgoingHttpHeaders = {};
        for (const [k, v] of Object.entries(upstreamRes.headers)) {
          if (!HOP_BY_HOP.has(k.toLowerCase())) outHeaders[k] = v;
        }
        res.writeHead(upstreamRes.statusCode ?? 200, outHeaders);

        const responseChunks: Buffer[] = [];
        upstreamRes.on('data', (chunk: Buffer) => {
          if (isCapture) responseChunks.push(chunk);
          res.write(chunk);
        });
        upstreamRes.on('end', () => {
          res.end();
          if (isCapture) {
            const rawSse = Buffer.concat(responseChunks).toString('utf-8');
            const msgId = strategy.parseMessageId(rawSse);
            this.captureStore.updateResponse(requestId, { rawResponseSse: rawSse, responseMessageId: msgId, responseTs: Date.now() });
            console.log(`[ai-code-power proxy] captured | sseLen=${rawSse.length} | store.size=${this.captureStore.size()}`);
          }
          resolve();
        });
        upstreamRes.on('error', reject);
      });

      upstreamReq.on('error', reject);
      if (body.length > 0) upstreamReq.write(body);
      upstreamReq.end();
    });
  }
}

/**
 * Decode a (possibly compressed) request body to text for display only.
 * Electron 28's bundled Node has no built-in zstd, so zstd uses the bundled
 * pure-JS fzstd decoder. Falls back to raw utf-8 on unknown/failed encodings.
 */
function decodeBodyForDisplay(buf: Buffer, contentEncoding: string | string[] | undefined): { text: string; encoding: string } {
  const raw = Array.isArray(contentEncoding) ? contentEncoding.join(',') : (contentEncoding ?? '');
  const enc = raw.toLowerCase().trim();
  try {
    if (enc === 'zstd') return { text: Buffer.from(zstdDecompress(new Uint8Array(buf))).toString('utf-8'), encoding: enc };
    if (enc === 'gzip' || enc === 'x-gzip') return { text: zlib.gunzipSync(buf).toString('utf-8'), encoding: enc };
    if (enc === 'br') return { text: zlib.brotliDecompressSync(buf).toString('utf-8'), encoding: enc };
    if (enc === 'deflate') return { text: zlib.inflateSync(buf).toString('utf-8'), encoding: enc };
  } catch { /* fall through to raw */ }
  return { text: buf.toString('utf-8'), encoding: enc || 'identity' };
}

function readBody(readable: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    readable.on('data', (c: Buffer) => chunks.push(c));
    readable.on('end', () => resolve(Buffer.concat(chunks)));
    readable.on('error', reject);
  });
}
