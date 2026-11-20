// rest.ts — the REST v3 surface: the API root, meta, the viewer, repositories, branches and git
// refs, the contents API (which commits into the git store), labels, issues and comments, and
// pull requests with a squash merge built on the git engine's three-way merge.

import {
  VIEWER,
  commentsOf,
  commentView,
  isoOfSec,
  issueView,
  labelView,
  pullView,
  repoView,
  userView,
  type Forge,
  type IssueRec,
  type PullRec,
  type RepoRec,
} from './store.ts';
import {
  buildCommit,
  buildTreeFromFlat,
  commitTree,
  diffFlat,
  flattenTree,
  identityLine,
  mergeBase,
  mergeTrees,
  parseCommit,
  parseTree,
  peelToCommit,
  storeObject,
} from './git.ts';

export interface RestResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  /** True for a 204: no body at all. */
  empty?: boolean;
}

function ok(status: number, body: unknown, headers?: Record<string, string>): RestResult {
  return { status, body, headers };
}

function fail(status: number, message: string): RestResult {
  return { status, body: { message } };
}

const NOT_FOUND: RestResult = { status: 404, body: { message: 'Not Found' } };

/** A branch name from a ref-ish input: strips a leading refs/heads/ or an owner: label prefix. */
export function branchNameOf(value: string): string {
  let name = value;
  if (name.startsWith('refs/heads/')) name = name.slice('refs/heads/'.length);
  const colon = name.indexOf(':');
  if (colon !== -1 && !name.slice(0, colon).includes('/')) name = name.slice(colon + 1);
  return name;
}

/** Resolve a ref-ish value (full ref, branch name, tag name, or sha) to a commit sha. */
export function resolveRef(repo: RepoRec, value: string): string | null {
  const candidates = [value, `refs/heads/${branchNameOf(value)}`, `refs/tags/${value}`];
  for (const candidate of candidates) {
    const sha = repo.refs.get(candidate);
    if (sha !== undefined) return peelToCommit(repo, sha);
  }
  if (/^[0-9a-f]{40}$/.test(value)) {
    const commit = peelToCommit(repo, value);
    if (commit !== null) return commit;
  }
  return null;
}

/** The tip commit of a branch, or null when the branch does not exist. */
export function branchTip(repo: RepoRec, branch: string): string | null {
  const sha = repo.refs.get(`refs/heads/${branch}`);
  return sha === undefined ? null : sha;
}

/** Slice a list by page/per_page and build the Link header for the next page, when there is one. */
export function paginate<T>(items: T[], query: URLSearchParams, host: string, path: string): { page: T[]; headers: Record<string, string> } {
  const perPageRaw = Number(query.get('per_page') ?? '30');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.trunc(perPageRaw)) : 30;
  const pageRaw = Number(query.get('page') ?? '1');
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < items.length) {
    const params = new URLSearchParams(query);
    params.set('per_page', `${perPage}`);
    params.set('page', `${page + 1}`);
    headers.link = `<http://${host}${path}?${params.toString()}>; rel="next"`;
  }
  return { page: slice, headers };
}

// ---------------------------------------------------------------- pull request machinery

export interface MergeAttempt {
  ok: boolean;
  sha?: string;
  conflict?: boolean;
}

/** Merge a pull request into its base branch (squash unless the method asks for a merge commit). */
export function mergePull(forge: Forge, repo: RepoRec, pull: PullRec, method: string): MergeAttempt {
  const baseTip = branchTip(repo, pull.baseRef);
  const headTip = branchTip(repo, pull.headRef) ?? pull.headSha;
  if (baseTip === null) return { ok: false, conflict: true };
  const base = mergeBase(repo, baseTip, headTip);
  const emptyTree = storeObject(repo, 'tree', Buffer.alloc(0));
  const baseTree = base === null ? emptyTree : commitTree(repo, base) ?? emptyTree;
  const oursTree = commitTree(repo, baseTip) ?? emptyTree;
  const theirsTree = commitTree(repo, headTip) ?? emptyTree;
  const outcome = mergeTrees(repo, baseTree, oursTree, theirsTree);
  if (!outcome.ok || outcome.treeSha === null) return { ok: false, conflict: true };
  const sec = forge.tickSec();
  const line = identityLine(sec);
  let message = `${pull.title} (#${pull.number})`;
  if (pull.body !== '') message += `\n\n${pull.body}`;
  const parents = method === 'merge' ? [baseTip, headTip] : [baseTip];
  const commitData = buildCommit(outcome.treeSha, parents, line, line, `${message}\n`);
  const sha = storeObject(repo, 'commit', commitData);
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  repo.packCache.clear();
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeCommitSha = sha;
  pull.mergedSeq = forge.clockSeq;
  return { ok: true, sha };
}

