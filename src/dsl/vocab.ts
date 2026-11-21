// Shared vocabulary for the scene DSL. The parser, the pose solver, the UI
// labels, and the LLM system prompt are all generated from these tables, so
// adding a word here makes it available everywhere.

export type Side = 'left' | 'right';

// ---------------------------------------------------------------------------
// Joints and their degrees of freedom (DOFs)
// ---------------------------------------------------------------------------
// Every DOF is stored in degrees. A positive value moves in the direction named
// by the DOF (e.g. `turn_left 30`), a negative value moves the opposite way.
// `aliases` map alternate phrasings to the DOF with a sign.

export interface DofDef {
  name: string;
  description: string;
  min: number;
  max: number;
  /** alternate phrasing -> sign applied to the value */
  aliases: Record<string, 1 | -1>;
}

export interface JointDef {
  name: string;
  description: string;
  aliases: string[];
  dofs: DofDef[];
}

function dof(name: string, description: string, min: number, max: number, aliases: Record<string, 1 | -1> = {}): DofDef {
  return { name, description, min, max, aliases };
}

const torsoDofs = (twistWord: string): DofDef[] => [
  dof('bend_forward', 'bend forward (negative = arch back)', -45, 100, { bend: 1, bend_forward: 1, bend_back: -1, arch: -1, arch_back: -1, lean_forward: 1, lean_back: -1 }),
  dof('lean_left', 'side-bend to own left (negative = right)', -45, 45, { lean_left: 1, lean_right: -1, tilt_left: 1, tilt_right: -1 }),
  dof(`${twistWord}_left`, `${twistWord} toward own left (negative = right)`, -70, 70, { [`${twistWord}_left`]: 1, [`${twistWord}_right`]: -1, turn_left: 1, turn_right: -1, twist_left: 1, twist_right: -1, rotate_left: 1, rotate_right: -1 }),
];

const armDofs: DofDef[] = [
  dof('raise_forward', 'raise arm forward from hanging (90 = pointing ahead, 180 = overhead; negative = swing back)', -60, 180, { raise_forward: 1, forward: 1, raise_front: 1, raise_back: -1, swing_back: -1, back: -1 }),
  dof('raise_sideways', 'raise arm out to the side (90 = T-pose; negative = across the body)', -40, 180, { raise_sideways: 1, sideways: 1, raise_side: 1, out: 1, raise_out: 1, across: -1, in: -1 }),
  dof('twist_out', 'rotate the arm outward around its own axis (negative = inward)', -90, 90, { twist_out: 1, rotate_out: 1, twist_in: -1, rotate_in: -1, twist: 1 }),
];

const legDofs: DofDef[] = [
  dof('raise_forward', 'raise thigh forward (90 = thigh horizontal; negative = swing back)', -40, 140, { raise_forward: 1, forward: 1, raise_knee: 1, kick_forward: 1, raise_back: -1, swing_back: -1, back: -1, kick_back: -1 }),
  dof('raise_sideways', 'raise leg out to the side (negative = across)', -30, 90, { raise_sideways: 1, sideways: 1, raise_side: 1, out: 1, spread: 1, across: -1, in: -1 }),
  dof('twist_out', 'rotate the leg outward so the toes point out (negative = in)', -45, 60, { twist_out: 1, rotate_out: 1, twist_in: -1, rotate_in: -1, twist: 1 }),
];

