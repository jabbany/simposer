// Channels: the named numeric values a pose writes to drive the rig, and the
// body regions they belong to. See docs/pose-system.md.
//
// - joint channels: `<joint>.<dof>` from the vocabulary (`left_knee.bend`)
// - finger channels: `<side>_<finger>.curl1..3`
// - support weights: `support.<part>` (what carries the body)
// - `body.lift`: height of an airborne body above its supports
// Reach goals are kept separately (see PoseValue.goals) but take part in the
// same exclusivity checks under the key `goal.<effector>`.

import { JOINTS } from '../../dsl/vocab.ts';
import type { HandShape } from '../../dsl/vocab.ts';

export const FINGERS = ['thumb', 'index', 'middle', 'ring', 'pinky'] as const;
export type Finger = (typeof FINGERS)[number];

/** Finger curls (degrees per joint, base to tip) for each named hand shape. */
export const FINGER_CURL: Record<HandShape, Record<Finger, [number, number, number]>> = {
  flat: { thumb: [0, 0, 0], index: [0, 0, 0], middle: [0, 0, 0], ring: [0, 0, 0], pinky: [0, 0, 0] },
  open: { thumb: [-5, 0, 0], index: [3, 3, 2], middle: [3, 3, 2], ring: [4, 4, 2], pinky: [5, 5, 3] },
  // small on purpose: rigs like MakeHuman already rest with naturally bent fingers
  relaxed: { thumb: [6, 5, 4], index: [5, 9, 5], middle: [9, 12, 7], ring: [12, 14, 8], pinky: [14, 16, 9] },
  grip: { thumb: [30, 18, 12], index: [40, 50, 30], middle: [44, 52, 32], ring: [48, 54, 34], pinky: [52, 56, 34] },
  // proximal joints stop short of 90 so fingertips rest on the palm instead of sinking in
  fist: { thumb: [38, 30, 25], index: [78, 92, 55], middle: [80, 92, 55], ring: [82, 92, 55], pinky: [84, 92, 55] },
  point: { thumb: [38, 30, 25], index: [0, 2, 0], middle: [80, 92, 55], ring: [82, 92, 55], pinky: [84, 92, 55] },
};

export function fingerKey(side: 'left' | 'right', finger: Finger, joint: 1 | 2 | 3): string {
  return `${side}_${finger}.curl${joint}`;
}

/** Finger channels for a named hand shape. */
export function handShapeChannels(side: 'left' | 'right', shape: HandShape): [string, number][] {
  const out: [string, number][] = [];
  const curl = FINGER_CURL[shape];
  for (const f of FINGERS) {
    const a = curl[f];
    out.push([fingerKey(side, f, 1), a[0]], [fingerKey(side, f, 2), a[1]], [fingerKey(side, f, 3), a[2]]);
  }
  return out;
}

/** The named hand shape whose finger angles these channels hold, if any. */
export function handShapeOf(dofs: Record<string, number>, side: 'left' | 'right'): HandShape | null {
  for (const shape of Object.keys(FINGER_CURL) as HandShape[]) {
    if (handShapeChannels(side, shape).every(([k, v]) => Math.abs((dofs[k] ?? neutralValue(k)) - v) < 1e-6)) {
      return shape;
    }
  }
  return null;
}

/** Parts that can carry the body. `feet`, `knees`, `hands` expand to both sides. */
export const SUPPORT_PARTS = ['left_foot', 'right_foot', 'left_knee', 'right_knee', 'left_hand', 'right_hand', 'seat', 'back', 'front'] as const;
export type SupportPart = (typeof SUPPORT_PARTS)[number];

export function expandSupport(word: string): SupportPart[] | undefined {
  const pairs: Record<string, SupportPart[]> = {
    feet: ['left_foot', 'right_foot'], knees: ['left_knee', 'right_knee'], hands: ['left_hand', 'right_hand'],
    buttocks: ['seat'], bottom: ['seat'], belly: ['front'], stomach: ['front'],
  };
  if (pairs[word] !== undefined) {
    return pairs[word];
  }
  return (SUPPORT_PARTS as readonly string[]).includes(word) ? [word as SupportPart] : undefined;
}

// ---------------------------------------------------------------- regions

/** Smallest regions; every channel belongs to exactly one. */
const ATOMIC = ['pelvis', 'torso', 'head', 'l_arm', 'r_arm', 'l_hand', 'r_hand', 'l_leg', 'r_leg', 'l_foot', 'r_foot', 'body'] as const;
type Atomic = (typeof ATOMIC)[number];

