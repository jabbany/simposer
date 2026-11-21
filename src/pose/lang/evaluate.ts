// Evaluate pose expressions into channel values. See docs/pose-system.md.
//
// Three kinds of pose:
// - atoms (built in, below) write channels directly;
// - composites (`define pose ... end`) combine lines that must not write the
//   same channel, unless a line is marked `override`; slots are parameters
//   that take a pose limited to a body region;
// - interpolations: blend/mix combine poses channel by channel. A channel set
//   by only one operand keeps that value; to blend toward neutral, a pose must
//   set the neutral value explicitly (e.g. with `rest(arms)`).

import { DslError } from '../../dsl/tokens.ts';
import { HAND_SHAPES, JOINT_BY_NAME, resolveDof, resolveEffector, resolvePart } from '../../dsl/vocab.ts';
import type { Effector, HandShape, JointDef } from '../../dsl/vocab.ts';
import { REGIONS, allChannels, expandSupport, footRollAngles, handShapeChannels, inRegion, mirrorKey, mirrorWord, neutralValue } from './channels.ts';
import { formatPoseExpr } from './ast.ts';
import type { PoseArg, PoseDef, PoseExpr } from './ast.ts';

export interface GoalPart {
  /** body part of the same figure (a landmark name) */
  part: string;
  weight: number;
}

export interface PoseValue {
  ch: Map<string, number>;
  /** reach goals per effector; an empty list means "explicitly no reach" */
  goals: Map<Effector, GoalPart[]>;
}

type Val = { t: 'num'; v: number } | { t: 'word'; w: string } | { t: 'pose'; p: PoseValue };

function emptyPose(): PoseValue {
  return { ch: new Map(), goals: new Map() };
}

// ---------------------------------------------------------------- built-ins

interface JointAtom {
  joint: string;
  sided: boolean;
  description: string;
}

/** Joint atoms: one per joint of the vocabulary, arguments are its motions. */
export const JOINT_ATOMS: Record<string, JointAtom> = {
  hips: { joint: 'hips', sided: false, description: 'pelvis: turn_left, bend_forward, lean_left' },
  torso: { joint: 'torso', sided: false, description: 'spine: bend_forward, lean_left, twist_left' },
  head: { joint: 'head', sided: false, description: 'neck and head: nod_down, tilt_left, turn_left' },
  arm: { joint: 'arm', sided: true, description: 'shoulder: raise_forward, raise_sideways, twist_out' },
  elbow: { joint: 'elbow', sided: true, description: 'elbow: bend' },
  wrist: { joint: 'wrist', sided: true, description: 'wrist: bend, bend_thumb_side, turn_palm_forward' },
  leg: { joint: 'leg', sided: true, description: 'hip joint: raise_forward, raise_sideways, twist_out' },
  knee: { joint: 'knee', sided: true, description: 'knee: bend' },
  ankle: { joint: 'ankle', sided: true, description: 'ankle: point, turn_out, roll_in' },
  toes: { joint: 'toes', sided: true, description: 'toes at the ball of the foot: bend_up' },
};

/** Other atoms, with a one-line signature for docs and the LLM prompt. */
export const OTHER_ATOMS: Record<string, string> = {
  foot_roll: 'foot_roll(side, roll): -1 on the heel (toes up), 0 flat, 1 high on the ball (toes bent flat), 2 on the tips; sets ankle point and toes, and how a standing foot meets the floor',
  foot_contact: 'foot_contact(side, roll): only how a standing foot meets the floor (same roll scale as foot_roll); the ankle angle is left to other poses',
  hand: 'hand(side, shape): finger shape, one of relaxed, open, fist, point, grip, flat',
  reach: 'reach(effector, part | none): put a hand or foot on a body part (IK)',
  support: 'support(part, ..., weight = 1): what carries the body: feet, knees, hands, seat, back, front (or one side, e.g. left_knee)',
  lift: 'lift(height): airborne height in meters above the supports',
  rest: 'rest(region): every channel of a region at its neutral value',
};

