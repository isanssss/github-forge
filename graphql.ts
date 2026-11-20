// graphql.ts — a small GraphQL parser and executor covering the documents the suite sends:
// viewer, repository (with issues/pullRequests connections and cursor pagination), node(id),
// the createIssue / closeIssue / createPullRequest / mergePullRequest / addComment mutations,
// and __type introspection. Unknown fields answer HTTP 200 with an errors entry naming them.

import { VIEWER, globalId, type Forge, type IssueRec, type PullRec, type RepoRec } from './store.ts';
import { branchTip, mergePull, pullFiles } from './rest.ts';
import { commitTree, mergeBase, mergeTrees } from './git.ts';

// ---------------------------------------------------------------- the parser

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: Value[] }
  | { kind: 'object'; fields: Array<{ name: string; value: Value }> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: Value }>;
  selectionSet: SelectionNode[] | null;
}

type SelectionNode =
  | FieldNode
  | { kind: 'inline'; typeCondition: string | null; selectionSet: SelectionNode[] }
  | { kind: 'spread'; name: string };

interface OperationNode {
  type: 'query' | 'mutation';
  name: string | null;
  selectionSet: SelectionNode[];
}

interface FragmentNode {
  typeCondition: string;
  selectionSet: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
}

interface Token {
  kind: 'name' | 'int' | 'float' | 'string' | 'punct' | 'eof';
  value: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '\uFEFF') { i += 1; continue; }
    if (c === '#') { while (i < source.length && source[i] !== '\n') i += 1; continue; }
    if (source.startsWith('...', i)) { tokens.push({ kind: 'punct', value: '...' }); i += 3; continue; }
    if ('!$():=@[]{}|&'.includes(c)) { tokens.push({ kind: 'punct', value: c }); i += 1; continue; }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        const text = end === -1 ? source.slice(i + 3) : source.slice(i + 3, end);
        tokens.push({ kind: 'string', value: text });
        i = end === -1 ? source.length : end + 3;
        continue;
      }
      let j = i + 1;
      let text = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1]!;
          if (esc === 'n') text += '\n';
          else if (esc === 't') text += '\t';
          else if (esc === 'r') text += '\r';
          else if (esc === 'b') text += '\b';
          else if (esc === 'f') text += '\f';
          else if (esc === 'u') { text += String.fromCharCode(parseInt(source.slice(j + 2, j + 6), 16)); j += 4; }
          else text += esc;
          j += 2;
        } else {
          text += source[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: text });
      i = j + 1;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j]!)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      let isFloat = false;
      while (j < source.length && /[0-9.eE+-]/.test(source[j]!)) {
        if (source[j] === '.' || source[j] === 'e' || source[j] === 'E') isFloat = true;
        j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

class Parser {
  tokens: Token[];
  pos: number;

  constructor(source: string) {
    this.tokens = tokenize(source);
    this.pos = 0;
  }

  peek(): Token {
    return this.tokens[this.pos]!;
  }

  next(): Token {
    const token = this.tokens[this.pos]!;
    this.pos += 1;
    return token;
  }

  expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}, found ${token.value}`);
  }

  skipPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) { this.pos += 1; return true; }
    return false;
  }

  expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name, found ${token.value}`);
    return token.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: null, selectionSet: this.parseSelectionSet() });
      } else if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        this.next();
        const type = token.value === 'mutation' ? 'mutation' : 'query';
        const name = this.peek().kind === 'name' ? this.next().value : null;
        if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseVariableDefinitions();
        this.skipDirectives();
        operations.push({ type, name, selectionSet: this.parseSelectionSet() });
      } else if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('expected on in a fragment definition');
        const typeCondition = this.expectName();
        this.skipDirectives();
        fragments.set(name, { typeCondition, selectionSet: this.parseSelectionSet() });
      } else {
        throw new Error(`unexpected token ${token.value}`);
      }
    }
    return { operations, fragments };
  }

  parseVariableDefinitions(): void {
    this.expectPunct('(');
    while (!this.skipPunct(')')) {
      this.expectPunct('$');
      this.expectName();
      this.expectPunct(':');
      this.parseType();
      if (this.skipPunct('=')) this.parseValue();
      this.skipDirectives();
    }
  }

  parseType(): void {
    if (this.skipPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.skipPunct('!');
  }

  skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
  }

  parseArguments(): Array<{ name: string; value: Value }> {
    const args: Array<{ name: string; value: Value }> = [];
    this.expectPunct('(');
    while (!this.skipPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    return args;
  }

  parseValue(): Value {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'int') return { kind: 'int', value: parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: parseFloat(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'punct' && token.value === '[') {
      const values: Value[] = [];
      while (!this.skipPunct(']')) values.push(this.parseValue());
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: Value }> = [];
      while (!this.skipPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${token.value}`);
  }

  parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.skipPunct('}')) selections.push(this.parseSelection());
    return selections;
  }

  parseSelection(): SelectionNode {
    if (this.peek().kind === 'punct' && this.peek().value === '...') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      const name = this.expectName();
      this.skipDirectives();
      return { kind: 'spread', name };
    }
    let name = this.expectName();
    let alias: string | null = null;
    if (this.skipPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    const args = this.peek().kind === 'punct' && this.peek().value === '(' ? this.parseArguments() : [];
    this.skipDirectives();
    const selectionSet = this.peek().kind === 'punct' && this.peek().value === '{' ? this.parseSelectionSet() : null;
    return { kind: 'field', alias, name, args, selectionSet };
  }
}

// ---------------------------------------------------------------- the schema (for introspection)

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'search', 'rateLimit'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name', 'email', 'url'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests',
    'description', 'isPrivate', 'createdAt', 'updatedAt', 'url', 'labels', 'refs', 'stargazerCount', 'forkCount',
  ],
  Ref: ['name', 'prefix', 'target'],
  Issue: [
    'id', 'number', 'title', 'state', 'body',
    'author', 'createdAt', 'updatedAt', 'closed', 'labels', 'comments', 'repository', 'url',
  ],
  PullRequest: [
    'id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files',
    'title', 'body', 'author', 'createdAt', 'updatedAt', 'closed', 'mergedAt', 'mergeCommit',
    'headRef', 'baseRef', 'repository', 'additions', 'deletions', 'changedFiles',
  ],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  IssueCommentEdge: ['node', 'cursor'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'possibleTypes'],
  __Field: ['name', 'description', 'type'],
  __EnumValue: ['name', 'description'],
  __Schema: ['types', 'queryType', 'mutationType'],
};

const TYPE_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

// ---------------------------------------------------------------- tagged values

type Tagged = { __type: string; [key: string]: unknown };

function tag(type: string, fields: Record<string, unknown> = {}): Tagged {
  return { __type: type, ...fields };
}

function isTagged(value: unknown): value is Tagged {
  return typeof value === 'object' && value !== null && typeof (value as Tagged).__type === 'string';
}

interface ExecContext {
  forge: Forge;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentNode>;
  errors: Array<{ message: string }>;
}

/** Substitute variables into a parsed value, producing plain JSON-shaped data. */
function resolveValue(value: Value, ctx: ExecContext): unknown {
  switch (value.kind) {
    case 'variable': return ctx.variables[value.name];
    case 'int': case 'float': case 'string': case 'boolean': case 'enum': return value.value;
    case 'null': return null;
    case 'list': return value.values.map((entry) => resolveValue(entry, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = resolveValue(field.value, ctx);
      return out;
    }
  }
}

function argsOf(node: FieldNode, ctx: ExecContext): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const arg of node.args) args[arg.name] = resolveValue(arg.value, ctx);
  return args;
}

// ---------------------------------------------------------------- object helpers

function repoTag(repo: RepoRec): Tagged {
  return tag('Repository', { repo });
}

function issueTag(repo: RepoRec, issue: IssueRec): Tagged {
  return tag('Issue', { repo, issue });
}

function pullTag(repo: RepoRec, pull: PullRec): Tagged {
  return tag('PullRequest', { repo, pull });
}

function cursorOf(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function pageInfo(nodes: Array<{ number: number }>, start: number, total: number): Tagged {
  return tag('PageInfo', {
    hasNextPage: start + nodes.length < total,
    hasPreviousPage: start > 0,
    endCursor: nodes.length > 0 ? cursorOf(nodes[nodes.length - 1]!.number) : null,
    startCursor: nodes.length > 0 ? cursorOf(nodes[0]!.number) : null,
  });
}

/** Slice a connection: `first` items after the `after` cursor, over an ordered item list. */
function connectionSlice<T extends { number: number }>(items: T[], args: Record<string, unknown>): { slice: T[]; start: number } {
  let start = 0;
  const after = args.after;
  if (typeof after === 'string' && after !== '') {
    try {
      const decoded = Buffer.from(after, 'base64').toString('utf8');
      const match = /^cursor:(\d+)$/.exec(decoded);
      if (match !== null) {
        const index = items.findIndex((item) => item.number === Number(match[1]));
        if (index !== -1) start = index + 1;
      }
    } catch {
      start = 0;
    }
  }
  const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : items.length;
  return { slice: items.slice(start, start + first), start };
}

/** Decode a global id into its parts; null when it is not one of ours. */
function decodeGlobalId(id: unknown): string[] | null {
  if (typeof id !== 'string' || id === '') return null;
  try {
    const decoded = Buffer.from(id, 'base64').toString('utf8');
    const parts = decoded.split(':');
    if (parts.length < 2) return null;
    if (!['Repository', 'Issue', 'PullRequest', 'IssueComment', 'User'].includes(parts[0]!)) return null;
    return parts;
  } catch {
    return null;
  }
}

function repoByGlobalId(forge: Forge, id: unknown): RepoRec | null {
  const parts = decodeGlobalId(id);
  if (parts === null || parts[0] !== 'Repository') return null;
  const dbId = Number(parts[1]);
  return forge.listRepos().find((repo) => repo.id === dbId) ?? null;
}

function itemByGlobalId(forge: Forge, id: unknown, kind: 'Issue' | 'PullRequest'): { repo: RepoRec; item: IssueRec | PullRec } | null {
  const parts = decodeGlobalId(id);
  if (parts === null || parts[0] !== kind) return null;
  const repo = forge.listRepos().find((candidate) => candidate.id === Number(parts[1]));
  if (repo === undefined) return null;
  const item = repo.items.get(Number(parts[2]));
  if (item === undefined) return null;
  if (kind === 'Issue' && item.kind !== 'issue') return null;
  if (kind === 'PullRequest' && item.kind !== 'pull') return null;
  return { repo, item };
}

/** Resolve a node(id:) to a tagged object. */
function nodeById(forge: Forge, id: unknown): Tagged | null {
  const parts = decodeGlobalId(id);
  if (parts === null) return null;
  if (parts[0] === 'Repository') {
    const repo = forge.listRepos().find((candidate) => candidate.id === Number(parts[1]));
    return repo === undefined ? null : repoTag(repo);
  }
  if (parts[0] === 'Issue' || parts[0] === 'PullRequest') {
    const found = itemByGlobalId(forge, id, parts[0]);
    if (found === null) return null;
    return found.item.kind === 'issue' ? issueTag(found.repo, found.item) : pullTag(found.repo, found.item as PullRec);
  }
  if (parts[0] === 'User') return tag('User');
  if (parts[0] === 'IssueComment') {
    const repo = forge.listRepos().find((candidate) => candidate.id === Number(parts[1]));
    if (repo === undefined) return null;
    const item = repo.items.get(Number(parts[2]));
    if (item === undefined) return null;
    const comment = item.comments.find((candidate) => candidate.id === Number(parts[3]));
    if (comment === undefined) return null;
    return tag('IssueComment', { repo, item, comment });
  }
  return null;
}

// ---------------------------------------------------------------- field resolvers

function resolveField(source: Tagged, field: string, args: Record<string, unknown>, ctx: ExecContext): unknown {
  const forge = ctx.forge;
  switch (source.__type) {
    case 'Query': {
      if (field === 'viewer') return tag('User');
      if (field === 'repository') {
        const owner = typeof args.owner === 'string' ? args.owner : '';
        const name = typeof args.name === 'string' ? args.name : '';
        const repo = forge.getRepo(owner, name);
        return repo === null ? null : repoTag(repo);
      }
      if (field === 'node') return nodeById(forge, args.id);
      if (field === '__type') {
        const name = typeof args.name === 'string' ? args.name : '';
        return TYPE_FIELDS[name] !== undefined || TYPE_ENUMS[name] !== undefined ? tag('__Type', { name }) : null;
      }
      if (field === '__schema') return tag('__Schema');
      break;
    }
    case 'Mutation': {
      if (field === 'createIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = repoByGlobalId(forge, input.repositoryId);
        if (repo === null) throw new Error('repository not found');
        const issue = forge.createIssue(repo, typeof input.title === 'string' ? input.title : '', typeof input.body === 'string' ? input.body : '', []);
        return tag('CreateIssuePayload', { issue: issueTag(repo, issue) });
      }
      if (field === 'closeIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = itemByGlobalId(forge, input.issueId, 'Issue');
        if (found === null) throw new Error('issue not found');
        (found.item as IssueRec).state = 'closed';
        return tag('CloseIssuePayload', { issue: issueTag(found.repo, found.item as IssueRec) });
      }
      if (field === 'createPullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = repoByGlobalId(forge, input.repositoryId);
        if (repo === null) throw new Error('repository not found');
        const head = typeof input.headRefName === 'string' ? input.headRefName : '';
        const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
        const headSha = branchTip(repo, head);
        const baseSha = branchTip(repo, base);
        if (headSha === null || baseSha === null) throw new Error('head or base branch not found');
        const pull = forge.createPull(repo, typeof input.title === 'string' ? input.title : '', typeof input.body === 'string' ? input.body : '', head, base, headSha, baseSha);
        return tag('CreatePullRequestPayload', { pullRequest: pullTag(repo, pull) });
      }
      if (field === 'mergePullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = itemByGlobalId(forge, input.pullRequestId, 'PullRequest');
        if (found === null) throw new Error('pull request not found');
        const pull = found.item as PullRec;
        if (!pull.merged) {
          const method = typeof input.mergeMethod === 'string' ? input.mergeMethod.toLowerCase() : 'squash';
          const attempt = mergePull(forge, found.repo, pull, method);
          if (!attempt.ok) throw new Error('pull request is not mergeable');
        }
        return tag('MergePullRequestPayload', { pullRequest: pullTag(found.repo, pull) });
      }
      if (field === 'addComment') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const parts = decodeGlobalId(input.subjectId);
        if (parts === null || (parts[0] !== 'Issue' && parts[0] !== 'PullRequest')) throw new Error('subject not found');
        const found = itemByGlobalId(forge, input.subjectId, parts[0]);
        if (found === null) throw new Error('subject not found');
        const comment = forge.addComment(found.item, typeof input.body === 'string' ? input.body : '');
        const node = tag('IssueComment', { repo: found.repo, item: found.item, comment });
        return tag('AddCommentPayload', { commentEdge: tag('IssueCommentEdge', { node }) });
      }
      break;
    }
    case 'User': {
      if (field === 'login') return VIEWER.login;
      if (field === 'id') return globalId('User', VIEWER.id);
      if (field === 'name') return VIEWER.name;
      if (field === 'email') return VIEWER.email;
      if (field === 'url') return `https://github.invalid/${VIEWER.login}`;
      break;
    }
    case 'Repository': {
      const repo = source.repo as RepoRec;
      if (field === 'id') return globalId('Repository', repo.id);
      if (field === 'databaseId') return repo.id;
      if (field === 'name') return repo.name;
      if (field === 'nameWithOwner') return `${VIEWER.login}/${repo.name}`;
      if (field === 'owner') return tag('User');
      if (field === 'description') return repo.description;
      if (field === 'isPrivate') return repo.private;
      if (field === 'defaultBranchRef') {
        return repo.refs.has(`refs/heads/${repo.defaultBranch}`) ? tag('Ref', { name: repo.defaultBranch }) : null;
      }
      if (field === 'viewerPermission') return 'ADMIN';
      if (field === 'hasIssuesEnabled') return true;
      if (field === 'createdAt' || field === 'updatedAt') return forge.isoOfSeq(repo.seq);
      if (field === 'url') return `https://github.invalid/${VIEWER.login}/${repo.name}`;
      if (field === 'stargazerCount' || field === 'forkCount') return 0;
      if (field === 'issue') {
        const item = repo.items.get(typeof args.number === 'number' ? args.number : -1);
        return item !== undefined && item.kind === 'issue' ? issueTag(repo, item) : null;
      }
      if (field === 'issues') {
        let issues = [...repo.items.values()].filter((item): item is IssueRec => item.kind === 'issue');
        const states = Array.isArray(args.states) ? (args.states as string[]) : null;
        if (states !== null && states.length > 0) {
          issues = issues.filter((issue) => states.includes(issue.state.toUpperCase()));
        }
        const orderBy = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
        const descending = orderBy?.direction === 'DESC';
        issues.sort((a, b) => (descending ? b.seq - a.seq || b.number - a.number : a.seq - b.seq || a.number - b.number));
        const { slice, start } = connectionSlice(issues, args);
        return tag('IssueConnection', { nodes: slice.map((issue) => issueTag(repo, issue)), pageInfo: pageInfo(slice, start, issues.length), totalCount: issues.length });
      }
      if (field === 'pullRequest') {
        const item = repo.items.get(typeof args.number === 'number' ? args.number : -1);
        return item !== undefined && item.kind === 'pull' ? pullTag(repo, item) : null;
      }
      if (field === 'pullRequests') {
        let pulls = [...repo.items.values()].filter((item): item is PullRec => item.kind === 'pull');
        const states = Array.isArray(args.states) ? (args.states as string[]) : ['OPEN'];
        if (states.length > 0) {
          pulls = pulls.filter((pull) => states.includes(pull.merged ? 'MERGED' : pull.state.toUpperCase()));
        }
        pulls.sort((a, b) => a.seq - b.seq || a.number - b.number);
        const { slice, start } = connectionSlice(pulls, args);
        return tag('PullRequestConnection', { nodes: slice.map((pull) => pullTag(repo, pull)), pageInfo: pageInfo(slice, start, pulls.length), totalCount: pulls.length });
      }
      break;
    }
    case 'Ref': {
      if (field === 'name') return source.name as string;
      if (field === 'prefix') return 'refs/heads/';
      break;
    }
    case 'Issue': {
      const repo = source.repo as RepoRec;
      const issue = source.issue as IssueRec;
      if (field === 'id') return globalId('Issue', repo.id, issue.number);
      if (field === 'number') return issue.number;
      if (field === 'title') return issue.title;
      if (field === 'body') return issue.body;
      if (field === 'state') return issue.state.toUpperCase();
      if (field === 'closed') return issue.state === 'closed';
      if (field === 'createdAt' || field === 'updatedAt') return forge.isoOfSeq(issue.seq);
      if (field === 'author') return tag('User');
      if (field === 'repository') return repoTag(repo);
      break;
    }
    case 'PullRequest': {
      const repo = source.repo as RepoRec;
      const pull = source.pull as PullRec;
      if (field === 'id') return globalId('PullRequest', repo.id, pull.number);
      if (field === 'number') return pull.number;
      if (field === 'title') return pull.title;
      if (field === 'body') return pull.body;
      if (field === 'state') return pull.merged ? 'MERGED' : pull.state.toUpperCase();
      if (field === 'merged') return pull.merged;
      if (field === 'closed') return pull.state === 'closed';
      if (field === 'headRefName') return pull.headRef;
      if (field === 'baseRefName') return pull.baseRef;
      if (field === 'createdAt' || field === 'updatedAt') return forge.isoOfSeq(pull.seq);
      if (field === 'mergedAt') return pull.mergedSeq === null ? null : forge.isoOfSeq(pull.mergedSeq);
      if (field === 'author') return tag('User');
      if (field === 'repository') return repoTag(repo);
      if (field === 'mergeable') {
        if (pull.merged || pull.state !== 'open') return 'UNKNOWN';
        const baseTip = branchTip(repo, pull.baseRef);
        const headTip = branchTip(repo, pull.headRef) ?? pull.headSha;
        if (baseTip === null) return 'UNKNOWN';
        const base = mergeBase(repo, baseTip, headTip);
        const empty = commitTree(repo, baseTip);
        const baseTree = base === null ? empty : commitTree(repo, base);
        const oursTree = commitTree(repo, baseTip);
        const theirsTree = commitTree(repo, headTip);
        if (baseTree === null || oursTree === null || theirsTree === null) return 'UNKNOWN';
        return mergeTrees(repo, baseTree, oursTree, theirsTree).ok ? 'MERGEABLE' : 'CONFLICTING';
      }
      if (field === 'files') {
        const files = pullFiles(repo, pull);
        const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : files.length;
        const slice = files.slice(0, first);
        return tag('PullRequestChangedFileConnection', {
          nodes: slice.map((file) => tag('PullRequestChangedFile', { path: file.filename, additions: file.additions, deletions: file.deletions })),
          totalCount: files.length,
        });
      }
      if (field === 'additions') return pullFiles(repo, pull).reduce((sum, file) => sum + file.additions, 0);
      if (field === 'deletions') return pullFiles(repo, pull).reduce((sum, file) => sum + file.deletions, 0);
      if (field === 'changedFiles') return pullFiles(repo, pull).length;
      break;
    }
    case 'IssueConnection': case 'PullRequestConnection': {
      if (field === 'nodes') return source.nodes as unknown[];
      if (field === 'pageInfo') return source.pageInfo as Tagged;
      if (field === 'totalCount') return source.totalCount as number;
      break;
    }
    case 'PageInfo': {
      if (field === 'hasNextPage') return source.hasNextPage as boolean;
      if (field === 'hasPreviousPage') return source.hasPreviousPage as boolean;
      if (field === 'endCursor') return source.endCursor as string | null;
      if (field === 'startCursor') return source.startCursor as string | null;
      break;
    }
    case 'PullRequestChangedFileConnection': {
      if (field === 'nodes') return source.nodes as unknown[];
      if (field === 'totalCount') return source.totalCount as number;
      break;
    }
    case 'PullRequestChangedFile': {
      if (field === 'path') return source.path as string;
      if (field === 'additions') return source.additions as number;
      if (field === 'deletions') return source.deletions as number;
      break;
    }
    case 'IssueComment': {
      const repo = source.repo as RepoRec;
      const item = source.item as IssueRec | PullRec;
      const comment = source.comment as { id: number; body: string; seq: number };
      if (field === 'id') return globalId('IssueComment', repo.id, item.number, comment.id);
      if (field === 'body') return comment.body;
      if (field === 'author') return tag('User');
      if (field === 'createdAt' || field === 'updatedAt') return forge.isoOfSeq(comment.seq);
      break;
    }
    case 'CreateIssuePayload': case 'CloseIssuePayload': {
      if (field === 'issue') return source.issue as Tagged;
      if (field === 'clientMutationId') return null;
      break;
    }
    case 'CreatePullRequestPayload': case 'MergePullRequestPayload': {
      if (field === 'pullRequest') return source.pullRequest as Tagged;
      if (field === 'clientMutationId') return null;
      break;
    }
    case 'AddCommentPayload': {
      if (field === 'commentEdge') return source.commentEdge as Tagged;
      if (field === 'clientMutationId') return null;
      break;
    }
    case 'IssueCommentEdge': {
      if (field === 'node') return source.node as Tagged;
      if (field === 'cursor') return cursorOf(0);
      break;
    }
    case '__Type': {
      const name = source.name as string;
      if (field === 'name') return name;
      if (field === 'kind') return TYPE_ENUMS[name] !== undefined ? 'ENUM' : 'OBJECT';
      if (field === 'fields') {
        const fields = TYPE_FIELDS[name];
        return fields === undefined ? null : fields.map((fieldName) => tag('__Field', { name: fieldName }));
      }
      if (field === 'enumValues') {
        const values = TYPE_ENUMS[name];
        return values === undefined ? null : values.map((valueName) => tag('__EnumValue', { name: valueName }));
      }
      if (field === 'possibleTypes') return null;
      break;
    }
    case '__Field': {
      if (field === 'name') return source.name as string;
      if (field === 'description') return null;
      break;
    }
    case '__EnumValue': {
      if (field === 'name') return source.name as string;
      if (field === 'description') return null;
      break;
    }
    case '__Schema': {
      if (field === 'types') return [...Object.keys(TYPE_FIELDS), ...Object.keys(TYPE_ENUMS)].map((name) => tag('__Type', { name }));
      if (field === 'queryType') return tag('__Type', { name: 'Query' });
      if (field === 'mutationType') return tag('__Type', { name: 'Mutation' });
      break;
    }
  }
  throw new Error(`Field '${field}' doesn't exist on type '${source.__type}'`);
}

