// store.ts — the one in-memory store every surface (REST, git smart HTTP, GraphQL, MCP) shares.
//
// Determinism is a hard rule here: no wall clock, no randomness. Timestamps come from a logical
// clock — a fixed base epoch plus a monotonically increasing counter — and every id is a
// sequential counter, so an identical sequence of requests produces identical responses.

import { createHash } from 'node:crypto';
import type { FetchPlan } from './git.ts';

/** The token's owner: every repository in the store belongs to this login. */
export const VIEWER = {
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
  type: 'User',
} as const;

/** The default branch every repository is born pointing at. */
export const DEFAULT_BRANCH = 'main';

/** The all-zero object id git uses for "no such object". */
export const ZERO_OID = '0'.repeat(40);

// ---------------------------------------------------------------- the logical clock

/** Days from the civil date (Howard Hinnant's algorithm): pure arithmetic, no Date object. */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = month > 2 ? month - 3 : month + 9;
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** The civil date for a day count since the epoch (the inverse of daysFromCivil). */
function civilFromDays(days: number): { year: number; month: number; day: number } {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const year = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return { year: month <= 2 ? year + 1 : year, month, day };
}

/** The logical clock's base: 2026-11-14T00:00:00Z, in epoch seconds. */
const BASE_SEC = daysFromCivil(2026, 11, 14) * 86_400;

function pad2(value: number): string {
  return value < 10 ? `0${value}` : `${value}`;
}

/** An ISO-8601 UTC string for `sec` epoch seconds, formatted arithmetically. */
export function isoOfSec(sec: number): string {
  const days = Math.floor(sec / 86_400);
  const rest = sec - days * 86_400;
  const { year, month, day } = civilFromDays(days);
  const hh = Math.floor(rest / 3600);
  const mm = Math.floor((rest - hh * 3600) / 60);
  const ss = rest - hh * 3600 - mm * 60;
  return `${year}-${pad2(month)}-${pad2(day)}T${pad2(hh)}:${pad2(mm)}:${pad2(ss)}Z`;
}

// ---------------------------------------------------------------- records

export interface GitObject {
  type: string;
  data: Buffer;
}

export interface LabelRec {
  name: string;
  color: string;
  description: string | null;
}

export interface CommentRec {
  id: number;
  body: string;
  seq: number;
}

export interface IssueRec {
  kind: 'issue';
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  seq: number;
}

export interface PullRec {
  kind: 'pull';
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  mergeCommitSha: string | null;
  mergedSeq: number | null;
  comments: CommentRec[];
  seq: number;
}

export type ItemRec = IssueRec | PullRec;

export interface RepoRec {
  id: number;
  name: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, LabelRec>;
  items: Map<number, ItemRec>;
  nextNumber: number;
  seq: number;
  packCache: Map<string, FetchPlan>;
  /** Framed ls-refs answers, keyed by the request's argument lines. */
  lsRefsCache: Map<string, Buffer>;
  /** Rendered single-item REST views, keyed by item number, stamped with the forge's store version. */
  itemViewCache: Map<number, { version: number; body: Buffer }>;
}

/**
 * Drop every derived-byte cache of a repository. The fetch plans and ls-refs answers are pure
 * functions of the repository's objects and refs, so every mutation of either calls this.
 */
export function invalidateRepoCaches(repo: RepoRec): void {
  repo.packCache.clear();
  repo.lsRefsCache.clear();
}

// ---------------------------------------------------------------- the forge

/** All mutable state of one forge instance, plus the counters that keep it deterministic. */
export class Forge {
  repos: Map<string, RepoRec>;
  clockSeq: number;
  nextRepoId: number;
  nextItemId: number;
  nextCommentId: number;
  requestSeq: number;
  /**
   * A monotone counter bumped by every mutation that can change a rendered item view (an issue
   * or pull field, its labels, its comment count). Cached views carry the version they were
   * rendered at; a mismatch re-renders. Pure bookkeeping: it never reaches a response.
   */
  storeVersion: number;

  constructor() {
    this.repos = new Map();
    this.clockSeq = 0;
    this.nextRepoId = 1;
    this.nextItemId = 1;
    this.nextCommentId = 1;
    this.requestSeq = 0;
    this.storeVersion = 0;
  }

  /** Record a mutation that can change rendered item views (see storeVersion). */
  touch(): void {
    this.storeVersion += 1;
  }

  /** Advance the logical clock and return the new epoch second. */
  tickSec(): number {
    this.clockSeq += 1;
    return BASE_SEC + this.clockSeq;
  }

  /** Advance the logical clock and return the new timestamp as an ISO string. */
  tickIso(): string {
    return isoOfSec(this.tickSec());
  }

  /** The ISO string for a recorded sequence number, without advancing the clock. */
  isoOfSeq(seq: number): string {
    return isoOfSec(BASE_SEC + seq);
  }

  /** The next X-GitHub-Request-Id value: a deterministic per-request counter. */
  nextRequestId(): string {
    this.requestSeq += 1;
    return `forge-${this.requestSeq.toString(16).padStart(8, '0')}`;
  }