export const COMBINATORS: Record<string, string> = {
  blend: 'blend(a, b, t): interpolate from pose a (t = 0) to pose b (t = 1); t outside 0..1 extrapolates',
  mix: 'mix(a, wa, b, wb, ...): weighted average of poses',
  mirror: 'mirror(pose): swap left and right',
};

const FUNCS: Record<string, { arity: number[]; f: (a: number[]) => number }> = {
  sin: { arity: [1], f: (a) => Math.sin(a[0] ?? 0) },
  cos: { arity: [1], f: (a) => Math.cos(a[0] ?? 0) },
  sin1: { arity: [1], f: (a) => Math.sin(2 * Math.PI * (a[0] ?? 0)) },
  cos1: { arity: [1], f: (a) => Math.cos(2 * Math.PI * (a[0] ?? 0)) },
  abs: { arity: [1], f: (a) => Math.abs(a[0] ?? 0) },
  frac: { arity: [1], f: (a) => (a[0] ?? 0) - Math.floor(a[0] ?? 0) },
  pow: { arity: [2], f: (a) => Math.pow(a[0] ?? 0, a[1] ?? 1) },
  min: { arity: [2, 3, 4], f: (a) => Math.min(...a) },
  max: { arity: [2, 3, 4], f: (a) => Math.max(...a) },
  clamp: { arity: [3], f: (a) => Math.max(a[1] ?? 0, Math.min(a[2] ?? 1, a[0] ?? 0)) },
  lerp: { arity: [3], f: (a) => (a[0] ?? 0) + ((a[1] ?? 0) - (a[0] ?? 0)) * (a[2] ?? 0) },
  smoothstep: {
    arity: [3],
    f: (a) => {
      const t = Math.max(0, Math.min(1, ((a[2] ?? 0) - (a[0] ?? 0)) / ((a[1] ?? 1) - (a[0] ?? 0))));
      return t * t * (3 - 2 * t);
    },
  },
};

const CONSTANTS: Record<string, number> = { pi: Math.PI, tau: 2 * Math.PI };

/**
 * A periodic curve through evenly spaced keys over one cycle (key i at phase
 * i / n), smooth (Catmull-Rom) and wrapping around: for joint-angle tables
 * such as gait data sampled every 5% of a stride.
 */
export function cycleCurve(x: number, keys: number[]): number {
  const n = keys.length;
  const t = (x - Math.floor(x)) * n;
  const i = Math.floor(t);
  const u = t - i;
  const k = (j: number): number => keys[((j % n) + n) % n] ?? 0;
  const p0 = k(i - 1);
  const p1 = k(i);
  const p2 = k(i + 1);
  const p3 = k(i + 2);
  return 0.5 * (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u + (-p0 + 3 * p1 - 3 * p2 + p3) * u * u * u);
}

/** Names a definition cannot take. */
export function isReservedName(name: string): boolean {
  return JOINT_ATOMS[name] !== undefined || OTHER_ATOMS[name] !== undefined || COMBINATORS[name] !== undefined
    || FUNCS[name] !== undefined || CONSTANTS[name] !== undefined || name === 'cycle'
    || ['end', 'override', 'define', 'left', 'right', 'both', 'none'].includes(name);
}

// ---------------------------------------------------------------- library

export class PoseLibrary {
  private readonly defs = new Map<string, PoseDef>();
  private readonly aliases: Record<string, string>;
  /** names defined or redefined by the scene */
  readonly userNames: ReadonlySet<string>;

  constructor(defaults: PoseDef[], user: PoseDef[], aliases: Record<string, string> = {}) {
    for (const d of defaults) {
      this.defs.set(d.name, d);
    }
    for (const d of user) {
      this.defs.set(d.name, d);
    }
    this.userNames = new Set(user.map((d) => d.name));
    this.aliases = aliases;
  }