// ---------------------------------------------------------------- execution

function completeValue(value: unknown, selectionSet: SelectionNode[] | null, ctx: ExecContext): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => completeValue(entry, selectionSet, ctx));
  if (isTagged(value)) {
    if (selectionSet === null) return null;
    return executeSelectionSet(value, selectionSet, ctx);
  }
  return value;
}

function executeSelectionSet(source: Tagged, selections: SelectionNode[], ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'field') {
      const key = selection.alias ?? selection.name;
      if (selection.name === '__typename') {
        out[key] = source.__type;
        continue;
      }
      let value: unknown;
      try {
        value = resolveField(source, selection.name, argsOf(selection, ctx), ctx);
      } catch (error) {
        ctx.errors.push({ message: error instanceof Error ? error.message : String(error) });
        value = null;
      }
      out[key] = completeValue(value, selection.selectionSet, ctx);
    } else if (selection.kind === 'inline') {
      if (selection.typeCondition === null || typeMatches(source.__type, selection.typeCondition)) {
        Object.assign(out, executeSelectionSet(source, selection.selectionSet, ctx));
      }
    } else {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined && typeMatches(source.__type, fragment.typeCondition)) {
        Object.assign(out, executeSelectionSet(source, fragment.selectionSet, ctx));
      }
    }
  }
  return out;
}

