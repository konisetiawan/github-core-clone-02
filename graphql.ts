export type Token =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'variable'; value: string };

export type ValueNode =
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null'; value: null }
  | { kind: 'enum'; value: string }
  | { kind: 'variable'; name: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { [k: string]: ValueNode } };

export interface Directive {
  name: string;
  arguments?: { [k: string]: ValueNode };
}

export type Selection =
  | {
      kind: 'field';
      name: string;
      alias?: string;
      arguments?: { [k: string]: ValueNode };
      directives?: Directive[];
      selectionSet?: Selection[];
    }
  | { kind: 'fragmentSpread'; name: string; directives?: Directive[] }
  | {
      kind: 'inlineFragment';
      typeCondition?: string;
      directives?: Directive[];
      selectionSet: Selection[];
    };

export interface VarDef {
  name: string;
  type: string;
  defaultValue?: ValueNode;
}

export interface Operation {
  operation: 'query' | 'mutation';
  name?: string;
  variableDefinitions: VarDef[];
  selectionSet: Selection[];
}

export interface FragmentDef {
  name: string;
  typeCondition?: string;
  selectionSet: Selection[];
}

export interface Document {
  operations: Operation[];
  fragments: Map<string, FragmentDef>;
}

const PUNCT: ReadonlySet<string> = new Set(['{', '}', '(', ')', ':', '$', '!', '=', '@', '[', ']', '...']);

function isNameStart(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_';
}

function isNameChar(ch: string): boolean {
  return isNameStart(ch) || (ch >= '0' && ch <= '9');
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

function parseEscape(src: string, i: number, line: number, col: number): { value: string; i: number } {
  const ch = src[i];
  switch (ch) {
    case '"': return { value: '"', i: i + 1 };
    case '\\': return { value: '\\', i: i + 1 };
    case '/': return { value: '/', i: i + 1 };
    case 'b': return { value: '\b', i: i + 1 };
    case 'f': return { value: '\f', i: i + 1 };
    case 'n': return { value: '\n', i: i + 1 };
    case 'r': return { value: '\r', i: i + 1 };
    case 't': return { value: '\t', i: i + 1 };
    case 'u': {
      const hex = src.slice(i + 1, i + 5);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
        throw new Error(`Unexpected character \\u at ${line}:${col}`);
      }
      return { value: String.fromCharCode(parseInt(hex, 16)), i: i + 5 };
    }
    default:
      throw new Error(`Unexpected character \\ at ${line}:${col}`);
  }
}

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let col = 1;
  const n = source.length;

  const advance = (count: number) => {
    for (let k = 0; k < count; k++) {
      if (source[i] === '\n') {
        line++;
        col = 1;
      } else {
        col++;
      }
      i++;
    }
  };

  while (i < n) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n' || ch === ',') {
      advance(1);
      continue;
    }
    if (ch === '#') {
      while (i < n && source[i] !== '\n') advance(1);
      continue;
    }
    if (ch === '.' && source[i + 1] === '.' && source[i + 2] === '.') {
      tokens.push({ kind: 'punct', value: '...' });
      advance(3);
      continue;
    }
    if (ch === '$') {
      const startCol = col;
      const startLine = line;
      advance(1);
      let value = '$';
      let sawName = false;
      while (i < n && isNameChar(source[i])) {
        value += source[i];
        advance(1);
        sawName = true;
      }
      if (!sawName) {
        throw new Error(`Unexpected character $ at ${startLine}:${startCol}`);
      }
      tokens.push({ kind: 'variable', value });
      continue;
    }
    if (PUNCT.has(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      advance(1);
      continue;
    }
    if (ch === '"') {
      const startCol = col;
      const startLine = line;
      advance(1);
      let value = '';
      let closed = false;
      while (i < n) {
        const c = source[i];
        if (c === '"') {
          advance(1);
          closed = true;
          break;
        }
        if (c === '\\') {
          const esc = parseEscape(source, i + 1, line, col + 1);
          value += esc.value;
          advance(1 + (esc.i - (i + 1)));
          continue;
        }
        value += c;
        advance(1);
      }
      if (!closed) {
        throw new Error(`Unterminated string at ${startLine}:${startCol}`);
      }
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (ch === '-') {
      const startCol = col;
      const startLine = line;
      if (!isDigit(source[i + 1])) {
        throw new Error(`Unexpected character - at ${startLine}:${startCol}`);
      }
      advance(1);
      const int = readIntPart();
      if (i < n && source[i] === '.') {
        advance(1);
        const frac = readIntPart();
        tokens.push({ kind: 'float', value: `-${int}.${frac}` });
      } else {
        const exp = readExp();
        tokens.push({ kind: 'float', value: `-${int}${exp}` });
      }
      continue;
    }
    if (isDigit(ch)) {
      const int = readIntPart();
      if (i < n && source[i] === '.') {
        advance(1);
        const frac = readIntPart();
        tokens.push({ kind: 'float', value: `${int}.${frac}` });
      } else {
        const exp = readExp();
        if (exp !== '') {
          tokens.push({ kind: 'float', value: `${int}${exp}` });
        } else {
          tokens.push({ kind: 'int', value: int });
        }
      }
      continue;
    }
    if (isNameStart(ch)) {
      let value = '';
      while (i < n && isNameChar(source[i])) {
        value += source[i];
        advance(1);
      }
      tokens.push({ kind: 'name', value });
      continue;
    }
    throw new Error(`Unexpected character ${ch} at ${line}:${col}`);
  }

  function readIntPart(): string {
    let value = '';
    while (i < n && isDigit(source[i])) {
      value += source[i];
      advance(1);
    }
    if (value === '') {
      throw new Error(`Unexpected character ${source[i] ?? 'EOF'} at ${line}:${col}`);
    }
    return value;
  }

  function readExp(): string {
    if (i < n && (source[i] === 'e' || source[i] === 'E')) {
      let value = source[i];
      advance(1);
      if (i < n && (source[i] === '+' || source[i] === '-')) {
        value += source[i];
        advance(1);
      }
      const digits = readIntPart();
      value += digits;
      return value;
    }
    return '';
  }

  return tokens;
}

