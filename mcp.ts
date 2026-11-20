// mcp.ts — the Model Context Protocol endpoint: JSON-RPC 2.0 over POST, speaking both the
// 2026-07-28 revision (server/discover, no handshake) and the legacy initialize handshake.
// The tools act on the same store as REST, so objects created here read back identically there.

import { issueView, pullView, repoView, type Forge, type IssueRec } from './store.ts';
import { branchTip, mergePull } from './rest.ts';

const SERVER_INFO = { name: 'github-forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

/** The tools/list answer: a module constant, so two calls serialize byte for byte identically. */
const TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by its owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all (default open).' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request into its base branch (squash).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
] as const;

interface JsonRpcRequest {
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface McpResult {
  status: number;
  body: unknown;
  /** True when the request was a notification: answer 202 with no body. */
  empty?: boolean;
}

function rpcResult(id: string | number | null, result: unknown): McpResult {
  return { status: 200, body: { jsonrpc: '2.0', id, result } };
}

function rpcError(id: string | number | null, code: number, message: string): McpResult {
  return { status: 200, body: { jsonrpc: '2.0', id, error: { code, message } } };
}

function toolSuccess(view: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(view) }],
    structuredContent: view,
    isError: false,
  };
}

function toolFailure(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

/** The required properties of one tool, from the constant schema above. */
function requiredArgs(toolName: string): string[] {
  const tool = TOOLS.find((candidate) => candidate.name === toolName);
  if (tool === undefined) return [];
  return [...tool.inputSchema.required];
}

/** Run one tool against the store; the tool result view, or null for an unknown tool. */
function callTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> | null {
  switch (name) {
    case 'create_repo': {
      const repoName = typeof args.name === 'string' ? args.name : '';
      const repo = forge.createRepo(repoName, args.private === true, typeof args.description === 'string' ? args.description : '');
      if (repo === null) return toolFailure(`a repository named ${repoName} already exists`);
      return toolSuccess(repoView(forge, repo));
    }
    case 'get_repo': {
      const repo = forge.getRepo(String(args.owner ?? ''), String(args.repo ?? ''));
      if (repo === null) return toolFailure('repository not found');
      return toolSuccess(repoView(forge, repo));
    }
    case 'create_issue': {
      const repo = forge.getRepo(String(args.owner ?? ''), String(args.repo ?? ''));
      if (repo === null) return toolFailure('repository not found');
      const issue = forge.createIssue(repo, String(args.title ?? ''), typeof args.body === 'string' ? args.body : '', []);
      return toolSuccess(issueView(forge, repo, issue));
    }
    case 'list_issues': {
      const repo = forge.getRepo(String(args.owner ?? ''), String(args.repo ?? ''));
      if (repo === null) return toolFailure('repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = [...repo.items.values()]
        .filter((item) => item.kind === 'issue')
        .filter((item) => state === 'all' || item.state === state)
        .sort((a, b) => a.seq - b.seq)
        .map((item) => issueView(forge, repo, item as IssueRec));
      return toolSuccess(issues);
    }
    case 'create_pull_request': {
      const repo = forge.getRepo(String(args.owner ?? ''), String(args.repo ?? ''));
      if (repo === null) return toolFailure('repository not found');
      const head = String(args.head ?? '');
      const base = String(args.base ?? '');
      const headSha = branchTip(repo, head);
      const baseSha = branchTip(repo, base);
      if (headSha === null || baseSha === null) return toolFailure('head or base branch not found');
      const pull = forge.createPull(repo, String(args.title ?? ''), typeof args.body === 'string' ? args.body : '', head, base, headSha, baseSha);
      return toolSuccess(pullView(forge, pull));
    }
    case 'merge_pull_request': {
      const repo = forge.getRepo(String(args.owner ?? ''), String(args.repo ?? ''));
      if (repo === null) return toolFailure('repository not found');
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const item = Number.isInteger(number) ? repo.items.get(number) : undefined;
      if (item === undefined || item.kind !== 'pull') return toolFailure('pull request not found');
      if (item.merged) return toolSuccess({ sha: item.mergeCommitSha, merged: true, message: 'Pull Request successfully merged' });
      const attempt = mergePull(forge, repo, item, 'squash');
      if (!attempt.ok || attempt.sha === undefined) return toolFailure('pull request is not mergeable: the head and base branches conflict');
      return toolSuccess({ sha: attempt.sha, merged: true, message: 'Pull Request successfully merged' });
    }
    default:
      return null;
  }
}

/** Handle one JSON-RPC request object. */
function handleRequest(forge: Forge, request: JsonRpcRequest): McpResult {
  const id = request.id ?? null;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (typeof request.params === 'object' && request.params !== null ? request.params : {}) as Record<string, unknown>;

  if (method === 'server/discover') {
    return rpcResult(id, {
      resultType: 'complete',
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
    });
  }
  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const protocolVersion = SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
    return rpcResult(id, { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO });
  }
  if (method === 'ping') return rpcResult(id, {});
  if (method === 'tools/list') return rpcResult(id, { tools: TOOLS });
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
    if (!TOOLS.some((tool) => tool.name === name)) {
      return rpcError(id, -32602, `Unknown tool: ${name}`);
    }
    const missing = requiredArgs(name).filter((arg) => args[arg] === undefined || args[arg] === null || args[arg] === '');
    if (missing.length > 0) {
      return rpcError(id, -32602, `Missing required argument: ${missing.join(', ')}`);
    }
    const view = callTool(forge, name, args);
    if (view === null) return rpcError(id, -32602, `Unknown tool: ${name}`);
    return rpcResult(id, view);
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}

/**
 * Handle one POST /mcp body. Authentication has already been decided by the caller.
 * A body that is not JSON answers HTTP 400 with a -32700 parse error, per the transport.
 */
export function handleMcp(forge: Forge, rawBody: Buffer): McpResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (Array.isArray(parsed)) {
    const responses = parsed
      .map((entry) => handleRequest(forge, (entry ?? {}) as JsonRpcRequest))
      .filter((response) => response.empty !== true)
      .map((response) => response.body);
    return { status: 200, body: responses };
  }
  const request = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as JsonRpcRequest;
  // A message with no id is a notification: acknowledge it with an empty 202.
  if (request.id === undefined && typeof request.method === 'string' && request.method.startsWith('notifications/')) {
    return { status: 202, body: null, empty: true };
  }
  return handleRequest(forge, request);
}
