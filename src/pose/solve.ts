// Pose solver: DOF angles + IK reaches + contacts + self-collision + look-at
// -> per-bone character-space rotations for any rig described by RigData.
//
// Notation: L(b) is a bone's local rotation in zero-frame terms, R(b) is the
// accumulated rotation from the zero pose (R(b) = R(parent) * L(b)), and the
// final bone rotation is Q(b) = R(b) * C(b) * restQuat(b).
//
// Stages, in order:
//   1. local rotations from DOFs (forearm twist shared by forearm and wrist)
//   2. foot reaches (IK)
//   3. grounding on the support surface (floor, box top, or seat)
//      + legs reaching down to the floor when sitting on a seat
//   4. leg self-collision, then planting feet (flat sole or ball + bent toes)
//   5. hand reaches (IK) with the palm oriented onto the target surface
//   6. arm self-collision (reaching arms swivel around the shoulder-wrist axis)
//   7. look-at

import { Matrix4, Quaternion, Vector3 } from 'three';
import type { Effector } from '../dsl/vocab.ts';
import type { ContactSet, RigData } from './rigData.ts';
import { LANDMARKS, LANDMARK_BY_NAME } from './landmarks.ts';
import { FINGERS, fingerKey, footRollAngles, neutralValue } from './lang/channels.ts';

/** feet: soles on the floor; lowest: lowest body point; seat: buttocks on the floor */
export type GroundMode = 'feet' | 'lowest' | 'seat';

const DEG = Math.PI / 180;
const AX = new Vector3(1, 0, 0);
const AY = new Vector3(0, 1, 0);
const AZ = new Vector3(0, 0, 1);
const UP = new Vector3(0, 1, 0);

/** anatomical bend limits for IK (degrees) */
const MAX_ELBOW = 148;
const MAX_KNEE = 152;
const MAX_WRIST_SWING = 80;
const MAX_FOREARM_TWIST = 100;

function rot(axis: Vector3, deg: number): Quaternion {
  return new Quaternion().setFromAxisAngle(axis, deg * DEG);
}

function rotRad(axis: Vector3, rad: number): Quaternion {
  return new Quaternion().setFromAxisAngle(axis, rad);
}

/** yaw (Y) then pitch (X) then roll (Z), intrinsic */
function ypr(yaw: number, pitch: number, roll: number): Quaternion {
  return rot(AY, yaw).multiply(rot(AX, pitch)).multiply(rot(AZ, roll));
}

/** Split q into swing * twist, with the twist about `axis` (unit). */
function swingTwist(q: Quaternion, axis: Vector3): { swing: Quaternion; twist: Quaternion } {
  const p = new Vector3(q.x, q.y, q.z).projectOnVector(axis);
  const twist = new Quaternion(p.x, p.y, p.z, q.w);
  if (twist.lengthSq() < 1e-12) {
    twist.identity();
  } else {
    twist.normalize();
  }
  const swing = q.clone().multiply(twist.clone().invert());
  return { swing, twist };
}

function quatAngle(q: Quaternion): number {
  return 2 * Math.acos(Math.min(1, Math.abs(q.w)));
}

/** Limit the rotation angle of q, keeping its axis. */
function capAngle(q: Quaternion, maxRad: number): Quaternion {
  const a = quatAngle(q);
  if (a <= maxRad) {
    return q;
  }
  return new Quaternion().slerp(q, maxRad / a);
}

export interface ReachTarget {
  /** character-space point, or null when `selfPart` is used */
  point: Vector3 | null;
  /** a landmark on this same figure */
  selfPart: string | null;
  /** outward surface normal at the target (character space), if known */
  normal: Vector3 | null;
  /**
   * blended pose goals: a weighted mix of landmarks on this figure. Weights
   * below 1 in total pull the hand/foot only part way from where the joint
   * angles put it.
   */
  blend?: { part: string; weight: number }[];
}

/** Surfaces under the figure, in character space. */
export interface Support {
  /** what the feet stand on (floor, or the top of a box/step) */
  floorY: number;
  /** seat surface when the figure is over a chair/bench/box and the pose sits */
  seatY: number | null;
}

export interface SolveInput {
  rig: RigData;
  /** joint channels (`left_knee.bend`) and finger channels (`left_index.curl1`), degrees; unset = neutral */
  dofs: Record<string, number>;
  reaches: Partial<Record<Effector, ReachTarget>>;
  /** character-space point to look at */
  look: Vector3 | null;
  ground: GroundMode;
  lift: number;
  /** pose sits on a seat when one is available */
  sit?: boolean;
  support?: Support;
  /** correction from measuring the deformed mesh (see Viewport.solveFigure) */
  groundBias?: number;
  /**
   * per-foot correction: height of the foot's sole landmarks above the floor
   * that puts its measured skin on the floor (see posing.ts)
   */
  footBias?: { l: number; r: number };
  /** resolve limb self-intersection (default true) */
  collisions?: boolean;
}

export interface Landmark {
  pos: Vector3;
  normal: Vector3 | null;
}

export interface SolveOutput {
  /** desired character-space rotation per canonical bone */
  quats: Map<string, Quaternion>;
  /** translation of the hips from the rest position, character space */
  hipsDelta: Vector3;
  /** posed landmarks in character space */
  landmarks: Map<string, Landmark>;
  /** posed joint positions in character space */
  joints: Map<string, Vector3>;
  /** which skin regions should touch which height, for mesh-based correction */
  contact: { sets: ContactSet[]; targetY: number } | null;
  /**
   * feet placed onto the floor by leg IK, for per-foot correction; weight is
   * the plant weight (1 planted, towards 0 lifting off). Standing feet (in a
   * gait, possibly part lifted) are corrected by their sole-to-skin offset,
   * resting feet (seated, kneeling, lying) by their measured gap.
   */
  restingFeet: { foot: Side; targetY: number; weight: number; standing: boolean }[];
}

export type Side = 'l' | 'r';

class PoseState {
  readonly L = new Map<string, Quaternion>();
  readonly R = new Map<string, Quaternion>();
  readonly P = new Map<string, Vector3>();
  readonly delta = new Vector3();
  readonly rig: RigData;
  constructor(rig: RigData) {
    this.rig = rig;
  }

  local(b: string): Quaternion {
    return this.L.get(b) ?? new Quaternion();
  }

  fk(): void {
    for (const name of this.rig.order) {
      const b = this.rig.bones.get(name);
      if (b === undefined) {
        continue;
      }
      const l = this.local(name);
      if (b.parent === null) {
        this.R.set(name, l.clone());
        this.P.set(name, b.restPos.clone().add(this.delta));
        continue;
      }
      const pr = this.R.get(b.parent) ?? new Quaternion();
      const pp = this.P.get(b.parent) ?? new Vector3();
      this.R.set(name, pr.clone().multiply(l));
      this.P.set(name, pp.clone().add(b.zeroOffset.clone().applyQuaternion(pr)));
    }
  }

  rotOf(b: string): Quaternion {
    return this.R.get(b) ?? new Quaternion();
  }

  posOf(b: string): Vector3 {
    return this.P.get(b) ?? new Vector3();
  }

  /** Joint or end point (e.g. head_end) position. */
  pointOf(name: string): Vector3 | undefined {
    if (this.P.has(name)) {
      return this.P.get(name);
    }
    const e = this.rig.ends.get(name);
    if (e === undefined) {
      return undefined;
    }
    return this.posOf(e.bone).clone().add(e.zeroOffset.clone().applyQuaternion(this.rotOf(e.bone)));
  }

  landmark(name: string): Landmark | undefined {
    const def = LANDMARK_BY_NAME.get(name);
    if (def === undefined) {
      return undefined;
    }
    const bone = def.bones.find((b) => this.rig.bones.has(b));
    if (bone === undefined) {
      return undefined;
    }
    const r = this.rotOf(bone);
    const pos = this.posOf(bone).clone().add(def.offset(this.rig, bone).applyQuaternion(r));
    const normal = def.normal === null ? null : def.normal.clone().applyQuaternion(r).normalize();
    return { pos, normal };
  }