  get(name: string): PoseDef | undefined {
    return this.defs.get(name) ?? this.defs.get(this.aliases[name] ?? '');
  }

  /** Canonical name for a pose name or alias. */
  resolve(name: string): string | undefined {
    if (this.defs.has(name)) {
      return name;
    }
    const a = this.aliases[name];
    return a !== undefined && this.defs.has(a) ? a : undefined;
  }

  all(): PoseDef[] {
    return [...this.defs.values()];
  }
}

// ---------------------------------------------------------------- evaluation

const MAX_DEPTH = 40;

class Evaluator {
  private readonly lib: PoseLibrary;
  private depth = 0;

  constructor(lib: PoseLibrary) {
    this.lib = lib;
  }

  value(e: PoseExpr, env: Map<string, Val>): Val {
    switch (e.k) {
      case 'num':
        return { t: 'num', v: e.v };
      case 'param': {
        const v = env.get(e.name);
        if (v === undefined) {
          throw new DslError(`unknown parameter $${e.name}`);
        }
        return v;
      }
      case 'word': {
        const c = CONSTANTS[e.w];
        return c !== undefined ? { t: 'num', v: c } : { t: 'word', w: e.w };
      }
      case 'neg':
        return { t: 'num', v: -this.num(e.a, env) };
      case 'bin': {
        const a = this.num(e.a, env);
        const b = this.num(e.b, env);
        if (e.op === '/' && b === 0) {
          throw new DslError('division by zero in a pose');
        }
        return { t: 'num', v: e.op === '+' ? a + b : e.op === '-' ? a - b : e.op === '*' ? a * b : a / b };
      }
      case 'call': {
        if (e.name === 'cycle') {
          if (e.args.length < 4 || e.args.some((a) => a.name !== null)) {
            throw new DslError('cycle(phase, k0, k1, k2, ...) takes a phase and at least 3 values');
          }
          const [x, ...keys] = e.args.map((a) => this.num(a.value, env));
          return { t: 'num', v: cycleCurve(x ?? 0, keys) };
        }
        const fn = FUNCS[e.name];
        if (fn !== undefined) {
          if (e.args.some((a) => a.name !== null) || !fn.arity.includes(e.args.length)) {
            throw new DslError(`${e.name} takes ${fn.arity.join(' or ')} numbers`);
          }
          return { t: 'num', v: fn.f(e.args.map((a) => this.num(a.value, env))) };
        }
        return { t: 'pose', p: this.call(e.name, e.args, env) };
      }
    }
  }

  num(e: PoseExpr, env: Map<string, Val>): number {
    const v = this.value(e, env);
    if (v.t !== 'num') {
      throw new DslError(`expected a number but got ${v.t === 'word' ? `"${v.w}"` : 'a pose'} (${formatPoseExpr(e)})`);
    }
    if (!Number.isFinite(v.v)) {
      throw new DslError(`${formatPoseExpr(e)} is not a finite number`);
    }
    return v.v;
  }

  word(e: PoseExpr, env: Map<string, Val>, what: string): string {
    const v = this.value(e, env);
    if (v.t !== 'word') {
      throw new DslError(`expected ${what} but got ${v.t === 'num' ? String(v.v) : 'a pose'}`);
    }
    return v.w;
  }

  pose(e: PoseExpr, env: Map<string, Val>): PoseValue {
    return this.asPose(this.value(e, env));
  }

  asPose(v: Val): PoseValue {
    if (v.t === 'pose') {
      return v.p;
    }
    if (v.t === 'word') {
      return this.call(v.w, [], new Map());
    }
    throw new DslError(`expected a pose but got the number ${v.v}`);
  }