/** Whether an inline fragment's type condition applies to a tagged object. */
function typeMatches(actual: string, condition: string): boolean {
  if (actual === condition) return true;
  if (condition === 'Node') return ['Repository', 'Issue', 'PullRequest', 'IssueComment', 'User'].includes(actual);
  return false;
}

export interface GraphQLResponse {
  status: number;
  body: unknown;
}

/** Execute one GraphQL request body (a single operation or a batch array). */
export function executeGraphQL(forge: Forge, body: unknown): GraphQLResponse {
  if (Array.isArray(body)) {
    return { status: 200, body: body.map((entry) => executeOne(forge, entry)) };
  }
  return { status: 200, body: executeOne(forge, body) };
}

function executeOne(forge: Forge, body: unknown): Record<string, unknown> {
  const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const query = typeof record.query === 'string' ? record.query : '';
  const variables = (typeof record.variables === 'object' && record.variables !== null ? record.variables : {}) as Record<string, unknown>;
  const operationName = typeof record.operationName === 'string' ? record.operationName : null;
  if (query === '') return { errors: [{ message: 'A query is required' }] };
  let document: DocumentNode;
  try {
    document = new Parser(query).parseDocument();
  } catch (error) {
    return { errors: [{ message: error instanceof Error ? error.message : 'parse error' }] };
  }
  const operation = operationName !== null
    ? document.operations.find((candidate) => candidate.name === operationName) ?? document.operations[0]
    : document.operations[0];
  if (operation === undefined) return { errors: [{ message: 'No operation found' }] };
  const ctx: ExecContext = { forge, variables, fragments: document.fragments, errors: [] };
  const root = tag(operation.type === 'mutation' ? 'Mutation' : 'Query');
  const data = executeSelectionSet(root, operation.selectionSet, ctx);
  const envelope: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) envelope.errors = ctx.errors;
  return envelope;
}
