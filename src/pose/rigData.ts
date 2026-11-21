// Rest-pose data the solver needs, independent of three.js scene objects.

import { Quaternion, Vector3 } from 'three';

/** Regions of the skin used to measure contact with a supporting surface. */
export type ContactSet = 'l_foot' | 'r_foot' | 'l_hand' | 'r_hand' | 'seat' | 'body';

export interface RigBoneData {
  name: string;
  parent: string | null;
  /** rest position in character space */
  restPos: Vector3;
  /** rest rotation in character space */
  restQuat: Quaternion;
  /** rotation taking the rest orientation to the anatomical zero orientation */
  C: Quaternion;
  /** offset from the canonical parent in the zero pose */
  zeroOffset: Vector3;
}

export interface RigEndData {
  bone: string;
  /** offset from `bone` in the zero pose */
  zeroOffset: Vector3;
}

export interface RigData {
  bones: Map<string, RigBoneData>;
  /** canonical bones ordered parents first */
  order: string[];
  ends: Map<string, RigEndData>;
  /** standing height in meters */
  height: number;
  /** distance from the head joint to the crown */
  headSize: number;
  /** ankle joint height above the sole in the rest pose */
  ankleHeight: { l: number; r: number };
  /**
   * Body volume as capsules along bone segments, measured from the mesh:
   * radius around the segment from `bone` to `to` (a canonical bone or end),
   * running `length` (fraction, default 1) of the way there.
   */
  capsules: Map<string, { to: string; radius: number; length?: number }>;
}