class Parser {
  private tokens: Token[];
  private pos = 0 | 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const t = this.tokens[this.pos];
    if (!t) throw new Error('Unexpected end of input');
    this.pos++;
    return t;
  }

  private eat(value: string): boolean {
    const t = this.peek();
    if (t && t.kind === 'punct' && t.value === value) {
      this.pos++;
      return true;
    }
    return false;
  }

  private expect(value: string): void {
    if (!this.eat(value)) {
      const t = this.peek();
      const got = t ? ` got '${t.value}'` : ' got end of input';
      throw new Error(`Expected '${value}'${got}`);
    }
  }

  private eatName(value?: string): Token | undefined {
    const t = this.peek();
    if (t && t.kind === 'name' && (value === undefined || t.value === value)) {
      this.pos++;
      return t;
    }
    return undefined;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, FragmentDef>();
    while (this.peek()) {
      const t = this.peek();
      if (t.kind === 'punct' && t.value === '{') {
        operations.push(this.parseOperationShorthand());
      } else if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
        operations.push(this.parseOperation());
      } else if (t.kind === 'name' && t.value === 'fragment') {
        const frag = this.parseFragmentDef();
        if (frag.typeCondition) {
          fragments.set(frag.name, frag);
        }
      } else {
        throw new Error(`Unexpected token '${t.value}' at top level`);
      }
    }
    return { operations, fragments };
  }

  private parseOperationShorthand(): Operation {
    const selectionSet = this.parseSelectionSet();
    return { operation: 'query', variableDefinitions: [], selectionSet };
  }

  private parseOperation(): Operation {
    const opToken = this.next();
    const operation = opToken.value === 'mutation' ? 'mutation' : 'query';
    let name: string | undefined;
    const t = this.peek();
    if (t && t.kind === 'name') {
      name = this.next().value;
    }
    const variableDefinitions: VarDef[] = [];
    if (this.eat('(')) {
      while (!this.eat(')')) {
        variableDefinitions.push(this.parseVariableDefinition());
      }
    }
    const selectionSet = this.parseSelectionSet();
    return { operation, name, variableDefinitions, selectionSet };
  }

  private parseVariableDefinition(): VarDef {
    const t = this.next();
    if (t.kind !== 'variable') throw new Error(`Expected variable definition, got '${t.value}'`);
    this.expect(':');
    const type = this.parseTypeRef();
    let defaultValue: ValueNode | undefined;
    if (this.eat('=')) {
      defaultValue = this.parseValue();
    }
    return { name: t.value.slice(1), type, defaultValue };
  }

  private parseTypeRef(): string {
    let type = '';
    const t = this.peek();
    if (t?.kind === 'punct' && t.value === '[') {
      this.next();
      const inner = this.parseTypeRef();
      this.expect(']');
      type = `[${inner}]`;
    } else if (t?.kind === 'name') {
      this.next();
      type = t.value;
    } else {
      throw new Error(`Expected type name, got '${t ? t.value : 'end of input'}'`);
    }
    if (this.eat('!')) {
      type = `${type}!`;
    }
    return type;
  }

  private parseSelectionSet(): Selection[] {
    this.expect('{');
    const selections: Selection[] = [];
    while (!this.eat('}')) {
      selections.push(this.parseSelection());
    }
    return selections;
  }

  private parseSelection(): Selection {
    const t = this.peek();
    if (!t) throw new Error('Unexpected end of input');
    if (t.kind === 'punct' && t.value === '...') {
      return this.parseFragment();
    }
    if (t.kind !== 'name') {
      throw new Error(`Unexpected token '${t.value}' in selection set`);
    }
    return this.parseField();
  }

  private parseField(): Selection {
    let name = this.next().value;
    let alias: string | undefined;
    if (this.eat(':')) {
      alias = name;
      name = this.next().value;
    }
    let arguments_: { [k: string]: ValueNode } | undefined;
    if (this.eat('(')) {
      arguments_ = {};
      while (!this.eat(')')) {
        const argName = this.next().value;
        this.expect(':');
        arguments_[argName] = this.parseValue();
      }
    }
    let directives: Directive[] | undefined;
    if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '@') {
      directives = this.parseDirectives();
    }
    let selectionSet: Selection[] | undefined;
    if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '{') {
      selectionSet = this.parseSelectionSet();
    }
    const field: Selection = { kind: 'field', name };
    if (alias !== undefined) field.alias = alias;
    if (arguments_ !== undefined) field.arguments = arguments_;
    if (directives !== undefined) field.directives = directives;
    if (selectionSet !== undefined) field.selectionSet = selectionSet;
    return field;
  }

  private parseFragment(): Selection {
    this.next();
    const t = this.peek();
    if (t && t.kind === 'name' && t.value === 'on') {
      this.next();
      const typeCondition = this.next().value;
      let directives: Directive[] | undefined;
      if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '@') {
        directives = this.parseDirectives();
      }
      const selectionSet = this.parseSelectionSet();
      const frag: Selection = { kind: 'inlineFragment', selectionSet };
      frag.typeCondition = typeCondition;
      if (directives !== undefined) frag.directives = directives;
      return frag;
    }
    if (t && t.kind === 'name') {
      const name = this.next().value;
      let directives: Directive[] | undefined;
      if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '@') {
        directives = this.parseDirectives();
      }
      const spread: Selection = { kind: 'fragmentSpread', name };
      if (directives !== undefined) spread.directives = directives;
      return spread;
    }
    if (t && t.kind === 'punct' && t.value === '{') {
      let directives: Directive[] | undefined;
      if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '@') {
        directives = this.parseDirectives();
      }
      const selectionSet = this.parseSelectionSet();
      const frag: Selection = { kind: 'inlineFragment', selectionSet };
      if (directives !== undefined) frag.directives = directives;
      return frag;
    }
    throw new Error(`Unexpected token after '...'`);
  }

  private parseDirectives(): Directive[] {
    const directives: Directive[] = [];
    while (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '@') {
      this.next();
      const name = this.next().value;
      let arguments_: { [k: string]: ValueNode } | undefined;
      if (this.eat('(')) {
        arguments_ = {};
        while (!this.eat(')')) {
          const argName = this.next().value;
          this.expect(':');
          arguments_[argName] = this.parseValue();
        }
      }
      const d: Directive = { name };
      if (arguments_ !== undefined) d.arguments = arguments_;
      directives.push(d);
    }
    return directives;
  }

  private parseValue(): ValueNode {
    const t = this.next();
    switch (t.kind) {
      case 'string':
        return { kind: 'string', value: t.value };
      case 'int':
        return { kind: 'int', value: parseInt(t.value, 10) };
      case 'float':
        return { kind: 'float', value: parseFloat(t.value) };
      case 'variable':
        return { kind: 'variable', name: t.value.slice(1) };
      case 'punct':
        if (t.value === '[') {
          const values: ValueNode[] = [];
          while (!this.eat(']')) {
            values.push(this.parseValue());
          }
          return { kind: 'list', values };
        }
        if (t.value === '{') {
          const fields: { [k: string]: ValueNode } = {};
          while (!this.eat('}')) {
            const key = this.next().value;
            this.expect(':');
            fields[key] = this.parseValue();
          }
          return { kind: 'object', fields };
        }
        throw new Error(`Unexpected token '${t.value}' in value`);
      case 'name': {
        if (t.value === 'true') return { kind: 'boolean', value: true };
        if (t.value === 'false') return { kind: 'boolean', value: false };
        if (t.value === 'null') return { kind: 'null', value: null };
        return { kind: 'enum', value: t.value };
      }
      default:
        throw new Error(`Unexpected token '${t.value}' in value`);
    }
  }

  private parseFragmentDef(): FragmentDef {
    this.next();
    const name = this.next().value;
    const onTok = this.next();
    if (onTok.kind !== 'name' || onTok.value !== 'on') {
      throw new Error(`Expected 'on' in fragment definition`);
    }
    const typeCondition = this.next().value;
    const selectionSet = this.parseSelectionSet();
    return { name, typeCondition, selectionSet };
  }
}

export function parseDocument(source: string): Document {
  const tokens = tokenize(source);
  const parser = new Parser(tokens);
  return parser.parseDocument();
}

