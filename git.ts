// git.ts — the git object model and the smart-HTTP protocol, implemented from scratch on the
// Node standard library: SHA-1 object ids, zlib (de)compression, packfile reading (with ofs-delta
// and ref-delta application) and writing (full objects only), pkt-line framing, protocol v2
// ls-refs/fetch with a v0 fallback, and a v0 receive-pack with fast-forward enforcement.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { VIEWER, ZERO_OID, invalidateRepoCaches, type Forge, type GitObject, type RepoRec } from './store.ts';

// ---------------------------------------------------------------- object primitives

/** A git object id: SHA-1 over "<type> <length>\0" + data. */
export function hashObject(type: string, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

/** Store an object in a repository (deduplicated by id); returns its id. */
export function storeObject(repo: RepoRec, type: string, data: Buffer): string {
  const sha = hashObject(type, data);
  if (!repo.objects.has(sha)) repo.objects.set(sha, { type, data });
  return sha;
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  message: string;
  /** The committer timestamp, epoch seconds (0 when unparseable). */
  time: number;
}

/** Parse a commit object's headers and message. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const headEnd = split === -1 ? text.length : split;
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = ZERO_OID;
  const parents: string[] = [];
  let time = 0;
  let pos = 0;
  while (pos < headEnd) {
    let nl = text.indexOf('\n', pos);
    if (nl === -1 || nl > headEnd) nl = headEnd;
    if (text.startsWith('tree ', pos)) {
      tree = text.slice(pos + 5, nl).trim();
    } else if (text.startsWith('parent ', pos)) {
      parents.push(text.slice(pos + 7, nl).trim());
    } else if (text.startsWith('committer ', pos)) {
      // The line ends "<timestamp> <sign><tz>": the timestamp sits between the last two spaces,
      // and the final token must be a signed four-digit zone, as the timestamp grammar requires.
      const tzSpace = text.lastIndexOf(' ', nl - 1);
      if (tzSpace > pos && /^[+-]\d{4}$/.test(text.slice(tzSpace + 1, nl))) {
        const tsSpace = text.lastIndexOf(' ', tzSpace - 1);
        if (tsSpace > pos) {
          const stamp = text.slice(tsSpace + 1, tzSpace);
          if (/^\d+$/.test(stamp)) time = Number(stamp);
        }
      }
    }
    pos = nl + 1;
  }
  return { tree, parents, message, time };
}

export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

/** Parse a tree object into its entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const mode = data.toString('utf8', offset, space);
    const nul = data.indexOf(0x00, space + 1);
    if (nul === -1 || nul + 21 > data.length) break;
    const name = data.toString('utf8', space + 1, nul);
    const sha = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, sha });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree ordering: names compare bytewise, directories as if suffixed with '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Serialize tree entries (sorted the git way) into a tree object's bytes. */
export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Serialize a commit object. */
export function buildCommit(tree: string, parents: string[], authorLine: string, committerLine: string, message: string): Buffer {
  let head = `tree ${tree}\n`;
  for (const parent of parents) head += `parent ${parent}\n`;
  head += `author ${authorLine}\ncommitter ${committerLine}\n\n`;
  return Buffer.from(head + message, 'utf8');
}

/** An identity line for a server-created commit at a logical-clock second. */
export function identityLine(sec: number): string {
  return `${VIEWER.name} <${VIEWER.email}> ${sec} +0000`;
}

/** Peel an object id to a commit: follow tag objects; null when it does not end at a commit. */
export function peelToCommit(repo: RepoRec, sha: string): string | null {
  let current = sha;
  const seen = new Set<string>();
  for (let guard = 0; guard < 64; guard += 1) {
    if (seen.has(current)) return null;
    seen.add(current);
    const object = repo.objects.get(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return null;
    const match = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'));
    if (match === null) return null;
    current = match[1]!;
  }
  return null;
}

/** The tree id of a commit (peeling tags first); null when unknown. */
export function commitTree(repo: RepoRec, sha: string): string | null {
  const commitSha = peelToCommit(repo, sha);
  if (commitSha === null) return null;
  const object = repo.objects.get(commitSha);
  if (object === undefined) return null;
  return parseCommit(object.data).tree;
}

/** Flatten a tree into a path -> entry map, recursing into subtrees. */
export function flattenTree(repo: RepoRec, treeSha: string, prefix = '', out = new Map<string, TreeEntry>()): Map<string, TreeEntry> {
  const object = repo.objects.get(treeSha);
  if (object === undefined || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(repo, entry.sha, path, out);
    else out.set(path, entry);
  }
  return out;
}

/** Rebuild nested tree objects from a flat path -> entry map; returns the root tree id. */
export function buildTreeFromFlat(repo: RepoRec, flat: Map<string, TreeEntry>): string {
  interface Node {
    files: TreeEntry[];
    dirs: Map<string, Node>;
  }
  const root: Node = { files: [], dirs: new Map() };
  for (const [path, entry] of flat) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i]!;
      let next = node.dirs.get(part);
      if (next === undefined) {
        next = { files: [], dirs: new Map() };
        node.dirs.set(part, next);
      }
      node = next;
    }
    node.files.push({ mode: entry.mode, name: parts[parts.length - 1]!, sha: entry.sha });
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [...node.files];
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, sha: build(child) });
    return storeObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

