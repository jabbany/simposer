// Deterministic application of delta commands to a scene document.
// applyCommands is a pure function: same document + same commands => same result.

import type { Command, CameraOp, ParsedLine, Placement, Selector } from './commands.ts';
import { DslError, normDeg } from './tokens.ts';
import { cloneScene } from './types.ts';
import type { FacingSpec, Figure, SceneDoc, TargetRef } from './types.ts';
import { DEG, bodyParams, facingDeg, forwardXZ, headingTo, leftXZ, locateApprox, rng } from './geometry.ts';
import { BODY_PRESET_BY_NAME, JOINT_BY_NAME, PROP_DEFAULT_SIZE } from './vocab.ts';
import type { Effector } from './vocab.ts';
import { poseName, withPoseArg } from '../pose/lang/ast.ts';
import type { PoseDef, PoseExpr } from '../pose/lang/ast.ts';
import { checkDefinition, evaluatePose } from '../pose/lang/evaluate.ts';
import type { PoseLibrary } from '../pose/lang/evaluate.ts';
import { libraryFor } from '../pose/lang/library.ts';
import { composePose } from '../pose/lang/compose.ts';

export interface ApplyContext {
  /** model ids that exist in the catalog */
  knownModels: string[];
  defaultModel: string;
  /** body preset to use when a figure is added with a model but no body */
  defaultBodies: Record<string, string>;
  /** model/body combos used for crowds when none are specified */
  crowdMix: { model: string; body: string }[];
}

export interface ApplyResult {
  doc: SceneDoc;
  errors: DslError[];
  /** figure ids touched by the delta, for UI highlighting */
  touched: string[];
}

/** Apply all commands atomically: on any error the original document is returned. */
export function applyCommands(doc: SceneDoc, lines: ParsedLine[], ctx: ApplyContext): ApplyResult {
  const next = cloneScene(doc);
  const errors: DslError[] = [];
  const touched = new Set<string>();
  for (const pl of lines) {
    try {
      applyOne(next, pl.command, ctx, touched);
    } catch (e) {
      if (e instanceof DslError) {
        errors.push(new DslError(e.message, pl.line));
      } else if (e instanceof Error) {
        errors.push(new DslError(`internal error: ${e.message}`, pl.line));
      } else {
        throw e;
      }
    }
  }
  if (errors.length > 0) {
    return { doc, errors, touched: [] };
  }
  return { doc: next, errors, touched: [...touched] };
}

function figureById(doc: SceneDoc, id: string): Figure {
  const f = doc.figures.find((q) => q.id === id);
  if (f === undefined) {
    const known = doc.figures.map((q) => q.id);
    throw new DslError(`no figure named "${id}"${known.length > 0 ? ` (figures: ${known.join(', ')})` : ' (the scene has no figures yet)'}`);
  }
  return f;
}

function select(doc: SceneDoc, sel: Selector): Figure[] {
  switch (sel.kind) {
    case 'all':
      return [...doc.figures];
    case 'group': {
      const r = doc.figures.filter((f) => f.group === sel.group);
      if (r.length === 0) {
        throw new DslError(`no figures in group @${sel.group}`);
      }
      return r;
    }
    case 'ids':
      return sel.ids.map((id) => figureById(doc, id));
  }
}

function nameTaken(doc: SceneDoc, id: string): boolean {
  return doc.figures.some((f) => f.id === id) || doc.props.some((p) => p.id === id) || id === 'camera' || id === 'self' || id === 'point' || id === 'origin';
}

/** Resolve `self`, and bare names that refer to props, then validate references. */
function bindTarget(doc: SceneDoc, tg: TargetRef, self: string | null): TargetRef {
  if (tg.kind === 'part' || tg.kind === 'figure') {
    let figId = tg.figure;
    if (figId === 'self') {
      if (self === null) {
        throw new DslError('"self" can only be used in commands about a figure');
      }
      figId = self;
    }
    if (tg.kind === 'figure' && doc.props.some((p) => p.id === figId)) {
      return { kind: 'prop', prop: figId };
    }
    figureById(doc, figId);
    return tg.kind === 'part' ? { kind: 'part', figure: figId, part: tg.part } : { kind: 'figure', figure: figId };
  }
  if (tg.kind === 'prop' && !doc.props.some((p) => p.id === tg.prop)) {
    throw new DslError(`no prop named "${tg.prop}"`);
  }
  return tg;
}

