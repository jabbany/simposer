// Automatic mapping from a rig's bone names to the canonical skeleton.
// Handles Mixamo ("mixamorig:LeftForeArm"), Unreal/Quaternius ("lowerarm_l",
// "spine_02"), VRM ("leftLowerArm"), Blender/Rigify ("forearm.L", "DEF-"),
// and plain names. A manifest can override any entry explicitly.

import type { Object3D } from 'three';
import { FINGERS } from './canon.ts';

export type BoneMap = Record<string, string>;

interface Candidate {
  obj: Object3D;
  norm: string;
  side: 'l' | 'r' | null;
  depth: number;
}

function normalize(name: string): { norm: string; side: 'l' | 'r' | null } {
  let n = name;
  n = n.replace(/^mixamorig\d*[:_]?/i, '');
  n = n.replace(/^(DEF|ORG|MCH|J_Bip|J_Adj|Bip\d*|Armature|Root|CC_Base)[-_:. ]?/i, '');
  // camelCase -> snake
  n = n.replace(/([a-z0-9])([A-Z])/g, '$1_$2');
  n = n.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  let side: 'l' | 'r' | null = null;
  const tokens = n.split('_').filter((t) => t.length > 0);
  const rest: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] ?? '';
    if (t === 'c' && i === 0) {
      // VRM center marker: J_Bip_C_Hips
      continue;
    }
    if (t === 'left' || ((t === 'l') && side === null)) {
      side = 'l';
      continue;
    }
    if (t === 'right' || ((t === 'r') && side === null)) {
      side = 'r';
      continue;
    }
    if (t.startsWith('left') && t.length > 4) {
      side = 'l';
      rest.push(t.slice(4));
      continue;
    }
    if (t.startsWith('right') && t.length > 5) {
      side = 'r';
      rest.push(t.slice(5));
      continue;
    }
    rest.push(t);
  }
  // Rigify-style suffix ".L" collapses to "_l" which was already handled.
  return { norm: rest.join(''), side };
}

const CENTER_PATTERNS: [string, RegExp][] = [
  ['hips', /^(hips?|pelvis|root_?hips)$/],
  ['neck', /^neck(0?1)?$/],
  ['head', /^head$/],
  ['head_end', /^(head_?top_?end|head_?end|headtop|head_?nub|head0?1?_?end)$/],
];

const SIDED_PATTERNS: [string, RegExp][] = [
  ['clavicle', /^(shoulder|clavicle|collar|collarbone)$/],
  ['upperarm', /^(arm|upper_?arm|uparm|upperarm0?1?)$/],
  ['forearm', /^(fore_?arm|lower_?arm|lowerarm0?1?|elbow)$/],
  ['hand', /^(hand|wrist)$/],
  ['thigh', /^(up_?leg|upleg|thigh|upper_?leg|upperleg)$/],
  ['shin', /^(leg|calf|shin|lower_?leg|lowerleg|knee)$/],
  ['foot', /^(foot|ankle)$/],
  ['toes', /^(toe_?base|toes?|ball|toe0?1?)$/],
  ['toes_end', /^(toe_?end|toes?_?end|toe_?nub|ball_?end)$/],
];

const FINGER_WORDS: Record<string, string> = {
  thumb: 'thumb', index: 'index', middle: 'middle', ring: 'ring', pinky: 'pinky', little: 'pinky', pinkie: 'pinky',
};

function fingerMatch(norm: string): { finger: string; idx: number | 'end' } | null {
  const m = /^(?:hand_?)?(thumb|index|middle|ring|pinky|pinkie|little)(?:_?finger)?_?(0?[1-4]|proximal|intermediate|distal|metacarpal|end|tip|nub)?$/.exec(norm);
  if (!m || m[1] === undefined) {
    return null;
  }
  const finger = FINGER_WORDS[m[1]] ?? m[1];
  const seg = m[2] ?? '1';
  const named: Record<string, number | 'end'> = { proximal: 1, intermediate: 2, distal: 3, metacarpal: 0, end: 'end', tip: 'end', nub: 'end' };
  let idx: number | 'end' = named[seg] ?? Number(seg.replace(/^0/, ''));
  if (finger === 'thumb' && typeof idx === 'number' && named[seg] === undefined && idx >= 1) {
    // Mixamo thumbs are numbered 1-4 like other fingers; keep as is.
    idx = Number(seg.replace(/^0/, ''));
  }
  if (idx === 4) {
    idx = 'end';
  }
  return { finger, idx };
}