  has(b: string): boolean {
    return this.rig.bones.has(b);
  }

  /** Set a bone's world-from-zero rotation, expressed as its local rotation. */
  setWorld(b: string, Rw: Quaternion): void {
    const parent = this.rig.bones.get(b)?.parent ?? null;
    const Rp = parent === null ? new Quaternion() : this.rotOf(parent);
    this.L.set(b, Rp.clone().invert().multiply(Rw));
  }
}

function dof(d: Record<string, number>, key: string): number {
  return d[key] ?? 0;
}

function setLocalRotations(st: PoseState, dofs: Record<string, number>): void {
  st.L.set('hips', ypr(dof(dofs, 'hips.turn_left'), dof(dofs, 'hips.bend_forward'), -dof(dofs, 'hips.lean_left')));

  const torso = ['spine', 'spine_mid', 'chest'].filter((b) => st.has(b));
  const n = Math.max(1, torso.length);
  for (const b of torso) {
    st.L.set(b, ypr(dof(dofs, 'torso.twist_left') / n, dof(dofs, 'torso.bend_forward') / n, -dof(dofs, 'torso.lean_left') / n));
  }
  setHeadRotations(st, dof(dofs, 'head.turn_left'), dof(dofs, 'head.nod_down'), dof(dofs, 'head.tilt_left'));

  for (const side of ['left', 'right'] as const) {
    const k: Side = side === 'left' ? 'l' : 'r';
    const sg = side === 'left' ? 1 : -1;
    const g = (j: string, d: string): number => dof(dofs, `${side}_${j}.${d}`);
    st.L.set(`${k}_upperarm`, rot(AX, -g('arm', 'raise_forward')).multiply(rot(AZ, sg * g('arm', 'raise_sideways'))).multiply(rot(AY, sg * g('arm', 'twist_out'))));
    // Pronation/supination is applied at the wrist: rigs without forearm twist
    // bones would otherwise turn the elbow skin as a block. The wrist helper
    // joint (and dual quaternion skinning) spreads it over the lower forearm.
    const sup = sg * g('wrist', 'turn_palm_forward');
    st.L.set(`${k}_forearm`, rot(AX, -Math.min(MAX_ELBOW, g('elbow', 'bend'))));
    st.L.set(`${k}_hand`, rot(AY, sup).multiply(rot(AZ, -sg * g('wrist', 'bend'))).multiply(rot(AX, -g('wrist', 'bend_thumb_side'))));
    st.L.set(`${k}_thigh`, rot(AX, -g('leg', 'raise_forward')).multiply(rot(AZ, sg * g('leg', 'raise_sideways'))).multiply(rot(AY, sg * g('leg', 'twist_out'))));
    st.L.set(`${k}_shin`, rot(AX, Math.min(MAX_KNEE, g('knee', 'bend'))));
    // inversion (roll_in) turns the sole toward the body's midline
    st.L.set(`${k}_foot`, rot(AX, g('ankle', 'point')).multiply(rot(AY, sg * g('ankle', 'turn_out'))).multiply(rot(AZ, -sg * g('ankle', 'roll_in'))));
    if (st.has(`${k}_toes`)) {
      st.L.set(`${k}_toes`, rot(AX, -g('toes', 'bend_up')));
    }
    for (const finger of FINGERS) {
      for (const i of [1, 2, 3] as const) {
        const key = fingerKey(side, finger, i);
        const a = dofs[key] ?? neutralValue(key);
        const q = finger === 'thumb'
          ? rot(AY, -sg * a).multiply(rot(AZ, -sg * a * 0.3))
          : rot(AZ, -sg * a);
        st.L.set(`${k}_${finger}${i}`, q);
      }
    }
  }
}

function setHeadRotations(st: PoseState, turn: number, nod: number, tilt: number): void {
  if (st.has('neck')) {
    st.L.set('neck', ypr(turn * 0.4, nod * 0.4, -tilt * 0.4));
    st.L.set('head', ypr(turn * 0.6, nod * 0.6, -tilt * 0.6));
  } else {
    st.L.set('head', ypr(turn, nod, -tilt));
  }
}

function perpUnit(v: Vector3, axis: Vector3): Vector3 | null {
  const p = v.clone().sub(axis.clone().multiplyScalar(v.dot(axis)));
  const len = p.length();
  return len < 1e-5 ? null : p.multiplyScalar(1 / len);
}

/**
 * Two-bone IK. `upper`/`lower`/`end` are canonical bones (shoulder/elbow/wrist
 * or hip/knee/ankle). `bendSign` is -1 for arms (elbow bends the forearm
 * toward +Z of the limb frame) and +1 for legs (knee bends toward -Z).
 * The lower twist (forearm pronation) is kept; the bend is capped at maxBend.
 */
function solveTwoBone(st: PoseState, upper: string, lower: string, end: string, target: Vector3, pole: Vector3, bendSign: 1 | -1, maxBend: number): void {
  const lb = st.rig.bones.get(lower);
  const eb = st.rig.bones.get(end);
  const ub = st.rig.bones.get(upper);
  if (lb === undefined || eb === undefined || ub === undefined) {
    return;
  }
  const l1 = lb.zeroOffset.length();
  const l2 = eb.zeroOffset.length();
  const S = st.posOf(upper);
  const toT = target.clone().sub(S);
  let d = toT.length();
  if (d < 1e-5) {
    return;
  }
  const dir = toT.clone().multiplyScalar(1 / d);
  // the joint cannot fold past maxBend: that sets a minimum reach
  const minD = Math.sqrt(l1 * l1 + l2 * l2 + 2 * l1 * l2 * Math.cos(maxBend * DEG));
  d = Math.min(l1 + l2 - 1e-4, Math.max(minD + 1e-4, d));
  const cosA = (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d);
  const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
  const bendDir = perpUnit(pole, dir) ?? perpUnit(new Vector3(0, 0, -1), dir) ?? new Vector3(1, 0, 0);
  const E = S.clone().add(dir.clone().multiplyScalar(l1 * cosA)).add(bendDir.clone().multiplyScalar(l1 * sinA));
  const T = S.clone().add(dir.clone().multiplyScalar(d));
  const u = E.clone().sub(S).normalize();
  const w = T.clone().sub(E).normalize();
  let side = perpUnit(w, u);
  if (side === null) {
    const cur = new Vector3(0, 0, 1).applyQuaternion(st.rotOf(upper));
    side = perpUnit(cur, u) ?? new Vector3(0, 0, 1);
    side.multiplyScalar(-bendSign);
  }
  const zAxis = bendSign === -1 ? side : side.clone().negate();
  const yAxis = u.clone().negate();
  const xAxis = new Vector3().crossVectors(yAxis, zAxis).normalize();
  st.setWorld(upper, new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(xAxis, yAxis, zAxis)));
  const theta = Math.acos(Math.max(-1, Math.min(1, u.dot(w)))) / DEG;
  // keep any existing twist of the lower bone about its own axis
  const { twist } = swingTwist(st.local(lower), AY);
  st.L.set(lower, rot(AX, bendSign * Math.min(maxBend, theta)).multiply(twist));
  st.fk();
}

/**
 * Orient a hand onto a surface: palm facing into the surface (normal n),
 * fingers continuing the forearm's direction along the surface. Wrist bend
 * and forearm rotation are limited to anatomical ranges.
 */