/** The changed files of a pull request, diffed from its merge-base to its head tip. */
export function pullFiles(repo: RepoRec, pull: PullRec): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
  const baseTip = branchTip(repo, pull.baseRef) ?? pull.baseSha;
  const headTip = branchTip(repo, pull.headRef) ?? pull.headSha;
  const base = mergeBase(repo, baseTip, headTip);
  const headTree = commitTree(repo, headTip);
  const baseFlat = base === null ? new Map<string, { mode: string; name: string; sha: string }>() : flattenTree(repo, commitTree(repo, base) ?? '');
  const headFlat = headTree === null ? new Map<string, { mode: string; name: string; sha: string }>() : flattenTree(repo, headTree);
  return diffFlat(repo, baseFlat, headFlat);
}

// ---------------------------------------------------------------- contents machinery

interface ContentsWrite {
  status: number;
  commitSha: string;
  blobSha: string;
  created: boolean;
}

/** Write one file into a branch, creating the branch (and the repo's first commit) when needed. */
function writeContents(forge: Forge, repo: RepoRec, branch: string, path: string, content: Buffer, message: string, expectedSha: string | null): ContentsWrite | { error: RestResult } {
  const refName = `refs/heads/${branch}`;
  let tip = repo.refs.get(refName);
  if (tip === undefined && branch !== repo.defaultBranch) {
    // A contents write names a branch the repository does not have: it forks the default branch.
    tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  }
  const tipCommit = tip === undefined ? null : peelToCommit(repo, tip);
  const currentTree = tipCommit === null ? null : commitTree(repo, tipCommit);
  const flat = currentTree === null ? new Map<string, { mode: string; name: string; sha: string }>() : flattenTree(repo, currentTree);
  const existing = flat.get(path);
  if (expectedSha !== null && (existing === undefined || existing.sha !== expectedSha)) {
    return { error: fail(409, `the sha provided does not match the current blob at ${path}`) };
  }
  if (expectedSha === null && existing !== undefined && tipCommit !== null) {
    return { error: fail(422, `the sha of the existing blob at ${path} is required to update it`) };
  }
  const blobSha = storeObject(repo, 'blob', content);
  flat.set(path, { mode: '100644', name: path.split('/').pop()!, sha: blobSha });
  const treeSha = buildTreeFromFlat(repo, flat);
  const sec = forge.tickSec();
  const line = identityLine(sec);
  const parents = tipCommit === null ? [] : [tipCommit];
  const commitData = buildCommit(treeSha, parents, line, line, `${message}\n`);
  const commitSha = storeObject(repo, 'commit', commitData);
  repo.refs.set(refName, commitSha);
  repo.packCache.clear();
  return { status: existing === undefined ? 201 : 200, commitSha, blobSha, created: existing === undefined };
}

/** Delete one file from a branch; null when the file is not there. */
function deleteContents(forge: Forge, repo: RepoRec, branch: string, path: string, message: string, expectedSha: string | null): { commitSha: string } | { error: RestResult } | null {
  const refName = `refs/heads/${branch}`;
  const tip = repo.refs.get(refName);
  if (tip === undefined) return null;
  const tipCommit = peelToCommit(repo, tip);
  if (tipCommit === null) return null;
  const tree = commitTree(repo, tipCommit);
  if (tree === null) return null;
  const flat = flattenTree(repo, tree);
  const existing = flat.get(path);
  if (existing === undefined) return null;
  if (expectedSha !== null && existing.sha !== expectedSha) {
    return { error: fail(409, `the sha provided does not match the current blob at ${path}`) };
  }
  flat.delete(path);
  const treeSha = buildTreeFromFlat(repo, flat);
  const sec = forge.tickSec();
  const line = identityLine(sec);
  const commitData = buildCommit(treeSha, [tipCommit], line, line, `${message}\n`);
  const commitSha = storeObject(repo, 'commit', commitData);
  repo.refs.set(refName, commitSha);
  repo.packCache.clear();
  return { commitSha };
}

