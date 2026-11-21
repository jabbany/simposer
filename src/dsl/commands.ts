// Delta DSL: one command per line. Each command is a high-level edit of the
// scene (add a figure, change a pose, aim the camera). Parsing is pure; see
// apply.ts for the deterministic application to a SceneDoc.

import type { FacingSpec, TargetRef } from './types.ts';
import {
  BODY_PRESET_BY_NAME, EFFECTORS, GROUND_KINDS, HAND_SHAPES, PROP_KINDS, RELATIONS, RENDER_STYLES,
  isBodyParam, resolveDof, resolveEffector, resolveJoint,
} from './vocab.ts';
import type { BodyParams, Effector, GroundKind, HandShape, PropKind, Relation, RenderStyle } from './vocab.ts';
import { DslError, Tokens, parseFacing, parseId, parseNumber, parseTarget, tokenize, unquote } from './tokens.ts';
import { isDefineLine, parsePoseExprPrefix, readDefineBlock, withPoseArg } from '../pose/lang/ast.ts';
import type { PoseDef, PoseExpr } from '../pose/lang/ast.ts';

export type Selector =
  | { kind: 'ids'; ids: string[] }
  | { kind: 'group'; group: string }
  | { kind: 'all' };

export interface Placement {
  relation: Relation;
  target: TargetRef;
  distance: number | null;
}

export type CameraOp =
  | { op: 'position'; x: number; y: number; z: number }
  | { op: 'height'; y: number }
  | { op: 'look_at'; target: TargetRef }
  | { op: 'angles'; yaw: number; pitch: number }
  | { op: 'orbit'; target: TargetRef; distance: number | null; azimuth: number | null; elevation: number | null }
  | { op: 'lens'; mm: number }
  | { op: 'aperture'; fstop: number }
  | { op: 'focus'; target: TargetRef | null; meters: number | null }
  | { op: 'dof'; on: boolean }
  | { op: 'roll'; deg: number }
  | { op: 'frame'; frame: string };

export type Command =
  | { op: 'title'; text: string }
  | {
    op: 'add'; id: string; model: string | null; body: string | null; overrides: Partial<BodyParams>;
    at: { x: number; z: number } | null; place: Placement | null; facing: FacingSpec | null;
    pose: PoseExpr | null; phase: number | null; elevation: number | null;
  }
  | {
    op: 'add_crowd'; group: string; count: number; models: string[]; bodies: string[];
    around: TargetRef | null; at: { x: number; z: number } | null; radius: number; pose: PoseExpr;
    facing: FacingSpec | 'random' | null; seed: number;
  }
  | { op: 'define'; def: PoseDef }
  | { op: 'undefine'; name: string }
  | { op: 'prop'; id: string; kind: PropKind; at: { x: number; z: number } | null; place: Placement | null; facing: number; size: [number, number, number] | null }
  | { op: 'remove'; sel: Selector }
  | { op: 'rename'; from: string; to: string }
  | { op: 'group'; sel: Selector; group: string | null }
  | { op: 'model'; sel: Selector; model: string }
  | { op: 'body'; sel: Selector; body: string | null; overrides: Partial<BodyParams> }
  | { op: 'place'; sel: Selector; at: { x: number; z: number } | null; place: Placement | null }
  | { op: 'move'; sel: Selector; dir: 'forward' | 'back' | 'left' | 'right'; distance: number }
  | { op: 'move_by'; sel: Selector; dx: number; dz: number }
  | { op: 'face'; sel: Selector; facing: FacingSpec }
  | { op: 'turn'; sel: Selector; deg: number }
  | { op: 'elevate'; sel: Selector; meters: number }
  | { op: 'pose'; sel: Selector; pose: PoseExpr }
  | { op: 'phase'; sel: Selector; phase: number }
  | { op: 'set'; sel: Selector; joint: string; dof: string; deg: number; relative: boolean }
  | { op: 'reach'; sel: Selector; effector: Effector; target: TargetRef }
  | { op: 'release'; sel: Selector; effector: Effector | 'all' }
  | { op: 'look'; sel: Selector; target: TargetRef | null }
  | { op: 'hand'; sel: Selector; side: 'left' | 'right' | 'both'; shape: HandShape }
  | { op: 'reset'; sel: Selector; what: string }
  | { op: 'camera'; cam: CameraOp }
  | { op: 'light'; azimuth: number | null; elevation: number | null; intensity: number | null; fill: number | null }
  | { op: 'ground'; kind: GroundKind }
  | { op: 'style'; style: RenderStyle };

