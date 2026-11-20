// app.ts — the HTTP router: the health probe, REST v3 under /api/v3, GraphQL at /api/graphql,
// MCP at /mcp, and git smart HTTP at /{owner}/{repo}.git, all over one shared in-memory store.
//
// Authentication follows the suite's contract: requests carry "Authorization: Bearer <token>"
// with the token from MAKEFUN_SHOP_TOKEN; a request without that header (or with a different
// token, when one is configured) is refused 401 on the API surfaces.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './store.ts';
import { routeRest, type RestResult } from './rest.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { infoRefs, receivePack, uploadPack } from './git.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** Whether the request carries the viewer's credential. */
function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || header === '') return false;
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (token === '') return true;
  return header === `Bearer ${token}`;
}

/** Answer with a JSON body and the forge's request-id header. */
function sendJson(forge: Forge, res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': forge.nextRequestId(),
    ...headers,
  });
  res.end(text);
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
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const forge = new Forge();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
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
}

/** Route one request to its surface. */
async function dispatch(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    sendJson(forge, res, 400, { message: 'Bad Request' });
    return;
  }
  const path = url.pathname;

  // The env's boot probe: no auth, no body.
  if (method === 'GET' && path === '/healthz') {
    sendJson(forge, res, 200, { ok: true });
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
      const result = infoRefs(repo, url.searchParams.get('service') ?? '', protocol);
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
    const segments = path
      .slice('/api/v3'.length)
      .split('/')
      .filter((segment) => segment !== '')
      .map(decodeSegment);
    const result: RestResult = routeRest(forge, {
      method,
      segments,
      query: url.searchParams,
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
    sendJson(forge, res, result.status, result.body, result.headers ?? {});
    return;
  }

  sendJson(forge, res, 404, { message: 'Not Found' });
}