function bindFacing(doc: SceneDoc, f: FacingSpec, self: string | null): FacingSpec {
  if (f.kind === 'angle') {
    return { kind: 'angle', deg: normDeg(f.deg) };
  }
  const target = bindTarget(doc, f.target, self);
  if ((target.kind === 'figure' || target.kind === 'part') && target.figure === self) {
    throw new DslError('a figure cannot face itself');
  }
  return { kind: f.kind, target };
}

function resolvePlacement(doc: SceneDoc, p: Placement, self: string | null): { x: number; z: number } {
  const target = bindTarget(doc, p.target, self);
  const loc = locateApprox(doc, target);
  if (loc === undefined) {
    throw new DslError('could not locate placement target');
  }
  const facing = loc.facing ?? 0;
  const d = p.distance ?? (p.relation === 'near' ? 0.9 : 1.0);
  const f = forwardXZ(facing);
  const l = leftXZ(facing);
  switch (p.relation) {
    case 'left_of':
      return { x: loc.x + l.x * d, z: loc.z + l.z * d };
    case 'right_of':
      return { x: loc.x - l.x * d, z: loc.z - l.z * d };
    case 'in_front_of':
      return { x: loc.x + f.x * d, z: loc.z + f.z * d };
    case 'behind':
      return { x: loc.x - f.x * d, z: loc.z - f.z * d };
    case 'near':
      return { x: loc.x + (l.x + f.x) * d * 0.707, z: loc.z + (l.z + f.z) * d * 0.707 };
  }
}

function round(n: number, digits = 3): number {
  const k = Math.pow(10, digits);
  const r = Math.round(n * k) / k;
  return Object.is(r, -0) ? 0 : r;
}

function clampDof(joint: string, dofName: string, v: number): number {
  const j = JOINT_BY_NAME.get(joint);
  const d = j?.dofs.find((q) => q.name === dofName);
  if (d === undefined) {
    return v;
  }
  return Math.max(d.min, Math.min(d.max, v));
}

const LIMB_JOINTS: Record<Effector, string[]> = {
  left_hand: ['left_arm', 'left_elbow'],
  right_hand: ['right_arm', 'right_elbow'],
  left_foot: ['left_leg', 'left_knee'],
  right_foot: ['right_leg', 'right_knee'],
};

function clearJointKeys(f: Figure, joints: string[]): void {
  for (const key of Object.keys(f.joints)) {
    const j = key.split('.')[0] ?? '';
    if (joints.includes(j)) {
      delete f.joints[key];
    }
  }
}

/**
 * Validate a pose expression against the scene's library and return it in
 * canonical form (aliases resolved: `walking` -> `walk`).
 */
function bindPose(lib: PoseLibrary, e: PoseExpr): PoseExpr {
  let out = e;
  const name = poseName(e);
  const canonical = lib.resolve(name);
  if (canonical !== undefined && canonical !== name) {
    out = e.k === 'call' ? { ...e, name: canonical } : { k: 'word', w: canonical };
  }
  evaluatePose(lib, out);
  return out;
}

/** Does the outermost pose take a `phase` parameter (walk, run, ...)? */
function hasPhase(lib: PoseLibrary, e: PoseExpr): boolean {
  return lib.get(poseName(e))?.params.some((p) => p.name === 'phase') ?? false;
}

/** Every figure's pose must still evaluate after the library changes. */
function checkFigurePoses(doc: SceneDoc, lib: PoseLibrary, what: string): void {
  for (const f of doc.figures) {
    try {
      evaluatePose(lib, f.pose);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new DslError(`${what} breaks the pose of ${f.id}: ${msg}`);
    }
  }
}