function orientHand(st: PoseState, side: Side, n: Vector3): void {
  const hand = `${side}_hand`;
  const fore = `${side}_forearm`;
  if (!st.has(hand) || !st.has(fore)) {
    return;
  }
  const sg = side === 'l' ? 1 : -1;
  const Rf = st.rotOf(fore);
  const foreAxis = new Vector3(0, -1, 0).applyQuaternion(Rf);
  let f = perpUnit(foreAxis, n);
  if (f === null) {
    f = perpUnit(new Vector3(0, 0, 1).applyQuaternion(st.rotOf('hips')), n) ?? new Vector3(1, 0, 0);
  }
  // hand zero frame: fingers along -Y, palm facing -sg X
  const X = n.clone().multiplyScalar(sg).normalize();
  const Y = f.clone().negate();
  const Z = new Vector3().crossVectors(X, Y).normalize();
  const desired = new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(X, Y, Z));
  const local = Rf.clone().invert().multiply(desired);
  const { swing, twist } = swingTwist(local, AY);
  st.L.set(hand, capAngle(swing, MAX_WRIST_SWING * DEG).multiply(capAngle(twist, MAX_FOREARM_TWIST * DEG)));
  st.fk();
}

/** Height of a ground mode's contact points; reaching limbs are skipped. */
function lowestOf(st: PoseState, mode: GroundMode, skip: Set<string>): number {
  let minY = Infinity;
  const consider = (name: string): void => {
    if (skip.has(name)) {
      return;
    }
    const lm = st.landmark(name);
    if (lm !== undefined) {
      minY = Math.min(minY, lm.pos.y);
    }
  };
  if (mode === 'feet') {
    for (const s of ['left', 'right']) {
      consider(`${s}_heel`);
      consider(`${s}_toes`);
      consider(`${s}_ball_sole`);
    }
  } else if (mode === 'seat') {
    consider('seat');
  } else {
    for (const def of LANDMARKS) {
      consider(def.name);
    }
  }
  if (!Number.isFinite(minY)) {
    for (const def of LANDMARKS) {
      const lm = st.landmark(def.name);
      if (lm !== undefined) {
        minY = Math.min(minY, lm.pos.y);
      }
    }
  }
  return Number.isFinite(minY) ? minY : 0;
}

/** Rotate bone `b` about world axis `a` (through its joint) by `rad`. */
function turnBone(st: PoseState, b: string, a: Vector3, rad: number): void {
  st.setWorld(b, rotRad(a, rad).multiply(st.rotOf(b)));
  st.fk();
}

/** Angle (radians) to rotate vector s about axis a so that it becomes horizontal. */
function levelAngle(s: Vector3, a: Vector3): number {
  let e1 = new Vector3().crossVectors(UP, a);
  if (e1.lengthSq() < 1e-8) {
    return 0;
  }
  e1.normalize();
  if (e1.dot(s) < 0) {
    e1 = e1.negate();
  }
  const e2 = new Vector3().crossVectors(a, e1);
  return -Math.atan2(s.dot(e2), s.dot(e1));
}

/**
 * Plant feet that touch the support: a foot standing on its sole is turned
 * flat; a foot on its ball with the heel up (toe-off, crouch) keeps the heel
 * up but bends the toes flat onto the surface.
 */
function plantFeet(st: PoseState, floorY: number, skip: Set<string>): void {
  for (const k of ['l', 'r'] as const) {
    const side = k === 'l' ? 'left' : 'right';
    if (skip.has(`${side}_heel`)) {
      continue;
    }
    const foot = `${k}_foot`;
    if (!st.has(foot)) {
      continue;
    }
    const heel = st.landmark(`${side}_heel`)?.pos;
    const ball = st.landmark(`${side}_ball_sole`)?.pos;
    if (heel === undefined || ball === undefined) {
      continue;
    }
    const soleDown = new Vector3(0, -1, 0).applyQuaternion(st.rotOf(foot));
    if (soleDown.y > -0.5) {
      continue; // foot is not standing on its sole (e.g. kneeling instep-down)
    }
    const near = Math.min(heel.y, ball.y) - floorY;
    if (near > 0.04) {
      continue; // swinging foot
    }
    const axis = new Vector3(1, 0, 0).applyQuaternion(st.rotOf(foot)).normalize();
    const heelUp = heel.y - ball.y;
    if (heelUp < 0.07) {
      // standing on the sole: level it
      const ang = levelAngle(ball.clone().sub(heel), axis);
      turnBone(st, foot, axis, Math.max(-0.6, Math.min(0.6, ang)));
    } else {
      // on the ball: toes flat on the surface
      const toesBone = `${k}_toes`;
      const tip = st.landmark(`${side}_toes`)?.pos;
      const ballNow = st.landmark(`${side}_ball_sole`)?.pos;
      if (st.has(toesBone) && tip !== undefined && ballNow !== undefined) {
        const taxis = new Vector3(1, 0, 0).applyQuaternion(st.rotOf(toesBone)).normalize();
        const ang = levelAngle(tip.clone().sub(ballNow), taxis);
        turnBone(st, toesBone, taxis, Math.max(-0.9, Math.min(0.9, ang)));
      }
    }
  }
}

function footSide(k: Side): 'left' | 'right' {
  return k === 'l' ? 'left' : 'right';
}

/** Lowest of a foot's sole points (heel, ball, toe tip). */
function footLowest(st: PoseState, k: Side): number {
  const s = footSide(k);
  let m = Infinity;
  for (const p of ['heel', 'ball_sole', 'toes']) {
    const lm = st.landmark(`${s}_${p}`);
    if (lm !== undefined) {
      m = Math.min(m, lm.pos.y);
    }
  }
  return m;
}

/** Pole for leg IK that keeps the knee pointing where it points now. */
function kneePole(st: PoseState, k: Side): Vector3 {
  // the thigh's own forward axis, not the knee's offset from the hip-ankle
  // line: on a nearly straight leg that offset is noise and can point
  // backwards, which twists the whole thigh half a turn
  return new Vector3(0, 0, 1).applyQuaternion(st.rotOf(`${k}_thigh`));
}

/** Pole for arm IK that keeps the elbow pointing where it points now. */
function elbowPole(st: PoseState, k: Side): Vector3 {
  return new Vector3(0, 0, -1).applyQuaternion(st.rotOf(`${k}_upperarm`));
}

/** Move a foot vertically by dy with leg IK, keeping the knee direction. */
function shiftFoot(st: PoseState, k: Side, dy: number): void {
  const ankle = st.posOf(`${k}_foot`).clone();
  ankle.y += dy;
  solveTwoBone(st, `${k}_thigh`, `${k}_shin`, `${k}_foot`, ankle, kneePole(st, k), 1, MAX_KNEE);
}

// ------------------------------------------------------------ weighted planting
//
// Standing, walking and running use the usual game-engine foot IK scheme
// (foot placement with plant weights and a pelvis offset):
// 1. every foot gets a plant weight that goes smoothly from 1 (on the floor)
//    to 0 (airborne) with its height above the floor;
// 2. its target is the animated (FK) foot blended by that weight with the
//    planted foot (sole flat, or toes flat when the heel is up, on the floor);
// 3. the pelvis offset is computed from those targets: as low as the most
//    demanding planted leg needs to reach its target at its animated length;
// 4. then each leg is solved to its target by two-bone IK.
// Every step is continuous in the animated pose, so the result changes
// continuously with the gait phase. A leg is never straightened beyond its
// animated extension, which avoids the knee "pop" of two-bone IK near full
// extension (the knee moves with the square root of the remaining length).

/** Feet this high or more above the floor are not planted at all. */
const PLANT_RANGE = 0.05;
/** Heel lift where a planted foot changes from sole-flat to on-the-ball. */
const HEEL_FLAT = 0.04;
const HEEL_BALL = 0.1;

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Plant weight of a foot at height h above the floor (h <= 0: planted). */
function plantWeight(h: number): number {
  return 1 - smoothstep(0, PLANT_RANGE, h);
}

interface FootPlan {
  k: Side;
  /** plant weight (position) */
  w: number;
  /** orientation weight: how far the foot has turned toward the floor */
  wo: number;
  /** animated ankle, character space, before the pelvis offset */
  animAnkle: Vector3;
  /** ankle of the fully planted foot (sole on the floor), character space */
  plantedAnkle: Vector3;
  /** animated hip-to-ankle distance: the leg is not stretched beyond it */
  length: number;
  /** blended foot world rotation and toes local rotation */
  footRot: Quaternion;
  toesLocal: Quaternion | null;
}