export const JOINTS: JointDef[] = [
  { name: 'hips', description: 'pelvis orientation', aliases: ['pelvis', 'waist'], dofs: torsoDofs('turn') },
  { name: 'torso', description: 'spine and chest, spread over the spine bones', aliases: ['spine', 'chest', 'upper_body', 'back', 'body'], dofs: torsoDofs('twist') },
  {
    name: 'head', description: 'neck and head together', aliases: ['neck', 'face'],
    dofs: [
      dof('nod_down', 'tip chin down (negative = look up)', -60, 70, { nod: 1, nod_down: 1, look_down: 1, tilt_down: 1, nod_up: -1, look_up: -1, tilt_up: -1, tilt_back: -1, down: 1, up: -1 }),
      dof('tilt_left', 'tilt ear toward own left shoulder (negative = right)', -45, 45, { tilt_left: 1, tilt_right: -1, cock_left: 1, cock_right: -1 }),
      dof('turn_left', 'turn to look toward own left (negative = right)', -85, 85, { turn_left: 1, turn_right: -1, look_left: 1, look_right: -1, left: 1, right: -1 }),
    ],
  },
  ...(['left', 'right'] as const).flatMap((s): JointDef[] => [
    { name: `${s}_arm`, description: `${s} shoulder joint (upper arm)`, aliases: [`${s}_shoulder`, `${s}_upper_arm`, `${s}_upperarm`], dofs: armDofs },
    { name: `${s}_elbow`, description: `${s} elbow`, aliases: [`${s}_forearm`, `${s}_lower_arm`], dofs: [dof('bend', 'bend the elbow (0 = straight, 150 = fully bent)', 0, 150, { bend: 1, flex: 1, straighten: -1 })] },
    {
      name: `${s}_wrist`, description: `${s} wrist and forearm twist`, aliases: [`${s}_hand`],
      dofs: [
        dof('bend', 'bend the hand toward the palm (negative = back of hand)', -70, 80, { bend: 1, flex: 1, bend_in: 1, bend_back: -1, extend: -1 }),
        dof('bend_thumb_side', 'tilt the hand toward the thumb (negative = pinky side)', -30, 30, { bend_thumb_side: 1, bend_pinky_side: -1, side: 1 }),
        dof('turn_palm_forward', 'rotate forearm so the palm faces forward/up (negative = palm back/down)', -90, 90, { turn_palm_forward: 1, palm_forward: 1, palm_up: 1, supinate: 1, turn_palm_back: -1, palm_back: -1, palm_down: -1, pronate: -1, twist: 1 }),
      ],
    },
    { name: `${s}_leg`, description: `${s} hip joint (thigh)`, aliases: [`${s}_hip`, `${s}_thigh`, `${s}_upper_leg`], dofs: legDofs },
    { name: `${s}_knee`, description: `${s} knee`, aliases: [`${s}_shin`, `${s}_lower_leg`, `${s}_calf`], dofs: [dof('bend', 'bend the knee (0 = straight, 150 = fully bent)', 0, 160, { bend: 1, flex: 1, straighten: -1 })] },
    {
      name: `${s}_ankle`, description: `${s} ankle`, aliases: [`${s}_foot`],
      dofs: [
        dof('point', 'point the toes down (negative = toes up)', -40, 70, { point: 1, point_down: 1, toes_down: 1, toes_up: -1, flex: -1 }),
        dof('turn_out', 'turn the foot outward (negative = inward)', -30, 30, { turn_out: 1, turn_in: -1 }),
        dof('roll_in', 'roll the sole to face inward, onto the outer edge (negative = onto the inner edge)', -25, 35, { roll_in: 1, invert: 1, roll_out: -1, evert: -1 }),
      ],
    },
    {
      name: `${s}_toes`, description: `${s} toes, bending at the ball of the foot`, aliases: [`${s}_toe`, `${s}_ball`],
      dofs: [
        dof('bend_up', 'bend the toes up at the ball of the foot (negative = curl down)', -40, 70, { bend_up: 1, lift: 1, extend: 1, bend: 1, curl: -1, bend_down: -1 }),
      ],
    },
  ]),
];

export const JOINT_BY_NAME: Map<string, JointDef> = new Map();
for (const j of JOINTS) {
  JOINT_BY_NAME.set(j.name, j);
  for (const a of j.aliases) {
    JOINT_BY_NAME.set(a, j);
  }
}

