// Canonical humanoid skeleton. Every loaded rig is mapped onto these names.
//
// Character space: the figure faces +Z, up is +Y, and the figure's own left is
// +X. The "anatomical zero" pose is standing straight with arms hanging down
// and palms facing the thighs. Pose DOFs are rotations away from that pose.

export const FINGERS = ['thumb', 'index', 'middle', 'ring', 'pinky'] as const;
export type FingerName = (typeof FINGERS)[number];

export type SideKey = 'l' | 'r';

/** How a bone's zero orientation is defined. */
export type ZeroMode =
  /** segment pointing along a fixed direction in the zero pose */
  | { kind: 'dir'; dir: [number, number, number]; secondary: [number, number, number] }
  /** keep the rest orientation relative to the canonical parent */
  | { kind: 'inherit' };

export interface CanonBoneDef {
  name: string;
  /** canonical child used to measure the bone direction (first one present wins) */
  aim: string[];
  zero: ZeroMode;
}

const UP: [number, number, number] = [0, 1, 0];
const DOWN: [number, number, number] = [0, -1, 0];
const FWD: [number, number, number] = [0, 0, 1];

function sided(s: SideKey): CanonBoneDef[] {
  const defs: CanonBoneDef[] = [
    { name: `${s}_clavicle`, aim: [`${s}_upperarm`], zero: { kind: 'inherit' } },
    { name: `${s}_upperarm`, aim: [`${s}_forearm`], zero: { kind: 'dir', dir: DOWN, secondary: FWD } },
    { name: `${s}_forearm`, aim: [`${s}_hand`], zero: { kind: 'dir', dir: DOWN, secondary: FWD } },
    { name: `${s}_hand`, aim: [`${s}_middle1`, `${s}_index1`, `${s}_ring1`, `${s}_hand_end`], zero: { kind: 'dir', dir: DOWN, secondary: FWD } },
    { name: `${s}_thigh`, aim: [`${s}_shin`], zero: { kind: 'dir', dir: DOWN, secondary: FWD } },
    { name: `${s}_shin`, aim: [`${s}_foot`], zero: { kind: 'dir', dir: DOWN, secondary: FWD } },
    { name: `${s}_foot`, aim: [`${s}_toes`, `${s}_toes_end`], zero: { kind: 'inherit' } },
    { name: `${s}_toes`, aim: [`${s}_toes_end`], zero: { kind: 'inherit' } },
  ];
  for (const f of FINGERS) {
    for (let i = 1; i <= 3; i++) {
      defs.push({ name: `${s}_${f}${i}`, aim: i < 3 ? [`${s}_${f}${i + 1}`] : [`${s}_${f}_end`], zero: { kind: 'inherit' } });
    }
  }
  return defs;
}

export const CANON_BONES: CanonBoneDef[] = [
  { name: 'hips', aim: ['spine', 'spine_mid', 'chest', 'neck'], zero: { kind: 'dir', dir: UP, secondary: FWD } },
  { name: 'spine', aim: ['spine_mid', 'chest', 'neck'], zero: { kind: 'dir', dir: UP, secondary: FWD } },
  { name: 'spine_mid', aim: ['chest', 'neck'], zero: { kind: 'dir', dir: UP, secondary: FWD } },
  { name: 'chest', aim: ['neck'], zero: { kind: 'dir', dir: UP, secondary: FWD } },
  { name: 'neck', aim: ['head'], zero: { kind: 'dir', dir: UP, secondary: FWD } },
  { name: 'head', aim: ['head_end'], zero: { kind: 'dir', dir: UP, secondary: FWD } },
  ...sided('l'),
  ...sided('r'),
];

export const CANON_BY_NAME = new Map(CANON_BONES.map((b) => [b.name, b]));

/** Reference points that are not posed but used for directions and sizes. */
export const CANON_ENDS = ['head_end', 'l_hand_end', 'r_hand_end', 'l_toes_end', 'r_toes_end', ...(['l', 'r'] as const).flatMap((s) => FINGERS.map((f) => `${s}_${f}_end`))];

export const ALL_CANON_NAMES = [...CANON_BONES.map((b) => b.name), ...CANON_ENDS];