/**
 * Target for one foot: orientation blended between animated and planted
 * (sole flat for a low heel, toes bent flat for a raised one), ankle lowered
 * or raised by the weighted amount that puts the sole on targetY. Leaves the
 * leg as animated.
 */
/**
 * Toes lie on the floor as they do when standing flat: the toe line (toe
 * joint to tip) keeps its standing pitch while the heel rises. Blended in as
 * the foot comes onto its ball (roll 0 to 0.25).
 */
function flattenToes(st: PoseState, k: Side, roll: number): void {
  const toesBone = `${k}_toes`;
  const tip = st.landmark(`${footSide(k)}_toes`)?.pos;
  if (!st.has(toesBone) || tip === undefined) {
    return;
  }
  const taxis = new Vector3(1, 0, 0).applyQuaternion(st.rotOf(toesBone)).normalize();
  const rest = restToePitch(st, k);
  const target = floorHeading(taxis).multiplyScalar(Math.cos(rest)).addScaledVector(UP, -Math.sin(rest));
  const flat = signedAngleAbout(tip.clone().sub(st.posOf(toesBone)), target, taxis);
  turnBone(st, toesBone, taxis, smoothstep(0, 0.25, roll) * flat);
}

/**
 * Pitch (radians, positive = tip down) of the toe line, from the toe joint to
 * the toe tip, when the figure stands with flat feet: the anatomical zero
 * pose, in which the zero frame is the character frame.
 */
function restToePitch(st: PoseState, k: Side): number {
  const end = st.rig.ends.get(`${k}_toes_end`);
  if (end === undefined) {
    return 0;
  }
  const o = end.zeroOffset;
  return Math.atan2(-o.y, Math.hypot(o.x, o.z));
}

/**
 * Horizontal direction a foot (or toes) with lateral axis `axis` points along
 * on the floor: perpendicular to the axis, toward the figure's front (+Z).
 */
function floorHeading(axis: Vector3): Vector3 {
  const f = new Vector3().crossVectors(axis, UP);
  f.y = 0;
  if (f.lengthSq() < 1e-8) {
    return new Vector3(0, 0, 1);
  }
  f.normalize();
  return f.z < 0 ? f.negate() : f;
}

/** Signed angle (radians) about `axis` that turns `from` toward `to` (both projected off the axis). */
function signedAngleAbout(from: Vector3, to: Vector3, axis: Vector3): number {
  const a = from.clone().sub(axis.clone().multiplyScalar(from.dot(axis)));
  const b = to.clone().sub(axis.clone().multiplyScalar(to.dot(axis)));
  if (a.lengthSq() < 1e-10 || b.lengthSq() < 1e-10) {
    return 0;
  }
  return Math.atan2(axis.dot(new Vector3().crossVectors(a, b)), a.dot(b));
}

/**
 * Turn a foot (and its toes) the way it meets the floor when planted: to the
 * declared roll's pitch, or, without one, sole flat / toes flat on the ball
 * depending on how high the heel is.
 */
function orientPlanted(st: PoseState, k: Side, roll: number | undefined): void {
  const side = footSide(k);
  const foot = `${k}_foot`;
  const toesBone = `${k}_toes`;
  const hasToes = st.has(toesBone);
  const heel = st.landmark(`${side}_heel`)?.pos;
  const ball = st.landmark(`${side}_ball_sole`)?.pos;
  if (heel !== undefined && ball !== undefined && roll !== undefined) {
    // declared foot roll: the sole meets the floor at the roll's pitch
    // (heel down and toes up, flat, or heel up), toes flat once on the ball
    // Targets are explicit directions (the foot's heading on the floor,
    // pitched by the roll), not "make it level", which has two solutions and
    // flips when the animated foot points past vertical.
    const { pitch } = footRollAngles(roll);
    const axis = new Vector3(1, 0, 0).applyQuaternion(st.rotOf(foot)).normalize();
    const heading = floorHeading(axis);
    const sole = heading.clone().multiplyScalar(Math.cos(pitch * DEG)).addScaledVector(UP, -Math.sin(pitch * DEG));
    turnBone(st, foot, axis, signedAngleAbout(ball.clone().sub(heel), sole, axis));
    if (hasToes) {
      flattenToes(st, k, roll);
    }
  } else if (heel !== undefined && ball !== undefined) {
    const onBall = smoothstep(HEEL_FLAT, HEEL_BALL, heel.y - ball.y);
    const axis = new Vector3(1, 0, 0).applyQuaternion(st.rotOf(foot)).normalize();
    const level = levelAngle(ball.clone().sub(heel), axis);
    turnBone(st, foot, axis, (1 - onBall) * Math.max(-0.6, Math.min(0.6, level)));
    const tip = st.landmark(`${side}_toes`)?.pos;
    const ballNow = st.landmark(`${side}_ball_sole`)?.pos;
    if (hasToes && tip !== undefined && ballNow !== undefined) {
      const taxis = new Vector3(1, 0, 0).applyQuaternion(st.rotOf(toesBone)).normalize();
      const toeAng = levelAngle(tip.clone().sub(ballNow), taxis);
      turnBone(st, toesBone, taxis, onBall * Math.max(-0.9, Math.min(0.9, toeAng)));
    }
  }
}

/** Lowest sole point of a foot if it were turned as when planted (the foot is left as it was). */
function plantedLowest(st: PoseState, k: Side, roll: number | undefined): number {
  const foot = `${k}_foot`;
  const toesBone = `${k}_toes`;
  const footLocal = st.local(foot).clone();
  const toesLocal = st.has(toesBone) ? st.local(toesBone).clone() : null;
  orientPlanted(st, k, roll);
  const y = footLowest(st, k);
  st.L.set(foot, footLocal);
  if (toesLocal !== null) {
    st.L.set(toesBone, toesLocal);
  }
  st.fk();
  return y;
}

/** A foot turns toward the floor over this height above it, before it plants. */
const ORIENT_RANGE = 0.15;

/**
 * Steepest a foot on its ball pivots before it leaves the floor (toe-off;
 * about 50-60 degrees in walking). Steeper, the ball barely moves as the
 * heel rises and the pivot would swing the foot abruptly.
 */
const MAX_BALL_PITCH = 55 * DEG;

/**
 * Ball pivot (foot-roll rigs; the forefoot rocker of gait): a foot that is on
 * its ball and held above the floor by the leg lets its heel rise further
 * about the ankle, keeping the toes flat, until the ball reaches the floor or
 * the foot is as steep as it gets. Toe-off then follows from the leg lifting
 * the foot, not from a fixed timing. Continuous in the foot's height.
 */