function newFigure(id: string, ctx: ApplyContext, camYaw: number, x: number, z: number): Figure {
  return {
    id,
    group: null,
    model: ctx.defaultModel,
    body: 'adult_male',
    bodyOverrides: {},
    x,
    z,
    elevation: 0,
    // face the camera by default
    facing: { kind: 'angle', deg: Math.round(normDeg(camYaw + 180)) },
    pose: { k: 'word', w: 'stand' },
    joints: {},
    reaches: {},
    look: null,
    hands: {},
  };
}

function checkModel(ctx: ApplyContext, model: string): void {
  if (!ctx.knownModels.includes(model)) {
    throw new DslError(`unknown model "${model}". Known models: ${ctx.knownModels.join(', ')}`);
  }
}

/** Remove references to a figure from everything else in the scene. */
function dropReferences(doc: SceneDoc, id: string): void {
  const refers = (tg: TargetRef): boolean => (tg.kind === 'figure' || tg.kind === 'part') && tg.figure === id;
  for (const f of doc.figures) {
    for (const k of Object.keys(f.reaches) as Effector[]) {
      const tg = f.reaches[k];
      if (tg !== undefined && refers(tg)) {
        delete f.reaches[k];
      }
    }
    if (f.look !== null && refers(f.look)) {
      f.look = null;
    }
    if (f.facing.kind !== 'angle' && refers(f.facing.target)) {
      f.facing = { kind: 'angle', deg: Math.round(facingDeg(doc, f)) };
    }
  }
  const cam = doc.camera;
  if (cam.aim.kind === 'target' && refers(cam.aim.target)) {
    cam.aim = { kind: 'angles', yaw: Math.round(cameraYaw(doc)), pitch: 0 };
  }
  if (cam.focus.kind === 'target' && refers(cam.focus.target)) {
    cam.focus = { kind: 'auto' };
  }
}

function renameRefs(doc: SceneDoc, from: string, to: string): void {
  const fix = (tg: TargetRef): TargetRef => {
    if ((tg.kind === 'figure' || tg.kind === 'part') && tg.figure === from) {
      return { ...tg, figure: to };
    }
    if (tg.kind === 'prop' && tg.prop === from) {
      return { kind: 'prop', prop: to };
    }
    return tg;
  };
  for (const f of doc.figures) {
    for (const k of Object.keys(f.reaches) as Effector[]) {
      const tg = f.reaches[k];
      if (tg !== undefined) {
        f.reaches[k] = fix(tg);
      }
    }
    if (f.look !== null) {
      f.look = fix(f.look);
    }
    if (f.facing.kind !== 'angle') {
      f.facing = { kind: f.facing.kind, target: fix(f.facing.target) };
    }
  }
  const cam = doc.camera;
  if (cam.aim.kind === 'target') {
    cam.aim = { kind: 'target', target: fix(cam.aim.target) };
  }
  if (cam.focus.kind === 'target') {
    cam.focus = { kind: 'target', target: fix(cam.focus.target) };
  }
}

function cameraYaw(doc: SceneDoc): number {
  const cam = doc.camera;
  if (cam.aim.kind === 'angles') {
    return cam.aim.yaw;
  }
  const loc = locateApprox(doc, cam.aim.target);
  return loc === undefined ? 180 : headingTo(cam.x, cam.z, loc.x, loc.z);
}