import type { Repo, Issue, Pull, Comment, Label } from './app.ts';
import { resolveTip } from './app.ts';
import { findMergeBase, getPullFilesDiff, checkPullConflicts, squashMergeCommit } from './git.ts';

// ---- Helpers ----

function toGlobalId(type: string, ...parts: (string | number)[]): string {
  return Buffer.from(`${type}:${parts.join(':')}`, 'utf8').toString('base64');
}

function fromGlobalId(id: string): { type: string; parts: string[] } | null {
  try {
    const decoded = Buffer.from(id, 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx === -1) return null;
    return { type: decoded.slice(0, idx), parts: decoded.slice(idx + 1).split(':') };
  } catch {
    return null;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object';
}

function isConnectionValue(v: unknown): boolean {
  return isObject(v) && '__connType' in v;
}

// ---- Synchronous evaluator ----

function evaluateValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'null':
    case 'enum':
      return node.value;
    case 'variable':
      return variables[node.name];
    case 'list':
      return node.values.map((v) => evaluateValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(node.fields)) {
        out[k] = evaluateValue(node.fields[k], variables);
      }
      return out;
    }
  }
}

interface Ctx {
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentDef>;
  repos: Map<string, Repo>;
  viewerLogin: string;
  errors: string[];
}

type Resolved =
  | { kind: 'ok'; value: unknown }
  | { kind: 'err'; message: string };

// ---- Type resolution ----

function resolveTypeName(value: unknown): string | null {
  if (!isObject(value)) return null;
  const o = value as Record<string, unknown>;
  if (o.issue !== undefined && isObject(o.issue) && o.repo !== undefined) {
    return 'Issue';
  }
  if (o.pr !== undefined && isObject(o.pr) && o.repo !== undefined) {
    return 'PullRequest';
  }
  if (
    o.head !== undefined && isObject(o.head) &&
    o.base !== undefined && isObject(o.base) &&
    typeof o.number === 'number'
  ) {
    return 'PullRequest';
  }
  if (typeof o.number === 'number' && typeof o.title === 'string' && typeof o.body === 'string') {
    return 'Issue';
  }
  if (typeof o.path === 'string' && typeof o.changeType === 'string') {
    return 'PullRequestFile';
  }
  if (o.login !== undefined && (o.__typename === 'User' || (typeof o.name !== 'string'))) {
    return 'User';
  }
  if (o.__typename === 'User') return 'User';
  if (o.login !== undefined && o.id !== undefined) {
    // Ref or User; a Ref has name, not login-with-id semantics
    if (typeof o.name === 'string' && o.__ref !== undefined) return 'Ref';
    return 'User';
  }
  if (typeof o.name === 'string' && o.__ref !== undefined) return 'Ref';
  if (o.node !== undefined && o.cursor !== undefined) return 'Edge';
  if (o.hasNextPage !== undefined) return 'PageInfo';
  if (typeof o.body === 'string' && o.user !== undefined) return 'Comment';
  if (typeof o.name === 'string' && typeof o.color === 'string' && o.description !== undefined) return 'Label';
  if (o.issues instanceof Map && o.prs instanceof Map) return 'Repository';
  if (o.__typename === 'Ref') return 'Ref';
  if (o.__intro === 'SCHEMA') return 'Schema';
  if (typeof o.name === 'string' && o.kind !== undefined) return 'IntroType';
  if (typeof o.name === 'string' && o.type !== undefined && isObject(o.type)) return 'IntroField';
  if (o.__intro === 'ENUM_VALUE') return 'IntroEnum';
  return null;
}

function mergeKey(k: string): string {
  return k;
}

function executeSelectionSet(
  selectionSet: Selection[],
  parent: unknown,
  parentType: string,
  ctx: Ctx,
): Resolved {
  if (!isObject(parent)) {
    return { kind: 'err', message: `Cannot read fields on non-object type "${parentType}"` };
  }
  const result: Record<string, unknown> = {};
  for (const sel of selectionSet) {
    const applied = applySelection(sel, parent, parentType, ctx);
    if (applied.kind === 'err') return applied;
    const items = applied.value as Array<{ key: string; value: unknown }>;
    for (const item of items) {
      result[item.key] = item.value;
    }
  }
  return { kind: 'ok', value: result };
}

function applySelection(
  sel: Selection,
  parent: unknown,
  parentType: string,
  ctx: Ctx,
): Resolved {
  if (sel.kind === 'field') {
    const key = sel.alias ?? sel.name;
    if (sel.name === '__typename') {
      return { kind: 'ok', value: [{ key, value: parentType }] };
    }
    const args: Record<string, unknown> = {};
    if (sel.arguments) {
      for (const k of Object.keys(sel.arguments)) {
        args[k] = evaluateValue(sel.arguments[k], ctx.variables);
      }
    }
    const r = resolveField(parentType, parent, sel.name, args, ctx, sel.selectionSet);
    if (r.kind === 'err') return r;
    let value = r.value;
    if (isObject(value) && '__graphqlResolved' in value) {
      value = (value as { result: unknown }).result;
    } else if (sel.selectionSet && isObject(value) && !Array.isArray(value) && !isConnectionValue(value)) {
      const childType = resolveTypeName(value);
      if (!childType) {
        return { kind: 'err', message: `Cannot query field "${sel.name}" on type "${parentType}"` };
      }
      const sub = executeSelectionSet(sel.selectionSet, value, childType, ctx);
      if (sub.kind === 'err') return sub;
      value = sub.value;
    }
    return { kind: 'ok', value: [{ key, value }] };
  }

  if (sel.kind === 'inlineFragment') {
    const cond = sel.typeCondition;
    if (cond === undefined || cond === parentType) {
      const r = executeSelectionSet(sel.selectionSet, parent, parentType, ctx);
      if (r.kind === 'err') return r;
      return { kind: 'ok', value: Object.entries(r.value as Record<string, unknown>).map(([key, value]) => ({ key, value })) };
    }
    return { kind: 'ok', value: [] };
  }

  if (sel.kind === 'fragmentSpread') {
    const frag = ctx.fragments.get(sel.name);
    if (!frag) {
      return { kind: 'err', message: `Unknown fragment "${sel.name}"` };
    }
    if (frag.typeCondition !== undefined && frag.typeCondition !== parentType) {
      return { kind: 'ok', value: [] };
    }
    const r = executeSelectionSet(frag.selectionSet, parent, parentType, ctx);
    if (r.kind === 'err') return r;
    return { kind: 'ok', value: Object.entries(r.value as Record<string, unknown>).map(([key, value]) => ({ key, value })) };
  }

  return { kind: 'ok', value: [] };
}