function ballPivot(st: PoseState, k: Side, targetY: number, roll: number): void {
  const strength = smoothstep(0.05, 0.3, roll);
  if (strength <= 0 || footLowest(st, k) - targetY <= 0) {
    return;
  }
  const side = footSide(k);
  const foot = `${k}_foot`;
  const toesBone = `${k}_toes`;
  const heel = st.landmark(`${side}_heel`)?.pos;
  const ball = st.landmark(`${side}_ball_sole`)?.pos;
  if (heel === undefined || ball === undefined) {
    return;
  }
  const pitchNow = Math.atan2(heel.y - ball.y, Math.hypot(ball.x - heel.x, ball.z - heel.z));
  const maxExtra = Math.max(0, MAX_BALL_PITCH - pitchNow);
  if (maxExtra <= 0) {
    return;
  }
  const axis = new Vector3(1, 0, 0).applyQuaternion(st.rotOf(foot)).normalize();
  const footLocal = st.local(foot).clone();
  const toesLocal = st.has(toesBone) ? st.local(toesBone).clone() : null;
  const tryExtra = (e: number): number => {
    st.L.set(foot, footLocal);
    if (toesLocal !== null) {
      st.L.set(toesBone, toesLocal);
    }
    st.fk();
    turnBone(st, foot, axis, e);
    flattenToes(st, k, roll);
    return footLowest(st, k) - targetY;
  };
  // the lowest sole point comes down as the heel rises: bisect for contact
  let lo = 0;
  let hi = maxExtra;
  if (tryExtra(hi) > 0) {
    lo = hi;
  } else {
    for (let i = 0; i < 14; i++) {
      const mid = (lo + hi) / 2;
      if (tryExtra(mid) > 0) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
  }
  tryExtra(strength * lo);
}

function planFoot(st: PoseState, k: Side, targetY: number, roll: number | undefined): FootPlan {
  const foot = `${k}_foot`;
  const toesBone = `${k}_toes`;
  const hasToes = st.has(toesBone);
  const animFootLocal = st.local(foot).clone();
  const animFootRot = st.rotOf(foot).clone();
  const animToesLocal = hasToes ? st.local(toesBone).clone() : null;
  const ankle = st.posOf(foot).clone();
  const length = ankle.distanceTo(st.posOf(`${k}_thigh`));

  orientPlanted(st, k, roll);
  if (roll !== undefined && roll > 0) {
    ballPivot(st, k, targetY, roll);
  }
  const lift = targetY - footLowest(st, k);
  // weights from the height the planted sole would have: position plants
  // over PLANT_RANGE, orientation turns toward the floor over ORIENT_RANGE
  const h = -lift;
  const w = plantWeight(h);
  const wo = 1 - smoothstep(0, ORIENT_RANGE, h);
  const plantedFootRot = st.rotOf(foot).clone();
  const plantedToesLocal = hasToes ? st.local(toesBone).clone() : null;

  // back to the animated foot; the blend is applied after the leg IK
  st.L.set(foot, animFootLocal);
  if (hasToes && animToesLocal !== null) {
    st.L.set(toesBone, animToesLocal);
  }
  st.fk();
  return {
    k,
    w,
    wo,
    animAnkle: ankle,
    plantedAnkle: ankle.clone().add(new Vector3(0, lift, 0)),
    length,
    footRot: animFootRot.clone().slerp(plantedFootRot, wo),
    toesLocal: animToesLocal === null || plantedToesLocal === null ? null : animToesLocal.clone().slerp(plantedToesLocal, wo),
  };
}

/** How far the pelvis must come down for a hip to reach an ankle target at a given leg length (negative: may go up). */
function pelvisDropFor(hip: Vector3, ankle: Vector3, length: number): number {
  const horizontal = Math.hypot(ankle.x - hip.x, ankle.z - hip.z);
  const vertical = hip.y - ankle.y;
  const reachable = Math.sqrt(Math.max(0, length * length - horizontal * horizontal));
  return vertical - reachable;
}

/**
 * Standing, walking, running: ground contact for both feet, continuous in
 * the pose. Returns the feet that carry some weight.
 */
function plantStandingFeet(st: PoseState, floorY: number, free: Side[], footBias: { l: number; r: number } | undefined, rolls: Partial<Record<Side, number>>): SolveOutput['restingFeet'] {
  if (free.length === 0) {
    return [];
  }
  // 1-2. targets
  const plans: FootPlan[] = [];
  for (const k of free) {
    plans.push(planFoot(st, k, floorY + (footBias?.[k] ?? 0), rolls[k]));
  }
  // 3. pelvis offset: the most demanding foot, each scaled by its weight
  // (a lifting foot lets the pelvis rise back gradually)
  let drop = -Infinity;
  for (const p of plans) {
    const need = p.w * pelvisDropFor(st.posOf(`${p.k}_thigh`), p.plantedAnkle, p.length);
    drop = Math.max(drop, need);
  }
  if (!Number.isFinite(drop)) {
    drop = 0;
  }
  if (drop !== 0) {
    st.delta.y -= drop;
    st.fk();
  }
  // 4. legs: each ankle goes from where the animated leg puts it (moved with
  // the pelvis) to the planted position, by its weight
  const resting: SolveOutput['restingFeet'] = [];
  for (const p of plans) {
    if (p.w > 0) {
      const carried = p.animAnkle.clone().sub(new Vector3(0, drop, 0));
      const target = carried.lerp(p.plantedAnkle, p.w);
      solveTwoBone(st, `${p.k}_thigh`, `${p.k}_shin`, `${p.k}_foot`, target, kneePole(st, p.k), 1, MAX_KNEE);
    }
    if (p.wo > 0) {
      st.setWorld(`${p.k}_foot`, p.footRot);
      if (p.toesLocal !== null) {
        st.L.set(`${p.k}_toes`, p.toesLocal);
      }
      st.fk();
    }
    // nothing ends up below the floor: a turning foot mid-blend, or a
    // swinging foot the pelvis came down onto (max(0, depth) is continuous)
    const depth = floorY + (footBias?.[p.k] ?? 0) - footLowest(st, p.k);
    if (depth > 0) {
      const rotNow = st.rotOf(`${p.k}_foot`).clone();
      shiftFoot(st, p.k, depth);
      st.setWorld(`${p.k}_foot`, rotNow);
      st.fk();
    }
    if (p.w > 0) {
      resting.push({ foot: p.k, targetY: floorY, weight: p.w, standing: true });
    }
  }
  return resting;
}

/**
 * Kneeling, floor sitting, lying: bring a resting foot to height y by bending
 * the knee only. The thigh, and so the seat or knee the body rests on, stays.
 */
function bendKneeToFloor(st: PoseState, k: Side, y: number): void {
  const shin = `${k}_shin`;
  if (!st.has(shin) || !st.has(`${k}_foot`)) {
    return;
  }
  const hinge = new Vector3(1, 0, 0).applyQuaternion(st.rotOf(`${k}_thigh`)).normalize();
  const base = st.local(shin).clone();
  const kneeAngle = (): number => {
    const a = st.posOf(shin).clone().sub(st.posOf(`${k}_thigh`));
    const b = st.posOf(`${k}_foot`).clone().sub(st.posOf(shin));
    return a.angleTo(b) / DEG;
  };
  let best = 0;
  let bestErr = Math.abs(footLowest(st, k) - y);
  for (let deg = -30; deg <= 30; deg += 1) {
    st.L.set(shin, base);
    st.fk();
    turnBone(st, shin, hinge, deg * DEG);
    const bend = kneeAngle();
    if (bend > MAX_KNEE) {
      continue;
    }
    const err = Math.abs(footLowest(st, k) - y) + Math.abs(deg) * 0.00005;
    if (err < bestErr) {
      bestErr = err;
      best = deg;
    }
  }
  st.L.set(shin, base);
  st.fk();
  if (best !== 0) {
    turnBone(st, shin, hinge, best * DEG);
  }
}

/**
 * Sitting, kneeling, lying: a foot resting near the floor turns at the ankle
 * until it touches (instep, toes or heel, whichever comes down first).
 */
function restFootOnFloor(st: PoseState, k: Side, floorY: number): void {
  const foot = `${k}_foot`;
  if (!st.has(foot)) {
    return;
  }
  const gap = footLowest(st, k) - floorY;
  if (gap < 0.003 || gap > 0.25) {
    return;
  }
  const axis = new Vector3(1, 0, 0).applyQuaternion(st.rotOf(foot)).normalize();
  const base = st.local(foot).clone();
  let best = 0;
  let bestErr = Math.abs(gap);
  for (let deg = -40; deg <= 40; deg += 2) {
    st.L.set(foot, base);
    st.fk();
    turnBone(st, foot, axis, deg * DEG);
    const err = Math.abs(footLowest(st, k) - floorY) + Math.abs(deg) * 0.0002;
    if (err < bestErr) {
      bestErr = err;
      best = deg;
    }
  }
  st.L.set(foot, base);
  st.fk();
  if (best !== 0) {
    turnBone(st, foot, axis, best * DEG);
  }
}

function resolveReach(st: PoseState, t: ReachTarget): { point: Vector3; normal: Vector3 | null; weight: number } | null {
  if (t.point !== null) {
    return { point: t.point.clone(), normal: t.normal, weight: 1 };
  }
  if (t.selfPart !== null) {
    const lm = st.landmark(t.selfPart);
    if (lm !== undefined) {
      return { point: lm.pos, normal: lm.normal, weight: 1 };
    }
  }
  if (t.blend !== undefined && t.blend.length > 0) {
    // weighted mix of landmarks (blended poses)
    const point = new Vector3();
    const normal = new Vector3();
    let total = 0;
    for (const b of t.blend) {
      const lm = st.landmark(b.part);
      if (lm === undefined) {
        continue;
      }
      point.addScaledVector(lm.pos, b.weight);
      if (lm.normal !== null) {
        normal.addScaledVector(lm.normal, b.weight);
      }
      total += b.weight;
    }
    if (Math.abs(total) < 1e-6) {
      return null;
    }
    point.multiplyScalar(1 / total);
    return { point, normal: normal.lengthSq() > 1e-8 ? normal.normalize() : null, weight: Math.max(0, Math.min(1, total)) };
  }
  return null;
}

// ---------------------------------------------------------------- self-collision

interface Capsule {
  bone: string;
  a: Vector3;
  b: Vector3;
  r: number;
}

/**
 * Soft-tissue volumes in front of the trunk (belly, chest) as spheres whose
 * front surface is the body surface. Capsules along the spine cannot model
 * the belly a flexed thigh presses against, because they also reach the hip
 * joint itself.
 */
const TRUNK_SPHERES: Record<string, { landmark: string; radius: number }> = {
  'sphere:belly': { landmark: 'belly', radius: 0.1 },
  'sphere:chest': { landmark: 'chest', radius: 0.1 },
};

function capsuleOf(st: PoseState, bone: string): Capsule | null {
  const sphere = TRUNK_SPHERES[bone];
  if (sphere !== undefined) {
    const lm = st.landmark(sphere.landmark);
    if (lm === undefined || lm.normal === null) {
      return null;
    }
    const r = sphere.radius * (st.rig.height / 1.75);
    const c = lm.pos.clone().sub(lm.normal.clone().multiplyScalar(r));
    return { bone, a: c, b: c.clone(), r };
  }
  const c = st.rig.capsules.get(bone);
  if (c === undefined || !st.P.has(bone)) {
    return null;
  }
  const b = st.pointOf(c.to);
  if (b === undefined) {
    return null;
  }
  const a = st.posOf(bone).clone();
  return { bone, a, b: a.clone().lerp(b, c.length ?? 1), r: c.radius };
}

/** Closest points between segments p0-p1 and q0-q1. */
function closestSegments(p0: Vector3, p1: Vector3, q0: Vector3, q1: Vector3): { pa: Vector3; pb: Vector3 } {
  const d1 = p1.clone().sub(p0);
  const d2 = q1.clone().sub(q0);
  const r = p0.clone().sub(q0);
  const a = d1.dot(d1);
  const e = d2.dot(d2);
  const f = d2.dot(r);
  let s = 0;
  let t = 0;
  if (a <= 1e-10 && e <= 1e-10) {
    return { pa: p0.clone(), pb: q0.clone() };
  }
  if (a <= 1e-10) {
    t = Math.max(0, Math.min(1, f / e));
  } else {
    const c = d1.dot(r);
    if (e <= 1e-10) {
      s = Math.max(0, Math.min(1, -c / a));
    } else {
      const b = d1.dot(d2);
      const denom = a * e - b * b;
      s = denom > 1e-10 ? Math.max(0, Math.min(1, (b * f - c * e) / denom)) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = Math.max(0, Math.min(1, -c / a));
      } else if (t > 1) {
        t = 1;
        s = Math.max(0, Math.min(1, (b - c) / a));
      }
    }
  }
  return { pa: p0.clone().add(d1.multiplyScalar(s)), pb: q0.clone().add(d2.multiplyScalar(t)) };
}