/** The commit graph reachable from `tips` (following parents), as a set of commit ids. */
export function commitClosure(repo: RepoRec, tips: string[], cutAt?: Set<string>): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [];
  for (const tip of tips) {
    const commit = peelToCommit(repo, tip);
    if (commit !== null) stack.push(commit);
  }
  while (stack.length > 0) {
    const sha = stack.pop()!;
    if (seen.has(sha)) continue;
    seen.add(sha);
    if (cutAt !== undefined && cutAt.has(sha)) continue;
    const object = repo.objects.get(sha);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return seen;
}

/** Whether `ancestor` is reachable from `descendant` through parent links (inclusive). */
export function isAncestor(repo: RepoRec, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const sha = stack.pop()!;
    if (sha === ancestor) return true;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const object = repo.objects.get(sha);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return false;
}

/** The best common ancestor of two commits, or null when they share no history. */
export function mergeBase(repo: RepoRec, a: string, b: string): string | null {
  const ancestorsOfA = commitClosure(repo, [a]);
  const seen = new Set<string>();
  const queue = [b];
  while (queue.length > 0) {
    const sha = queue.shift()!;
    if (seen.has(sha)) continue;
    seen.add(sha);
    if (ancestorsOfA.has(sha)) return sha;
    const object = repo.objects.get(sha);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return null;
}

/** Count the lines of a blob for diff accounting. */
export function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  const text = data.toString('utf8');
  let count = 0;
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') count += 1;
  return text.endsWith('\n') ? count : count + 1;
}

export interface FileChange {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
}

/** The file-level diff between two flat trees (merge-base tree -> head tree). */
export function diffFlat(repo: RepoRec, baseFlat: Map<string, TreeEntry>, headFlat: Map<string, TreeEntry>): FileChange[] {
  const changes: FileChange[] = [];
  const paths = new Set<string>([...baseFlat.keys(), ...headFlat.keys()]);
  for (const path of [...paths].sort()) {
    const before = baseFlat.get(path);
    const after = headFlat.get(path);
    if (before !== undefined && after !== undefined && before.sha === after.sha && before.mode === after.mode) continue;
    const beforeLines = before === undefined ? 0 : countLines(repo.objects.get(before.sha)?.data ?? Buffer.alloc(0));
    const afterLines = after === undefined ? 0 : countLines(repo.objects.get(after.sha)?.data ?? Buffer.alloc(0));
    if (before === undefined) changes.push({ filename: path, status: 'added', additions: afterLines, deletions: 0, changes: afterLines });
    else if (after === undefined) changes.push({ filename: path, status: 'removed', additions: 0, deletions: beforeLines, changes: beforeLines });
    else changes.push({ filename: path, status: 'modified', additions: afterLines, deletions: beforeLines, changes: afterLines + beforeLines });
  }
  return changes;
}

export interface MergeOutcome {
  ok: boolean;
  treeSha: string | null;
  conflicts: string[];
}

/**
 * A file-level three-way merge: paths one side changed take that side's version; a path both
 * sides changed differently (including delete-vs-modify) is a conflict.
 */
