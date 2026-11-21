// Pose language syntax: expressions, definitions, and their canonical text.
// See docs/pose-system.md.
//
//   expr   := term (('+' | '-') term)*
//   term   := unary (('*' | '/') unary)*
//   unary  := '-' unary | primary
//   primary:= NUMBER | '$' NAME | NAME ['(' [arg (',' arg)*] ')'] | '(' expr ')'
//   arg    := NAME '=' expr | expr
//
//   define pose NAME ['(' param (',' param)* ')'] [STRING] ['=' expr]
//     [override] expr
//     ...
//   end
//   param  := NAME [':' REGION] ['=' expr]

import { DslError } from '../../dsl/tokens.ts';

export type PoseExpr =
  | { k: 'num'; v: number }
  | { k: 'word'; w: string }
  | { k: 'param'; name: string }
  | { k: 'call'; name: string; args: PoseArg[] }
  | { k: 'bin'; op: '+' | '-' | '*' | '/'; a: PoseExpr; b: PoseExpr }
  | { k: 'neg'; a: PoseExpr };

export interface PoseArg {
  name: string | null;
  value: PoseExpr;
}

export interface PoseParam {
  name: string;
  /** slot: the parameter takes a pose limited to this region */
  region: string | null;
  def: PoseExpr | null;
}

export interface PoseLine {
  override: boolean;
  expr: PoseExpr;
}

export interface PoseDef {
  name: string;
  params: PoseParam[];
  description: string;
  /** composite body (lines), or null for the one-line `= expr` form */
  body: PoseLine[] | null;
  expr: PoseExpr | null;
}

// ---------------------------------------------------------------- lexer

type Tok =
  | { t: 'num'; v: number; pos: number }
  | { t: 'name'; v: string; pos: number }
  | { t: 'param'; v: string; pos: number }
  | { t: 'str'; v: string; pos: number }
  | { t: 'sym'; v: string; pos: number };

const NAME_RE = /[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)?/y;
const NUM_RE = /(?:\d+\.?\d*|\.\d+)/y;

function lex(src: string, line: number): Tok[] {
  const out: Tok[] = [];
  const lower = src.toLowerCase();
  let i = 0;
  while (i < src.length) {
    const c = src[i] ?? '';
    if (c === ' ' || c === '\t') {
      i++;
      continue;
    }
    if (c === '#') {
      break;
    }
    if (c === '"' || c === "'") {
      const end = src.indexOf(c, i + 1);
      if (end < 0) {
        throw new DslError('unterminated quote', line);
      }
      out.push({ t: 'str', v: src.slice(i + 1, end), pos: i });
      i = end + 1;
      continue;
    }
    if (c === '$') {
      NAME_RE.lastIndex = i + 1;
      const m = NAME_RE.exec(lower);
      if (m === null) {
        throw new DslError('expected a parameter name after "$"', line);
      }
      out.push({ t: 'param', v: m[0], pos: i });
      i = NAME_RE.lastIndex;
      continue;
    }
    NUM_RE.lastIndex = i;
    const n = NUM_RE.exec(src);
    if (n !== null) {
      out.push({ t: 'num', v: Number(n[0]), pos: i });
      i = NUM_RE.lastIndex;
      continue;
    }
    NAME_RE.lastIndex = i;
    const m = NAME_RE.exec(lower);
    if (m !== null) {
      out.push({ t: 'name', v: m[0], pos: i });
      i = NAME_RE.lastIndex;
      continue;
    }
    if ('(),=+-*/:'.includes(c)) {
      out.push({ t: 'sym', v: c, pos: i });
      i++;
      continue;
    }
    throw new DslError(`unexpected character "${c}" in pose`, line);
  }
  return out;
}