// ---------------------------------------------------------------- the router

export interface RestRequest {
  method: string;
  /** Path segments after /api/v3, decoded. */
  segments: string[];
  query: URLSearchParams;
  host: string;
  path: string;
  body: unknown;
  bodyMalformed: boolean;
}

/** Route one REST request. Authentication has already been decided by the caller. */
export function routeRest(forge: Forge, request: RestRequest): RestResult {
  const { method, segments, query } = request;
  const seg = (index: number): string => segments[index] ?? '';

  // The root, meta, and the viewer.
  if (segments.length === 0) {
    if (method !== 'GET') return NOT_FOUND;
    return ok(200, { current_user_url: '/api/v3/user', repository_url: '/api/v3/repos/{owner}/{repo}', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
  }
  if (segments.length === 1 && seg(0) === 'meta') {
    if (method !== 'GET') return NOT_FOUND;
    return ok(200, { installed_version: '1.0.0', verifiable_password_authentication: false });
  }
  if (segments.length === 1 && seg(0) === 'user') {
    if (method !== 'GET') return NOT_FOUND;
    return ok(200, userView());
  }
  if (segments.length === 2 && seg(0) === 'user' && seg(1) === 'repos') {
    if (method === 'GET') {
      const { page, headers } = paginate(forge.listRepos().map((repo) => repoView(forge, repo)), query, request.host, request.path);
      return ok(200, page, headers);
    }
    if (method === 'POST') {
      if (request.bodyMalformed) return fail(400, 'Problems parsing JSON');
      const body = asRecord(request.body);
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '') return fail(422, 'Repository creation failed: name is required');
      const repo = forge.createRepo(name, body.private === true, typeof body.description === 'string' ? body.description : '');
      if (repo === null) return fail(422, 'Repository creation failed: name already exists on this account');
      return ok(201, repoView(forge, repo));
    }
    return NOT_FOUND;
  }

  if (seg(0) !== 'repos' || segments.length < 3) return NOT_FOUND;
  const owner = seg(1);
  const repoName = seg(2);
  const repo = forge.getRepo(owner, repoName);
  if (repo === null) return NOT_FOUND;
  const rest = segments.slice(3);

  // The repository itself.
  if (rest.length === 0) {
    if (method === 'GET') return ok(200, repoView(forge, repo));
    if (method === 'PATCH') {
      if (request.bodyMalformed) return fail(400, 'Problems parsing JSON');
      const body = asRecord(request.body);
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.private = body.private;
      return ok(200, repoView(forge, repo));
    }
    if (method === 'DELETE') {
      forge.deleteRepo(owner, repoName);
      return { status: 204, body: null, empty: true };
    }
    return NOT_FOUND;
  }

  // Branches.
  if (rest[0] === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const branches = [...repo.refs.entries()]
        .filter(([name]) => name.startsWith('refs/heads/'))
        .map(([name, sha]) => ({ name: name.slice('refs/heads/'.length), commit: { sha }, protected: false }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      return ok(200, branches);
    }
    if (rest.length >= 2 && method === 'GET') {
      const branch = rest.slice(1).join('/');
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (sha === undefined) return NOT_FOUND;
      return ok(200, { name: branch, commit: { sha }, protected: false });
    }
    return NOT_FOUND;
  }

  // Git refs (the Git Data API).
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (rest.length === 2) {
      if (method === 'GET') {
        const refs = [...repo.refs.entries()].map(([ref, sha]) => ({ ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } }));
        return ok(200, refs);
      }
      if (method === 'POST') {
        if (request.bodyMalformed) return fail(400, 'Problems parsing JSON');
        const body = asRecord(request.body);
        const ref = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (ref === '' || !repo.objects.has(sha)) return fail(422, 'Validation Failed: ref and a known sha are required');
        repo.refs.set(ref, sha);
        repo.packCache.clear();
        return ok(201, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
      }
      return NOT_FOUND;
    }
    if (method === 'GET') {
      const ref = `refs/${rest.slice(2).join('/')}`;
      const sha = repo.refs.get(ref);
      if (sha === undefined) return NOT_FOUND;
      return ok(200, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
    }
    return NOT_FOUND;
  }

  // Commits.
  if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
    const shaParam = query.get('sha');
    const start = shaParam !== null && shaParam !== '' ? resolveRef(repo, shaParam) : branchTip(repo, repo.defaultBranch);
    if (start === null) return ok(200, []);
    const commits: Array<Record<string, unknown>> = [];
    let current: string | null = start;
    const seen = new Set<string>();
    while (current !== null && !seen.has(current) && commits.length < 10_000) {
      seen.add(current);
      const object = repo.objects.get(current);
      if (object === undefined || object.type !== 'commit') break;
      const info = parseCommit(object.data);
      const date = isoOfSec(info.time > 0 ? info.time : 0);
      commits.push({
        sha: current,
        commit: {
          message: info.message.replace(/\n$/, ''),
          tree: { sha: info.tree },
          author: { name: VIEWER.name, email: VIEWER.email, date },
          committer: { name: VIEWER.name, email: VIEWER.email, date },
        },
        parents: info.parents.map((parent) => ({ sha: parent })),
      });
      current = info.parents[0] ?? null;
    }
    const { page, headers } = paginate(commits, query, request.host, request.path);
    return ok(200, page, headers);
  }

  // Contents.
  if (rest[0] === 'contents') {
    const path = rest.slice(1).join('/');
    if (method === 'PUT') {
      if (request.bodyMalformed) return fail(400, 'Problems parsing JSON');
      const body = asRecord(request.body);
      const message = typeof body.message === 'string' ? body.message : 'update';
      const content = typeof body.content === 'string' ? Buffer.from(body.content.replace(/\s+/g, ''), 'base64') : Buffer.alloc(0);
      const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
      const expectedSha = typeof body.sha === 'string' ? body.sha : null;
      const result = writeContents(forge, repo, branch, path, content, message, expectedSha);
      if ('error' in result) return result.error;
      const blob = repo.objects.get(result.blobSha);
      return ok(result.status, {
        content: {
          name: path.split('/').pop() ?? path,
          path,
          sha: result.blobSha,
          size: blob?.data.length ?? 0,
          type: 'file',
          encoding: 'base64',
          content: content.toString('base64'),
        },
        commit: { sha: result.commitSha, message },
      });
    }
    if (method === 'GET') {
      const refParam = query.get('ref');
      const commitSha = refParam !== null && refParam !== '' ? resolveRef(repo, refParam) : branchTip(repo, repo.defaultBranch);
      if (commitSha === null) return NOT_FOUND;
      const tree = commitTree(repo, commitSha);
      if (tree === null) return NOT_FOUND;
      if (path === '') {
        return ok(200, dirListing(repo, tree, ''));
      }
      const located = locatePath(repo, tree, path);
      if (located === null) return NOT_FOUND;
      if (located.kind === 'dir') return ok(200, dirListing(repo, located.sha, path));
      const blob = repo.objects.get(located.sha);
      if (blob === undefined) return NOT_FOUND;
      return ok(200, {
        type: 'file',
        name: path.split('/').pop() ?? path,
        path,
        sha: located.sha,
        size: blob.data.length,
        encoding: 'base64',
        content: blob.data.toString('base64'),
      });
    }
    if (method === 'DELETE') {
      if (request.bodyMalformed) return fail(400, 'Problems parsing JSON');
      const body = asRecord(request.body);
      const message = typeof body.message === 'string' ? body.message : 'delete';
      const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
      const expectedSha = typeof body.sha === 'string' ? body.sha : null;
      const result = deleteContents(forge, repo, branch, path, message, expectedSha);
      if (result === null) return NOT_FOUND;
      if ('error' in result) return result.error;
      return ok(200, { content: null, commit: { sha: result.commitSha, message } });
    }
    return NOT_FOUND;
  }

  // Labels.
  if (rest[0] === 'labels') {
    if (rest.length === 1 && method === 'POST') {
      if (request.bodyMalformed) return fail(400, 'Problems parsing JSON');
      const body = asRecord(request.body);
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '') return fail(422, 'Validation Failed: name is required');
      if (repo.labels.has(name)) return fail(422, 'Validation Failed: name has already been taken');
      const label = { name, color: typeof body.color === 'string' ? body.color.replace(/^#/, '') : 'ededed', description: typeof body.description === 'string' ? body.description : null };
      repo.labels.set(name, label);
      return ok(201, labelView(label));
    }
    if (rest.length === 1 && method === 'GET') {
      return ok(200, [...repo.labels.values()].map(labelView));
    }
    return NOT_FOUND;
  }

  // Issues and their comments.
  if (rest[0] === 'issues') {
    if (rest.length === 1) {
      if (method === 'POST') {
        if (request.bodyMalformed) return fail(400, 'Problems parsing JSON');
        const body = asRecord(request.body);
        const title = typeof body.title === 'string' ? body.title : '';
        if (title === '') return fail(422, 'Validation Failed: title is required');
        const labelNames = labelNamesOf(body.labels);
        for (const name of labelNames) {
          if (!repo.labels.has(name)) return fail(422, `Validation Failed: label "${name}" does not exist`);
        }
        const issue = forge.createIssue(repo, title, typeof body.body === 'string' ? body.body : '', labelNames);
        return ok(201, issueView(forge, repo, issue));
      }
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        const labelFilter = (query.get('labels') ?? '').split(',').map((name) => name.trim()).filter((name) => name !== '');
        let issues = [...repo.items.values()].filter((item): item is IssueRec => item.kind === 'issue');
        if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
        if (labelFilter.length > 0) issues = issues.filter((issue) => labelFilter.every((name) => issue.labels.includes(name)));
        const direction = query.get('direction') ?? 'desc';
        issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
        const views = issues.map((issue) => issueView(forge, repo, issue));
        const { page, headers } = paginate(views, query, request.host, request.path);
        return ok(200, page, headers);
      }
      return NOT_FOUND;
    }
    const number = Number(rest[1]);
    if (!Number.isInteger(number)) return NOT_FOUND;
    const item = repo.items.get(number);
    if (rest.length === 2) {
      if (item === undefined) return NOT_FOUND;
      if (method === 'GET') {
        return ok(200, item.kind === 'issue' ? issueView(forge, repo, item) : pullView(forge, item));
      }
      if (method === 'PATCH' && item.kind === 'issue') {
        if (request.bodyMalformed) return fail(400, 'Problems parsing JSON');
        const body = asRecord(request.body);
        if (typeof body.title === 'string') item.title = body.title;
        if (typeof body.body === 'string') item.body = body.body;
        if (body.state === 'open' || body.state === 'closed') item.state = body.state;
        if (body.labels !== undefined) {
          const labelNames = labelNamesOf(body.labels);
          for (const name of labelNames) if (!repo.labels.has(name)) return fail(422, `Validation Failed: label "${name}" does not exist`);
          item.labels = labelNames;
        }
        return ok(200, issueView(forge, repo, item));
      }
      return NOT_FOUND;
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (item === undefined) return NOT_FOUND;
      if (method === 'POST') {
        if (request.bodyMalformed) return fail(400, 'Problems parsing JSON');
        const body = asRecord(request.body);
        const text = typeof body.body === 'string' ? body.body : '';
        if (text === '') return fail(422, 'Validation Failed: body is required');
        const comment = forge.addComment(item, text);
        return ok(201, commentView(forge, comment));
      }
      if (method === 'GET') {
        const views = commentsOf(item).map((comment) => commentView(forge, comment));
        const { page, headers } = paginate(views, query, request.host, request.path);
        return ok(200, page, headers);
      }
      return NOT_FOUND;
    }
    return NOT_FOUND;
  }

  // Pull requests.
  if (rest[0] === 'pulls') {
    if (rest.length === 1) {
      if (method === 'POST') {
        if (request.bodyMalformed) return fail(400, 'Problems parsing JSON');
        const body = asRecord(request.body);
        const title = typeof body.title === 'string' ? body.title : '';
        const head = typeof body.head === 'string' ? branchNameOf(body.head) : '';
        const base = typeof body.base === 'string' ? branchNameOf(body.base) : '';
        if (title === '' || head === '' || base === '') return fail(422, 'Validation Failed: title, head and base are required');
        const headSha = branchTip(repo, head);
        const baseSha = branchTip(repo, base);
        if (headSha === null || baseSha === null) return fail(422, 'Validation Failed: head or base branch does not exist');
        const pull = forge.createPull(repo, title, typeof body.body === 'string' ? body.body : '', head, base, headSha, baseSha);
        return ok(201, pullView(forge, pull));
      }
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        let pulls = [...repo.items.values()].filter((item): item is PullRec => item.kind === 'pull');
        if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
        else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
        const direction = query.get('direction') ?? 'desc';
        pulls.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
        const views = pulls.map((pull) => pullView(forge, pull));
        const { page, headers } = paginate(views, query, request.host, request.path);
        return ok(200, page, headers);
      }
      return NOT_FOUND;
    }
    const number = Number(rest[1]);
    if (!Number.isInteger(number)) return NOT_FOUND;
    const item = repo.items.get(number);
    const pull = item !== undefined && item.kind === 'pull' ? item : null;
    if (rest.length === 2 && method === 'GET') {
      if (pull === null) return NOT_FOUND;
      return ok(200, pullView(forge, pull));
    }
    if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
      if (pull === null) return NOT_FOUND;
      return ok(200, pullFiles(repo, pull));
    }
    if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
      if (pull === null) return NOT_FOUND;
      if (request.bodyMalformed) return fail(400, 'Problems parsing JSON');
      if (pull.merged) return fail(405, 'Pull Request is not mergeable: it has already been merged');
      if (pull.state !== 'open') return fail(405, 'Pull Request is not mergeable: it is closed');
      const body = asRecord(request.body);
      const method2 = typeof body.merge_method === 'string' ? body.merge_method : 'squash';
      const attempt = mergePull(forge, repo, pull, method2);
      if (!attempt.ok || attempt.sha === undefined) return fail(405, 'Pull Request is not mergeable: the head and base branches conflict');
      return ok(200, { sha: attempt.sha, merged: true, message: 'Pull Request successfully merged' });
    }
    return NOT_FOUND;
  }

  return NOT_FOUND;
}