export function resolveJoint(word: string): JointDef | undefined {
  return JOINT_BY_NAME.get(word.toLowerCase());
}

/** Resolve a DOF phrase like `turn_right` or `raise forward` to a DOF and sign. */
export function resolveDof(joint: JointDef, phrase: string): { dof: DofDef; sign: 1 | -1 } | undefined {
  const key = phrase.toLowerCase().replace(/[\s-]+/g, '_');
  for (const d of joint.dofs) {
    if (d.name === key) {
      return { dof: d, sign: 1 };
    }
  }
  for (const d of joint.dofs) {
    const s = d.aliases[key];
    if (s !== undefined) {
      return { dof: d, sign: s };
    }
  }
  return undefined;
}

/**
 * Canonical text for a DOF value. Negative values use the first opposite
 * phrasing so the scene reads naturally: `turn_left -20` -> `turn_right 20`.
 */
export function formatDofPhrase(jointName: string, dofName: string, value: number): { phrase: string; value: number } {
  if (value >= 0) {
    return { phrase: dofName, value };
  }
  const d = JOINT_BY_NAME.get(jointName)?.dofs.find((q) => q.name === dofName);
  const neg = d === undefined ? undefined : Object.entries(d.aliases).find(([, s]) => s === -1)?.[0];
  return neg === undefined ? { phrase: dofName, value } : { phrase: neg, value: -value };
}

// ---------------------------------------------------------------------------
// Body part labels (landmarks). Usable as targets: `runner.face`, `self.left_hip`.
// ---------------------------------------------------------------------------

export interface PartDef {
  name: string;
  description: string;
}

const centerParts: PartDef[] = [
  { name: 'head', description: 'center of the head' },
  { name: 'top_of_head', description: 'crown of the head' },
  { name: 'face', description: 'front of the face' },
  { name: 'forehead', description: 'forehead' },
  { name: 'eyes', description: 'between the eyes' },
  { name: 'mouth', description: 'mouth' },
  { name: 'chin', description: 'chin' },
  { name: 'back_of_head', description: 'back of the head' },
  { name: 'neck', description: 'front of the neck' },
  { name: 'chest', description: 'front of the chest' },
  { name: 'belly', description: 'front of the stomach' },
  { name: 'back', description: 'upper back' },
  { name: 'lower_back', description: 'small of the back' },
  { name: 'pelvis', description: 'center of the hips' },
];

const sidedParts = ['eye', 'ear', 'cheek', 'shoulder', 'upper_arm', 'elbow', 'forearm', 'wrist', 'hand', 'hip', 'thigh', 'knee', 'shin', 'ankle', 'foot', 'heel', 'toes'];

export const PARTS: PartDef[] = [
  ...centerParts,
  ...sidedParts.flatMap((p) => (['left', 'right'] as const).map((s) => ({ name: `${s}_${p}`, description: `${s} ${p.replace(/_/g, ' ')}` }))),
];

export const PART_NAMES = new Set(PARTS.map((p) => p.name));

const PART_ALIASES: Record<string, string> = {
  nose: 'face', cheek: 'face', cheeks: 'face', lips: 'mouth', jaw: 'chin', crown: 'top_of_head', skull: 'head',
  throat: 'neck', breast: 'chest', heart: 'chest', stomach: 'belly', abdomen: 'belly', tummy: 'belly', waist: 'belly',
  hips: 'pelvis', groin: 'pelvis', spine: 'back', butt: 'lower_back',
};

export function resolvePart(word: string): string | undefined {
  const w = word.toLowerCase();
  if (PART_NAMES.has(w)) {
    return w;
  }
  const a = PART_ALIASES[w];
  if (a !== undefined) {
    return a;
  }
  // `left_palm` -> `left_hand`, `right_fingers` -> `right_hand`, etc.
  const m = /^(left|right)_(palm|fingers|fist|lower_leg|calf|upper_leg|foot_tip|toe)$/.exec(w);
  if (m) {
    const map: Record<string, string> = { palm: 'hand', fingers: 'hand', fist: 'hand', lower_leg: 'shin', calf: 'shin', upper_leg: 'thigh', foot_tip: 'toes', toe: 'toes' };
    return `${m[1]}_${map[m[2] ?? ''] ?? ''}`;
  }
  return undefined;
}