  call(name: string, args: PoseArg[], env: Map<string, Val>): PoseValue {
    if (JOINT_ATOMS[name] !== undefined) {
      return this.jointAtom(name, args, env);
    }
    switch (name) {
      case 'foot_roll':
        return this.footRollAtom(args, env, true);
      case 'foot_contact':
        return this.footRollAtom(args, env, false);
      case 'hand':
        return this.handAtom(args, env);
      case 'reach':
        return this.reachAtom(args, env);
      case 'support':
        return this.supportAtom(args, env);
      case 'lift': {
        const [h] = this.positional(name, args, 1);
        const p = emptyPose();
        p.ch.set('body.lift', this.num(h ?? { k: 'num', v: 0 }, env));
        return p;
      }
      case 'rest':
        return this.restAtom(args, env);
      case 'blend':
        return this.blend(args, env);
      case 'mix':
        return this.mix(args, env);
      case 'mirror': {
        const [a] = this.positional(name, args, 1);
        return mirrorPose(this.pose(a ?? { k: 'word', w: '' }, env));
      }
      default:
        return this.callDef(name, args, env);
    }
  }

  private positional(name: string, args: PoseArg[], n: number): PoseExpr[] {
    if (args.length !== n || args.some((a) => a.name !== null)) {
      throw new DslError(`${name} takes ${n} argument${n === 1 ? '' : 's'}`);
    }
    return args.map((a) => a.value);
  }

  private sides(e: PoseExpr | undefined, env: Map<string, Val>, atom: string): ('left' | 'right')[] {
    if (e === undefined) {
      throw new DslError(`${atom} needs a side first: left, right or both`);
    }
    const w = this.word(e, env, 'a side (left, right or both)');
    if (w === 'both') {
      return ['left', 'right'];
    }
    if (w === 'left' || w === 'right') {
      return [w];
    }
    throw new DslError(`${atom}: expected left, right or both but got "${w}"`);
  }

  private jointAtom(name: string, args: PoseArg[], env: Map<string, Val>): PoseValue {
    const spec = JOINT_ATOMS[name];
    if (spec === undefined) {
      throw new DslError(`unknown atom ${name}`);
    }
    const pos = args.filter((a) => a.name === null).map((a) => a.value);
    const named = args.filter((a) => a.name !== null);
    const sides: (string | null)[] = spec.sided ? this.sides(pos.shift(), env, name) : [null];
    const out = emptyPose();
    for (const side of sides) {
      const joint: JointDef | undefined = JOINT_BY_NAME.get(side === null ? spec.joint : `${side}_${spec.joint}`);
      if (joint === undefined) {
        throw new DslError(`unknown joint for ${name}`);
      }
      if (pos.length > 1 || (pos.length === 1 && joint.dofs.length !== 1)) {
        throw new DslError(`${name}: name the motion, e.g. ${name}(${spec.sided ? 'left, ' : ''}${joint.dofs[0]?.name ?? 'motion'} = 20)`);
      }
      const only = joint.dofs[0];
      if (pos.length === 1 && only !== undefined && pos[0] !== undefined) {
        out.ch.set(`${joint.name}.${only.name}`, this.num(pos[0], env));
      }
      for (const a of named) {
        const r = resolveDof(joint, a.name ?? '');
        if (r === undefined) {
          throw new DslError(`${name} has no motion "${a.name}". Use: ${joint.dofs.map((d) => d.name).join(', ')}`);
        }
        out.ch.set(`${joint.name}.${r.dof.name}`, r.sign * this.num(a.value, env));
      }
    }
    return out;
  }

  private footRollAtom(args: PoseArg[], env: Map<string, Val>, withAngles: boolean): PoseValue {
    const atom = withAngles ? 'foot_roll' : 'foot_contact';
    const pos = args.filter((a) => a.name === null).map((a) => a.value);
    const named = args.filter((a) => a.name !== null);
    if (pos.length < 1 || pos.length > 2 || named.some((a) => a.name !== 'roll') || pos.length + named.length !== 2) {
      throw new DslError(`${atom} takes a side and a roll: ${atom}(left, roll = 0.5)`);
    }
    const rollE = pos[1] ?? named[0]?.value;
    const roll = this.num(rollE ?? { k: 'num', v: 0 }, env);
    const { pitch, toes } = footRollAngles(roll);
    const out = emptyPose();
    for (const side of this.sides(pos[0], env, atom)) {
      // foot_roll also sets the angles as seen with the shin upright; either
      // way a standing foot is turned to the roll's pitch on the floor by the
      // solver
      if (withAngles) {
        out.ch.set(`${side}_ankle.point`, pitch);
        out.ch.set(`${side}_toes.bend_up`, toes);
      }
      out.ch.set(`${side}_foot.roll`, roll);
    }
    return out;
  }

