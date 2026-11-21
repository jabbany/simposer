// Body part landmarks: named points on the body surface, defined relative to
// canonical bones in the anatomical zero frame. Used as labels in the UI, as
// targets for reach/look commands, and for grounding.

import { Vector3 } from 'three';
import type { RigData } from './rigData.ts';

export interface LandmarkDef {
  name: string;
  /** canonical bones to attach to, first present wins */
  bones: string[];
  /** offset in the zero frame of the bone */
  offset: (rig: RigData, bone: string) => Vector3;
  /** outward surface normal in the zero frame, if meaningful */
  normal: Vector3 | null;
  /** hidden landmarks are used for grounding only */
  hidden?: boolean;
}

const v = (x: number, y: number, z: number): Vector3 => new Vector3(x, y, z);
const s = (rig: RigData): number => rig.height / 1.75;
const h = (rig: RigData): number => rig.headSize;

/** offset toward a child bone, as a fraction of the child's zero offset */
function toward(child: string, t: number, extra: (rig: RigData) => Vector3 = () => v(0, 0, 0)) {
  return (rig: RigData): Vector3 => {
    const c = rig.bones.get(child);
    const base = c === undefined ? v(0, 0, 0) : c.zeroOffset.clone().multiplyScalar(t);
    return base.add(extra(rig));
  };
}

function headPoint(x: number, y: number, z: number) {
  return (rig: RigData): Vector3 => v(x * h(rig), y * h(rig), z * h(rig));
}

const FWD = v(0, 0, 1);
const BACK = v(0, 0, -1);

function sidedDefs(side: 'left' | 'right'): LandmarkDef[] {
  const k = side === 'left' ? 'l' : 'r';
  const sg = side === 'left' ? 1 : -1;
  const out = v(sg, 0, 0);
  return [
    { name: `${side}_eye`, bones: ['head'], offset: headPoint(sg * 0.17, 0.52, 0.5), normal: FWD },
    { name: `${side}_ear`, bones: ['head'], offset: headPoint(sg * 0.42, 0.45, -0.02), normal: out },
    { name: `${side}_cheek`, bones: ['head'], offset: headPoint(sg * 0.24, 0.32, 0.45), normal: v(sg * 0.4, 0, 0.92).normalize() },
    { name: `${side}_shoulder`, bones: [`${k}_upperarm`], offset: (r) => v(sg * 0.02 * s(r), 0.04 * s(r), 0), normal: v(0, 1, 0) },
    { name: `${side}_upper_arm`, bones: [`${k}_upperarm`], offset: toward(`${k}_forearm`, 0.5, (r) => v(sg * 0.04 * s(r), 0, 0)), normal: out },
    { name: `${side}_elbow`, bones: [`${k}_forearm`], offset: (r) => v(0, 0, -0.03 * s(r)), normal: BACK },
    { name: `${side}_forearm`, bones: [`${k}_forearm`], offset: toward(`${k}_hand`, 0.5), normal: out },
    { name: `${side}_wrist`, bones: [`${k}_hand`], offset: () => v(0, 0, 0), normal: null },
    { name: `${side}_hand`, bones: [`${k}_hand`], offset: (r) => v(-sg * 0.015 * s(r), -0.075 * s(r), 0), normal: v(-sg, 0, 0) },
    { name: `${side}_hip`, bones: [`${k}_thigh`], offset: (r) => v(sg * 0.085 * s(r), 0.02 * s(r), 0), normal: out },
    { name: `${side}_thigh`, bones: [`${k}_thigh`], offset: toward(`${k}_shin`, 0.45, (r) => v(0, 0, 0.07 * s(r))), normal: FWD },
    { name: `${side}_knee`, bones: [`${k}_shin`], offset: (r) => v(0, 0, 0.05 * s(r)), normal: FWD },
    { name: `${side}_shin`, bones: [`${k}_shin`], offset: toward(`${k}_foot`, 0.5, (r) => v(0, 0, 0.045 * s(r))), normal: FWD },
    { name: `${side}_ankle`, bones: [`${k}_foot`], offset: () => v(0, 0, 0), normal: null },
    { name: `${side}_foot`, bones: [`${k}_foot`], offset: toward(`${k}_toes`, 0.6, (r) => v(0, -r.ankleHeight[k] * 0.5, 0)), normal: v(0, 1, 0) },
    {
      name: `${side}_heel`, bones: [`${k}_foot`],
      offset: (r) => v(0, -r.ankleHeight[k], -0.045 * s(r)), normal: BACK,
    },
    {
      name: `${side}_toes`, bones: [`${k}_toes`, `${k}_foot`],
      offset: (r, bone) => {
        const end = r.ends.get(`${k}_toes_end`);
        if (end !== undefined && end.bone === bone) {
          return end.zeroOffset.clone();
        }
        return v(0, 0, 0.06 * s(r));
      },
      normal: FWD,
    },
    // hidden sole points for grounding
    {
      name: `${side}_ball_sole`, bones: [`${k}_toes`], hidden: true, normal: null,
      offset: (r) => {
        const toes = r.bones.get(`${k}_toes`);
        return v(0, toes === undefined ? 0 : -toes.restPos.y, 0);
      },
    },
  ];
}

export const LANDMARKS: LandmarkDef[] = [
  { name: 'head', bones: ['head'], offset: headPoint(0, 0.5, 0.05), normal: null },
  { name: 'top_of_head', bones: ['head'], offset: (r) => r.ends.get('head_end')?.zeroOffset.clone() ?? v(0, h(r), 0), normal: v(0, 1, 0) },
  { name: 'face', bones: ['head'], offset: headPoint(0, 0.4, 0.55), normal: FWD },
  { name: 'forehead', bones: ['head'], offset: headPoint(0, 0.7, 0.5), normal: FWD },
  { name: 'eyes', bones: ['head'], offset: headPoint(0, 0.52, 0.52), normal: FWD },
  { name: 'mouth', bones: ['head'], offset: headPoint(0, 0.2, 0.55), normal: FWD },
  { name: 'chin', bones: ['head'], offset: headPoint(0, 0.03, 0.5), normal: v(0, -0.5, 0.86).normalize() },
  { name: 'back_of_head', bones: ['head'], offset: headPoint(0, 0.5, -0.48), normal: BACK },
  { name: 'neck', bones: ['neck', 'head'], offset: (r) => v(0, 0.03 * s(r), 0.05 * s(r)), normal: FWD },
  { name: 'chest', bones: ['chest', 'spine_mid', 'spine'], offset: (r) => v(0, 0.06 * s(r), 0.11 * s(r)), normal: FWD },
  { name: 'belly', bones: ['spine', 'hips'], offset: (r) => v(0, 0.03 * s(r), 0.11 * s(r)), normal: FWD },
  { name: 'back', bones: ['chest', 'spine_mid', 'spine'], offset: (r) => v(0, 0.06 * s(r), -0.1 * s(r)), normal: BACK },
  { name: 'lower_back', bones: ['spine', 'hips'], offset: (r) => v(0, 0.03 * s(r), -0.1 * s(r)), normal: BACK },
  { name: 'pelvis', bones: ['hips'], offset: () => v(0, 0, 0), normal: null },
  { name: 'seat', bones: ['hips'], offset: (r) => v(0, -0.11 * s(r), -0.06 * s(r)), normal: v(0, -1, 0), hidden: true },
  ...sidedDefs('left'),
  ...sidedDefs('right'),
];

export const LANDMARK_BY_NAME = new Map(LANDMARKS.map((l) => [l.name, l]));