export function mergeTrees(repo: RepoRec, baseTree: string, oursTree: string, theirsTree: string): MergeOutcome {
  const base = flattenTree(repo, baseTree);
  const ours = flattenTree(repo, oursTree);
  const theirs = flattenTree(repo, theirsTree);
  const merged = new Map(ours);
  const conflicts: string[] = [];
  const same = (x: TreeEntry | undefined, y: TreeEntry | undefined): boolean =>
    x === undefined && y === undefined ? true : x !== undefined && y !== undefined && x.sha === y.sha && x.mode === y.mode;
  const paths = new Set<string>([...base.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const t = theirs.get(path);
    const o = ours.get(path);
    if (same(t, b)) continue;
    if (same(o, b)) {
      if (t === undefined) merged.delete(path);
      else merged.set(path, t);
    } else if (!same(o, t)) {
      conflicts.push(path);
    }
  }
  if (conflicts.length > 0) return { ok: false, treeSha: null, conflicts };
  return { ok: true, treeSha: buildTreeFromFlat(repo, merged), conflicts: [] };
}

// ---------------------------------------------------------------- packfiles

const PACK_TYPES: Record<number, string> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag', 6: 'ofs-delta', 7: 'ref-delta' };
const TYPE_CODES: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** Apply a git delta to its base object. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset]!;
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  readVarint(); // the base size, not needed beyond consuming it
  const resultSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset]!;
    offset += 1;
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) if ((op & (1 << bit)) !== 0) { copyOffset |= delta[offset]! << (8 * bit); offset += 1; }
      for (let bit = 0; bit < 3; bit += 1) if ((op & (0x10 << bit)) !== 0) { copySize |= delta[offset]! << (8 * bit); offset += 1; }
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op !== 0) {
      out.push(delta.subarray(offset, offset + op));
      produced += op;
      offset += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== resultSize || produced !== resultSize) throw new Error('delta size mismatch');
  return result;
}

export interface ParsedPack {
  objects: GitObject[];
  /** The object id of each entry of `objects` (same order), computed during the parse. */
  oids: string[];
  consumed: number;
}

/**
 * Parse a packfile at `offset` in `buf`, resolving deltas against objects from the same pack or
 * from the repository. Reports how many bytes the pack occupied (its trailer included).
 */