class Cursor {
  i = 0;
  readonly toks: Tok[];
  readonly line: number;
  constructor(toks: Tok[], line: number) {
    this.toks = toks;
    this.line = line;
  }
  peek(): Tok | undefined {
    return this.toks[this.i];
  }
  isSym(s: string, offset = 0): boolean {
    const t = this.toks[this.i + offset];
    return t !== undefined && t.t === 'sym' && t.v === s;
  }
  isName(v?: string): boolean {
    const t = this.toks[this.i];
    return t !== undefined && t.t === 'name' && (v === undefined || t.v === v);
  }
  sym(s: string): void {
    if (!this.isSym(s)) {
      const t = this.peek();
      throw new DslError(`expected "${s}" but got ${t === undefined ? 'end of line' : `"${String(t.v)}"`}`, this.line);
    }
    this.i++;
  }
  name(what: string): string {
    const t = this.peek();
    if (t === undefined || t.t !== 'name') {
      throw new DslError(`expected ${what} but got ${t === undefined ? 'end of line' : `"${String(t.v)}"`}`, this.line);
    }
    this.i++;
    return t.v;
  }
  get done(): boolean {
    return this.i >= this.toks.length;
  }
}

// ---------------------------------------------------------------- parser

function parseExpr(c: Cursor): PoseExpr {
  let a = parseTerm(c);
  while (c.isSym('+') || c.isSym('-')) {
    const op = (c.peek()?.v ?? '+') as '+' | '-';
    c.i++;
    a = { k: 'bin', op, a, b: parseTerm(c) };
  }
  return a;
}

function parseTerm(c: Cursor): PoseExpr {
  let a = parseUnary(c);
  while (c.isSym('*') || c.isSym('/')) {
    const op = (c.peek()?.v ?? '*') as '*' | '/';
    c.i++;
    a = { k: 'bin', op, a, b: parseUnary(c) };
  }
  return a;
}

function parseUnary(c: Cursor): PoseExpr {
  if (c.isSym('-')) {
    c.i++;
    const a = parseUnary(c);
    return a.k === 'num' ? { k: 'num', v: -a.v } : { k: 'neg', a };
  }
  return parsePrimary(c);
}

function parsePrimary(c: Cursor): PoseExpr {
  const t = c.peek();
  if (t === undefined) {
    throw new DslError('expected a pose or a value but the line ended', c.line);
  }
  if (t.t === 'num') {
    c.i++;
    return { k: 'num', v: t.v };
  }
  if (t.t === 'param') {
    c.i++;
    return { k: 'param', name: t.v };
  }
  if (t.t === 'sym' && t.v === '(') {
    c.i++;
    const e = parseExpr(c);
    c.sym(')');
    return e;
  }
  if (t.t === 'name') {
    c.i++;
    if (!c.isSym('(')) {
      return { k: 'word', w: t.v };
    }
    c.i++;
    const args: PoseArg[] = [];
    if (!c.isSym(')')) {
      for (;;) {
        if (c.isName() && c.isSym('=', 1)) {
          const name = c.name('an argument name');
          c.sym('=');
          args.push({ name, value: parseExpr(c) });
        } else {
          args.push({ name: null, value: parseExpr(c) });
        }
        if (c.isSym(',')) {
          c.i++;
          continue;
        }
        break;
      }
    }
    c.sym(')');
    return { k: 'call', name: t.v, args };
  }
  throw new DslError(`unexpected "${String(t.v)}" in pose`, c.line);
}

/** Parse a whole string as one pose expression. */
export function parsePoseExpr(src: string, line = 0): PoseExpr {
  const c = new Cursor(lex(src, line), line);
  const e = parseExpr(c);
  if (!c.done) {
    throw new DslError(`unexpected "${String(c.peek()?.v)}" after the pose`, line);
  }
  return e;
}

/**
 * Parse a pose expression at the start of `src` and return where it ends, so
 * that commands like `add bob pose walk(phase = 0.2) facing 90` can continue.
 * Without parentheses only the name is taken.
 */
export function parsePoseExprPrefix(src: string, line = 0): { expr: PoseExpr; rest: string } {
  const toks = lex(src, line);
  const c = new Cursor(toks, line);
  const t = c.peek();
  if (t === undefined || t.t !== 'name') {
    throw new DslError('expected a pose name', line);
  }
  let expr: PoseExpr;
  if (c.isSym('(', 1)) {
    expr = parsePrimary(c);
  } else {
    c.i++;
    expr = { k: 'word', w: t.v };
  }
  const next = c.peek();
  return { expr, rest: next === undefined ? '' : src.slice(next.pos) };
}