/** Region names usable as slot types. */
export const REGIONS: Record<string, Atomic[]> = {
  pelvis: ['pelvis'],
  torso: ['torso'],
  head: ['head'],
  left_arm: ['l_arm', 'l_hand'],
  right_arm: ['r_arm', 'r_hand'],
  arms: ['l_arm', 'r_arm', 'l_hand', 'r_hand'],
  left_hand: ['l_hand'],
  right_hand: ['r_hand'],
  hands: ['l_hand', 'r_hand'],
  left_leg: ['l_leg'],
  right_leg: ['r_leg'],
  legs: ['l_leg', 'r_leg'],
  left_foot: ['l_foot'],
  right_foot: ['r_foot'],
  feet: ['l_foot', 'r_foot'],
  body: ['body'],
  upper: ['torso', 'head', 'l_arm', 'r_arm', 'l_hand', 'r_hand'],
  lower: ['pelvis', 'l_leg', 'r_leg', 'l_foot', 'r_foot'],
  all: [...ATOMIC],
};

export function atomicRegion(key: string): Atomic {
  const [head = '', tail = ''] = key.split('.');
  if (head === 'support') {
    if (tail === 'left_foot') {
      return 'l_foot';
    }
    if (tail === 'right_foot') {
      return 'r_foot';
    }
    return 'body';
  }
  if (head === 'goal') {
    return tail === 'left_hand' ? 'l_arm' : tail === 'right_hand' ? 'r_arm' : tail === 'left_foot' ? 'l_leg' : 'r_leg';
  }
  if (head === 'body') {
    return 'body';
  }
  if (head === 'hips') {
    return 'pelvis';
  }
  if (head === 'torso' || head === 'head') {
    return head;
  }
  const m = /^(left|right)_(\w+)$/.exec(head);
  const s = m?.[1] === 'left' ? 'l' : 'r';
  const part = m?.[2] ?? '';
  if (part === 'arm' || part === 'elbow' || part === 'wrist') {
    return `${s}_arm`;
  }
  if ((FINGERS as readonly string[]).includes(part)) {
    return `${s}_hand`;
  }
  if (part === 'leg' || part === 'knee') {
    return `${s}_leg`;
  }
  return `${s}_foot`; // ankle, toes, foot
}

export function inRegion(key: string, region: string): boolean {
  return (REGIONS[region] ?? []).includes(atomicRegion(key));
}

// ---------------------------------------------------------------- neutral values

/** Every channel, for `rest(region)`. */
export function allChannels(): string[] {
  const out: string[] = [];
  for (const j of JOINTS) {
    for (const d of j.dofs) {
      out.push(`${j.name}.${d.name}`);
    }
  }
  for (const side of ['left', 'right'] as const) {
    for (const f of FINGERS) {
      for (const i of [1, 2, 3] as const) {
        out.push(fingerKey(side, f, i));
      }
    }
  }
  for (const p of SUPPORT_PARTS) {
    out.push(`support.${p}`);
  }
  out.push('left_foot.roll', 'right_foot.roll', 'body.lift');
  return out;
}

// ---------------------------------------------------------------- foot roll

/**
 * Foot roll (as in foot-roll rigs; Perry's heel / ankle / forefoot rockers):
 * -1 on the heel with the toes up, 0 flat, 1 high on the ball with the toes
 * bent flat, 2 on the tips. Returns the sole's pitch to the floor (degrees,
 * positive = heel up) and the toes' bend at the ball relative to the foot.
 */
export function footRollAngles(roll: number): { pitch: number; toes: number } {
  const r = Math.max(-1.5, Math.min(2, roll));
  if (r <= 0) {
    return { pitch: 25 * r, toes: 0 };
  }
  if (r <= 1) {
    return { pitch: 45 * r, toes: 45 * r };
  }
  return { pitch: 45 + 25 * (r - 1), toes: 45 - 25 * (r - 1) };
}

const RELAXED = new Map<string, number>([...handShapeChannels('left', 'relaxed'), ...handShapeChannels('right', 'relaxed')]);

/** Value a channel takes when no pose sets it: 0, except relaxed fingers. */
export function neutralValue(key: string): number {
  return RELAXED.get(key) ?? 0;
}

// ---------------------------------------------------------------- mirroring

/** Center channels whose sign flips when the pose is mirrored left to right. */
const SIDED_CENTER = new Set(['hips.turn_left', 'hips.lean_left', 'torso.lean_left', 'torso.twist_left', 'head.turn_left', 'head.tilt_left']);

export function mirrorKey(key: string): { key: string; sign: 1 | -1 } {
  if (SIDED_CENTER.has(key)) {
    return { key, sign: -1 };
  }
  return { key: mirrorWord(key), sign: 1 };
}

/** Swap `left`/`right` anywhere in a name: `left_knee.bend`, `support.left_foot`. */
export function mirrorWord(w: string): string {
  return w.replace(/\b(left|right)_/g, (_m, s: string) => (s === 'left' ? 'right_' : 'left_'));
}