export function readPack(repo: RepoRec, buf: Buffer, offset: number): ParsedPack {
  if (buf.length - offset < 12 || buf.toString('utf8', offset, offset + 4) !== 'PACK') throw new Error('not a packfile');
  const count = buf.readUInt32BE(offset + 8);
  let pos = offset + 12;
  const byOffset = new Map<number, GitObject>();
  const byOffsetOid = new Map<number, string>();
  const bySha = new Map<string, GitObject>();
  const pending: Array<{ start: number; kind: 'ofs' | 'ref'; baseOffset: number; baseSha: string; delta: Buffer }> = [];

  const resolveDelta = (base: GitObject, delta: Buffer): GitObject => ({ type: base.type, data: applyDelta(base.data, delta) });

  for (let index = 0; index < count; index += 1) {
    const start = pos;
    let byte = buf[pos]!;
    pos += 1;
    const typeCode = (byte >> 4) & 7;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = buf[pos]!;
      pos += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    void size;
    const type = PACK_TYPES[typeCode];
    if (type === undefined) throw new Error(`unknown pack object type ${typeCode}`);
    if (type === 'ofs-delta') {
      let back = buf[pos]!;
      pos += 1;
      let baseOffset = back & 0x7f;
      while ((back & 0x80) !== 0) {
        back = buf[pos]!;
        pos += 1;
        baseOffset = ((baseOffset + 1) << 7) | (back & 0x7f);
      }
      const inflated = inflateSync(buf.subarray(pos), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
      pos += inflated.engine.bytesWritten;
      pending.push({ start, kind: 'ofs', baseOffset: start - baseOffset, baseSha: '', delta: inflated.buffer });
    } else if (type === 'ref-delta') {
      const baseSha = buf.toString('hex', pos, pos + 20);
      pos += 20;
      const inflated = inflateSync(buf.subarray(pos), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
      pos += inflated.engine.bytesWritten;
      pending.push({ start, kind: 'ref', baseOffset: 0, baseSha, delta: inflated.buffer });
    } else {
      const inflated = inflateSync(buf.subarray(pos), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
      pos += inflated.engine.bytesWritten;
      const object: GitObject = { type, data: inflated.buffer };
      const oid = hashObject(type, inflated.buffer);
      byOffset.set(start, object);
      byOffsetOid.set(start, oid);
      bySha.set(oid, object);
    }
  }

  // Resolve deltas in dependency order; a delta's base may itself be a delta.
  let remaining = pending;
  let guard = 0;
  while (remaining.length > 0) {
    guard += 1;
    if (guard > 10_000) throw new Error('delta chain too deep');
    const next: typeof remaining = [];
    let progressed = false;
    for (const entry of remaining) {
      const base = entry.kind === 'ofs' ? byOffset.get(entry.baseOffset) : bySha.get(entry.baseSha) ?? repo.objects.get(entry.baseSha);
      if (base === undefined) {
        next.push(entry);
        continue;
      }
      const object = resolveDelta(base, entry.delta);
      const oid = hashObject(object.type, object.data);
      byOffset.set(entry.start, object);
      byOffsetOid.set(entry.start, oid);
      bySha.set(oid, object);
      progressed = true;
    }
    if (!progressed) throw new Error('delta base not found');
    remaining = next;
  }

  const trailerStart = pos;
  pos += 20;
  void trailerStart;
  const objects: GitObject[] = [];
  const oids: string[] = [];
  for (const [start, object] of byOffset) {
    objects.push(object);
    oids.push(byOffsetOid.get(start)!);
  }
  return { objects, oids, consumed: pos - offset };
}

/** Write a packfile holding full objects only (no deltas); the trailer is the pack's SHA-1. */
export function writePack(objects: GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'utf8');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    const code = TYPE_CODES[object.type];
    if (code === undefined) throw new Error(`cannot pack ${object.type}`);
    let size = object.data.length;
    const headBytes: number[] = [];
    let first = (code << 4) | (size & 0x0f);
    size >>= 4;
    if (size > 0) first |= 0x80;
    headBytes.push(first);
    while (size > 0) {
      let byte = size & 0x7f;
      size >>= 7;
      if (size > 0) byte |= 0x80;
      headBytes.push(byte);
    }
    parts.push(Buffer.from(headBytes));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------- pkt-lines

const HEX_DIGITS = '0123456789abcdef';

/** One pkt-line: a 4-hex length prefix (counting itself) plus the payload, in a single buffer. */
export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  const out = Buffer.allocUnsafe(length);
  out[0] = HEX_DIGITS.charCodeAt((length >> 12) & 15);
  out[1] = HEX_DIGITS.charCodeAt((length >> 8) & 15);
  out[2] = HEX_DIGITS.charCodeAt((length >> 4) & 15);
  out[3] = HEX_DIGITS.charCodeAt(length & 15);
  data.copy(out, 4);
  return out;
}

export const FLUSH_PKT = Buffer.from('0000', 'utf8');
export const DELIM_PKT = Buffer.from('0001', 'utf8');

export interface PktReader {
  /** The next pkt-line payload, 'flush'/'delim' for the control packets, null at the end. */
  next(): Buffer | 'flush' | 'delim' | null;
  /** How many bytes have been consumed. */
  offset: number;
  /** Whether the stream so far was well-formed. */
  ok: boolean;
}

/** A cursor over a pkt-line stream. */
export function pktReader(buf: Buffer, start = 0): PktReader {
  let offset = start;
  let ok = true;
  return {
    next(): Buffer | 'flush' | 'delim' | null {
      if (offset >= buf.length) return null;
      if (offset + 4 > buf.length) { ok = false; return null; }
      const head = buf.toString('utf8', offset, offset + 4);
      if (!/^[0-9a-f]{4}$/.test(head)) { ok = false; return null; }
      const length = parseInt(head, 16);
      if (length === 0) { offset += 4; return 'flush'; }
      if (length === 1) { offset += 4; return 'delim'; }
      if (length === 2) { offset += 4; return 'delim'; }
      if (length < 4 || offset + length > buf.length) { ok = false; return null; }
      const payload = buf.subarray(offset + 4, offset + length);
      offset += length;
      return payload;
    },
    get offset(): number { return offset; },
    get ok(): boolean { return ok; },
  };
}

// ---------------------------------------------------------------- ref advertisement

const AGENT = 'github-forge/1.0';

/** The refs a repository advertises: HEAD plus every ref, sorted by name. */
export function advertisedRefs(repo: RepoRec): Array<{ name: string; sha: string }> {
  const refs = [...repo.refs.entries()].map(([name, sha]) => ({ name, sha })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return refs;
}

/** The v0 ref advertisement body shared by upload-pack and receive-pack. */
function v0Advertisement(repo: RepoRec, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), FLUSH_PKT];
  const caps = service === 'git-upload-pack'
    ? ['multi_ack_detailed', 'side-band-64k', 'thin-pack', 'ofs-delta', 'shallow', `agent=${AGENT}`, `symref=HEAD:refs/heads/${repo.defaultBranch}`]
    : ['report-status', 'side-band-64k', 'delete-refs', 'ofs-delta', `agent=${AGENT}`];
  const refs = advertisedRefs(repo);
  const headSha = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const lines: Array<{ name: string; sha: string }> = [];
  if (service === 'git-upload-pack') {
    if (headSha !== undefined) lines.push({ name: 'HEAD', sha: headSha });
  }
  lines.push(...refs);
  if (lines.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps.join(' ')}`));
  } else {
    lines.forEach((line, index) => {
      const suffix = index === 0 ? `\0${caps.join(' ')}` : '';
      parts.push(pktLine(`${line.sha} ${line.name}${suffix}`));
      const object = repo.objects.get(line.sha);
      if (object !== undefined && object.type === 'tag') {
        const commit = peelToCommit(repo, line.sha);
        if (commit !== null) parts.push(pktLine(`${commit} ${line.name}^{}`));
      }
    });
  }
  parts.push(FLUSH_PKT);
  return Buffer.concat(parts);
}

/** The protocol v2 capability advertisement for upload-pack: constant bytes, built once. */
let v2AdvertisementCache: Buffer | null = null;

function v2Advertisement(): Buffer {
  if (v2AdvertisementCache === null) {
    v2AdvertisementCache = Buffer.concat([
      pktLine('# service=git-upload-pack\n'),
      FLUSH_PKT,
      pktLine('version 2\n'),
      pktLine(`agent=${AGENT}\n`),
      pktLine('ls-refs=unborn\n'),
      pktLine('fetch=shallow\n'),
      pktLine('object-format=sha1\n'),
      FLUSH_PKT,
    ]);
  }
  return v2AdvertisementCache;
}

export interface GitHttpResult {
  status: number;
  contentType: string;
  body: Buffer;
}

/** GET /info/refs for either service. */
export function infoRefs(repo: RepoRec, service: string, protocolVersion: string | null): GitHttpResult {
  if (service === 'git-upload-pack') {
    if (protocolVersion === 'version=2') {
      return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v2Advertisement() };
    }
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v0Advertisement(repo, 'git-upload-pack') };
  }
  if (service === 'git-receive-pack') {
    return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: v0Advertisement(repo, 'git-receive-pack') };
  }
  return { status: 400, contentType: 'text/plain', body: Buffer.from('error: unknown service\n') };
}

// ---------------------------------------------------------------- ls-refs (protocol v2)

function lsRefs(repo: RepoRec, args: string[]): Buffer {
  // The answer is a pure function of the arguments and the repository's refs and objects;
  // both are covered by the repository's cache invalidation, so a hit replays the bytes.
  const cacheKey = args.join('\n');
  const hit = repo.lsRefsCache.get(cacheKey);
  if (hit !== undefined) return hit;
  let peel = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headSha = repo.refs.get(headTarget);
  if (matches('HEAD')) {
    if (headSha !== undefined) parts.push(pktLine(`${headSha} HEAD symref-target:${headTarget}\n`));
    else if (unborn) parts.push(pktLine(`unborn HEAD symref-target:${headTarget}\n`));
  }
  for (const ref of advertisedRefs(repo)) {
    if (!matches(ref.name)) continue;
    let line = `${ref.sha} ${ref.name}`;
    const object = repo.objects.get(ref.sha);
    if (peel && object !== undefined && object.type === 'tag') {
      const commit = peelToCommit(repo, ref.sha);
      if (commit !== null) line += ` peeled:${commit}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(FLUSH_PKT);
  const body = Buffer.concat(parts);
  if (repo.lsRefsCache.size > 64) repo.lsRefsCache.clear();
  repo.lsRefsCache.set(cacheKey, body);
  return body;
}

// ---------------------------------------------------------------- fetch

export interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
  deepenSince: number | null;
  deepenNot: string[];
}