/** Does a pose header or line leave a parenthesis open (continues on the next line)? */
export function parenDepth(src: string): number {
  let d = 0;
  let quote: string | null = null;
  for (const ch of src) {
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#') {
      break;
    } else if (ch === '(') {
      d++;
    } else if (ch === ')') {
      d--;
    }
  }
  return d;
}

/**
 * Parse the header of a definition (`define pose ...` already stripped):
 * name, params, description, and the optional one-line `= expr` body.
 */
export function parseDefineHeader(src: string, line: number): { name: string; params: PoseParam[]; description: string; expr: PoseExpr | null } {
  const c = new Cursor(lex(src, line), line);
  const name = c.name('a pose name');
  const params: PoseParam[] = [];
  if (c.isSym('(')) {
    c.i++;
    if (!c.isSym(')')) {
      for (;;) {
        const pname = c.name('a parameter name');
        let region: string | null = null;
        let def: PoseExpr | null = null;
        if (c.isSym(':')) {
          c.i++;
          region = c.name('a body region');
        }
        if (c.isSym('=')) {
          c.i++;
          def = parseExpr(c);
        }
        params.push({ name: pname, region, def });
        if (c.isSym(',')) {
          c.i++;
          continue;
        }
        break;
      }
    }
    c.sym(')');
  }
  let description = '';
  const s = c.peek();
  if (s !== undefined && s.t === 'str') {
    description = s.v;
    c.i++;
  }
  let expr: PoseExpr | null = null;
  if (c.isSym('=')) {
    c.i++;
    expr = parseExpr(c);
  }
  if (!c.done) {
    throw new DslError(`unexpected "${String(c.peek()?.v)}" in the pose definition`, line);
  }
  return { name, params, description, expr };
}

/** Parse one body line of a composite definition. */
export function parsePoseLine(src: string, line: number): PoseLine {
  const c = new Cursor(lex(src, line), line);
  let override = false;
  if (c.isName('override') && c.toks.length > 1) {
    c.i++;
    override = true;
  }
  const expr = parseExpr(c);
  if (!c.done) {
    throw new DslError(`unexpected "${String(c.peek()?.v)}" after the pose`, line);
  }
  return { override, expr };
}

/**
 * Parse a full definition from its source lines: the header line(s) after
 * `define pose`, then (unless one-line) body lines up to `end`.
 */
export function parseDefinition(header: string, bodyLines: { text: string; line: number }[], line: number): PoseDef {
  const h = parseDefineHeader(header, line);
  if (h.expr !== null) {
    if (bodyLines.length > 0) {
      throw new DslError('a one-line pose definition ("= ...") cannot also have body lines', line);
    }
    return { name: h.name, params: h.params, description: h.description, body: null, expr: h.expr };
  }
  const body = bodyLines.map((b) => parsePoseLine(b.text, b.line));
  if (body.length === 0) {
    throw new DslError(`pose ${h.name} has no body: add lines and "end", or use "= <pose>"`, line);
  }
  return { name: h.name, params: h.params, description: h.description, body, expr: null };
}

/** Does this line start a pose definition? */
export function isDefineLine(text: string): boolean {
  return /^\s*define\s+pose\b/i.test(text);
}

/**
 * Read one `define pose` block starting at lines[start]: header (continued
 * over lines while a parenthesis is open), then body lines up to `end` unless
 * the header is a one-line `= expr` definition. Returns the definition and
 * the index of the first line after it. Line numbers are start-based + base.
 */
