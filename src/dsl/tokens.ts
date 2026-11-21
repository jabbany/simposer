// Tokenizer and small value parsers shared by the delta and scene parsers.

import type { FacingSpec, TargetRef } from './types.ts';
import { resolvePart } from './vocab.ts';

export class DslError extends Error {
  readonly line: number;
  constructor(message: string, line: number = 0) {
    super(message);
    this.name = 'DslError';
    this.line = line;
  }
}

/** Split a line into tokens. Quoted strings stay one token; `key=value` splits in two. */
export function tokenize(line: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  const hash = findCommentStart(line);
  const src = hash >= 0 ? line.slice(0, hash) : line;
  while ((m = re.exec(src)) !== null) {
    if (m[1] !== undefined) {
      out.push(`"${m[1]}`);
    } else if (m[2] !== undefined) {
      out.push(`"${m[2]}`);
    } else if (m[3] !== undefined) {
      const t = m[3];
      const eq = t.indexOf('=');
      if (eq > 0 && eq < t.length - 1 && /^[a-z_]+$/i.test(t.slice(0, eq))) {
        out.push(t.slice(0, eq), t.slice(eq + 1));
      } else {
        out.push(t);
      }
    }
  }
  return out;
}

function findCommentStart(line: string): number {
  let inQuote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuote !== null) {
      if (c === inQuote) {
        inQuote = null;
      }
    } else if (c === '"' || c === "'") {
      inQuote = c;
    } else if (c === '#') {
      return i;
    }
  }
  return -1;
}

export function isQuoted(tok: string): boolean {
  return tok.startsWith('"');
}

export function unquote(tok: string): string {
  return tok.startsWith('"') ? tok.slice(1) : tok;
}

/** Cursor over a token list with helpful errors. */
export class Tokens {
  private i = 0;
  private readonly toks: string[];
  readonly line: number;
  constructor(toks: string[], line: number) {
    this.toks = toks;
    this.line = line;
  }

  get done(): boolean {
    return this.i >= this.toks.length;
  }

  peek(offset = 0): string | undefined {
    return this.toks[this.i + offset];
  }

  peekLower(offset = 0): string | undefined {
    return this.toks[this.i + offset]?.toLowerCase();
  }

  next(what: string): string {
    const t = this.toks[this.i];
    if (t === undefined) {
      throw new DslError(`expected ${what} but the line ended`, this.line);
    }
    this.i++;
    return t;
  }

  nextLower(what: string): string {
    return this.next(what).toLowerCase();
  }

  accept(...words: string[]): string | undefined {
    const t = this.peekLower();
    if (t !== undefined && words.includes(t)) {
      this.i++;
      return t;
    }
    return undefined;
  }

  expect(...words: string[]): string {
    const t = this.peekLower();
    if (t === undefined || !words.includes(t)) {
      throw new DslError(`expected ${words.map((w) => `"${w}"`).join(' or ')} but got ${t === undefined ? 'end of line' : `"${t}"`}`, this.line);
    }
    this.i++;
    return t;
  }

  number(what: string): number {
    const t = this.next(what);
    const v = parseNumber(t);
    if (v === undefined) {
      throw new DslError(`expected ${what} (a number) but got "${t}"`, this.line);
    }
    return v;
  }

  peekNumber(): boolean {
    const t = this.peek();
    return t !== undefined && parseNumber(t) !== undefined;
  }

  rest(): string[] {
    const r = this.toks.slice(this.i);
    this.i = this.toks.length;
    return r;
  }

  end(): void {
    if (!this.done) {
      throw new DslError(`unexpected extra words: "${this.toks.slice(this.i).join(' ')}"`, this.line);
    }
  }
}

/** Parse numbers with optional units: 1.6, 1.6m, 160cm, 35mm, f/2.8, 30deg, -20 */
export function parseNumber(tok: string): number | undefined {
  const t = tok.toLowerCase().replace(/^f\//, '').replace(/,$/, '');
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+))(m|cm|mm|deg|degrees|s)?$/.exec(t);
  if (!m || m[1] === undefined) {
    return undefined;
  }
  const v = Number(m[1]);
  if (!Number.isFinite(v)) {
    return undefined;
  }
  if (m[2] === 'cm') {
    return v / 100;
  }
  return v;
}