/** Build the canonical mapping for a model hierarchy. */
export function autoMapBones(root: Object3D, overrides: BoneMap = {}): BoneMap {
  const cands: Candidate[] = [];
  const walk = (o: Object3D, depth: number): void => {
    const { norm, side } = normalize(o.name);
    if (o.name.length > 0) {
      cands.push({ obj: o, norm, side, depth });
    }
    for (const c of o.children) {
      walk(c, depth + 1);
    }
  };
  walk(root, 0);
  const isBoneLike = (c: Candidate): boolean => (c.obj as { isBone?: boolean }).isBone === true || c.obj.type === 'Object3D' || c.obj.type === 'Bone';

  const map: BoneMap = {};
  const take = (canon: string, c: Candidate | undefined): void => {
    if (c !== undefined && map[canon] === undefined) {
      map[canon] = c.obj.name;
    }
  };
  const shallowest = (list: Candidate[]): Candidate | undefined => [...list].sort((a, b) => a.depth - b.depth)[0];

  for (const [canon, re] of CENTER_PATTERNS) {
    take(canon, shallowest(cands.filter((c) => c.side === null && re.test(c.norm) && isBoneLike(c))));
  }
  for (const [canon, re] of SIDED_PATTERNS) {
    for (const s of ['l', 'r'] as const) {
      take(`${s}_${canon}`, shallowest(cands.filter((c) => c.side === s && re.test(c.norm) && isBoneLike(c))));
    }
  }
  for (const c of cands) {
    if (c.side === null) {
      continue;
    }
    const fm = fingerMatch(c.norm);
    if (fm === null) {
      continue;
    }
    if (fm.idx === 'end') {
      take(`${c.side}_${fm.finger}_end`, c);
    } else if (fm.idx >= 1 && fm.idx <= 3) {
      take(`${c.side}_${fm.finger}${fm.idx}`, c);
    }
  }

  // Spine chain: bones strictly between hips and neck.
  const hipsName = map['hips'];
  const neckName = map['neck'];
  if (hipsName !== undefined && neckName !== undefined) {
    const neck = root.getObjectByName(neckName);
    const chain: string[] = [];
    let p = neck?.parent ?? null;
    while (p !== null && p.name !== hipsName) {
      chain.unshift(p.name);
      p = p.parent;
    }
    if (p !== null && chain.length > 0) {
      take('spine', cands.find((c) => c.obj.name === chain[0]));
      if (chain.length >= 2) {
        take('chest', cands.find((c) => c.obj.name === chain[chain.length - 1]));
      }
      if (chain.length >= 3) {
        take('spine_mid', cands.find((c) => c.obj.name === chain[Math.floor((chain.length - 1) / 2)]));
      }
    }
  }

  // Finger ends from children when not named.
  for (const s of ['l', 'r'] as const) {
    for (const f of FINGERS) {
      const last = map[`${s}_${f}3`];
      if (last !== undefined && map[`${s}_${f}_end`] === undefined) {
        const o = root.getObjectByName(last);
        const child = o?.children[0];
        if (child !== undefined) {
          map[`${s}_${f}_end`] = child.name;
        }
      }
    }
    const toes = map[`${s}_toes`];
    if (toes !== undefined && map[`${s}_toes_end`] === undefined) {
      const child = root.getObjectByName(toes)?.children[0];
      if (child !== undefined) {
        map[`${s}_toes_end`] = child.name;
      }
    }
  }
  const head = map['head'];
  if (head !== undefined && map['head_end'] === undefined) {
    const o = root.getObjectByName(head);
    const child = o?.children.find((c) => /top|end/i.test(c.name));
    if (child !== undefined) {
      map['head_end'] = child.name;
    }
  }
  return { ...map, ...overrides };
}

export const REQUIRED_BONES = ['hips', 'head', 'l_upperarm', 'l_forearm', 'l_hand', 'r_upperarm', 'r_forearm', 'r_hand', 'l_thigh', 'l_shin', 'l_foot', 'r_thigh', 'r_shin', 'r_foot'];

export function missingRequired(map: BoneMap): string[] {
  return REQUIRED_BONES.filter((b) => map[b] === undefined);
}