  private handAtom(args: PoseArg[], env: Map<string, Val>): PoseValue {
    const [s, shapeE] = this.positional('hand', args, 2);
    const out = emptyPose();
    const shape = this.word(shapeE ?? { k: 'word', w: '' }, env, 'a hand shape');
    if (!(HAND_SHAPES as readonly string[]).includes(shape)) {
      throw new DslError(`unknown hand shape "${shape}". Use: ${HAND_SHAPES.join(', ')}`);
    }
    for (const side of this.sides(s, env, 'hand')) {
      for (const [k, v] of handShapeChannels(side, shape as HandShape)) {
        out.ch.set(k, v);
      }
    }
    return out;
  }

  private reachAtom(args: PoseArg[], env: Map<string, Val>): PoseValue {
    const [effE, partE] = this.positional('reach', args, 2);
    const effWord = this.word(effE ?? { k: 'word', w: '' }, env, 'a hand or foot');
    const eff = resolveEffector(effWord);
    if (eff === undefined) {
      throw new DslError(`reach: unknown effector "${effWord}" (use left_hand, right_hand, left_foot, right_foot)`);
    }
    const partWord = this.word(partE ?? { k: 'word', w: '' }, env, 'a body part');
    const out = emptyPose();
    if (partWord === 'none') {
      out.goals.set(eff, []);
      return out;
    }
    const part = resolvePart(partWord.replace(/^self\./, ''));
    if (part === undefined) {
      throw new DslError(`reach: unknown body part "${partWord}"`);
    }
    out.goals.set(eff, [{ part, weight: 1 }]);
    return out;
  }

  private supportAtom(args: PoseArg[], env: Map<string, Val>): PoseValue {
    const out = emptyPose();
    let weight = 1;
    const parts: string[] = [];
    for (const a of args) {
      if (a.name === 'weight') {
        weight = this.num(a.value, env);
      } else if (a.name === null) {
        parts.push(this.word(a.value, env, 'a supporting part'));
      } else {
        throw new DslError(`support has no argument "${a.name}"`);
      }
    }
    if (parts.length === 0) {
      throw new DslError('support needs at least one part: feet, knees, hands, seat, back, front');
    }
    for (const w of parts) {
      const ps = expandSupport(w);
      if (ps === undefined) {
        throw new DslError(`support: unknown part "${w}" (use feet, knees, hands, seat, back, front, or one side like left_knee)`);
      }
      for (const p of ps) {
        out.ch.set(`support.${p}`, weight);
      }
    }
    return out;
  }

  private restAtom(args: PoseArg[], env: Map<string, Val>): PoseValue {
    const [r] = this.positional('rest', args, 1);
    const region = this.word(r ?? { k: 'word', w: '' }, env, 'a body region');
    if (REGIONS[region] === undefined) {
      throw new DslError(`rest: unknown region "${region}". Use: ${Object.keys(REGIONS).join(', ')}`);
    }
    const out = emptyPose();
    for (const k of allChannels()) {
      if (inRegion(k, region)) {
        out.ch.set(k, neutralValue(k));
      }
    }
    for (const eff of ['left_hand', 'right_hand', 'left_foot', 'right_foot'] as const) {
      if (inRegion(`goal.${eff}`, region)) {
        out.goals.set(eff, []);
      }
    }
    return out;
  }