function resolveField(
  parentType: string,
  parent: unknown,
  fieldName: string,
  args: Record<string, unknown>,
  ctx: Ctx,
  selectionSet?: Selection[],
): Resolved {
  switch (parentType) {
    case 'Query':
      return resolveQueryField(parent, fieldName, args, ctx, selectionSet);
    case 'Mutation':
      return resolveMutationField(parent, fieldName, args, ctx, selectionSet);
    case 'Repository':
      return resolveRepositoryField(parent, fieldName, args, ctx, selectionSet);
    case 'Issue':
      return resolveIssueField(parent, fieldName, args, ctx, selectionSet);
    case 'PullRequest':
      return resolvePullField(parent, fieldName, args, ctx, selectionSet);
    case 'User':
      return resolveUserField(parent, fieldName, args, ctx, selectionSet);
    case 'Ref':
      return resolveRefField(parent, fieldName, args, ctx, selectionSet);
    case 'Edge':
      return resolveEdgeField(parent, fieldName, args, ctx, selectionSet);
    case 'PageInfo':
      return resolvePageInfoField(parent, fieldName, args, ctx, selectionSet);
    case 'Comment':
      return resolveCommentField(parent, fieldName, args, ctx, selectionSet);
    case 'Label':
      return resolveLabelField(parent, fieldName, args, ctx, selectionSet);
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestFileConnection':
      return resolveConnectionField(parentType, parent, fieldName, args, ctx, selectionSet);
    default: {
      if (isObject(parent) && Object.prototype.hasOwnProperty.call(parent, fieldName)) {
        const value = (parent as Record<string, unknown>)[fieldName];
        if (selectionSet && Array.isArray(value) && value.length > 0 && isObject(value[0])) {
          const childType = resolveTypeName(value[0]);
          if (childType) {
            const items: unknown[] = [];
            for (const item of value) {
              const r = executeSelectionSet(selectionSet, item, childType, ctx);
              if (r.kind === 'err') return r;
              items.push(r.value);
            }
            return { kind: 'ok', value: items };
          }
        }
        return { kind: 'ok', value };
      }
      return { kind: 'err', message: `Cannot query field "${fieldName}" on type "${parentType}"` };
    }
  }
}

// ---- Connection helpers ----

interface ConnNode {
  node: unknown;
  cursor: string;
}

function buildConnection(
  connType: 'IssueConnection' | 'PullRequestConnection' | 'PullRequestFileConnection',
  items: ConnNode[],
  ctx: Ctx,
  selectionSet?: Selection[],
  hasNextPage = false,
): Resolved {
  if (!selectionSet) {
    return { kind: 'err', message: `Field "${connType.toLowerCase()}" of type "${connType}" must have a selection of subfields` };
  }
  const r = executeSelectionSet(selectionSet, { __connType: connType, __items: items, __hasNextPage: hasNextPage }, connType, ctx);
  if (r.kind === 'err') return r;
  return { kind: 'ok', value: { __graphqlResolved: true, result: r.value } };
}

function resolveConnectionField(
  connType: 'IssueConnection' | 'PullRequestConnection' | 'PullRequestFileConnection',
  parent: unknown,
  fieldName: string,
  args: Record<string, unknown>,
  ctx: Ctx,
  selectionSet?: Selection[],
): Resolved {
  if (!isObject(parent)) {
    return { kind: 'err', message: `Cannot read fields on non-object type "${connType}"` };
  }
  const conn = parent as { __connType: string; __items: ConnNode[]; __hasNextPage?: boolean };
  const items = conn.__items;
  if (fieldName === 'nodes') {
    if (!selectionSet) {
      return { kind: 'err', message: `Field "nodes" of type "[Node]" must have a selection of subfields` };
    }
    const nodes: unknown[] = [];
    for (const item of items) {
      const nodeType = resolveTypeName(item.node);
      if (!nodeType) {
        return { kind: 'err', message: `Cannot resolve type of node` };
      }
      const r = executeSelectionSet(selectionSet, item.node, nodeType, ctx);
      if (r.kind === 'err') return r;
      nodes.push(r.value);
    }
    return { kind: 'ok', value: nodes };
  }

  if (fieldName === 'edges') {
    if (!selectionSet) {
      return { kind: 'err', message: `Field "edges" of type "[Edge]" must have a selection of subfields` };
    }
    const edges: unknown[] = [];
    for (const item of items) {
      const nodeType = resolveTypeName(item.node);
      if (!nodeType) {
        return { kind: 'err', message: `Cannot resolve type of node` };
      }
      const edgeParent = { node: item.node, cursor: item.cursor };
      const r = executeSelectionSet(selectionSet, edgeParent, 'Edge', ctx);
      if (r.kind === 'err') return r;
      edges.push(r.value);
    }
    return { kind: 'ok', value: edges };
  }

  if (fieldName === 'pageInfo') {
    if (!selectionSet) {
      return { kind: 'err', message: `Field "pageInfo" of type "PageInfo!" must have a selection of subfields` };
    }
    const startCursor = items.length > 0 ? items[0].cursor : null;
    const endCursor = items.length > 0 ? items[items.length - 1].cursor : null;
    const pi = { hasNextPage: conn.__hasNextPage ?? false, hasPreviousPage: false, startCursor, endCursor };
    return executeSelectionSet(selectionSet, pi, 'PageInfo', ctx);
  }

  if (fieldName === 'totalCount') {
    return { kind: 'ok', value: items.length };
  }

  return { kind: 'err', message: `Cannot query field "${fieldName}" on type "${connType}"` };
}

// ---- Field resolvers ----

interface IntroFieldDef {
  name: string;
  type: { name: string; kind: string };
}

interface IntroTypeDef {
  kind: string;
  fields?: IntroFieldDef[];
  enumValues?: Array<{ name: string }>;
}

const INTRO_TYPES: Record<string, IntroTypeDef> = {
  Issue: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: { name: 'ID', kind: 'SCALAR' } },
      { name: 'number', type: { name: 'Int', kind: 'SCALAR' } },
      { name: 'title', type: { name: 'String', kind: 'SCALAR' } },
      { name: 'state', type: { name: 'String', kind: 'SCALAR' } },
      { name: 'body', type: { name: 'String', kind: 'SCALAR' } },
      { name: 'createdAt', type: { name: 'String', kind: 'SCALAR' } },
      { name: 'author', type: { name: 'User', kind: 'OBJECT' } },
    ],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: { name: 'ID', kind: 'SCALAR' } },
      { name: 'number', type: { name: 'Int', kind: 'SCALAR' } },
      { name: 'title', type: { name: 'String', kind: 'SCALAR' } },
      { name: 'state', type: { name: 'String', kind: 'SCALAR' } },
      { name: 'merged', type: { name: 'Boolean', kind: 'SCALAR' } },
      { name: 'headRefName', type: { name: 'String', kind: 'SCALAR' } },
      { name: 'baseRefName', type: { name: 'String', kind: 'SCALAR' } },
      { name: 'mergeable', type: { name: 'String', kind: 'SCALAR' } },
      { name: 'files', type: { name: 'String', kind: 'SCALAR' } },
    ],
  },
  Repository: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: { name: 'ID', kind: 'SCALAR' } },
      { name: 'databaseId', type: { name: 'Int', kind: 'SCALAR' } },
      { name: 'name', type: { name: 'String', kind: 'SCALAR' } },
      { name: 'nameWithOwner', type: { name: 'String', kind: 'SCALAR' } },
      { name: 'owner', type: { name: 'User', kind: 'OBJECT' } },
      { name: 'defaultBranchRef', type: { name: 'Ref', kind: 'OBJECT' } },
      { name: 'viewerPermission', type: { name: 'String', kind: 'SCALAR' } },
      { name: 'hasIssuesEnabled', type: { name: 'Boolean', kind: 'SCALAR' } },
      { name: 'issue', type: { name: 'Issue', kind: 'OBJECT' } },
      { name: 'issues', type: { name: 'IssueConnection', kind: 'OBJECT' } },
      { name: 'pullRequest', type: { name: 'PullRequest', kind: 'OBJECT' } },
      { name: 'pullRequests', type: { name: 'PullRequestConnection', kind: 'OBJECT' } },
    ],
  },
  User: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: { name: 'ID', kind: 'SCALAR' } },
      { name: 'login', type: { name: 'String', kind: 'SCALAR' } },
      { name: 'name', type: { name: 'String', kind: 'SCALAR' } },
    ],
  },
  SearchType: {
    kind: 'ENUM',
    enumValues: [
      { name: 'ISSUE' },
      { name: 'PULL_REQUEST' },
      { name: 'REPOSITORY' },
      { name: 'USER' },
    ],
  },
};