export interface FetchPlan {
  pack: Buffer;
  shallowLines: string[];
  hasHaves: boolean;
  /** The framed protocol-v2 response for this plan, built on first use. */
  v2Body?: Buffer;
  /** The framed protocol-v0 response for this plan, built on first use. */
  v0Body?: Buffer;
}

/** Compute what a fetch sends: the pack bytes and the shallow-info lines. */
export function planFetch(repo: RepoRec, request: FetchRequest): FetchPlan {
  // The plan is a pure function of the request and the repository's objects and refs, and the
  // repository clears this cache on every mutation of either, so a hit needs no recomputation.
  const cacheKey = [
    [...request.wants].sort().join(','),
    [...request.haves].sort().join(','),
    [...request.shallow].sort().join(','),
    request.deepen ?? '',
    request.deepenSince ?? '',
    request.deepenNot.join(','),
  ].join('|');
  const cached = repo.packCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const clientShallow = new Set(request.shallow);
  const clientHas = commitClosure(repo, request.haves, clientShallow);

  // Exclusions from deepen-not refs.
  const excluded = new Set<string>();
  for (const ref of request.deepenNot) {
    const sha = repo.refs.get(ref) ?? (repo.objects.has(ref) ? ref : undefined);
    if (sha !== undefined) for (const commit of commitClosure(repo, [sha])) excluded.add(commit);
  }

  // Generations from the wants over the full parent graph (BFS levels). With a depth limit the
  // walk stops expanding at the boundary: nothing deeper can be delivered.
  const wantCommits: string[] = [];
  for (const want of request.wants) {
    const commit = peelToCommit(repo, want);
    if (commit !== null && !wantCommits.includes(commit)) wantCommits.push(commit);
  }
  const generations = new Map<string, number>();
  let frontier = wantCommits;
  for (const commit of frontier) generations.set(commit, 1);
  let generation = 1;
  while (frontier.length > 0) {
    if (request.deepen !== null && generation >= request.deepen) break;
    generation += 1;
    const next: string[] = [];
    for (const sha of frontier) {
      const object = repo.objects.get(sha);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        if (!generations.has(parent)) {
          generations.set(parent, generation);
          next.push(parent);
        }
      }
    }
    frontier = next;
  }

  const depth = request.deepen;
  const delivered = new Set<string>();
  for (const [sha, gen] of generations) {
    if (clientHas.has(sha) || excluded.has(sha)) continue;
    if (depth !== null && gen > depth) continue;
    if (request.deepenSince !== null) {
      const object = repo.objects.get(sha);
      if (object === undefined || object.type !== 'commit') continue;
      if (parseCommit(object.data).time < request.deepenSince) continue;
    }
    delivered.add(sha);
  }

  // Shallow bookkeeping: a delivered commit whose parent stays behind becomes a boundary; a
  // client-shallow commit whose parent is now delivered (or present) stops being shallow.
  const shallowLines: string[] = [];
  const boundary = new Set<string>();
  for (const sha of delivered) {
    const object = repo.objects.get(sha);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (!delivered.has(parent) && !clientHas.has(parent) && !excluded.has(parent)) boundary.add(sha);
    }
  }
  for (const sha of boundary) shallowLines.push(`shallow ${sha}`);
  for (const sha of clientShallow) {
    if (boundary.has(sha)) continue;
    const object = repo.objects.get(sha);
    if (object === undefined || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.some((parent) => delivered.has(parent))) shallowLines.push(`unshallow ${sha}`);
  }

  // Everything the client already holds: its have-commits and their full tree closures. None of
  // it may be re-sent (the incremental-fetch check counts re-sent objects).
  const haveObjects = new Set<string>();
  const addClosure = (sha: string, into: Set<string>): void => {
    if (into.has(sha)) return;
    const object = repo.objects.get(sha);
    if (object === undefined) return;
    into.add(sha);
    if (object.type === 'tag') {
      const match = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'));
      if (match !== null) addClosure(match[1]!, into);
    }
    if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) addClosure(entry.sha, into);
    }
  };
  for (const sha of clientHas) {
    haveObjects.add(sha);
    const object = repo.objects.get(sha);
    if (object !== undefined && object.type === 'commit') addClosure(parseCommit(object.data).tree, haveObjects);
  }

  // Objects: tag objects on the want chains, the delivered commits, and their full trees —
  // minus everything the client already holds.
  const objects = new Map<string, GitObject>();
  const addObject = (sha: string): void => {
    if (objects.has(sha) || haveObjects.has(sha)) return;
    const object = repo.objects.get(sha);
    if (object === undefined) return;
    objects.set(sha, object);
    if (object.type === 'tag') {
      const match = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'));
      if (match !== null) addObject(match[1]!);
    }
    if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) addObject(entry.sha);
    }
  };
  for (const want of request.wants) {
    const object = repo.objects.get(want);
    if (object !== undefined && object.type === 'tag') addObject(want);
  }
  for (const sha of delivered) {
    const object = repo.objects.get(sha);
    if (object === undefined) continue;
    objects.set(sha, object);
    addObject(parseCommit(object.data).tree);
  }

  const plan: FetchPlan = { pack: writePack([...objects.values()]), shallowLines, hasHaves: request.haves.length > 0 };
  if (repo.packCache.size > 64) repo.packCache.clear();
  repo.packCache.set(cacheKey, plan);
  return plan;
}