export const EFFECTORS = ['left_hand', 'right_hand', 'left_foot', 'right_foot'] as const;
export type Effector = (typeof EFFECTORS)[number];

export function resolveEffector(word: string): Effector | undefined {
  const w = word.toLowerCase();
  const map: Record<string, Effector> = {
    left_hand: 'left_hand', right_hand: 'right_hand', left_foot: 'left_foot', right_foot: 'right_foot',
    left_palm: 'left_hand', right_palm: 'right_hand', left_wrist: 'left_hand', right_wrist: 'right_hand',
    left_arm: 'left_hand', right_arm: 'right_hand', left_leg: 'left_foot', right_leg: 'right_foot',
  };
  return map[w];
}

export const HAND_SHAPES = ['relaxed', 'open', 'fist', 'point', 'grip', 'flat'] as const;
export type HandShape = (typeof HAND_SHAPES)[number];

// Poses are defined in the pose language: built-in atoms in
// src/pose/lang/evaluate.ts, default recipes in src/pose/lang/library.ts.

// ---------------------------------------------------------------------------
// Body presets. The human figure (MakeHuman CC0, src/rig/makehuman.ts) follows
// every parameter except waist; other rigged models only follow height.
// ---------------------------------------------------------------------------

export interface BodyParams {
  /** standing height in meters */
  height: number;
  /** age in years (1-90): body proportions change from child to elderly */
  age: number;
  /** total height in head-heights; 0 = natural for the age. Anime ~6.5, chibi ~3 */
  heads: number;
  /** 0 = male body, 1 = female body, in between blends */
  femininity: number;
  /** body weight: 0.8 slim .. 1.0 average .. 1.4 heavy */
  build: number;
  /** muscle: 0.7 soft .. 1.0 average .. 1.4 very muscular */
  muscle: number;
  /** chest / bust circumference in cm (with hip, sets cup size) */
  bust: number;
  /** waist circumference in cm (not yet used by the human figure) */
  waist: number;
  /** hip circumference in cm */
  hip: number;
  /** leg length relative to natural (1.0); anime styles use ~1.1 */
  leg_length: number;
}

export interface BodyPreset {
  name: string;
  description: string;
  params: BodyParams;
}