function resolveQueryField(
  parent: unknown,
  fieldName: string,
  args: Record<string, unknown>,
  ctx: Ctx,
  selectionSet?: Selection[],
): Resolved {
  switch (fieldName) {
    case 'viewer':
      return {
        kind: 'ok',
        value: { login: ctx.viewerLogin, id: 1000, type: 'User', __typename: 'User' },
      };
    case 'repository': {
      const owner = args['owner'];
      const name = args['name'];
      if (typeof owner !== 'string' || typeof name !== 'string') {
        return { kind: 'err', message: 'repository requires owner and name' };
      }
      const repo = ctx.repos.get(`${owner}/${name}`);
      if (!repo) return { kind: 'ok', value: null };
      return { kind: 'ok', value: attachRepo(repo) };
    }
    case 'node': {
      const id = args['id'];
      if (typeof id !== 'string') {
        return { kind: 'err', message: 'node requires id' };
      }
      const parsed = fromGlobalId(id);
      if (!parsed) return { kind: 'ok', value: null };
      return resolveNode(parsed, ctx);
    }
    case '__type': {
      const name = args['name'];
      if (typeof name !== 'string') {
        return { kind: 'err', message: '__type requires name' };
      }
      const t = INTRO_TYPES[name];
      if (!t) return { kind: 'ok', value: null };
      return {
        kind: 'ok',
        value: {
          name,
          kind: t.kind,
          ...(t.fields ? { fields: t.fields } : {}),
          ...(t.enumValues ? { enumValues: t.enumValues } : {}),
        },
      };
    }
    case '__schema': {
      const types = Object.keys(INTRO_TYPES)
        .filter((n) => INTRO_TYPES[n].kind === 'OBJECT')
        .map((n) => ({ name: n, kind: INTRO_TYPES[n].kind }));
      return {
        kind: 'ok',
        value: { types, queryType: { name: 'Query', kind: 'OBJECT' }, __intro: 'SCHEMA' },
      };
    }
    default:
      return { kind: 'err', message: `Cannot query field "${fieldName}" on type "Query"` };
  }
}

function attachRepo(repo: Repo): Repo & { __repo: Repo } {
  return Object.assign(repo, { __repo: repo });
}

function resolveNode(
  parsed: { type: string; parts: string[] },
  ctx: Ctx,
): Resolved {
  switch (parsed.type) {
    case 'Repository': {
      const id = Number(parsed.parts[0]);
      for (const repo of ctx.repos.values()) {
        if (repo.id === id) {
          return { kind: 'ok', value: attachRepo(repo) };
        }
      }
      return { kind: 'ok', value: null };
    }
    case 'Issue': {
      const repoId = Number(parsed.parts[0]);
      const num = Number(parsed.parts[1]);
      for (const repo of ctx.repos.values()) {
        if (repo.id === repoId) {
          const issue = repo.issues.get(num);
          if (issue) return { kind: 'ok', value: { issue, repo } };
          return { kind: 'ok', value: null };
        }
      }
      return { kind: 'ok', value: null };
    }
    case 'PullRequest': {
      const repoId = Number(parsed.parts[0]);
      const num = Number(parsed.parts[1]);
      for (const repo of ctx.repos.values()) {
        if (repo.id === repoId) {
          const pr = repo.prs.get(num);
          if (pr) return { kind: 'ok', value: { pr, repo } };
          return { kind: 'ok', value: null };
        }
      }
      return { kind: 'ok', value: null };
    }
    default:
      return { kind: 'ok', value: null };
  }
}

function resolveRepositoryField(
  parent: unknown,
  fieldName: string,
  args: Record<string, unknown>,
  ctx: Ctx,
  selectionSet?: Selection[],
): Resolved {
  const repo = (parent as { __repo: Repo }).__repo;
  switch (fieldName) {
    case 'id':
      return { kind: 'ok', value: toGlobalId('Repository', repo.id) };
    case 'databaseId':
      return { kind: 'ok', value: repo.id };
    case 'name':
      return { kind: 'ok', value: repo.name };
    case 'nameWithOwner':
      return { kind: 'ok', value: `${repo.owner}/${repo.name}` };
    case 'owner':
      return { kind: 'ok', value: { login: repo.owner, __typename: 'User' } };
    case 'defaultBranchRef':
      return {
        kind: 'ok',
        value: { name: repo.defaultBranch, __typename: 'Ref', __ref: true },
      };
    case 'viewerPermission':
      return { kind: 'ok', value: 'ADMIN' };
    case 'hasIssuesEnabled':
      return { kind: 'ok', value: true };
    case 'issue': {
      const num = Number(args['number']);
      const issue = repo.issues.get(num);
      if (!issue) return { kind: 'ok', value: null };
      return { kind: 'ok', value: { issue, repo } };
    }
    case 'issues':
      return resolveIssuesConnection(repo, args, ctx, selectionSet);
    case 'pullRequest': {
      const num = Number(args['number']);
      const pr = repo.prs.get(num);
      if (!pr) return { kind: 'ok', value: null };
      return { kind: 'ok', value: { pr, repo } };
    }
    case 'pullRequests':
      return resolvePullsConnection(repo, args, ctx, selectionSet);
    default:
      return { kind: 'err', message: `Cannot query field "${fieldName}" on type "Repository"` };
  }
}

function resolveIssuesConnection(
  repo: Repo,
  args: Record<string, unknown>,
  ctx: Ctx,
  selectionSet?: Selection[],
): Resolved {
  let issues = [...repo.issues.values()];

  if (args['states'] !== undefined) {
    const states = args['states'] as unknown[];
    if (Array.isArray(states)) {
      const stateSet = new Set(states.map((s) => String(s).toUpperCase()));
      issues = issues.filter((i) => stateSet.has(i.state.toUpperCase()));
    }
  }

  issues.sort((a, b) => {
    const t = b.createdAt.localeCompare(a.createdAt);
    if (t !== 0) return t;
    return b.number - a.number;
  });

  let start = 0;
  if (args['after'] !== undefined) {
    const cursor = fromGlobalId(String(args['after']));
    if (cursor && cursor.type === 'cursor') {
      const idx = Number(cursor.parts[0]);
      if (Number.isFinite(idx) && idx >= 0) start = idx + 1;
    }
  }

  const remaining = issues.slice(start);
  let slice = remaining;
  if (args['first'] !== undefined) {
    const first = Number(args['first']);
    if (Number.isFinite(first) && first >= 0) slice = remaining.slice(0, first);
  }
  const hasNextPage = remaining.length > slice.length;

  const items: ConnNode[] = slice.map((issue, i) => ({
    node: { issue, repo },
    cursor: toGlobalId('cursor', start + i),
  }));

  return buildConnection('IssueConnection', items, ctx, selectionSet, hasNextPage);
}