/** Frame pack bytes as side-band-64k pkt-lines (band 1), each within the 65520-byte limit. */
function sidebandPack(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 65_515;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    const payload = Buffer.concat([Buffer.from([1]), slice]);
    parts.push(pktLine(payload));
  }
  return parts;
}

/** A protocol v2 fetch response: sections of pkt-lines, the packfile last. */
function fetchV2(repo: RepoRec, request: FetchRequest): Buffer {
  const plan = planFetch(repo, request);
  if (plan.v2Body !== undefined) return plan.v2Body;
  const parts: Buffer[] = [];
  if (plan.hasHaves) {
    parts.push(pktLine('acknowledgments\n'), pktLine('NAK\n'), DELIM_PKT);
  }
  if (plan.shallowLines.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const line of plan.shallowLines) parts.push(pktLine(`${line}\n`));
    parts.push(DELIM_PKT);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPack(plan.pack));
  parts.push(FLUSH_PKT);
  plan.v2Body = Buffer.concat(parts);
  return plan.v2Body;
}

/** A protocol v0 fetch response: plain negotiation lines, then the sideband pack. */
function fetchV0(repo: RepoRec, request: FetchRequest): Buffer {
  const plan = planFetch(repo, request);
  if (plan.v0Body !== undefined) return plan.v0Body;
  const parts: Buffer[] = [];
  if (plan.hasHaves) parts.push(pktLine('NAK\n'));
  for (const line of plan.shallowLines) parts.push(pktLine(`${line}\n`));
  parts.push(...sidebandPack(plan.pack));
  parts.push(FLUSH_PKT);
  plan.v0Body = Buffer.concat(parts);
  return plan.v0Body;
}