type Limb = { side: Side; kind: 'arm' | 'leg' };

const LIMB_SEGMENTS: Record<'arm' | 'leg', string[]> = {
  arm: ['upperarm', 'forearm', 'hand'],
  leg: ['thigh', 'shin', 'foot'],
};

function limbOf(bone: string): Limb | null {
  const m = /^(l|r)_(upperarm|forearm|hand|thigh|shin|foot)$/.exec(bone);
  if (m === null) {
    return null;
  }
  const side = m[1] as Side;
  const kind = m[2] === 'upperarm' || m[2] === 'forearm' || m[2] === 'hand' ? 'arm' : 'leg';
  return { side, kind };
}

/** Pairs of segments that must not interpenetrate (adjacent parts excluded). */
function collisionPairs(kind: 'arm' | 'leg'): [string, string][] {
  const pairs: [string, string][] = [];
  const torso = ['hips', 'spine', 'spine_mid', 'chest'];
  for (const s of ['l', 'r'] as const) {
    const o = s === 'l' ? 'r' : 'l';
    if (kind === 'arm') {
      for (const seg of ['forearm', 'hand']) {
        for (const t of [...torso, 'head', 'l_thigh', 'r_thigh']) {
          pairs.push([`${s}_${seg}`, t]);
        }
      }
      pairs.push([`${s}_upperarm`, 'head'], [`${s}_upperarm`, 'l_thigh'], [`${s}_upperarm`, 'r_thigh']);
      if (s === 'l') {
        for (const a of ['upperarm', 'forearm', 'hand']) {
          for (const b of ['forearm', 'hand']) {
            pairs.push([`l_${a}`, `r_${b}`]);
            if (a !== 'upperarm') {
              pairs.push([`l_${b}`, `r_${a}`]);
            }
          }
        }
      }
    } else {
      for (const seg of ['shin', 'foot']) {
        for (const t of ['spine', 'spine_mid', 'chest']) {
          pairs.push([`${s}_${seg}`, t]);
        }
      }
      pairs.push([`${s}_thigh`, 'spine_mid'], [`${s}_thigh`, 'chest']);
      for (const seg of ['thigh', 'shin']) {
        pairs.push([`${s}_${seg}`, 'sphere:belly'], [`${s}_${seg}`, 'sphere:chest']);
      }
      if (s === 'l') {
        for (const a of ['thigh', 'shin', 'foot']) {
          for (const b of ['shin', 'foot']) {
            pairs.push([`l_${a}`, `${o}_${b}`]);
            if (a !== 'thigh') {
              pairs.push([`l_${b}`, `${o}_${a}`]);
            }
          }
        }
      }
    }
  }
  return pairs;
}

/**
 * Push a limb away along `dir` by `amount` at `point`. Free limbs rotate at
 * the shoulder/hip; limbs that must keep their end in place (reaches, planted
 * feet) swivel about the shoulder-wrist / hip-ankle axis instead.
 */