function resolvePullsConnection(
  repo: Repo,
  args: Record<string, unknown>,
  ctx: Ctx,
  selectionSet?: Selection[],
): Resolved {
  let prs = [...repo.prs.values()];

  if (args['states'] !== undefined) {
    const states = args['states'] as unknown[];
    if (Array.isArray(states)) {
      const stateSet = new Set(states.map((s) => String(s).toUpperCase()));
      prs = prs.filter((p) => {
        const s = p.merged ? 'MERGED' : p.state.toUpperCase();
        return stateSet.has(s);
      });
    }
  }

  prs.sort((a, b) => {
    const t = b.createdAt.localeCompare(a.createdAt);
    if (t !== 0) return t;
    return b.number - a.number;
  });

  let start = 0;
  if (args['after'] !== undefined) {
    const cursor = fromGlobalId(String(args['after']));
    if (cursor && cursor.type === 'cursor') {
      const idx = Number(cursor.parts[0]);
      if (Number.isFinite(idx) && idx >= 0) start = idx + 1;
    }
  }

  const remaining = prs.slice(start);
  let slice = remaining;
  if (args['first'] !== undefined) {
    const first = Number(args['first']);
    if (Number.isFinite(first) && first >= 0) slice = remaining.slice(0, first);
  }
  const hasNextPage = remaining.length > slice.length;

  const items: ConnNode[] = slice.map((pr, i) => ({
    node: { pr, repo },
    cursor: toGlobalId('cursor', start + i),
  }));

  return buildConnection('PullRequestConnection', items, ctx, selectionSet, hasNextPage);
}

function issueState(issue: Issue): string {
  return issue.state.toUpperCase();
}

function prState(pr: Pull): string {
  if (pr.merged) return 'MERGED';
  return pr.state.toUpperCase();
}

function resolveIssueField(
  parent: unknown,
  fieldName: string,
  args: Record<string, unknown>,
  ctx: Ctx,
  selectionSet?: Selection[],
): Resolved {
  const holder = parent as { issue: Issue; repo: Repo };
  const issue = holder.issue;
  const repo = holder.repo;
  switch (fieldName) {
    case 'id':
      return { kind: 'ok', value: toGlobalId('Issue', repo.id, issue.number) };
    case 'number':
      return { kind: 'ok', value: issue.number };
    case 'title':
      return { kind: 'ok', value: issue.title };
    case 'state':
      return { kind: 'ok', value: issueState(issue) };
    case 'body':
      return { kind: 'ok', value: issue.body };
    case 'createdAt':
      return { kind: 'ok', value: issue.createdAt };
    case 'author':
      return { kind: 'ok', value: { login: ctx.viewerLogin, __typename: 'User' } };
    default:
      return { kind: 'err', message: `Cannot query field "${fieldName}" on type "Issue"` };
  }
}

function resolvePullField(
  parent: unknown,
  fieldName: string,
  args: Record<string, unknown>,
  ctx: Ctx,
  selectionSet?: Selection[],
): Resolved {
  const holder = parent as { pr: Pull; repo: Repo };
  const pr = holder.pr;
  const repo = holder.repo;
  switch (fieldName) {
    case 'id':
      return { kind: 'ok', value: toGlobalId('PullRequest', repo.id, pr.number) };
    case 'number':
      return { kind: 'ok', value: pr.number };
    case 'title':
      return { kind: 'ok', value: pr.title };
    case 'state':
      return { kind: 'ok', value: prState(pr) };
    case 'merged':
      return { kind: 'ok', value: pr.merged };
    case 'headRefName':
      return { kind: 'ok', value: pr.head.ref };
    case 'baseRefName':
      return { kind: 'ok', value: pr.base.ref };
    case 'mergeable': {
      const headTip = resolveTipForMerge(repo, pr.head.ref, pr.head.sha);
      const baseTip = resolveTipForMerge(repo, pr.base.ref, pr.base.sha);
      try {
        const mergeBase = findMergeBase(repo, headTip, baseTip) ?? baseTip;
        const conflicts = checkPullConflicts(repo, mergeBase, headTip, baseTip);
        return { kind: 'ok', value: conflicts ? 'CONFLICTING' : 'MERGEABLE' };
      } catch {
        return { kind: 'ok', value: 'UNKNOWN' };
      }
    }
    case 'files': {
      const headTip = resolveTipForMerge(repo, pr.head.ref, pr.head.sha);
      const baseTip = resolveTipForMerge(repo, pr.base.ref, pr.base.sha);
      let nodes: Array<{ path: string; additions: number; deletions: number; changeType: string }> = [];
      try {
        const mergeBase = findMergeBase(repo, headTip, baseTip) ?? baseTip;
        nodes = getPullFilesDiff(repo, mergeBase, headTip).map((f) => ({
          path: f.path,
          additions: f.additions,
          deletions: f.deletions,
          changeType: f.changeType,
        }));
      } catch {
        nodes = [];
      }
      const items: ConnNode[] = nodes.map((n, i) => ({ node: n, cursor: toGlobalId('cursor', i) }));
      return buildConnection('PullRequestFileConnection', items, ctx, selectionSet);
    }
    default:
      return { kind: 'err', message: `Cannot query field "${fieldName}" on type "PullRequest"` };
  }
}

function resolveTipForMerge(repo: Repo, ref: string, storedSha: string): string {
  if (repo.refs.has(`refs/heads/${ref}`)) return repo.refs.get(`refs/heads/${ref}`)!;
  if (repo.refs.has(ref)) return repo.refs.get(ref)!;
  if (repo.objects.has(ref)) return ref;
  return storedSha;
}

function resolveUserField(
  parent: unknown,
  fieldName: string,
  args: Record<string, unknown>,
  ctx: Ctx,
  selectionSet?: Selection[],
): Resolved {
  const user = parent as { login: string; id?: number };
  switch (fieldName) {
    case 'login':
      return { kind: 'ok', value: user.login };
    case 'id':
      return { kind: 'ok', value: user.id ?? 1000 };
    case 'name':
      return { kind: 'ok', value: 'Ada Iversen' };
    default:
      return { kind: 'err', message: `Cannot query field "${fieldName}" on type "User"` };
  }
}

function resolveRefField(
  parent: unknown,
  fieldName: string,
  args: Record<string, unknown>,
  ctx: Ctx,
  selectionSet?: Selection[],
): Resolved {
  const ref = parent as { name: string };
  switch (fieldName) {
    case 'name':
      return { kind: 'ok', value: ref.name };
    default:
      return { kind: 'err', message: `Cannot query field "${fieldName}" on type "Ref"` };
  }
}