/** Parse one fetch/ls-refs argument block into a FetchRequest. */
function parseFetchArgs(args: string[]): FetchRequest {
  const request: FetchRequest = { wants: [], haves: [], shallow: [], deepen: null, deepenSince: null, deepenNot: [] };
  for (const arg of args) {
    if (arg.startsWith('want ')) request.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) request.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) request.shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) request.deepen = Number(arg.slice(7).trim());
    else if (arg.startsWith('deepen-since ')) request.deepenSince = Number(arg.slice(13).trim());
    else if (arg.startsWith('deepen-not ')) request.deepenNot.push(arg.slice(11).trim());
  }
  return request;
}

/** POST /git-upload-pack: protocol v2 commands, or the v0 want/have negotiation. */
export function uploadPack(repo: RepoRec, body: Buffer, protocolVersion: string | null): GitHttpResult {
  try {
    if (protocolVersion === 'version=2') {
      const reader = pktReader(body);
      const first = reader.next();
      if (first === null || first === 'flush' || first === 'delim') throw new Error('empty request');
      const commandLine = first.toString('utf8').trim();
      // Capability lines run until the delimiter; arguments until the flush.
      const args: string[] = [];
      let sawDelim = false;
      for (;;) {
        const item = reader.next();
        if (item === null || item === 'flush') break;
        if (item === 'delim') { sawDelim = true; continue; }
        if (sawDelim) args.push(item.toString('utf8').replace(/\n$/, ''));
      }
      if (commandLine === 'command=ls-refs') {
        return { status: 200, contentType: 'application/x-git-upload-pack-result', body: lsRefs(repo, args) };
      }
      if (commandLine === 'command=fetch') {
        return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchV2(repo, parseFetchArgs(args)) };
      }
      return { status: 400, contentType: 'text/plain', body: Buffer.from('error: unknown command\n') };
    }
    // Protocol v0: want lines (with shallow/deepen), a flush, have lines, done, a flush.
    const reader = pktReader(body);
    const args: string[] = [];
    let phase: 'wants' | 'haves' = 'wants';
    for (;;) {
      const item = reader.next();
      if (item === null) break;
      if (item === 'flush') {
        if (phase === 'wants') { phase = 'haves'; continue; }
        break;
      }
      if (item === 'delim') continue;
      let line = item.toString('utf8').replace(/\n$/, '');
      const nul = line.indexOf('\0');
      if (nul !== -1) line = line.slice(0, nul);
      if (phase === 'wants') args.push(line);
      else if (line.startsWith('have ') || line === 'done') args.push(line);
    }
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchV0(repo, parseFetchArgs(args)) };
  } catch {
    return { status: 400, contentType: 'text/plain', body: Buffer.from('error: malformed upload-pack request\n') };
  }
}