export const ID_RE = /^[a-z][a-z0-9_]*$/;

export function parseId(tok: string, line: number, what = 'a name'): string {
  const id = tok.toLowerCase();
  if (!ID_RE.test(id)) {
    throw new DslError(`${what} must be lowercase letters, digits and _ (got "${tok}")`, line);
  }
  return id;
}

/**
 * Parse a target: `runner.face`, `self.left_hand`, `runner`, `camera`,
 * `point x y z`, `origin`, or a prop name. Bare names become `figure` targets
 * and are re-resolved against props when the command is applied.
 */
export function parseTarget(t: Tokens): TargetRef {
  const tok = t.nextLower('a target (figure.part, figure, camera, or point x y z)');
  if (tok === 'camera' || tok === 'viewer') {
    return { kind: 'camera' };
  }
  if (tok === 'origin' || tok === 'center') {
    return { kind: 'point', x: 0, y: 0, z: 0 };
  }
  if (tok === 'point') {
    const x = t.number('x');
    const y = t.number('y');
    const z = t.number('z');
    return { kind: 'point', x, y, z };
  }
  const dot = tok.indexOf('.');
  if (dot > 0) {
    const fig = tok.slice(0, dot);
    const partWord = tok.slice(dot + 1);
    const part = resolvePart(partWord);
    if (part === undefined) {
      throw new DslError(`unknown body part "${partWord}"`, t.line);
    }
    return { kind: 'part', figure: parseId(fig, t.line, 'figure name'), part };
  }
  // `her face` style is not supported; accept `self` + part as two tokens: `self face`
  return { kind: 'figure', figure: parseId(tok, t.line, 'figure name') };
}

export function formatTarget(tg: TargetRef): string {
  switch (tg.kind) {
    case 'camera':
      return 'camera';
    case 'point':
      return `point ${fmt(tg.x)} ${fmt(tg.y)} ${fmt(tg.z)}`;
    case 'part':
      return `${tg.figure}.${tg.part}`;
    case 'figure':
      return tg.figure;
    case 'prop':
      return tg.prop;
  }
}

/** facing: `<deg>` | `toward <target>` | `away_from <target>` | compass word */
export function parseFacing(t: Tokens): FacingSpec {
  const w = t.peekLower();
  if (w === 'toward' || w === 'towards' || w === 'at') {
    t.next('toward');
    return { kind: 'toward', target: parseTarget(t) };
  }
  if (w === 'away_from' || w === 'away') {
    t.next('away_from');
    t.accept('from');
    return { kind: 'away', target: parseTarget(t) };
  }
  const named: Record<string, number> = { camera_facing: 0, front: 0, forward: 0, back: 180, backward: 180, away: 180, left: 90, right: -90 };
  if (w !== undefined && named[w] !== undefined) {
    t.next('direction');
    return { kind: 'angle', deg: named[w] ?? 0 };
  }
  return { kind: 'angle', deg: normDeg(t.number('a facing angle in degrees')) };
}

export function formatFacing(f: FacingSpec): string {
  switch (f.kind) {
    case 'angle':
      return fmt(f.deg);
    case 'toward':
      return `toward ${formatTarget(f.target)}`;
    case 'away':
      return `away_from ${formatTarget(f.target)}`;
  }
}

/** Normalize degrees to (-180, 180]. */
export function normDeg(d: number): number {
  let x = d % 360;
  if (x <= -180) {
    x += 360;
  }
  if (x > 180) {
    x -= 360;
  }
  return x;
}

/** Format numbers compactly and deterministically (max 3 decimals). */
export function fmt(n: number): string {
  const r = Math.round(n * 1000) / 1000;
  if (Object.is(r, -0)) {
    return '0';
  }
  return String(r);
}
