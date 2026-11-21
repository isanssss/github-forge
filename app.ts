// app.ts — the HTTP router: the health probe, REST v3 under /api/v3, GraphQL at /api/graphql,
// MCP at /mcp, and git smart HTTP at /{owner}/{repo}.git, all over one shared in-memory store.
//
// The transport is a minimal HTTP/1.1 server on raw sockets (node:net), not node:http: the
// workload is thousands of small request/response exchanges, and the per-request machinery of
// node:http (parser objects, stream plumbing) costs more than the handlers it feeds. This
// transport parses just the request line and the headers the router reads, buffers the whole
// body (Content-Length or chunked, with 100-continue honored), and writes each response as a
// status line, the handler's headers and one body buffer. Keep-alive, backpressure and
// connection-close semantics follow HTTP/1.1 as the suite's fetch client exercises them.
//
// Authentication follows the suite's contract: requests carry "Authorization: Bearer <token>"
// with the token from MAKEFUN_SHOP_TOKEN; a request without that header (or with a different
// token, when one is configured) is refused 401 on the API surfaces.

import { STATUS_CODES } from 'node:http';
import { createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net';
import { Forge } from './store.ts';
import { getItemResult, routeRest, type RestResult } from './rest.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { infoRefs, receivePack, uploadPack } from './git.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** The query of every queryless request: shared, because the router only ever reads it. */
const EMPTY_QUERY = new URLSearchParams();

/** The expected Authorization header for the configured token, rebuilt only when the token changes. */
let authHeaderCache: { token: string; header: string } | null = null;

/** The request the router consumes: method, raw target, the headers it reads, the whole body. */
interface ShimRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[]>;
  body: Buffer;
}

/** Whether the request carries the viewer's credential. */
function authorized(req: ShimRequest): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || header === '') return false;
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (token === '') return true;
  if (authHeaderCache === null || authHeaderCache.token !== token) {
    authHeaderCache = { token, header: `Bearer ${token}` };
  }
  return header === authHeaderCache.header;
}

/** The response the router writes to: a status, a header set, one body, written once. */
class ShimResponse {
  headersSent = false;
  ended = false;
  destroyed = false;
  /** Resolves true once the response bytes are flushed, false when the socket died first. */
  readonly done: Promise<boolean>;
  private resolveDone: (ok: boolean) => void = () => {};
  private status = 200;
  private head = '';
  private socket: Socket;
  private headOnly: boolean;

  constructor(socket: Socket, headOnly: boolean) {
    this.socket = socket;
    this.headOnly = headOnly;
    this.done = new Promise<boolean>((resolve) => {
      this.resolveDone = resolve;
    });
  }

  writeHead(status: number, headers: Record<string, string | number>): void {
    this.status = status;
    let head = `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ''}\r\n`;
    for (const name of Object.keys(headers)) {
      head += `${name}: ${headers[name]}\r\n`;
    }
    this.head = head;
    this.headersSent = true;
  }

  end(body?: Buffer): void {
    if (this.ended) return;
    this.ended = true;
    if (this.destroyed || this.socket.destroyed) {
      this.resolveDone(false);
      return;
    }
    // A HEAD answer and the bodyless statuses carry the headers but never body bytes.
    const suppress = this.headOnly || this.status === 204 || this.status === 304;
    const headBuf = Buffer.from(`${this.head}\r\n`, 'latin1');
    if (body === undefined || body.length === 0 || suppress) {
      this.socket.write(headBuf, (err) => this.resolveDone(!err));
      return;
    }
    // Head and body in one flush, without copying the body.
    this.socket.cork();
    this.socket.write(headBuf);
    this.socket.write(body, (err) => this.resolveDone(!err));
    this.socket.uncork();
  }

  destroy(): void {
    this.destroyed = true;
    this.socket.destroy();
    this.resolveDone(false);
  }
}