// ---------------------------------------------------------------- receive-pack

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** POST /git-receive-pack: unpack, validate fast-forwards per ref, apply, and report. */
export function receivePack(forge: Forge, repo: RepoRec, body: Buffer): GitHttpResult {
  void forge;
  try {
    const reader = pktReader(body);
    const commands: PushCommand[] = [];
    let sideband = false;
    let firstLine = true;
    for (;;) {
      const item = reader.next();
      if (item === null) break;
      if (item === 'flush') break;
      if (item === 'delim') continue;
      let line = item.toString('utf8').replace(/\n$/, '');
      if (firstLine) {
        firstLine = false;
        const nul = line.indexOf('\0');
        if (nul !== -1) {
          const caps = line.slice(nul + 1);
          if (caps.split(' ').includes('side-band-64k')) sideband = true;
          line = line.slice(0, nul);
        }
      }
      const parts = line.trim().split(/\s+/);
      if (parts.length !== 3 || !/^[0-9a-f]{40}$/.test(parts[0]!) || !/^[0-9a-f]{40}$/.test(parts[1]!)) {
        return { status: 400, contentType: 'text/plain', body: Buffer.from('error: malformed receive-pack command\n') };
      }
      commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
    }
    if (!reader.ok) {
      return { status: 400, contentType: 'text/plain', body: Buffer.from('error: malformed receive-pack request\n') };
    }

    const packBytes = body.subarray(reader.offset);
    let unpackError: string | null = null;
    if (packBytes.length > 0) {
      try {
        const parsed = readPack(repo, packBytes, 0);
        for (let index = 0; index < parsed.objects.length; index += 1) {
          const sha = parsed.oids[index]!;
          if (!repo.objects.has(sha)) repo.objects.set(sha, parsed.objects[index]!);
        }
      } catch (error) {
        unpackError = error instanceof Error ? error.message : 'unpack failed';
      }
    }

    const report: string[] = [unpackError === null ? 'unpack ok\n' : 'unpack error\n'];
    for (const command of commands) {
      const failure = unpackError === null ? validateAndApply(repo, command) : 'unpacker error';
      report.push(failure === null ? `ok ${command.ref}\n` : `ng ${command.ref} ${failure}\n`);
    }
    invalidateRepoCaches(repo);

    const lines = report.map((line) => pktLine(line));
    let responseBody: Buffer;
    if (sideband) {
      const wrapped = lines.map((line) => pktLine(Buffer.concat([Buffer.from([1]), line])));
      responseBody = Buffer.concat([...wrapped, FLUSH_PKT]);
    } else {
      responseBody = Buffer.concat([...lines, FLUSH_PKT]);
    }
    return { status: 200, contentType: 'application/x-git-receive-pack-result', body: responseBody };
  } catch {
    return { status: 400, contentType: 'text/plain', body: Buffer.from('error: malformed receive-pack request\n') };
  }
}

/** Validate one ref update (fast-forward only) and apply it; a failure reason or null. */
function validateAndApply(repo: RepoRec, command: PushCommand): string | null {
  const current = repo.refs.get(command.ref);
  if (command.newOid === ZERO_OID) {
    // A deletion: the ref goes away (deleting a missing ref is refused like git refuses it).
    if (current === undefined) return 'reference not found';
    repo.refs.delete(command.ref);
    return null;
  }
  const newCommit = peelToCommit(repo, command.newOid);
  if (newCommit === null) return 'non-fast-forward';
  if (command.oldOid === ZERO_OID) {
    if (current !== undefined) return 'already exists';
    repo.refs.set(command.ref, command.newOid);
    return null;
  }
  if (current !== command.oldOid) return 'non-fast-forward';
  if (command.ref.startsWith('refs/tags/')) {
    repo.refs.set(command.ref, command.newOid);
    return null;
  }
  const oldCommit = peelToCommit(repo, command.oldOid);
  if (oldCommit === null || !isAncestor(repo, oldCommit, newCommit)) return 'non-fast-forward';
  repo.refs.set(command.ref, command.newOid);
  return null;
}