function pushLimb(st: PoseState, limb: Limb, point: Vector3, dir: Vector3, amount: number, locked: boolean, segment?: string): void {
  const root = limb.kind === 'arm' ? `${limb.side}_upperarm` : `${limb.side}_thigh`;
  if (!st.has(root)) {
    return;
  }
  const J = st.posOf(root);
  if (!locked) {
    const lever = point.clone().sub(J);
    const len = lever.length();
    const axis = new Vector3().crossVectors(lever, dir);
    if (len < 1e-3 || axis.lengthSq() < 1e-10) {
      return;
    }
    turnBone(st, root, axis.normalize(), Math.min(0.25, amount / len));
    return;
  }
  const end = limb.kind === 'arm' ? `${limb.side}_hand` : `${limb.side}_foot`;
  const mid = limb.kind === 'arm' ? `${limb.side}_forearm` : `${limb.side}_shin`;
  // a planted foot that collides (crossed feet) slides apart along the floor
  if (limb.kind === 'leg' && segment !== undefined && (segment.endsWith('_foot') || segment.endsWith('_shin'))) {
    const slide = new Vector3(dir.x, 0, dir.z);
    if (slide.lengthSq() > 1e-8) {
      const footRot = st.rotOf(end).clone();
      const ankle = st.posOf(end).clone().add(slide.normalize().multiplyScalar(Math.min(0.05, amount)));
      solveTwoBone(st, root, mid, end, ankle, kneePole(st, limb.side), 1, MAX_KNEE);
      st.setWorld(end, footRot);
      st.fk();
      return;
    }
  }
  const axis = st.posOf(end).clone().sub(J);
  if (axis.lengthSq() < 1e-8) {
    return;
  }
  axis.normalize();
  const rel = st.posOf(mid).clone().sub(J);
  const radial = rel.sub(axis.clone().multiplyScalar(rel.dot(axis)));
  const r = radial.length();
  if (r < 1e-3) {
    return;
  }
  const tangent = new Vector3().crossVectors(axis, radial).normalize();
  const sign = Math.sign(tangent.dot(dir)) || 1;
  // the swivel moves the knee/elbow only: the planted foot or reaching hand
  // keeps its orientation
  const endRot = st.rotOf(end).clone();
  turnBone(st, root, axis, sign * Math.min(0.3, amount / r));
  st.setWorld(end, endRot);
  st.fk();
}

function resolveCollisions(st: PoseState, kind: 'arm' | 'leg', locked: (l: Limb) => boolean, exempt: Set<string> = new Set()): void {
  // exempt segments touch the body on purpose (a hand on the chin or thigh)
  const pairs = collisionPairs(kind).filter(([m, o]) => !exempt.has(m) && !exempt.has(o));
  const margin = 0.004; // skin compresses a little where limbs touch
  for (let iter = 0; iter < 8; iter++) {
    let worst = 0;
    for (const [m, o] of pairs) {
      const A = capsuleOf(st, m);
      const B = capsuleOf(st, o);
      if (A === null || B === null) {
        continue;
      }
      const { pa, pb } = closestSegments(A.a, A.b, B.a, B.b);
      const sep = pa.clone().sub(pb);
      const dist = sep.length();
      const pen = A.r + B.r - margin - dist;
      if (pen <= 0) {
        continue;
      }
      const la = limbOf(m);
      const lb = limbOf(o);
      if (la === null) {
        continue;
      }
      // a reaching hand rests on the body: the forearm touching it right at
      // the wrist (a chin on the fist) is the intended contact
      if (exempt.has(`${la.side}_hand`) && m === `${la.side}_forearm` && pa.distanceTo(A.b) < 0.07 * (st.rig.height / 1.75)) {
        continue;
      }
      worst = Math.max(worst, pen);
      const dir = dist > 1e-6 ? sep.multiplyScalar(1 / dist) : new Vector3(0, 0, 1);
      const both = lb !== null && lb.kind === la.kind && lb.side !== la.side;
      const share = both ? 0.5 : 1;
      pushLimb(st, la, pa, dir, pen * share * 0.8, locked(la), m);
      if (both && lb !== null) {
        pushLimb(st, lb, pb, dir.clone().negate(), pen * share * 0.8, locked(lb), o);
      }
    }
    if (worst < 0.002) {
      break;
    }
  }
}

// ---------------------------------------------------------------- solve