function resolveEdgeField(
  parent: unknown,
  fieldName: string,
  args: Record<string, unknown>,
  ctx: Ctx,
  selectionSet?: Selection[],
): Resolved {
  const edge = parent as { node: unknown; cursor: string };
  switch (fieldName) {
    case 'node':
      return { kind: 'ok', value: edge.node };
    case 'cursor':
      return { kind: 'ok', value: edge.cursor };
    default:
      return { kind: 'err', message: `Cannot query field "${fieldName}" on type "Edge"` };
  }
}

function resolvePageInfoField(
  parent: unknown,
  fieldName: string,
  args: Record<string, unknown>,
  ctx: Ctx,
  selectionSet?: Selection[],
): Resolved {
  const pi = parent as { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null };
  switch (fieldName) {
    case 'hasNextPage':
      return { kind: 'ok', value: pi.hasNextPage };
    case 'hasPreviousPage':
      return { kind: 'ok', value: pi.hasPreviousPage };
    case 'startCursor':
      return { kind: 'ok', value: pi.startCursor };
    case 'endCursor':
      return { kind: 'ok', value: pi.endCursor };
    default:
      return { kind: 'err', message: `Cannot query field "${fieldName}" on type "PageInfo"` };
  }
}

function resolveCommentField(
  parent: unknown,
  fieldName: string,
  args: Record<string, unknown>,
  ctx: Ctx,
  selectionSet?: Selection[],
): Resolved {
  const holder = parent as { comment: Comment; repo: Repo; issueNumber: number };
  const comment = holder.comment;
  const repo = holder.repo;
  switch (fieldName) {
    case 'id':
      return {
        kind: 'ok',
        value: toGlobalId('IssueComment', repo.id, holder.issueNumber, comment.id),
      };
    case 'body':
      return { kind: 'ok', value: comment.body };
    case 'author':
      return { kind: 'ok', value: { login: comment.user.login, __typename: 'User' } };
    default:
      return { kind: 'err', message: `Cannot query field "${fieldName}" on type "Comment"` };
  }
}

function resolveLabelField(
  parent: unknown,
  fieldName: string,
  args: Record<string, unknown>,
  ctx: Ctx,
  selectionSet?: Selection[],
): Resolved {
  const label = parent as { name: string; color: string; description: string };
  switch (fieldName) {
    case 'name':
      return { kind: 'ok', value: label.name };
    case 'color':
      return { kind: 'ok', value: label.color };
    case 'description':
      return { kind: 'ok', value: label.description };
    default:
      return { kind: 'err', message: `Cannot query field "${fieldName}" on type "Label"` };
  }
}

// ---- Mutations ----

function resolveMutationField(
  parent: unknown,
  fieldName: string,
  args: Record<string, unknown>,
  ctx: Ctx,
  selectionSet?: Selection[],
): Resolved {
  const input = (args['input'] ?? {}) as Record<string, unknown>;
  let payload: unknown;
  switch (fieldName) {
    case 'createIssue': {
      const r = mutationCreateIssue(input, ctx);
      if (r.kind === 'err') return r;
      payload = r.value;
      break;
    }
    case 'closeIssue': {
      const r = mutationCloseIssue(input, ctx);
      if (r.kind === 'err') return r;
      payload = r.value;
      break;
    }
    case 'createPullRequest': {
      const r = mutationCreatePullRequest(input, ctx);
      if (r.kind === 'err') return r;
      payload = r.value;
      break;
    }
    case 'mergePullRequest': {
      const r = mutationMergePullRequest(input, ctx);
      if (r.kind === 'err') return r;
      payload = r.value;
      break;
    }
    case 'addComment': {
      const r = mutationAddComment(input, ctx);
      if (r.kind === 'err') return r;
      payload = r.value;
      break;
    }
    default:
      return { kind: 'err', message: `Cannot query field "${fieldName}" on type "Mutation"` };
  }

  if (!selectionSet) return { kind: 'ok', value: payload };
  const shaped = shapePayload(payload, selectionSet, ctx);
  if (shaped.kind === 'err') return shaped;
  return { kind: 'ok', value: { __graphqlResolved: true, result: shaped.value } };
}

function shapePayload(
  payload: unknown,
  selectionSet: Selection[],
  ctx: Ctx,
): Resolved {
  if (!isObject(payload)) return { kind: 'err', message: 'Mutation returned no payload' };
  const out: Record<string, unknown> = {};
  for (const sel of selectionSet) {
    if (sel.kind !== 'field') continue;
    const key = sel.alias ?? sel.name;
    const child = (payload as Record<string, unknown>)[key];
    if (child === undefined) {
      return { kind: 'err', message: `Cannot query field "${key}" on mutation payload` };
    }
    if (sel.selectionSet && isObject(child)) {
      const childType = resolveTypeName(child);
      if (!childType) {
        return { kind: 'err', message: `Cannot query field "${key}"` };
      }
      const sub = executeSelectionSet(sel.selectionSet, child, childType, ctx);
      if (sub.kind === 'err') return sub;
      out[key] = sub.value;
    } else {
      out[key] = child;
    }
  }
  return { kind: 'ok', value: out };
}

function nowIso(): string {
  return new Date().toISOString();
}

function mutationCreateIssue(
  input: Record<string, unknown>,
  ctx: Ctx,
): Resolved {
  const repo = findRepoByGlobalId(String(input['repositoryId']), ctx);
  if (!repo) return { kind: 'err', message: 'Repository not found' };
  const issue: Issue = {
    number: repo.nextIssueNumber++,
    title: String(input['title']),
    body: typeof input['body'] === 'string' ? String(input['body']) : '',
    state: 'open',
    labels: [],
    comments: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
    cachedJsonBuffer: null,
  };
  repo.issues.set(issue.number, issue);
  return { kind: 'ok', value: { issue: { issue, repo } } };
}

function mutationCloseIssue(
  input: Record<string, unknown>,
  ctx: Ctx,
): Resolved {
  const parsed = fromGlobalId(String(input['issueId']));
  if (!parsed || parsed.type !== 'Issue') return { kind: 'err', message: 'Issue not found' };
  const repo = findRepoById(Number(parsed.parts[0]), ctx);
  if (!repo) return { kind: 'err', message: 'Issue not found' };
  const issue = repo.issues.get(Number(parsed.parts[1]));
  if (!issue) return { kind: 'err', message: 'Issue not found' };
  issue.state = 'closed';
  issue.updatedAt = nowIso();
  issue.cachedJsonBuffer = null;
  return { kind: 'ok', value: { issue: { issue, repo } } };
}