/** A JSON body as a record (anything else reads as empty). */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Label names out of a create/update payload: strings or {name} objects. */
function labelNamesOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') names.push(entry);
    else if (typeof entry === 'object' && entry !== null && typeof (entry as { name?: unknown }).name === 'string') names.push((entry as { name: string }).name);
  }
  return names;
}

/** Locate a path inside a tree: a file, a directory, or null. */
function locatePath(repo: RepoRec, rootTree: string, path: string): { kind: 'file' | 'dir'; sha: string } | null {
  const parts = path.split('/').filter((part) => part !== '');
  let tree = rootTree;
  for (let i = 0; i < parts.length; i += 1) {
    const object = repo.objects.get(tree);
    if (object === undefined || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === parts[i]);
    if (entry === undefined) return null;
    if (i === parts.length - 1) return entry.mode === '40000' ? { kind: 'dir', sha: entry.sha } : { kind: 'file', sha: entry.sha };
    if (entry.mode !== '40000') return null;
    tree = entry.sha;
  }
  return { kind: 'dir', sha: rootTree };
}

/** A directory listing in the contents API's shape. */
function dirListing(repo: RepoRec, treeSha: string, basePath: string): Array<Record<string, unknown>> {
  const object = repo.objects.get(treeSha);
  if (object === undefined || object.type !== 'tree') return [];
  return parseTree(object.data).map((entry) => ({
    name: entry.name,
    path: basePath === '' ? entry.name : `${basePath}/${entry.name}`,
    sha: entry.sha,
    size: entry.mode === '40000' ? 0 : repo.objects.get(entry.sha)?.data.length ?? 0,
    type: entry.mode === '40000' ? 'dir' : 'file',
  }));
}