  private blend(args: PoseArg[], env: Map<string, Val>): PoseValue {
    const [a, b, t] = this.positional('blend', args, 3);
    if (a === undefined || b === undefined || t === undefined) {
      throw new DslError('blend(a, b, t) takes two poses and a number');
    }
    const tv = this.num(t, env);
    return combine([[this.pose(a, env), 1 - tv], [this.pose(b, env), tv]], 'blend');
  }

  private mix(args: PoseArg[], env: Map<string, Val>): PoseValue {
    if (args.length < 2 || args.length % 2 !== 0 || args.some((a) => a.name !== null)) {
      throw new DslError('mix takes pairs: mix(pose_a, weight_a, pose_b, weight_b, ...)');
    }
    const items: [PoseValue, number][] = [];
    for (let i = 0; i < args.length; i += 2) {
      const pe = args[i]?.value;
      const we = args[i + 1]?.value;
      if (pe === undefined || we === undefined) {
        continue;
      }
      items.push([this.pose(pe, env), this.num(we, env)]);
    }
    return combine(items, 'mix');
  }

  private callDef(name: string, args: PoseArg[], callerEnv: Map<string, Val>): PoseValue {
    const def = this.lib.get(name);
    if (def === undefined) {
      throw new DslError(`unknown pose "${name}"`);
    }
    if (this.depth >= MAX_DEPTH) {
      throw new DslError(`pose ${def.name} calls itself (directly or through other poses)`);
    }
    // bind arguments: positional in order, then named
    const given = new Map<string, PoseExpr>();
    let posIdx = 0;
    for (const a of args) {
      if (a.name === null) {
        const p = def.params[posIdx];
        if (p === undefined) {
          throw new DslError(`pose ${def.name} takes ${def.params.length} argument${def.params.length === 1 ? '' : 's'}`);
        }
        given.set(p.name, a.value);
        posIdx++;
      } else {
        if (!def.params.some((p) => p.name === a.name)) {
          throw new DslError(`pose ${def.name} has no parameter "${a.name}"${def.params.length > 0 ? ` (parameters: ${def.params.map((p) => p.name).join(', ')})` : ''}`);
        }
        given.set(a.name, a.value);
      }
    }
    this.depth++;
    try {
      const env = new Map<string, Val>();
      for (const p of def.params) {
        const arg = given.get(p.name);
        let v: Val;
        if (arg !== undefined) {
          v = this.value(arg, callerEnv);
        } else if (p.def !== null) {
          v = this.value(p.def, env);
        } else {
          throw new DslError(`pose ${def.name} needs a value for "${p.name}"`);
        }
        if (p.region !== null) {
          if (REGIONS[p.region] === undefined) {
            throw new DslError(`pose ${def.name}: unknown region "${p.region}" for slot ${p.name}`);
          }
          const pv = this.asPose(v);
          checkRegion(pv, p.region, `pose ${def.name}, slot ${p.name}`);
          v = { t: 'pose', p: pv };
        }
        env.set(p.name, v);
      }
      if (def.expr !== null) {
        return this.pose(def.expr, env);
      }
      const out = emptyPose();
      const owner = new Map<string, string>();
      for (const line of def.body ?? []) {
        const label = formatPoseExpr(line.expr);
        const pv = this.pose(line.expr, env);
        for (const [k, v] of pv.ch) {
          const prev = owner.get(k);
          if (prev !== undefined && !line.override) {
            throw new DslError(`pose ${def.name}: ${k} is set by both "${prev}" and "${label}" (mark the later line "override" to replace it)`);
          }
          owner.set(k, label);
          out.ch.set(k, v);
        }
        for (const [eff, g] of pv.goals) {
          const key = `goal.${eff}`;
          const prev = owner.get(key);
          if (prev !== undefined && !line.override) {
            throw new DslError(`pose ${def.name}: the ${eff.replace('_', ' ')} reach is set by both "${prev}" and "${label}"`);
          }
          owner.set(key, label);
          out.goals.set(eff, g);
        }
      }
      return out;
    } catch (e) {
      if (e instanceof DslError && !e.message.includes(`pose ${def.name}`) && this.depth === 1) {
        throw new DslError(`in pose ${def.name}: ${e.message}`);
      }
      throw e;
    } finally {
      this.depth--;
    }
  }
}