function mutationCreatePullRequest(
  input: Record<string, unknown>,
  ctx: Ctx,
): Resolved {
  const repo = findRepoByGlobalId(String(input['repositoryId']), ctx);
  if (!repo) return { kind: 'err', message: 'Repository not found' };
  const rawHead = String(input['headRefName'] ?? input['head']);
  const rawBase = String(input['baseRefName'] ?? input['base']);
  const headSha = resolveRefForCreate(repo, rawHead);
  const baseSha = resolveRefForCreate(repo, rawBase);
  if (!headSha || !baseSha || headSha === baseSha) {
    return { kind: 'err', message: 'Cannot resolve base/head refs or same OID' };
  }
  const pr: Pull = {
    number: repo.nextPrNumber++,
    title: String(input['title']),
    body: typeof input['body'] === 'string' ? String(input['body']) : '',
    state: 'open',
    head: { ref: rawHead, sha: headSha },
    base: { ref: rawBase, sha: baseSha },
    merged: false,
    merged_at: null,
    merge_commit_sha: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  repo.prs.set(pr.number, pr);
  return { kind: 'ok', value: { pullRequest: { pr, repo } } };
}

function mutationMergePullRequest(
  input: Record<string, unknown>,
  ctx: Ctx,
): Resolved {
  const parsed = fromGlobalId(String(input['pullRequestId']));
  if (!parsed || parsed.type !== 'PullRequest') return { kind: 'err', message: 'PullRequest not found' };
  const repo = findRepoById(Number(parsed.parts[0]), ctx);
  if (!repo) return { kind: 'err', message: 'PullRequest not found' };
  const pr = repo.prs.get(Number(parsed.parts[1]));
  if (!pr) return { kind: 'err', message: 'PullRequest not found' };

  if (pr.merged) {
    ctx.errors.push('PullRequest already merged');
    return { kind: 'ok', value: { pullRequest: { pr, repo } } };
  }

  const headTip = resolveCurrentTip(repo, pr.head.ref, pr.head.sha);
  const baseTip = resolveCurrentTip(repo, pr.base.ref, pr.base.sha);
  let mergeBase: string;
  try {
    mergeBase = findMergeBase(repo, headTip, baseTip) ?? baseTip;
    if (checkPullConflicts(repo, mergeBase, headTip, baseTip)) {
      return { kind: 'err', message: 'Merge conflict' };
    }
  } catch {
    return { kind: 'err', message: 'Merge conflict' };
  }

  const baseRef = 'refs/heads/' + pr.base.ref;
  squashMergeCommit(
    repo,
    baseRef,
    headTip,
    `${pr.title} (#${pr.number})`,
    'Ada Iversen <ada@example.com> 1770000000 +0000',
  );
  pr.state = 'closed';
  pr.merged = true;
  pr.merged_at = nowIso();
  pr.merge_commit_sha = headTip;
  repo.generation++;
  return { kind: 'ok', value: { pullRequest: { pr, repo } } };
}

function mutationAddComment(
  input: Record<string, unknown>,
  ctx: Ctx,
): Resolved {
  const parsed = fromGlobalId(String(input['subjectId']));
  if (!parsed || parsed.type !== 'Issue') return { kind: 'err', message: 'Issue not found' };
  const repo = findRepoById(Number(parsed.parts[0]), ctx);
  if (!repo) return { kind: 'err', message: 'Issue not found' };
  const issue = repo.issues.get(Number(parsed.parts[1]));
  if (!issue) return { kind: 'err', message: 'Issue not found' };

  const comment: Comment = {
    id: issue.comments.length + 1,
    body: String(input['body']),
    user: { login: ctx.viewerLogin, id: 1000, type: 'User' },
    created_at: nowIso(),
  };
  issue.comments.push(comment);
  issue.updatedAt = nowIso();
  issue.cachedJsonBuffer = null;

  const node = { ...comment, comment, repo, issueNumber: issue.number };
  const edge = {
    node,
    cursor: Buffer.from(String(comment.id)).toString('base64'),
    __typename: 'Edge',
  };
  return { kind: 'ok', value: { commentEdge: edge } };
}

function findRepoByGlobalId(id: string, ctx: Ctx): Repo | null {
  const parsed = fromGlobalId(id);
  if (!parsed || parsed.type !== 'Repository') return null;
  return findRepoById(Number(parsed.parts[0]), ctx);
}

function findRepoById(id: number, ctx: Ctx): Repo | null {
  for (const repo of ctx.repos.values()) {
    if (repo.id === id) return repo;
  }
  return null;
}

function resolveRefForCreate(repo: Repo, ref: string): string | null {
  const name = stripOwnerPrefix(ref);
  if (repo.refs.has(`refs/heads/${name}`)) return repo.refs.get(`refs/heads/${name}`)!;
  if (repo.refs.has(name)) return repo.refs.get(name)!;
  return null;
}

function resolveCurrentTip(repo: Repo, ref: string, storedSha: string): string {
  const name = stripOwnerPrefix(ref);
  if (repo.refs.has(`refs/heads/${name}`)) return repo.refs.get(`refs/heads/${name}`)!;
  if (repo.refs.has(name)) return repo.refs.get(name)!;
  if (repo.objects.has(ref)) return ref;
  return storedSha;
}

function stripOwnerPrefix(ref: string): string {
  const idx = ref.indexOf(':');
  return idx !== -1 ? ref.slice(idx + 1) : ref;
}

// ---- Handler ----

export interface GraphQLRequest {
  status: number;
  json: unknown;
}

export function createGraphQLHandler(opts: {
  repos: Map<string, Repo>;
  viewerLogin: string;
}): (req: unknown, rawBody: string) => GraphQLRequest {
  const reposMap = opts.repos;
  const login = opts.viewerLogin;

  return async (req: unknown, rawBody: string): Promise<GraphQLRequest> => {
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return { status: 200, json: { errors: [{ message: 'Invalid JSON body' }] } };
    }

    if (Array.isArray(body)) {
      const results: unknown[] = [];
      for (const entry of body) {
        results.push(await handleSingle(entry, reposMap, login));
      }
      return { status: 200, json: results };
    }

    return { status: 200, json: await handleSingle(body, reposMap, login) };
  };
}

async function handleSingle(body: unknown, reposMap: Map<string, Repo>, login: string): Promise<unknown> {
  if (!isObject(body) || typeof body.query !== 'string') {
    return { errors: [{ message: 'Expected a "query" field' }] };
  }

  let doc: Document;
  try {
    doc = parseDocument(body.query);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { errors: [{ message: msg }] };
  }

  const variables: Record<string, unknown> = {};
  if (isObject(body.variables)) {
    for (const k of Object.keys(body.variables)) {
      variables[k] = body.variables[k];
    }
  }

  const op = doc.operations[0];
  if (!op) return { errors: [{ message: 'No operation found' }] };

  const ctx: Ctx = {
    variables,
    fragments: doc.fragments,
    repos: reposMap,
    viewerLogin: login,
    errors: [],
  };

  const errs: string[] = [];
  const data: Record<string, unknown> = {};

  const rootType = op.operation === 'mutation' ? 'Mutation' : 'Query';

  for (const sel of op.selectionSet) {
    const applied = applySelection(sel, {}, rootType, ctx);
    if (applied.kind === 'err') {
      errs.push(applied.message);
      continue;
    }
    const items = applied.value as Array<{ key: string; value: unknown }>;
    for (const item of items) {
      data[item.key] = item.value;
    }
  }

  const allErrs = [...ctx.errors, ...errs];
  if (allErrs.length > 0) {
    return { errors: allErrs.map((message) => ({ message })), ...(Object.keys(data).length > 0 ? { data } : {}) };
  }

  return { data };
}