/** Every word that can start a command line (used to filter chatty LLM output). */
export const COMMAND_WORDS = new Set([
  'title', 'add', 'add_crowd', 'crowd', 'prop', 'add_prop', 'remove', 'delete', 'rename', 'group', 'model', 'body', 'height',
  'place', 'move', 'face', 'turn', 'elevate', 'pose', 'phase', 'set', 'adjust', 'reach', 'touch', 'put', 'release', 'look',
  'hand', 'hands', 'reset', 'camera', 'light', 'ground', 'style', 'define', 'undefine', 'end',
]);

export interface ParsedLine {
  line: number;
  text: string;
  command: Command;
}

export interface ParseResult {
  commands: ParsedLine[];
  errors: DslError[];
}

/** Parse delta DSL text. Never throws; collects per-line errors. */
export function parseDelta(text: string): ParseResult {
  const commands: ParsedLine[] = [];
  const errors: DslError[] = [];
  const lines = text.split(/\r?\n/);
  let idx = 0;
  while (idx < lines.length) {
    const raw = lines[idx] ?? '';
    const lineNo = idx + 1;
    // pose definitions span several lines, up to "end"
    if (isDefineLine(raw)) {
      try {
        const r = readDefineBlock(lines, idx);
        commands.push({ line: lineNo, text: lines.slice(idx, r.next).join('\n').trim(), command: { op: 'define', def: r.def } });
        idx = r.next;
      } catch (e) {
        if (!(e instanceof DslError)) {
          throw e;
        }
        errors.push(e.line === 0 ? new DslError(e.message, lineNo) : e);
        // skip the rest of the broken block
        idx++;
        while (idx < lines.length && !/^\s*end\s*(#.*)?$/i.test(lines[idx] ?? '') && !isDefineLine(lines[idx] ?? '')) {
          idx++;
        }
        if (idx < lines.length && /^\s*end\s*(#.*)?$/i.test(lines[idx] ?? '')) {
          idx++;
        }
      }
      continue;
    }
    idx++;
    const toks = tokenize(raw);
    if (toks.length === 0) {
      continue;
    }
    try {
      const command = parseCommand(new Tokens(toks, lineNo), raw);
      commands.push({ line: lineNo, text: raw.trim(), command });
    } catch (e) {
      if (e instanceof DslError) {
        errors.push(e.line === 0 ? new DslError(e.message, lineNo) : e);
      } else {
        throw e;
      }
    }
  }
  return { commands, errors };
}

/** Skip `n` whitespace-separated words of a raw line; return the rest. */
function afterWords(raw: string, n: number): string {
  let s = raw.trimStart();
  for (let i = 0; i < n; i++) {
    s = s.replace(/^\S+\s*/, '');
  }
  return s;
}

/**
 * Parse `<pose expression> [phase <n>]` at the start of `src`. `phase` after
 * a pose name is the older way to give the phase argument.
 */
function parsePoseClause(src: string, line: number): { pose: PoseExpr; rest: string } {
  const r = parsePoseExprPrefix(src, line);
  let pose = r.expr;
  let rest = r.rest;
  const m = /^phase\s+(\S+)\s*/i.exec(rest);
  if (m !== null) {
    const v = parseNumber(m[1] ?? '');
    if (v === undefined) {
      throw new DslError(`expected a phase number but got "${m[1] ?? ''}"`, line);
    }
    pose = withPoseArg(pose, 'phase', { k: 'num', v });
    rest = rest.slice(m[0].length);
  }
  return { pose, rest };
}

/**
 * Lines like `add bob ... pose walk(phase = 0.2) facing 90` carry a pose
 * expression among word attributes: cut it out of the raw line.
 */
function extractPose(raw: string, line: number): { raw: string; pose: PoseExpr | null } {
  const m = /(^|\s)pose\s+/i.exec(raw);
  if (m === null) {
    return { raw, pose: null };
  }
  const start = m.index + m[0].length;
  const r = parsePoseClause(raw.slice(start), line);
  return { raw: `${raw.slice(0, m.index)} ${r.rest}`, pose: r.pose };
}

function parseSelector(t: Tokens): Selector {
  const tok = t.nextLower('a figure name, @group, or *');
  if (tok === '*' || tok === 'all' || tok === 'everyone') {
    return { kind: 'all' };
  }
  if (tok.startsWith('@')) {
    return { kind: 'group', group: parseId(tok.slice(1), t.line, 'group name') };
  }
  const ids = tok.split(',').filter((s) => s.length > 0).map((s) => parseId(s, t.line, 'figure name'));
  if (ids.length === 0) {
    throw new DslError('empty selector', t.line);
  }
  return { kind: 'ids', ids };
}

function parseModelName(t: Tokens): string {
  return parseId(t.next('a model name'), t.line, 'model name');
}

function parseBodyName(t: Tokens): string {
  const b = t.nextLower('a body preset');
  if (!BODY_PRESET_BY_NAME.has(b)) {
    throw new DslError(`unknown body "${b}". Known: ${[...BODY_PRESET_BY_NAME.keys()].join(', ')}`, t.line);
  }
  return b;
}

function parsePlacement(t: Tokens): Placement {
  const relWord = t.nextLower('a relation');
  const rel = normalizeRelation(relWord);
  if (rel === undefined) {
    throw new DslError(`unknown relation "${relWord}". Use one of: ${RELATIONS.join(', ')}`, t.line);
  }
  const target = parseTarget(t);
  let distance: number | null = null;
  if (t.accept('distance', 'by', 'gap')) {
    distance = t.number('distance in meters');
  } else if (t.peekNumber()) {
    distance = t.number('distance in meters');
  }
  return { relation: rel, target, distance };
}

function normalizeRelation(w: string): Relation | undefined {
  const map: Record<string, Relation> = {
    left_of: 'left_of', right_of: 'right_of', in_front_of: 'in_front_of', front_of: 'in_front_of', ahead_of: 'in_front_of',
    behind: 'behind', near: 'near', next_to: 'near', beside: 'near',
  };
  return map[w];
}

function parseXZ(t: Tokens): { x: number; z: number } {
  const x = t.number('x');
  const z = t.number('z');
  return { x, z };
}

function parseOverrides(t: Tokens, out: Partial<BodyParams>): boolean {
  const k = t.peekLower();
  if (k !== undefined && isBodyParam(k)) {
    t.next('body parameter');
    out[k] = t.number(`value for ${k}`);
    return true;
  }
  return false;
}

function parseCommand(t0: Tokens, raw: string): Command {
  let t = t0;
  const op = t.nextLower('a command');
  switch (op) {
    case 'title': {
      const words = t.rest().map(unquote);
      return { op: 'title', text: words.join(' ') };
    }
    case 'add': {
      if (t.peekLower() === 'prop') {
        t.next('prop');
        return parseProp(t);
      }
      const ex = extractPose(raw, t.line);
      if (ex.pose !== null) {
        t = new Tokens(tokenize(ex.raw), t.line);
        t.next('add');
      }
      if (t.peekLower() === 'crowd') {
        t.next('crowd');
        return parseCrowd(t, ex.pose);
      }
      const id = parseId(t.next('a figure name'), t.line, 'figure name');
      const cmd: Command & { op: 'add' } = {
        op: 'add', id, model: null, body: null, overrides: {}, at: null, place: null, facing: null, pose: ex.pose, phase: null, elevation: null,
      };
      while (!t.done) {
        if (parseOverrides(t, cmd.overrides)) {
          continue;
        }
        const k = t.nextLower('an attribute (model, body, at, facing, pose, ...)');
        if (k === 'model') {
          cmd.model = parseModelName(t);
        } else if (k === 'body') {
          cmd.body = parseBodyName(t);
        } else if (k === 'at') {
          cmd.at = parseXZ(t);
        } else if (k === 'place' || k === 'placed') {
          cmd.place = parsePlacement(t);
        } else if (normalizeRelation(k) !== undefined) {
          // `add bob left_of alice 1.5`
          cmd.place = parsePlacement(new Tokens([k, ...t.rest()], t.line));
        } else if (k === 'facing' || k === 'face') {
          cmd.facing = parseFacing(t);
        } else if (k === 'phase') {
          cmd.phase = t.number('phase 0..1');
        } else if (k === 'elevation') {
          cmd.elevation = t.number('elevation in meters');
        } else {
          throw new DslError(`unknown add attribute "${k}"`, t.line);
        }
      }
      return cmd;
    }
    case 'add_crowd':
    case 'crowd': {
      const ex = extractPose(raw, t.line);
      if (ex.pose !== null) {
        t = new Tokens(tokenize(ex.raw), t.line);
        t.next('crowd');
      }
      return parseCrowd(t, ex.pose);
    }
    case 'undefine': {
      t.expect('pose');
      const name = parseId(t.next('a pose name'), t.line, 'pose name');
      t.end();
      return { op: 'undefine', name };
    }
    case 'end':
      throw new DslError('"end" without a "define pose" above it', t.line);
    case 'prop':
    case 'add_prop':
      return parseProp(t);
    case 'remove':
    case 'delete':
      return { op: 'remove', sel: parseSelector(t) };
    case 'rename': {
      const from = parseId(t.next('old name'), t.line);
      t.accept('to', 'as');
      const to = parseId(t.next('new name'), t.line);
      t.end();
      return { op: 'rename', from, to };
    }
    case 'group': {
      const sel = parseSelector(t);
      const g = t.nextLower('group name or none');
      t.end();
      return { op: 'group', sel, group: g === 'none' ? null : parseId(g.replace(/^@/, ''), t.line, 'group name') };
    }
    case 'model': {
      const sel = parseSelector(t);
      const model = parseModelName(t);
      t.end();
      return { op: 'model', sel, model };
    }
    case 'body': {
      const sel = parseSelector(t);
      const overrides: Partial<BodyParams> = {};
      let body: string | null = null;
      while (!t.done) {
        if (parseOverrides(t, overrides)) {
          continue;
        }
        body = parseBodyName(t);
      }
      return { op: 'body', sel, body, overrides };
    }
    case 'height': {
      const sel = parseSelector(t);
      const h = t.number('height in meters');
      t.end();
      return { op: 'body', sel, body: null, overrides: { height: h } };
    }
    case 'place': {
      const sel = parseSelector(t);
      if (t.accept('at')) {
        const at = parseXZ(t);
        t.end();
        return { op: 'place', sel, at, place: null };
      }
      const place = parsePlacement(t);
      t.end();
      return { op: 'place', sel, at: null, place };
    }
    case 'move': {
      const sel = parseSelector(t);
      if (t.accept('by')) {
        const dx = t.number('dx');
        const dz = t.number('dz');
        t.end();
        return { op: 'move_by', sel, dx, dz };
      }
      const d = t.expect('forward', 'forwards', 'back', 'backward', 'backwards', 'left', 'right');
      const dir = d.startsWith('forward') ? 'forward' : d.startsWith('back') ? 'back' : (d as 'left' | 'right');
      const distance = t.number('distance in meters');
      t.end();
      return { op: 'move', sel, dir, distance };
    }
    case 'face': {
      const sel = parseSelector(t);
      const facing = parseFacing(t);
      t.end();
      return { op: 'face', sel, facing };
    }
    case 'turn': {
      const sel = parseSelector(t);
      const d = t.expect('left', 'right', 'around');
      const deg = d === 'around' ? 180 : t.number('degrees');
      t.end();
      return { op: 'turn', sel, deg: d === 'right' ? -deg : deg };
    }
    case 'elevate': {
      const sel = parseSelector(t);
      const meters = t.number('meters');
      t.end();
      return { op: 'elevate', sel, meters };
    }
    case 'pose': {
      const sel = parseSelector(t);
      const r = parsePoseClause(afterWords(raw, 2), t.line);
      if (r.rest.trim().length > 0) {
        throw new DslError(`unexpected "${r.rest.trim()}" after the pose`, t.line);
      }
      return { op: 'pose', sel, pose: r.pose };
    }
    case 'phase': {
      const sel = parseSelector(t);
      const phase = t.number('phase 0..1');
      t.end();
      return { op: 'phase', sel, phase };
    }
    case 'set':
    case 'adjust': {
      const sel = parseSelector(t);
      const jWord = t.nextLower('a joint');
      const joint = resolveJoint(jWord);
      if (joint === undefined) {
        throw new DslError(`unknown joint "${jWord}"`, t.line);
      }
      const words: string[] = [];
      while (!t.done && !t.peekNumber()) {
        words.push(t.nextLower('motion'));
      }
      if (words.length === 0 && joint.dofs.length === 1 && joint.dofs[0] !== undefined) {
        words.push(joint.dofs[0].name);
      }
      const phrase = words.join('_');
      const r = resolveDof(joint, phrase);
      if (r === undefined) {
        throw new DslError(`unknown motion "${words.join(' ')}" for ${joint.name}. Use: ${joint.dofs.map((d) => d.name).join(', ')}`, t.line);
      }
      const deg = t.number('degrees') * r.sign;
      t.accept('deg', 'degrees');
      t.end();
      return { op: 'set', sel, joint: joint.name, dof: r.dof.name, deg, relative: op === 'adjust' };
    }
    case 'reach':
    case 'touch':
    case 'put': {
      const sel = parseSelector(t);
      const eWord = t.nextLower('left_hand, right_hand, left_foot or right_foot');
      const effector = resolveEffector(eWord);
      if (effector === undefined) {
        throw new DslError(`unknown effector "${eWord}". Use: ${EFFECTORS.join(', ')}`, t.line);
      }
      t.accept('to', 'on', 'at', 'toward');
      const target = parseTarget(t);
      t.end();
      return { op: 'reach', sel, effector, target };
    }
    case 'release': {
      const sel = parseSelector(t);
      const w = t.nextLower('effector or all');
      const effector = w === 'all' ? 'all' : resolveEffector(w);
      if (effector === undefined) {
        throw new DslError(`unknown effector "${w}"`, t.line);
      }
      t.end();
      return { op: 'release', sel, effector };
    }
    case 'look': {
      const sel = parseSelector(t);
      if (t.accept('forward', 'ahead', 'none', 'straight')) {
        t.end();
        return { op: 'look', sel, target: null };
      }
      t.accept('at', 'toward');
      const target = parseTarget(t);
      t.end();
      return { op: 'look', sel, target };
    }
    case 'hand':
    case 'hands': {
      const sel = parseSelector(t);
      const side = t.expect('left', 'right', 'both') as 'left' | 'right' | 'both';
      const shape = t.nextLower('a hand shape');
      if (!(HAND_SHAPES as readonly string[]).includes(shape)) {
        throw new DslError(`unknown hand shape "${shape}". Use: ${HAND_SHAPES.join(', ')}`, t.line);
      }
      t.end();
      return { op: 'hand', sel, side, shape: shape as HandShape };
    }
    case 'reset': {
      const sel = parseSelector(t);
      const w = t.done ? 'all' : t.nextLower('what to reset');
      if (w !== 'all' && w !== 'joints' && w !== 'reaches' && w !== 'look' && w !== 'hands' && resolveJoint(w) === undefined) {
        throw new DslError(`reset expects all, joints, reaches, look, hands, or a joint name (got "${w}")`, t.line);
      }
      t.end();
      return { op: 'reset', sel, what: resolveJoint(w)?.name ?? w };
    }
    case 'camera':
      return { op: 'camera', cam: parseCamera(t) };
    case 'light': {
      t.accept('sun', 'key');
      const cmd: Command & { op: 'light' } = { op: 'light', azimuth: null, elevation: null, intensity: null, fill: null };
      while (!t.done) {
        const k = t.expect('azimuth', 'elevation', 'intensity', 'fill');
        const v = t.number(k);
        if (k === 'azimuth') {
          cmd.azimuth = v;
        } else if (k === 'elevation') {
          cmd.elevation = v;
        } else if (k === 'intensity') {
          cmd.intensity = v;
        } else {
          cmd.fill = v;
        }
      }
      return cmd;
    }
    case 'ground': {
      const k = t.nextLower('ground kind');
      if (!(GROUND_KINDS as readonly string[]).includes(k)) {
        throw new DslError(`unknown ground "${k}". Use: ${GROUND_KINDS.join(', ')}`, t.line);
      }
      t.end();
      return { op: 'ground', kind: k as GroundKind };
    }
    case 'style': {
      const k = t.nextLower('render style');
      if (!(RENDER_STYLES as readonly string[]).includes(k)) {
        throw new DslError(`unknown style "${k}". Use: ${RENDER_STYLES.join(', ')}`, t.line);
      }
      t.end();
      return { op: 'style', style: k as RenderStyle };
    }
    default:
      throw new DslError(`unknown command "${op}"`, t.line);
  }
}

function parseCrowd(t: Tokens, pose: PoseExpr | null): Command {
  const group = parseId(t.next('a crowd group name').replace(/^@/, ''), t.line, 'group name');
  const cmd: Command & { op: 'add_crowd' } = {
    op: 'add_crowd', group, count: 6, models: [], bodies: [], around: null, at: null, radius: 5, pose: pose ?? { k: 'word', w: 'walk' }, facing: null, seed: 1,
  };
  while (!t.done) {
    const k = t.nextLower('a crowd attribute');
    if (k === 'count') {
      cmd.count = Math.max(1, Math.min(40, Math.round(t.number('count'))));
    } else if (k === 'models' || k === 'model') {
      cmd.models = t.next('model list').toLowerCase().split(',').filter((s) => s.length > 0).map((s) => parseId(s, t.line, 'model'));
    } else if (k === 'bodies' || k === 'body') {
      cmd.bodies = t.next('body list').toLowerCase().split(',').filter((s) => s.length > 0);
      for (const b of cmd.bodies) {
        if (!BODY_PRESET_BY_NAME.has(b)) {
          throw new DslError(`unknown body "${b}"`, t.line);
        }
      }
    } else if (k === 'around') {
      cmd.around = parseTarget(t);
    } else if (k === 'at') {
      cmd.at = parseXZ(t);
    } else if (k === 'radius') {
      cmd.radius = t.number('radius in meters');
    } else if (k === 'facing') {
      if (t.accept('random')) {
        cmd.facing = 'random';
      } else {
        cmd.facing = parseFacing(t);
      }
    } else if (k === 'seed') {
      cmd.seed = Math.round(t.number('seed'));
    } else {
      throw new DslError(`unknown crowd attribute "${k}"`, t.line);
    }
  }
  return cmd;
}

function parseProp(t: Tokens): Command {
  const id = parseId(t.next('a prop name'), t.line, 'prop name');
  const kind = t.nextLower('a prop kind');
  if (!(PROP_KINDS as readonly string[]).includes(kind)) {
    throw new DslError(`unknown prop kind "${kind}". Use: ${PROP_KINDS.join(', ')}`, t.line);
  }
  const cmd: Command & { op: 'prop' } = { op: 'prop', id, kind: kind as PropKind, at: null, place: null, facing: 0, size: null };
  while (!t.done) {
    const k = t.nextLower('a prop attribute');
    if (k === 'at') {
      cmd.at = parseXZ(t);
    } else if (normalizeRelation(k) !== undefined) {
      cmd.place = parsePlacement(new Tokens([k, ...t.rest()], t.line));
    } else if (k === 'facing') {
      cmd.facing = t.number('facing degrees');
    } else if (k === 'size') {
      cmd.size = [t.number('width'), t.number('height'), t.number('depth')];
    } else {
      throw new DslError(`unknown prop attribute "${k}"`, t.line);
    }
  }
  return cmd;
}

function parseCamera(t: Tokens): CameraOp {
  const k = t.nextLower('a camera setting');
  switch (k) {
    case 'at':
    case 'position': {
      const x = t.number('x');
      const y = t.number('y');
      const z = t.number('z');
      t.end();
      return { op: 'position', x, y, z };
    }
    case 'height': {
      const y = t.number('height');
      t.end();
      return { op: 'height', y };
    }
    case 'look_at':
    case 'look':
    case 'aim_at':
    case 'target': {
      t.accept('at');
      const target = parseTarget(t);
      t.end();
      return { op: 'look_at', target };
    }
    case 'angles':
    case 'aim': {
      const yaw = t.number('yaw');
      const pitch = t.number('pitch');
      t.end();
      return { op: 'angles', yaw, pitch };
    }
    case 'orbit': {
      const target = parseTarget(t);
      const r: CameraOp & { op: 'orbit' } = { op: 'orbit', target, distance: null, azimuth: null, elevation: null };
      while (!t.done) {
        const a = t.expect('distance', 'azimuth', 'elevation');
        const v = t.number(a);
        if (a === 'distance') {
          r.distance = v;
        } else if (a === 'azimuth') {
          r.azimuth = v;
        } else {
          r.elevation = v;
        }
      }
      return r;
    }
    case 'lens':
    case 'focal':
    case 'focal_length': {
      const mm = t.number('focal length in mm');
      t.end();
      return { op: 'lens', mm };
    }
    case 'aperture':
    case 'fstop':
    case 'f': {
      const fstop = t.number('f-number');
      t.end();
      return { op: 'aperture', fstop };
    }
    case 'focus': {
      if (t.accept('auto')) {
        t.end();
        return { op: 'focus', target: null, meters: null };
      }
      if (t.peekNumber()) {
        const m = t.number('focus distance');
        t.end();
        return { op: 'focus', target: null, meters: m };
      }
      t.accept('on', 'at');
      const target = parseTarget(t);
      t.end();
      return { op: 'focus', target, meters: null };
    }
    case 'dof': {
      const v = t.expect('on', 'off');
      t.end();
      return { op: 'dof', on: v === 'on' };
    }
    case 'roll':
    case 'dutch': {
      const deg = t.number('roll degrees');
      t.end();
      return { op: 'roll', deg };
    }
    case 'frame': {
      const f = t.nextLower('frame aspect like 3:2');
      if (f !== 'free' && !/^\d+(\.\d+)?:\d+(\.\d+)?$/.test(f)) {
        throw new DslError(`frame must be "free" or W:H like 3:2 (got "${f}")`, t.line);
      }
      t.end();
      return { op: 'frame', frame: f };
    }
    default:
      throw new DslError(`unknown camera setting "${k}"`, t.line);
  }
}