function checkRegion(p: PoseValue, region: string, where: string): void {
  for (const k of p.ch.keys()) {
    if (!inRegion(k, region)) {
      throw new DslError(`${where} takes only the ${region} region, but the pose sets ${k}`);
    }
  }
  for (const eff of p.goals.keys()) {
    if (!inRegion(`goal.${eff}`, region)) {
      throw new DslError(`${where} takes only the ${region} region, but the pose places the ${eff.replace('_', ' ')}`);
    }
  }
}

/**
 * Weighted combination. Each channel averages over the operands that set it,
 * so a channel set by only one operand keeps its value.
 */
function combine(items: [PoseValue, number][], what: string): PoseValue {
  const out = emptyPose();
  const keys = new Set<string>();
  for (const [p] of items) {
    for (const k of p.ch.keys()) {
      keys.add(k);
    }
  }
  for (const k of keys) {
    let sum = 0;
    let wsum = 0;
    for (const [p, w] of items) {
      const v = p.ch.get(k);
      if (v !== undefined) {
        sum += v * w;
        wsum += w;
      }
    }
    if (Math.abs(wsum) < 1e-9) {
      throw new DslError(`${what}: the weights of the poses that set ${k} add up to zero`);
    }
    out.ch.set(k, sum / wsum);
  }
  const effs = new Set<Effector>();
  for (const [p] of items) {
    for (const e of p.goals.keys()) {
      effs.add(e);
    }
  }
  for (const eff of effs) {
    const setters = items.filter(([p]) => p.goals.has(eff));
    const wsum = setters.reduce((s, [, w]) => s + w, 0);
    const parts = new Map<string, number>();
    for (const [p, w] of setters) {
      for (const g of p.goals.get(eff) ?? []) {
        parts.set(g.part, (parts.get(g.part) ?? 0) + (g.weight * w) / (Math.abs(wsum) < 1e-9 ? 1 : wsum));
      }
    }
    out.goals.set(eff, [...parts].map(([part, weight]) => ({ part, weight })).filter((g) => Math.abs(g.weight) > 1e-9));
  }
  return out;
}

function mirrorPose(p: PoseValue): PoseValue {
  const out = emptyPose();
  for (const [k, v] of p.ch) {
    const m = mirrorKey(k);
    out.ch.set(m.key, m.sign * v);
  }
  for (const [eff, g] of p.goals) {
    out.goals.set(mirrorWord(eff) as Effector, g.map((x) => ({ part: mirrorWord(x.part), weight: x.weight })));
  }
  return out;
}

/** Evaluate a pose expression against a library. Throws DslError. */
export function evaluatePose(lib: PoseLibrary, e: PoseExpr): PoseValue {
  return new Evaluator(lib).pose(e, new Map());
}

/** Check a definition: it must not shadow a built-in, and must evaluate with its defaults. */
export function checkDefinition(lib: PoseLibrary, def: PoseDef): void {
  if (isReservedName(def.name)) {
    throw new DslError(`"${def.name}" is a built-in name; choose another pose name`);
  }
  const seen = new Set<string>();
  for (const p of def.params) {
    if (seen.has(p.name)) {
      throw new DslError(`pose ${def.name}: parameter "${p.name}" appears twice`);
    }
    seen.add(p.name);
  }
  // evaluate with defaults when every parameter has one; otherwise only the
  // calls made with arguments are checked, when they happen
  if (def.params.every((p) => p.def !== null)) {
    evaluatePose(lib, { k: 'call', name: def.name, args: [] });
  }
}