  /** Create a repository for the viewer; null when the name is already taken. */
  createRepo(name: string, priv: boolean, description: string): RepoRec | null {
    if (this.repos.has(name)) return null;
    this.clockSeq += 1;
    const repo: RepoRec = {
      id: this.nextRepoId,
      name,
      private: priv,
      description,
      defaultBranch: DEFAULT_BRANCH,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      items: new Map(),
      nextNumber: 1,
      seq: this.clockSeq,
      packCache: new Map(),
      lsRefsCache: new Map(),
      itemViewCache: new Map(),
    };
    this.nextRepoId += 1;
    this.repos.set(name, repo);
    return repo;
  }

  /** A repository by owner and name; a foreign owner is indistinguishable from a missing repo. */
  getRepo(owner: string, name: string): RepoRec | null {
    if (owner !== VIEWER.login) return null;
    return this.repos.get(name) ?? null;
  }

  /** Delete a repository; false when it does not exist under that owner. */
  deleteRepo(owner: string, name: string): boolean {
    if (owner !== VIEWER.login) return false;
    return this.repos.delete(name);
  }

  /** Every repository, in creation order. */
  listRepos(): RepoRec[] {
    return [...this.repos.values()].sort((a, b) => a.id - b.id);
  }

  /** Create an issue on a repository (labels are validated by the caller). */
  createIssue(repo: RepoRec, title: string, body: string, labels: string[]): IssueRec {
    this.clockSeq += 1;
    const issue: IssueRec = {
      kind: 'issue',
      number: repo.nextNumber,
      id: this.nextItemId,
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      seq: this.clockSeq,
    };
    repo.nextNumber += 1;
    this.nextItemId += 1;
    repo.items.set(issue.number, issue);
    return issue;
  }

  /** Create a pull request, snapshotting the two branch tips as they are now. */
  createPull(repo: RepoRec, title: string, body: string, headRef: string, baseRef: string, headSha: string, baseSha: string): PullRec {
    this.clockSeq += 1;
    const pull: PullRec = {
      kind: 'pull',
      number: repo.nextNumber,
      id: this.nextItemId,
      title,
      body,
      state: 'open',
      merged: false,
      headRef,
      baseRef,
      headSha,
      baseSha,
      mergeCommitSha: null,
      mergedSeq: null,
      comments: [],
      seq: this.clockSeq,
    };
    repo.nextNumber += 1;
    this.nextItemId += 1;
    repo.items.set(pull.number, pull);
    return pull;
  }

  /** Add a comment to an issue or pull request. */
  addComment(item: IssueRec | PullRec, body: string): CommentRec {
    this.clockSeq += 1;
    const comment: CommentRec = { id: this.nextCommentId, body, seq: this.clockSeq };
    this.nextCommentId += 1;
    item.comments.push(comment);
    this.touch();
    return comment;
  }
}

// ---------------------------------------------------------------- shared views

/** The viewer's REST object: one shared instance (views are only ever serialized, never mutated). */
const USER_VIEW: Record<string, unknown> = { login: VIEWER.login, id: VIEWER.id, type: VIEWER.type, name: VIEWER.name, email: VIEWER.email };

/** The viewer's REST object (also the shape of every `user` field). */
export function userView(): Record<string, unknown> {
  return USER_VIEW;
}

/** The REST repository object. */
export function repoView(forge: Forge, repo: RepoRec): Record<string, unknown> {
  const timestamp = forge.isoOfSeq(repo.seq);
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${VIEWER.login}/${repo.name}`,
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner: userView(),
    created_at: timestamp,
    updated_at: timestamp,
  };
}

/** The REST label object. */
export function labelView(label: LabelRec): Record<string, unknown> {
  return { name: label.name, color: label.color, description: label.description, default: false };
}

/** The REST issue object. */
export function issueView(forge: Forge, repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  const timestamp = forge.isoOfSeq(issue.seq);
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label !== undefined ? labelView(label) : { name, color: 'ededed', description: null, default: false };
    }),
    user: userView(),
    comments: issue.comments.length,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

/** The REST pull request object. */
export function pullView(forge: Forge, pull: PullRec): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${VIEWER.login}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${VIEWER.login}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedSeq === null ? null : forge.isoOfSeq(pull.mergedSeq),
    merge_commit_sha: pull.mergeCommitSha,
    user: userView(),
    created_at: forge.isoOfSeq(pull.seq),
    updated_at: forge.isoOfSeq(pull.mergedSeq ?? pull.seq),
  };
}

/** The REST comment object. */
export function commentView(forge: Forge, comment: CommentRec): Record<string, unknown> {
  const timestamp = forge.isoOfSeq(comment.seq);
  return {
    id: comment.id,
    body: comment.body,
    user: userView(),
    created_at: timestamp,
    updated_at: timestamp,
  };
}

/** Comments live on both issues and pull requests through this accessor. */
export function commentsOf(item: ItemRec): CommentRec[] {
  return item.comments;
}

/** A GraphQL node id: opaque, stable, and resolvable back to its object. */
export function globalId(type: string, ...parts: Array<string | number>): string {
  return Buffer.from(`${type}:${parts.join(':')}`, 'utf8').toString('base64');
}

/** The SHA-1 of a byte string, hex (used for cache keys, never for git objects). */
export function sha1Hex(data: Buffer | string): string {
  return createHash('sha1').update(data).digest('hex');
}
