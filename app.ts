// app.ts — the HTTP router: the health probe, REST v3 under /api/v3, GraphQL at /api/graphql,
// MCP at /mcp, and git smart HTTP at /{owner}/{repo}.git, all over one shared in-memory store.
//
// Authentication follows the suite's contract: requests carry "Authorization: Bearer <token>"
// with the token from MAKEFUN_SHOP_TOKEN; a request without that header (or with a different
// token, when one is configured) is refused 401 on the API surfaces.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
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

/** Whether the request carries the viewer's credential. */
function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || header === '') return false;
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (token === '') return true;
  if (authHeaderCache === null || authHeaderCache.token !== token) {
    authHeaderCache = { token, header: `Bearer ${token}` };
  }
  return header === authHeaderCache.header;
}

/** Answer with a JSON body and the forge's request-id header. */
function sendJson(forge: Forge, res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}, raw?: Buffer): void {
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
function sendBytes(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

/** Read a request body to the end. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
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

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const forge = new Forge();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async (): Promise<void> => {
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
    })();
  });
  // Small request/response exchanges dominate the workload: never let Nagle hold a reply back.
  server.on('connection', (socket) => {
    socket.setNoDelay(true);
  });
  return server;
}

/** Route one request to its surface. */
async function dispatch(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
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
