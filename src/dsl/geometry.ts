// Model-independent geometry helpers used while applying commands. These work
// on the scene document only (no rig data), so placement stays deterministic.

import type { CameraSpec, Figure, SceneDoc, TargetRef } from './types.ts';
import { BODY_PRESET_BY_NAME } from './vocab.ts';
import type { BodyParams } from './vocab.ts';

/** Small deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const DEG = Math.PI / 180;

export function bodyParams(fig: Pick<Figure, 'body' | 'bodyOverrides'>): BodyParams {
  const base = BODY_PRESET_BY_NAME.get(fig.body) ?? BODY_PRESET_BY_NAME.get('adult_male');
  if (base === undefined) {
    throw new Error('missing default body preset');
  }
  return { ...base.params, ...fig.bodyOverrides };
}

/** Forward unit vector (x, z) for a facing angle. 0 = +Z, positive = turn left (toward +X). */
export function forwardXZ(deg: number): { x: number; z: number } {
  return { x: Math.sin(deg * DEG), z: Math.cos(deg * DEG) };
}

/** The figure's own left for a facing angle. */
export function leftXZ(deg: number): { x: number; z: number } {
  return { x: Math.cos(deg * DEG), z: -Math.sin(deg * DEG) };
}

export function headingTo(fromX: number, fromZ: number, toX: number, toZ: number): number {
  return Math.atan2(toX - fromX, toZ - fromZ) / DEG;
}

/** Rough height fractions for named parts; precise positions come from the rig at render time. */
const PART_HEIGHT: Record<string, number> = {
  head: 0.93, top_of_head: 1, face: 0.93, forehead: 0.96, eyes: 0.94, mouth: 0.9, chin: 0.88, back_of_head: 0.93, neck: 0.85,
  chest: 0.72, belly: 0.6, back: 0.72, lower_back: 0.58, pelvis: 0.52,
};
const SIDED_HEIGHT: Record<string, number> = {
  ear: 0.93, shoulder: 0.82, upper_arm: 0.72, elbow: 0.63, forearm: 0.55, wrist: 0.48, hand: 0.44,
  hip: 0.52, thigh: 0.4, knee: 0.28, shin: 0.16, ankle: 0.04, foot: 0.03, heel: 0.02, toes: 0.02,
};

export function approxPartHeight(part: string): number {
  const c = PART_HEIGHT[part];
  if (c !== undefined) {
    return c;
  }
  const m = /^(left|right)_(.+)$/.exec(part);
  return m && m[2] !== undefined ? (SIDED_HEIGHT[m[2]] ?? 0.6) : 0.6;
}

export interface Located {
  x: number;
  y: number;
  z: number;
  /** facing of the located thing in degrees, when meaningful */
  facing: number | null;
}

/** Approximate location of a target using only the document (no rig). */
export function locateApprox(doc: SceneDoc, target: TargetRef, depth = 0): Located | undefined {
  switch (target.kind) {
    case 'point':
      return { x: target.x, y: target.y, z: target.z, facing: null };
    case 'camera':
      return { x: doc.camera.x, y: doc.camera.y, z: doc.camera.z, facing: cameraYawApprox(doc, doc.camera, depth) };
    case 'prop': {
      const p = doc.props.find((q) => q.id === target.prop);
      if (p === undefined) {
        return undefined;
      }
      return { x: p.x, y: p.size[1], z: p.z, facing: p.facing };
    }
    case 'figure':
    case 'part': {
      const f = doc.figures.find((q) => q.id === target.figure);
      if (f === undefined) {
        return undefined;
      }
      const h = bodyParams(f).height;
      const frac = target.kind === 'part' ? approxPartHeight(target.part) : 0.72;
      return { x: f.x, y: f.elevation + h * frac, z: f.z, facing: depth > 4 ? 0 : facingDeg(doc, f, depth + 1) };
    }
  }
}

export function facingDeg(doc: SceneDoc, fig: Figure, depth = 0): number {
  const f = fig.facing;
  if (f.kind === 'angle') {
    return f.deg;
  }
  if (depth > 4) {
    return 0;
  }
  const loc = locateApprox(doc, f.target, depth + 1);
  if (loc === undefined) {
    return 0;
  }
  if (Math.abs(loc.x - fig.x) < 1e-6 && Math.abs(loc.z - fig.z) < 1e-6) {
    return 0;
  }
  const h = headingTo(fig.x, fig.z, loc.x, loc.z);
  return f.kind === 'toward' ? h : h + 180;
}

export function cameraYawApprox(doc: SceneDoc, cam: CameraSpec, depth = 0): number {
  if (cam.aim.kind === 'angles') {
    return cam.aim.yaw;
  }
  if (depth > 4) {
    return 180;
  }
  const loc = locateApprox(doc, cam.aim.target, depth + 1);
  if (loc === undefined) {
    return 180;
  }
  return headingTo(cam.x, cam.z, loc.x, loc.z);
}