export const BODY_PRESETS: BodyPreset[] = [
  { name: 'adult_male', description: 'average adult man', params: { height: 1.76, age: 30, heads: 0, femininity: 0, build: 1, muscle: 1, bust: 100, waist: 86, hip: 98, leg_length: 1 } },
  { name: 'adult_female', description: 'average adult woman', params: { height: 1.63, age: 30, heads: 0, femininity: 1, build: 1, muscle: 1, bust: 92, waist: 74, hip: 98, leg_length: 1 } },
  { name: 'teen_male', description: 'teenage boy, about 15', params: { height: 1.68, age: 15, heads: 0, femininity: 0, build: 0.92, muscle: 0.95, bust: 86, waist: 72, hip: 86, leg_length: 1 } },
  { name: 'teen_female', description: 'teenage girl, about 15', params: { height: 1.6, age: 15, heads: 0, femininity: 1, build: 0.92, muscle: 0.95, bust: 82, waist: 64, hip: 88, leg_length: 1 } },
  { name: 'child', description: 'child, about 8', params: { height: 1.28, age: 8, heads: 0, femininity: 0.5, build: 0.95, muscle: 0.9, bust: 64, waist: 58, hip: 66, leg_length: 1 } },
  { name: 'athletic_male', description: 'muscular athletic man', params: { height: 1.82, age: 28, heads: 0, femininity: 0, build: 0.95, muscle: 1.38, bust: 112, waist: 82, hip: 98, leg_length: 1 } },
  { name: 'athletic_female', description: 'fit athletic woman', params: { height: 1.7, age: 27, heads: 0, femininity: 1, build: 0.92, muscle: 1.3, bust: 90, waist: 68, hip: 94, leg_length: 1 } },
  { name: 'heavy_male', description: 'heavyset man', params: { height: 1.75, age: 40, heads: 0, femininity: 0, build: 1.36, muscle: 0.95, bust: 118, waist: 112, hip: 112, leg_length: 1 } },
  { name: 'heavy_female', description: 'heavyset woman', params: { height: 1.62, age: 40, heads: 0, femininity: 1, build: 1.36, muscle: 0.95, bust: 112, waist: 100, hip: 118, leg_length: 1 } },
  { name: 'elderly', description: 'older man around 75', params: { height: 1.72, age: 75, heads: 0, femininity: 0, build: 1.05, muscle: 0.85, bust: 100, waist: 96, hip: 100, leg_length: 1 } },
  { name: 'elderly_female', description: 'older woman around 75', params: { height: 1.6, age: 75, heads: 0, femininity: 1, build: 1.05, muscle: 0.85, bust: 96, waist: 88, hip: 102, leg_length: 1 } },
  { name: 'anime_female', description: 'stylized anime proportions: larger head, long legs', params: { height: 1.6, age: 19, heads: 6.4, femininity: 1, build: 0.85, muscle: 0.95, bust: 86, waist: 58, hip: 88, leg_length: 1.12 } },
  { name: 'anime_male', description: 'stylized anime proportions: larger head, long legs', params: { height: 1.75, age: 20, heads: 6.8, femininity: 0, build: 0.88, muscle: 1.05, bust: 92, waist: 72, hip: 88, leg_length: 1.12 } },
  { name: 'chibi', description: 'super-deformed cartoon, huge head', params: { height: 1.0, age: 8, heads: 3, femininity: 0.5, build: 1.05, muscle: 0.85, bust: 70, waist: 66, hip: 72, leg_length: 0.85 } },
];

export const BODY_PRESET_BY_NAME = new Map(BODY_PRESETS.map((b) => [b.name, b]));

export const BODY_PARAM_NAMES: (keyof BodyParams)[] = ['height', 'age', 'heads', 'femininity', 'build', 'muscle', 'bust', 'waist', 'hip', 'leg_length'];

export function isBodyParam(name: string): name is keyof BodyParams {
  return (BODY_PARAM_NAMES as string[]).includes(name);
}

// ---------------------------------------------------------------------------
// Placement relations, props, scene settings
// ---------------------------------------------------------------------------

export const RELATIONS = ['left_of', 'right_of', 'in_front_of', 'behind', 'near'] as const;
export type Relation = (typeof RELATIONS)[number];

export const PROP_KINDS = ['box', 'chair', 'bench', 'table', 'wall', 'pillar', 'step'] as const;
export type PropKind = (typeof PROP_KINDS)[number];

export const PROP_DEFAULT_SIZE: Record<PropKind, [number, number, number]> = {
  box: [0.5, 0.5, 0.5],
  chair: [0.48, 0.9, 0.5],
  bench: [1.6, 0.45, 0.4],
  table: [1.2, 0.75, 0.8],
  wall: [4, 2.5, 0.2],
  pillar: [0.4, 3, 0.4],
  step: [1.2, 0.18, 0.35],
};

export const GROUND_KINDS = ['grid', 'plain', 'street'] as const;
export type GroundKind = (typeof GROUND_KINDS)[number];

export const RENDER_STYLES = ['smooth', 'flat', 'toon'] as const;
export type RenderStyle = (typeof RENDER_STYLES)[number];