/** Answer with a JSON body and the forge's request-id header. */
function sendJson(forge: Forge, res: ShimResponse, status: number, body: unknown, headers: Record<string, string> = {}, raw?: Buffer): void {
  const bytes = raw ?? Buffer.from(`${JSON.stringify(body)}\n`, 'utf8');
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': bytes.length,
    'x-github-request-id': forge.nextRequestId(),
    ...headers,
  });
  res.end(bytes);
}

/** Answer with raw bytes (the git transport). */
function sendBytes(res: ShimResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

/** The request body: the transport read it in full before dispatch. */
function readBody(req: ShimRequest): Buffer {
  return req.body;
}

/** Decode one URL path segment (a malformed escape reads as the raw segment). */
function decodeSegment(segment: string): string {
  if (!segment.includes('%')) return segment;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** One query parameter's value from a raw query string, or null when the name is absent. */
function queryParam(query: string, name: string): string | null {
  let start = 0;
  while (start <= query.length) {
    let end = query.indexOf('&', start);
    if (end === -1) end = query.length;
    if (query.startsWith(`${name}=`, start)) {
      const value = query.slice(start + name.length + 1, end);
      // The plain values this router reads (a git service name) carry no escapes; anything
      // escaped goes through the full form parser, which decodes exactly as before.
      if (!value.includes('%') && !value.includes('+')) return value;
      return new URLSearchParams(query).get(name);
    }
    if (end === query.length) break;
    start = end + 1;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The raw-socket HTTP/1.1 transport.
// ---------------------------------------------------------------------------

const HEAD_END = Buffer.from('\r\n\r\n');
const CRLF = Buffer.from('\r\n');
const CONTINUE_BYTES = Buffer.from('HTTP/1.1 100 Continue\r\n\r\n', 'latin1');
const BAD_REQUEST_BYTES = Buffer.from('HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\nconnection: close\r\n\r\n', 'latin1');
const EMPTY_BODY = Buffer.alloc(0);
const MAX_HEAD_BYTES = 64 * 1024;
const MAX_BODY_BYTES = 128 * 1024 * 1024;

/** A buffered reader over one socket: the connection loop pulls heads, lines and byte runs. */
class Conn {
  private buf: Buffer = EMPTY_BODY;
  private closed = false;
  private waiter: (() => void) | null = null;
  private socket: Socket;

  constructor(socket: Socket) {
    this.socket = socket;
    socket.on('data', (chunk: Buffer) => {
      this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
      this.poke();
    });
    const done = (): void => {
      this.closed = true;
      this.poke();
    };
    socket.on('end', done);
    socket.on('close', done);
    socket.on('error', done);
  }

  private poke(): void {
    const waiter = this.waiter;
    this.waiter = null;
    if (waiter !== null) waiter();
  }

  /**
   * Suspend until the next data or close event. Callers re-check their own condition after
   * waking: waiting for "more than nothing" by re-testing a non-empty buffer would spin the
   * event loop instead of yielding to it, and the bytes being waited for could never arrive.
   */
  private waitMore(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.waiter = resolve;
    });
  }

  /** One head block, through the blank line; null when the connection is done or oversized. */
  async readHead(): Promise<Buffer | null> {
    for (;;) {
      const at = this.buf.indexOf(HEAD_END);
      if (at !== -1) {
        const head = this.buf.subarray(0, at + 4);
        this.buf = this.buf.subarray(at + 4);
        return head;
      }
      if (this.buf.length > MAX_HEAD_BYTES) return null;
      if (this.closed) return null;
      await this.waitMore();
    }
  }

  /** Exactly n bytes; null when the socket closes first. */
  async readBytes(n: number): Promise<Buffer | null> {
    while (this.buf.length < n) {
      if (this.closed) return null;
      await this.waitMore();
    }
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }

  /** One CRLF-terminated line, without the CRLF; null on close or oversize. */
  async readLine(): Promise<Buffer | null> {
    for (;;) {
      const at = this.buf.indexOf(CRLF);
      if (at !== -1) {
        const line = this.buf.subarray(0, at);
        this.buf = this.buf.subarray(at + 2);
        return line;
      }
      if (this.buf.length > MAX_HEAD_BYTES) return null;
      if (this.closed) return null;
      await this.waitMore();
    }
  }
}

/** A chunked request body, decoded; null when the stream breaks or runs oversize. */
async function readChunked(conn: Conn): Promise<Buffer | null> {
  const parts: Buffer[] = [];
  let total = 0;
  for (;;) {
    const line = await conn.readLine();
    if (line === null) return null;
    const semi = line.indexOf(0x3b); // ';' — chunk extensions are ignored
    const sizeText = (semi === -1 ? line : line.subarray(0, semi)).toString('latin1').trim();
    if (!/^[0-9a-fA-F]+$/.test(sizeText)) return null;
    const size = Number.parseInt(sizeText, 16);
    if (size === 0) {
      // Trailer lines run to an empty line; their content is not used.
      for (;;) {
        const trailer = await conn.readLine();
        if (trailer === null) return null;
        if (trailer.length === 0) return Buffer.concat(parts, total);
      }
    }
    total += size;
    if (total > MAX_BODY_BYTES) return null;
    const data = await conn.readBytes(size + 2); // the payload and its trailing CRLF
    if (data === null) return null;
    parts.push(data.subarray(0, size));
  }
}

/** What the transport needs from a head, plus the headers the router reads. */
interface ParsedHead {
  method: string;
  target: string;
  headers: Record<string, string | string[]>;
  contentLength: string | null;
  chunked: boolean;
  expectContinue: boolean;
  keepAlive: boolean;
}

/** Whether a Connection header value carries the given token. */
function hasToken(value: string, token: string): boolean {
  for (const part of value.split(',')) {
    if (part.trim() === token) return true;
  }
  return false;
}

/** Parse a request head; null when the request line or a header line is malformed. */
function parseHead(head: Buffer): ParsedHead | null {
  const lines = head.toString('latin1').split('\r\n');
  const requestLine = lines[0] ?? '';
  const sp1 = requestLine.indexOf(' ');
  const sp2 = requestLine.lastIndexOf(' ');
  if (sp1 <= 0 || sp2 <= sp1) return null;
  const method = requestLine.slice(0, sp1);
  const target = requestLine.slice(sp1 + 1, sp2);
  const version = requestLine.slice(sp2 + 1);
  if (!version.startsWith('HTTP/')) return null;
  const http11 = version !== 'HTTP/1.0';

  const headers: Record<string, string | string[]> = {};
  let contentLength: string | null = null;
  let chunked = false;
  let expectContinue = false;
  let connection = '';
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (line === '') continue;
    const colon = line.indexOf(':');
    if (colon <= 0) return null;
    const name = line.slice(0, colon).toLowerCase();
    const value = line.slice(colon + 1).trim();
    switch (name) {
      case 'authorization':
      case 'host':
      case 'git-protocol': {
        const prev = headers[name];
        headers[name] = prev === undefined ? value : `${prev as string}, ${value}`;
        break;
      }
      case 'content-length':
        contentLength = contentLength === null ? value : `${contentLength}, ${value}`;
        break;
      case 'transfer-encoding':
        if (value.toLowerCase().includes('chunked')) chunked = true;
        break;
      case 'expect':
        expectContinue = value.toLowerCase() === '100-continue';
        break;
      case 'connection':
        connection = value.toLowerCase();
        break;
      default:
        break;
    }
  }
  const keepAlive = http11 ? !hasToken(connection, 'close') : hasToken(connection, 'keep-alive');
  return { method, target, headers, contentLength, chunked, expectContinue, keepAlive };
}

/** A Content-Length value (possibly a repeated, identical list) as a byte count, or null. */
function parseContentLength(value: string): number | null {
  let result: number | null = null;
  for (const part of value.split(',')) {
    const text = part.trim();
    if (!/^\d+$/.test(text)) return null;
    const n = Number(text);
    if (result !== null && n !== result) return null;
    result = n;
  }
  return result;
}

/** Write all bytes and resolve once flushed; false when the socket dies first. */
function writeAll(socket: Socket, bytes: Buffer): Promise<boolean> {
  return new Promise((resolve) => {
    if (socket.destroyed) {
      resolve(false);
      return;
    }
    socket.write(bytes, (err) => resolve(!err));
  });
}

/** Dispatch one request, with the router's failure net: a 500 before headers, a drop after. */
async function runRequest(forge: Forge, req: ShimRequest, res: ShimResponse): Promise<void> {
  try {
    await dispatch(forge, req, res);
  } catch {
    if (!res.headersSent) {
      try {
        sendJson(forge, res, 500, { message: 'Internal Server Error' });
      } catch {
        res.destroy();
      }
    } else {
      res.destroy();
    }
  }
  if (!res.ended && !res.destroyed) res.destroy();
}

/** Serve one connection: request after request until close, error or a dead socket. */
async function serve(forge: Forge, socket: Socket): Promise<void> {
  // Small request/response exchanges dominate the workload: never let Nagle hold a reply back.
  socket.setNoDelay(true);
  const conn = new Conn(socket);
  try {
    for (;;) {
      const headBuf = await conn.readHead();
      if (headBuf === null) {
        socket.destroy();
        return;
      }
      const head = parseHead(headBuf);
      if (head === null) {
        await writeAll(socket, BAD_REQUEST_BYTES);
        socket.end();
        return;
      }
      if (head.expectContinue) socket.write(CONTINUE_BYTES);
      let body: Buffer;
      if (head.chunked) {
        const decoded = await readChunked(conn);
        if (decoded === null) {
          socket.destroy();
          return;
        }
        body = decoded;
      } else if (head.contentLength !== null) {
        const n = parseContentLength(head.contentLength);
        if (n === null || n > MAX_BODY_BYTES) {
          await writeAll(socket, BAD_REQUEST_BYTES);
          socket.end();
          return;
        }
        const bytes = await conn.readBytes(n);
        if (bytes === null) {
          socket.destroy();
          return;
        }
        body = bytes;
      } else {
        body = EMPTY_BODY;
      }
      const req: ShimRequest = { method: head.method, url: head.target, headers: head.headers, body };
      const res = new ShimResponse(socket, head.method === 'HEAD');
      await runRequest(forge, req, res);
      const flushed = await res.done;
      if (!flushed || res.destroyed || !head.keepAlive) {
        socket.end();
        return;
      }
    }
  } catch {
    socket.destroy();
  }
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): NetServer {
  const forge = new Forge();
  return createNetServer((socket: Socket) => {
    void serve(forge, socket);
  });
}

/** Route one request to its surface. */
async function dispatch(forge: Forge, req: ShimRequest, res: ShimResponse): Promise<void> {
  const method = req.method ?? 'GET';
  // The request target arrives in origin form ("/path?query"): split it by hand rather than
  // paying for a full URL parse on every request.
  const target = req.url ?? '/';
  const queryAt = target.indexOf('?');
  const path = queryAt === -1 ? target : target.slice(0, queryAt);
  const query = queryAt === -1 ? '' : target.slice(queryAt + 1);

  // The env's boot probe: no auth, no body.
  if (method === 'GET' && path === '/healthz') {
    sendJson(forge, res, 200, { ok: true });
    return;
  }

  // GraphQL at /api/graphql.
  if (path === '/api/graphql') {
    if (!authorized(req)) {
      sendJson(forge, res, 401, { message: 'Requires authentication' });
      return;
    }
    if (method !== 'POST') {
      sendJson(forge, res, 404, { message: 'Not Found' });
      return;
    }
    const raw = await readBody(req);
    let body: unknown;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      sendJson(forge, res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
      return;
    }
    const result = executeGraphQL(forge, body);
    sendJson(forge, res, result.status, result.body);
    return;
  }

  // MCP at /mcp.
  if (path === '/mcp') {
    if (!authorized(req)) {
      sendJson(forge, res, 401, { message: 'Requires authentication' });
      return;
    }
    if (method !== 'POST') {
      sendJson(forge, res, 405, { message: 'Method Not Allowed' });
      return;
    }
    const raw = await readBody(req);
    const result = handleMcp(forge, raw);
    if (result.empty === true) {
      res.writeHead(202, { 'content-length': 0 });
      res.end();
      return;
    }
    sendJson(forge, res, result.status, result.body);
    return;
  }

  // REST v3 under /api/v3.
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    if (!authorized(req)) {
      sendJson(forge, res, 401, { message: 'Requires authentication' });
      return;
    }
    // The hot read: one issue or pull request with no query string. Anything encoded,
    // queried or otherwise unusual falls through to the general router below.
    if (method === 'GET' && query === '') {
      const fast = /^\/api\/v3\/repos\/([^/%]+)\/([^/%]+)\/issues\/(\d+)$/.exec(path);
      if (fast !== null) {
        const repo = forge.getRepo(fast[1]!, fast[2]!);
        if (repo === null) {
          sendJson(forge, res, 404, { message: 'Not Found' });
          return;
        }
        const result = getItemResult(forge, repo, Number(fast[3]));
        sendJson(forge, res, result.status, result.body, {}, result.raw);
        return;
      }
    }
    let body: unknown = undefined;
    let bodyMalformed = false;
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      const raw = await readBody(req);
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          bodyMalformed = true;
        }
      }
    }
    if (bodyMalformed && method !== 'DELETE') {
      sendJson(forge, res, 400, { message: 'Problems parsing JSON' });
      return;
    }
    const segments: string[] = [];
    for (const part of path.slice('/api/v3'.length).split('/')) {
      if (part !== '') segments.push(decodeSegment(part));
    }
    const result: RestResult = routeRest(forge, {
      method,
      segments,
      query: query === '' ? EMPTY_QUERY : new URLSearchParams(query),
      host: req.headers.host ?? 'entry',
      path,
      body,
      bodyMalformed,
    });
    if (result.empty === true) {
      res.writeHead(204, { 'x-github-request-id': forge.nextRequestId() });
      res.end();
      return;
    }
    sendJson(forge, res, result.status, result.body, result.headers ?? {}, result.raw);
    return;
  }

  // Git smart HTTP at /{owner}/{repo}.git/...
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
  if (gitMatch !== null) {
    const owner = decodeSegment(gitMatch[1]!);
    const repoName = decodeSegment(gitMatch[2]!);
    const sub = gitMatch[3] ?? '';
    const repo = forge.getRepo(owner, repoName);
    if (repo === null) {
      sendJson(forge, res, 404, { message: 'Not Found' });
      return;
    }
    const protocolHeader = req.headers['git-protocol'];
    const protocol = Array.isArray(protocolHeader) ? protocolHeader[0] ?? null : protocolHeader ?? null;
    if (method === 'GET' && sub === '/info/refs') {
      const result = infoRefs(repo, queryParam(query, 'service') ?? '', protocol);
      sendBytes(res, result.status, result.contentType, result.body);
      return;
    }
    if (method === 'POST' && sub === '/git-upload-pack') {
      const body = await readBody(req);
      const result = uploadPack(repo, body, protocol);
      sendBytes(res, result.status, result.contentType, result.body);
      return;
    }
    if (method === 'POST' && sub === '/git-receive-pack') {
      const body = await readBody(req);
      const result = receivePack(forge, repo, body);
      sendBytes(res, result.status, result.contentType, result.body);
      return;
    }
    sendJson(forge, res, 404, { message: 'Not Found' });
    return;
  }

  sendJson(forge, res, 404, { message: 'Not Found' });
}