function applyOne(doc: SceneDoc, c: Command, ctx: ApplyContext, touched: Set<string>): void {
  switch (c.op) {
    case 'title':
      doc.title = c.text.length > 0 ? c.text : 'Untitled';
      return;
    case 'add': {
      if (nameTaken(doc, c.id)) {
        throw new DslError(`the name "${c.id}" is already used`);
      }
      const f = newFigure(c.id, ctx, cameraYaw(doc), 0, 0);
      if (c.model !== null) {
        checkModel(ctx, c.model);
        f.model = c.model;
        f.body = ctx.defaultBodies[c.model] ?? f.body;
      }
      if (c.body !== null) {
        f.body = c.body;
      }
      f.bodyOverrides = { ...c.overrides };
      if (c.at !== null) {
        f.x = c.at.x;
        f.z = c.at.z;
      } else if (c.place !== null) {
        const p = resolvePlacement(doc, c.place, null);
        f.x = round(p.x);
        f.z = round(p.z);
      }
      if (c.facing !== null) {
        f.facing = bindFacing(doc, c.facing, c.id);
      }
      const lib = libraryFor(doc.poses);
      if (c.pose !== null) {
        f.pose = bindPose(lib, c.pose);
      }
      if (c.phase !== null) {
        if (!hasPhase(lib, f.pose)) {
          throw new DslError(`pose ${poseName(f.pose)} has no phase`);
        }
        f.pose = withPoseArg(f.pose, 'phase', { k: 'num', v: round(c.phase, 2) });
      }
      if (c.elevation !== null) {
        f.elevation = c.elevation;
      }
      doc.figures.push(f);
      touched.add(f.id);
      return;
    }
    case 'add_crowd':
      addCrowd(doc, c, ctx, touched);
      return;
    case 'prop': {
      const existing = doc.props.find((p) => p.id === c.id);
      if (existing === undefined && nameTaken(doc, c.id)) {
        throw new DslError(`the name "${c.id}" is already used`);
      }
      let pos = c.at ?? { x: 0, z: 0 };
      if (c.place !== null) {
        pos = resolvePlacement(doc, c.place, null);
      }
      const prop = { id: c.id, kind: c.kind, x: round(pos.x), z: round(pos.z), facing: normDeg(c.facing), size: c.size ?? [...PROP_DEFAULT_SIZE[c.kind]] as [number, number, number] };
      if (existing !== undefined) {
        Object.assign(existing, prop);
      } else {
        doc.props.push(prop);
      }
      return;
    }
    case 'remove': {
      if (c.sel.kind === 'ids') {
        for (const id of c.sel.ids) {
          const pi = doc.props.findIndex((p) => p.id === id);
          if (pi >= 0) {
            doc.props.splice(pi, 1);
            continue;
          }
          figureById(doc, id);
          doc.figures = doc.figures.filter((f) => f.id !== id);
          dropReferences(doc, id);
        }
        return;
      }
      for (const f of select(doc, c.sel)) {
        doc.figures = doc.figures.filter((q) => q.id !== f.id);
        dropReferences(doc, f.id);
      }
      return;
    }
    case 'rename': {
      if (nameTaken(doc, c.to)) {
        throw new DslError(`the name "${c.to}" is already used`);
      }
      const prop = doc.props.find((p) => p.id === c.from);
      if (prop !== undefined) {
        prop.id = c.to;
      } else {
        figureById(doc, c.from).id = c.to;
        touched.add(c.to);
      }
      renameRefs(doc, c.from, c.to);
      return;
    }
    case 'group':
      for (const f of select(doc, c.sel)) {
        f.group = c.group;
      }
      return;
    case 'model':
      checkModel(ctx, c.model);
      for (const f of select(doc, c.sel)) {
        f.model = c.model;
        touched.add(f.id);
      }
      return;
    case 'body':
      for (const f of select(doc, c.sel)) {
        if (c.body !== null) {
          f.body = c.body;
          f.bodyOverrides = {};
        }
        f.bodyOverrides = { ...f.bodyOverrides, ...c.overrides };
        touched.add(f.id);
      }
      return;
    case 'place':
      for (const f of select(doc, c.sel)) {
        const p = c.at ?? (c.place !== null ? resolvePlacement(doc, c.place, f.id) : null);
        if (p === null) {
          throw new DslError('place needs "at x z" or a relation');
        }
        f.x = round(p.x);
        f.z = round(p.z);
        touched.add(f.id);
      }
      return;
    case 'move':
      for (const f of select(doc, c.sel)) {
        const yaw = facingDeg(doc, f);
        const fw = forwardXZ(yaw);
        const lf = leftXZ(yaw);
        const v = c.dir === 'forward' ? fw : c.dir === 'back' ? { x: -fw.x, z: -fw.z } : c.dir === 'left' ? lf : { x: -lf.x, z: -lf.z };
        f.x = round(f.x + v.x * c.distance);
        f.z = round(f.z + v.z * c.distance);
        touched.add(f.id);
      }
      return;
    case 'move_by':
      for (const f of select(doc, c.sel)) {
        f.x = round(f.x + c.dx);
        f.z = round(f.z + c.dz);
        touched.add(f.id);
      }
      return;
    case 'face':
      for (const f of select(doc, c.sel)) {
        f.facing = bindFacing(doc, c.facing, f.id);
        touched.add(f.id);
      }
      return;
    case 'turn':
      for (const f of select(doc, c.sel)) {
        f.facing = { kind: 'angle', deg: round(normDeg(facingDeg(doc, f) + c.deg), 1) };
        touched.add(f.id);
      }
      return;
    case 'elevate':
      for (const f of select(doc, c.sel)) {
        f.elevation = Math.max(0, c.meters);
        touched.add(f.id);
      }
      return;
    case 'pose': {
      const lib = libraryFor(doc.poses);
      const pose = bindPose(lib, c.pose);
      for (const f of select(doc, c.sel)) {
        f.pose = pose;
        f.joints = {};
        f.reaches = {};
        f.hands = {};
        f.look = null;
        touched.add(f.id);
      }
      return;
    }
    case 'phase': {
      const lib = libraryFor(doc.poses);
      for (const f of select(doc, c.sel)) {
        if (!hasPhase(lib, f.pose)) {
          throw new DslError(`${f.id}'s pose ${poseName(f.pose)} has no phase`);
        }
        f.pose = withPoseArg(f.pose, 'phase', { k: 'num', v: round(((c.phase % 1) + 1) % 1, 2) });
        touched.add(f.id);
      }
      return;
    }
    case 'define': {
      const others = doc.poses.filter((d) => d.name !== c.def.name);
      const lib = libraryFor([...others, c.def]);
      checkDefinition(lib, c.def);
      checkFigurePoses(doc, lib, `defining pose ${c.def.name}`);
      const i = doc.poses.findIndex((d) => d.name === c.def.name);
      if (i >= 0) {
        doc.poses[i] = c.def;
      } else {
        doc.poses.push(c.def);
      }
      return;
    }
    case 'undefine': {
      if (!doc.poses.some((d) => d.name === c.name)) {
        throw new DslError(`the scene does not define a pose "${c.name}"`);
      }
      const rest: PoseDef[] = doc.poses.filter((d) => d.name !== c.name);
      const lib = libraryFor(rest);
      for (const d of rest) {
        try {
          checkDefinition(lib, d);
        } catch (e) {
          throw new DslError(`pose ${d.name} uses ${c.name}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      checkFigurePoses(doc, lib, `removing pose ${c.name}`);
      doc.poses = rest;
      return;
    }
    case 'set':
      for (const f of select(doc, c.sel)) {
        const key = `${c.joint}.${c.dof}`;
        const base = f.joints[key] ?? composePose(libraryFor(doc.poses), f.pose).dofs[key] ?? 0;
        f.joints[key] = round(clampDof(c.joint, c.dof, c.relative ? base + c.deg : c.deg), 1);
        // explicit joint angles on a limb override an IK reach on that limb
        for (const eff of Object.keys(LIMB_JOINTS) as Effector[]) {
          if ((LIMB_JOINTS[eff] ?? []).includes(c.joint)) {
            delete f.reaches[eff];
          }
        }
        if (c.joint === 'head') {
          f.look = null;
        }
        touched.add(f.id);
      }
      return;
    case 'reach':
      for (const f of select(doc, c.sel)) {
        f.reaches[c.effector] = bindTarget(doc, c.target, f.id);
        clearJointKeys(f, LIMB_JOINTS[c.effector] ?? []);
        touched.add(f.id);
      }
      return;
    case 'release':
      for (const f of select(doc, c.sel)) {
        if (c.effector === 'all') {
          f.reaches = {};
        } else {
          delete f.reaches[c.effector];
        }
        touched.add(f.id);
      }
      return;
    case 'look':
      for (const f of select(doc, c.sel)) {
        f.look = c.target === null ? null : bindTarget(doc, c.target, f.id);
        if (f.look !== null && (f.look.kind === 'figure' || f.look.kind === 'part') && f.look.figure === f.id) {
          throw new DslError('a figure cannot look at itself; use "set <figure> head nod_down <deg>" instead');
        }
        clearJointKeys(f, ['head']);
        touched.add(f.id);
      }
      return;
    case 'hand':
      for (const f of select(doc, c.sel)) {
        if (c.side === 'left' || c.side === 'both') {
          f.hands.left = c.shape;
        }
        if (c.side === 'right' || c.side === 'both') {
          f.hands.right = c.shape;
        }
        touched.add(f.id);
      }
      return;
    case 'reset':
      for (const f of select(doc, c.sel)) {
        if (c.what === 'all') {
          f.joints = {};
          f.reaches = {};
          f.look = null;
          f.hands = {};
        } else if (c.what === 'joints') {
          f.joints = {};
        } else if (c.what === 'reaches') {
          f.reaches = {};
        } else if (c.what === 'look') {
          f.look = null;
        } else if (c.what === 'hands') {
          f.hands = {};
        } else {
          clearJointKeys(f, [c.what]);
        }
        touched.add(f.id);
      }
      return;
    case 'camera':
      applyCamera(doc, c.cam);
      return;
    case 'light': {
      const l = doc.light;
      if (c.azimuth !== null) {
        l.azimuth = normDeg(c.azimuth);
      }
      if (c.elevation !== null) {
        l.elevation = Math.max(2, Math.min(90, c.elevation));
      }
      if (c.intensity !== null) {
        l.intensity = Math.max(0, Math.min(10, c.intensity));
      }
      if (c.fill !== null) {
        l.fill = Math.max(0, Math.min(2, c.fill));
      }
      return;
    }
    case 'ground':
      doc.ground = c.kind;
      return;
    case 'style':
      doc.style = c.style;
      return;
  }
}

function applyCamera(doc: SceneDoc, op: CameraOp): void {
  const cam = doc.camera;
  switch (op.op) {
    case 'position':
      cam.x = op.x;
      cam.y = op.y;
      cam.z = op.z;
      return;
    case 'height':
      cam.y = op.y;
      return;
    case 'look_at':
      cam.aim = { kind: 'target', target: bindTarget(doc, op.target, null) };
      return;
    case 'angles':
      cam.aim = { kind: 'angles', yaw: round(normDeg(op.yaw), 2), pitch: round(Math.max(-89, Math.min(89, op.pitch)), 2) };
      return;
    case 'orbit': {
      const target = bindTarget(doc, op.target, null);
      const loc = locateApprox(doc, target);
      if (loc === undefined) {
        throw new DslError('could not locate orbit target');
      }
      let subjectHeight = 1.8;
      if (target.kind === 'figure' || target.kind === 'part') {
        const f = figureById(doc, target.figure);
        subjectHeight = target.kind === 'part' ? 0.6 : bodyParams(f).height;
      }
      // default distance frames the subject's height with some margin
      const dist = op.distance ?? (subjectHeight * 1.25 * cam.lens) / 24;
      const az = (loc.facing ?? 0) + (op.azimuth ?? 0);
      const el = (op.elevation ?? 0) * DEG;
      const dir = forwardXZ(az);
      cam.x = round(loc.x + dir.x * dist * Math.cos(el));
      cam.z = round(loc.z + dir.z * dist * Math.cos(el));
      cam.y = round(Math.max(0.05, loc.y + dist * Math.sin(el)));
      cam.aim = { kind: 'target', target };
      return;
    }
    case 'lens':
      cam.lens = Math.max(8, Math.min(600, op.mm));
      return;
    case 'aperture':
      cam.fstop = Math.max(0.95, Math.min(32, op.fstop));
      cam.dof = true;
      return;
    case 'focus':
      if (op.target !== null) {
        cam.focus = { kind: 'target', target: bindTarget(doc, op.target, null) };
      } else if (op.meters !== null) {
        cam.focus = { kind: 'distance', meters: Math.max(0.1, op.meters) };
      } else {
        cam.focus = { kind: 'auto' };
      }
      return;
    case 'dof':
      cam.dof = op.on;
      return;
    case 'roll':
      cam.roll = normDeg(op.deg);
      return;
    case 'frame':
      cam.frame = op.frame;
      return;
  }
}

function addCrowd(doc: SceneDoc, c: Command & { op: 'add_crowd' }, ctx: ApplyContext, touched: Set<string>): void {
  if (doc.figures.some((f) => f.group === c.group)) {
    throw new DslError(`group @${c.group} already exists; remove it first or use another name`);
  }
  const rand = rng(c.seed * 9973 + c.count);
  let cx = 0;
  let cz = 0;
  let avoid: { x: number; z: number } | null = null;
  if (c.at !== null) {
    cx = c.at.x;
    cz = c.at.z;
  } else if (c.around !== null) {
    const tg = bindTarget(doc, c.around, null);
    const loc = locateApprox(doc, tg);
    if (loc === undefined) {
      throw new DslError('could not locate crowd center');
    }
    cx = loc.x;
    cz = loc.z;
    avoid = { x: cx, z: cz };
  }
  for (const m of c.models) {
    checkModel(ctx, m);
  }
  let mix: { model: string; body: string }[];
  if (c.models.length > 0 || c.bodies.length > 0) {
    const models = c.models.length > 0 ? c.models : [ctx.defaultModel];
    const bodies = c.bodies.length > 0 ? c.bodies : ['adult_male', 'adult_female'];
    mix = models.flatMap((m) => bodies.map((b) => ({ model: m, body: b })));
  } else {
    mix = ctx.crowdMix.filter((e) => ctx.knownModels.includes(e.model));
    if (mix.length === 0) {
      mix = [{ model: ctx.defaultModel, body: 'adult_male' }, { model: ctx.defaultModel, body: 'adult_female' }];
    }
  }
  const lib = libraryFor(doc.poses);
  const crowdPose = bindPose(lib, c.pose);
  const phased = hasPhase(lib, crowdPose);
  const occupied = doc.figures.map((f) => ({ x: f.x, z: f.z }));
  let n = 1;
  for (let i = 0; i < c.count; i++) {
    let px = cx;
    let pz = cz;
    for (let attempt = 0; attempt < 60; attempt++) {
      const r = c.radius * Math.sqrt(rand());
      const a = rand() * Math.PI * 2;
      px = cx + Math.cos(a) * r;
      pz = cz + Math.sin(a) * r;
      const clear = occupied.every((o) => (o.x - px) ** 2 + (o.z - pz) ** 2 > 0.85 ** 2);
      const clearOfCenter = avoid === null || (avoid.x - px) ** 2 + (avoid.z - pz) ** 2 > 1.3 ** 2;
      if (clear && clearOfCenter) {
        break;
      }
    }
    occupied.push({ x: px, z: pz });
    while (nameTaken(doc, `${c.group}_${n}`)) {
      n++;
    }
    const id = `${c.group}_${n}`;
    n++;
    const pick = mix[Math.floor(rand() * mix.length)] ?? mix[0];
    const f = newFigure(id, ctx, cameraYaw(doc), round(px, 2), round(pz, 2));
    f.group = c.group;
    if (pick !== undefined) {
      f.model = pick.model;
      f.body = pick.body;
    }
    // natural height variation
    const base = BODY_PRESET_BY_NAME.get(f.body)?.params.height ?? 1.7;
    f.bodyOverrides = { height: round(base * (0.95 + rand() * 0.1), 2) };
    if (c.facing === 'random') {
      f.facing = { kind: 'angle', deg: Math.round(normDeg(rand() * 360)) };
    } else if (c.facing !== null && c.facing.kind === 'angle') {
      f.facing = { kind: 'angle', deg: Math.round(normDeg(c.facing.deg + (rand() - 0.5) * 24)) };
    } else if (c.facing !== null) {
      f.facing = bindFacing(doc, c.facing, id);
      rand();
    } else {
      rand();
    }
    // walkers in a crowd are each at their own moment of the stride
    const phase = round(rand(), 2);
    f.pose = phased ? withPoseArg(crowdPose, 'phase', { k: 'num', v: phase }) : crowdPose;
    doc.figures.push(f);
    touched.add(id);
  }
}