export function solvePose(input: SolveInput): SolveOutput {
  const st = new PoseState(input.rig);
  const s = input.rig.height / 1.75;
  const floorY = input.support?.floorY ?? 0;
  const seated = input.sit === true && input.support?.seatY !== null && input.support?.seatY !== undefined;
  const mode: GroundMode = seated ? 'seat' : input.ground;
  const targetY = seated ? (input.support?.seatY ?? floorY) : floorY;
  setLocalRotations(st, input.dofs);
  st.fk();

  // landmarks of reaching limbs do not take part in grounding
  const skip = new Set<string>();
  const reachingFeet: Side[] = [];
  for (const k of ['left', 'right'] as const) {
    if (input.reaches[`${k}_foot`] !== undefined) {
      reachingFeet.push(k === 'left' ? 'l' : 'r');
      for (const p of ['heel', 'toes', 'ball_sole', 'foot', 'ankle']) {
        skip.add(`${k}_${p}`);
      }
    }
    if (input.reaches[`${k}_hand`] !== undefined) {
      for (const p of ['hand', 'wrist', 'forearm', 'elbow']) {
        skip.add(`${k}_${p}`);
      }
    }
  }

  // 1. foot reaches (foot on a step, kicking a ball)
  for (const k of ['l', 'r'] as const) {
    const t = input.reaches[k === 'l' ? 'left_foot' : 'right_foot'];
    const tgt = t === undefined ? null : resolveReach(st, t);
    if (tgt === null) {
      continue;
    }
    let ankleTarget = tgt.point.clone().add(new Vector3(0, input.rig.ankleHeight[k], 0));
    if (tgt.weight < 1) {
      ankleTarget = st.posOf(`${k}_foot`).clone().lerp(ankleTarget, tgt.weight);
    }
    const sg = k === 'l' ? 1 : -1;
    const pole = new Vector3(sg * 0.15, 0, 1).applyQuaternion(st.rotOf('hips'));
    solveTwoBone(st, `${k}_thigh`, `${k}_shin`, `${k}_foot`, ankleTarget, pole, 1, MAX_KNEE);
  }

  // 2. grounding on the support (floor, box top, or seat). Standing feet are
  // measured as they will be planted (declared roll, or sole/toes flat), so
  // a foot the animation points into the floor does not sink the body.
  const freeFeet = (['l', 'r'] as const).filter((k) => !reachingFeet.includes(k));
  const rolls: Partial<Record<Side, number>> = { l: input.dofs['left_foot.roll'], r: input.dofs['right_foot.roll'] };
  const ground = (): void => {
    st.delta.set(0, 0, 0);
    st.fk();
    let low = Infinity;
    if (mode === 'feet' && freeFeet.length > 0) {
      for (const k of freeFeet) {
        low = Math.min(low, plantedLowest(st, k, rolls[k]));
      }
    } else {
      low = lowestOf(st, mode, skip);
    }
    st.delta.y = targetY - low + input.lift + (input.groundBias ?? 0);
    st.fk();
  };
  ground();

  // sitting (on a seat or on the floor): feet come to rest on the floor, not
  // through it, keeping each knee's direction
  // sitting on a seat: feet reach down to the floor first
  if (seated) {
    for (const k of freeFeet) {
      shiftFoot(st, k, floorY - footLowest(st, k));
    }
  }

  // 3. legs: self-collision, then feet placed on the support
  const legLocked = (l: Limb): boolean => reachingFeet.includes(l.side) || (mode === 'feet' && l.kind === 'leg');
  if (input.collisions !== false) {
    resolveCollisions(st, 'leg', legLocked);
  }
  let restingFeet: SolveOutput['restingFeet'] = [];
  if (mode === 'feet') {
    // standing, walking, running: weighted planting, continuous in the pose;
    // a lifted body (a run's flight, a jump) unplants its feet by their height
    restingFeet = plantStandingFeet(st, floorY, freeFeet, input.footBias, rolls);
  } else if (input.lift === 0) {
    // seated, kneeling, lying, floor sitting: static poses. Feet within reach
    // of the surface rest on it: soles are levelled (or on the ball with bent
    // toes), other feet turn at the ankle, then the leg lowers the foot onto
    // the surface; nothing ends up below it
    for (const k of freeFeet) {
      const gap = footLowest(st, k) - floorY;
      if (gap > 0.25) {
        continue;
      }
      const soleDown = new Vector3(0, -1, 0).applyQuaternion(st.rotOf(`${k}_foot`)).y < -0.5;
      if (soleDown) {
        plantFeet(st, floorY, new Set([...skip, `${footSide(k === 'l' ? 'r' : 'l')}_heel`]));
        shiftFoot(st, k, floorY + (input.footBias?.[k] ?? 0) - footLowest(st, k));
      } else {
        // on the instep, heel or side (kneeling, lying, cross-legged): turn at
        // the ankle, then let the leg lay the foot down onto the floor
        // prefer the knee alone (keeps the thigh and the seat on it); the
        // whole leg moves only when the knee cannot do it
        const footY = floorY + (input.footBias?.[k] ?? 0);
        restFootOnFloor(st, k, floorY);
        bendKneeToFloor(st, k, footY);
        if (Math.abs(footLowest(st, k) - footY) > 0.01) {
          shiftFoot(st, k, footY - footLowest(st, k));
        }
        restFootOnFloor(st, k, footY);
      }
      // each resting foot is refined from the measured skin (see posing.ts)
      restingFeet.push({ foot: k, targetY: floorY, weight: 1, standing: false });
    }
  }

  // 4. hand reaches, palm placed on the target surface
  for (const k of ['l', 'r'] as const) {
    const t = input.reaches[k === 'l' ? 'left_hand' : 'right_hand'];
    if (t === undefined) {
      continue;
    }
    const sg = k === 'l' ? 1 : -1;
    const chest = ['chest', 'spine_mid', 'spine', 'hips'].find((b) => st.has(b)) ?? 'hips';
    const palmDef = LANDMARK_BY_NAME.get(k === 'l' ? 'left_hand' : 'right_hand');
    // where the joint angles put the hand, for partial (blended) goals
    const fkWrist = st.posOf(`${k}_hand`).clone();
    const fkHand = st.rotOf(`${k}_hand`).clone();
    for (let iter = 0; iter < 3; iter++) {
      const tgt = resolveReach(st, t);
      if (tgt === null) {
        break;
      }
      // elbows prefer to hang down; for targets low beside the body they swing
      // out and back, for targets in front of the face (chin, mouth) they come
      // forward under the hand
      const chestPos = st.posOf(chest);
      const chestInv = st.rotOf(chest).clone().invert();
      const rel = tgt.point.clone().sub(chestPos).applyQuaternion(chestInv);
      const high = Math.max(0, Math.min(1, rel.y / (0.3 * s) + 0.5));
      const front = Math.max(0, Math.min(1, rel.z / (0.12 * s)));
      const pole = new Vector3(sg * (0.75 - 0.35 * high), -0.3 - 0.5 * high, -0.6 + 0.4 * high + 0.9 * high * front)
        .normalize()
        .applyQuaternion(st.rotOf(chest));
      let wrist: Vector3;
      if (tgt.normal !== null && palmDef !== undefined) {
        const palmOffset = palmDef.offset(input.rig, `${k}_hand`).applyQuaternion(st.rotOf(`${k}_hand`));
        wrist = tgt.point.clone().add(tgt.normal.clone().multiplyScalar(0.012 * s)).sub(palmOffset);
      } else {
        // the hand continues the reach: first guess along shoulder -> target,
        // then along the forearm as solved
        const handDir = iter === 0
          ? tgt.point.clone().sub(st.posOf(`${k}_upperarm`)).normalize()
          : new Vector3(0, -1, 0).applyQuaternion(st.rotOf(`${k}_hand`));
        wrist = tgt.point.clone().sub(handDir.multiplyScalar(0.075 * s));
      }
      if (tgt.weight < 1) {
        wrist = fkWrist.clone().lerp(wrist, tgt.weight);
      }
      solveTwoBone(st, `${k}_upperarm`, `${k}_forearm`, `${k}_hand`, wrist, pole, -1, MAX_ELBOW);
      if (tgt.normal !== null) {
        orientHand(st, k, tgt.normal);
      }
      if (tgt.weight < 1) {
        st.setWorld(`${k}_hand`, fkHand.clone().slerp(st.rotOf(`${k}_hand`), tgt.weight));
        st.fk();
      }
    }
  }

  // 5. arms: self-collision (reaching arms swivel so the hand stays on target)
  if (input.collisions !== false) {
    const armLocked = (l: Limb): boolean => input.reaches[l.side === 'l' ? 'left_hand' : 'right_hand'] !== undefined;
    const exempt = new Set<string>();
    for (const k of ['l', 'r'] as const) {
      if (input.reaches[k === 'l' ? 'left_hand' : 'right_hand'] !== undefined) {
        exempt.add(`${k}_hand`);
      }
    }
    resolveCollisions(st, 'arm', armLocked, exempt);
    // the swivel kept the wrist; re-seat the palm on the target from the new
    // elbow position, keeping the elbow where the swivel put it
    for (const k of ['l', 'r'] as const) {
      const t = input.reaches[k === 'l' ? 'left_hand' : 'right_hand'];
      const tgt = t === undefined ? null : resolveReach(st, t);
      if (tgt === null || tgt.normal === null || tgt.weight < 1) {
        continue;
      }
      orientHand(st, k, tgt.normal);
      const palmDef = LANDMARK_BY_NAME.get(k === 'l' ? 'left_hand' : 'right_hand');
      if (palmDef === undefined) {
        continue;
      }
      const palmOffset = palmDef.offset(input.rig, `${k}_hand`).applyQuaternion(st.rotOf(`${k}_hand`));
      const wrist = tgt.point.clone().add(tgt.normal.clone().multiplyScalar(0.012 * s)).sub(palmOffset);
      solveTwoBone(st, `${k}_upperarm`, `${k}_forearm`, `${k}_hand`, wrist, elbowPole(st, k), -1, MAX_ELBOW);
      orientHand(st, k, tgt.normal);
    }
  }

  // 6. look-at overrides the head DOFs
  if (input.look !== null && st.has('head')) {
    const base = st.has('neck') ? (input.rig.bones.get('neck')?.parent ?? 'hips') : (input.rig.bones.get('head')?.parent ?? 'hips');
    const eyes = st.landmark('eyes')?.pos ?? st.posOf('head');
    const dir = input.look.clone().sub(eyes).applyQuaternion(st.rotOf(base).clone().invert());
    const yaw = Math.max(-80, Math.min(80, Math.atan2(dir.x, dir.z) / DEG));
    const pitch = Math.max(-55, Math.min(65, Math.atan2(-dir.y, Math.hypot(dir.x, dir.z)) / DEG));
    setHeadRotations(st, yaw, pitch, 0);
    st.fk();
  }

  const quats = new Map<string, Quaternion>();
  for (const name of input.rig.order) {
    const b = input.rig.bones.get(name);
    if (b === undefined) {
      continue;
    }
    quats.set(name, st.rotOf(name).clone().multiply(b.C).multiply(b.restQuat));
  }
  const landmarks = new Map<string, Landmark>();
  for (const def of LANDMARKS) {
    const lm = st.landmark(def.name);
    if (lm !== undefined) {
      landmarks.set(def.name, lm);
    }
  }

  // tell the caller which skin should rest on which height, for exact contact
  let contact: SolveOutput['contact'] = null;
  if (input.lift === 0) {
    const free = (['l', 'r'] as const).filter((k) => !reachingFeet.includes(k));
    if (mode === 'feet' && free.length > 0 && restingFeet.length === 0) {
      contact = { sets: free.map((k): ContactSet => `${k}_foot`), targetY };
    } else if (mode === 'seat' && seated) {
      contact = { sets: ['seat'], targetY };
    } else if (mode === 'seat' || mode === 'lowest') {
      // sitting on the floor, kneeling, lying: the lowest body point rests on
      // the floor; feet laid down by IK are corrected per foot (restingFeet)
      contact = { sets: ['seat', 'body'], targetY };
    }
  }
  return { quats, hipsDelta: st.delta.clone(), landmarks, joints: new Map(st.P), contact, restingFeet };
}