export function readDefineBlock(lines: string[], start: number, base = 1): { def: PoseDef; next: number } {
  const lineNo = start + base;
  let i = start;
  let header = (lines[i] ?? '').replace(/^\s*define\s+pose\b/i, '');
  i++;
  while (parenDepth(header) > 0 && i < lines.length) {
    header += ` ${lines[i] ?? ''}`;
    i++;
  }
  if (parenDepth(header) !== 0) {
    throw new DslError('unbalanced parentheses in the pose definition', lineNo);
  }
  // the description and a one-line definition's "= expr" may follow on their own lines
  if (/^\s*"/.test(lines[i] ?? '') && !/"\s*$/.test(header.replace(/#.*$/, '').trim())) {
    header += ` ${(lines[i] ?? '').trim()}`;
    i++;
  }
  if (/^\s*=/.test(lines[i] ?? '')) {
    header += ` ${(lines[i] ?? '').trim()}`;
    i++;
    while (parenDepth(header) > 0 && i < lines.length) {
      header += ` ${(lines[i] ?? '').trim()}`;
      i++;
    }
  }
  const h = parseDefineHeader(header, lineNo);
  if (h.expr !== null) {
    return { def: { name: h.name, params: h.params, description: h.description, body: null, expr: h.expr }, next: i };
  }
  const body: { text: string; line: number }[] = [];
  for (;;) {
    if (i >= lines.length) {
      throw new DslError(`pose ${h.name}: missing "end"`, lineNo);
    }
    const raw = lines[i] ?? '';
    const trimmed = raw.replace(/#.*$/, '').trim();
    if (trimmed.toLowerCase() === 'end') {
      i++;
      break;
    }
    if (trimmed.length === 0) {
      i++;
      continue;
    }
    if (isDefineLine(trimmed)) {
      throw new DslError(`pose ${h.name}: missing "end" before the next definition`, i + base);
    }
    let text = trimmed;
    const at = i + base;
    i++;
    while (parenDepth(text) > 0 && i < lines.length) {
      text += ` ${(lines[i] ?? '').trim()}`;
      i++;
    }
    body.push({ text, line: at });
  }
  return { def: parseDefinition(header, body, lineNo), next: i };
}

// ---------------------------------------------------------------- printing

function fmtNum(n: number): string {
  const r = Math.round(n * 1000) / 1000;
  return Object.is(r, -0) ? '0' : String(r);
}

const PREC: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2 };

export function formatPoseExpr(e: PoseExpr, parentPrec = 0): string {
  switch (e.k) {
    case 'num':
      return fmtNum(e.v);
    case 'word':
      return e.w;
    case 'param':
      return `$${e.name}`;
    case 'neg':
      return `-${formatPoseExpr(e.a, 3)}`;
    case 'bin': {
      const p = PREC[e.op] ?? 1;
      // right operand of - and / needs parentheses at equal precedence
      const s = `${formatPoseExpr(e.a, p)} ${e.op} ${formatPoseExpr(e.b, e.op === '-' || e.op === '/' ? p + 1 : p)}`;
      return p < parentPrec ? `(${s})` : s;
    }
    case 'call':
      return `${e.name}(${e.args.map((a) => (a.name === null ? formatPoseExpr(a.value) : `${a.name} = ${formatPoseExpr(a.value)}`)).join(', ')})`;
  }
}

/** Canonical text of a definition, as it appears in the scene DSL. */
export function formatDefinition(d: PoseDef): string[] {
  const params = d.params.map((p) => `${p.name}${p.region !== null ? `: ${p.region}` : ''}${p.def !== null ? ` = ${formatPoseExpr(p.def)}` : ''}`);
  const head = `define pose ${d.name}${params.length > 0 ? `(${params.join(', ')})` : ''}${d.description.length > 0 ? ` "${d.description.replace(/"/g, "'")}"` : ''}`;
  if (d.expr !== null) {
    return [`${head} = ${formatPoseExpr(d.expr)}`];
  }
  return [head, ...(d.body ?? []).map((l) => `  ${l.override ? 'override ' : ''}${formatPoseExpr(l.expr)}`), 'end'];
}

// ---------------------------------------------------------------- helpers for figures

/** Name of the outermost pose of an expression (`walk` for `walk(phase = 0.3)`). */
export function poseName(e: PoseExpr): string {
  return e.k === 'call' ? e.name : e.k === 'word' ? e.w : '';
}

/** A literal numeric argument of the outermost pose, if given. */
export function poseArgNumber(e: PoseExpr, name: string): number | undefined {
  if (e.k !== 'call') {
    return undefined;
  }
  const a = e.args.find((x) => x.name === name);
  return a !== undefined && a.value.k === 'num' ? a.value.v : undefined;
}

/** Copy of a pose expression with a named argument of the outermost pose set. */
export function withPoseArg(e: PoseExpr, name: string, value: PoseExpr): PoseExpr {
  const base: { name: string; args: PoseArg[] } = e.k === 'call' ? { name: e.name, args: e.args } : { name: poseName(e), args: [] };
  const args = base.args.filter((a) => a.name !== name);
  args.push({ name, value });
  return { k: 'call', name: base.name, args };
}
