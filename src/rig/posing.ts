// Solve a pose and apply it to a rig with exact surface contact.
//
// The solver places the body with landmark estimates (heel, seat, ...). After
// applying, the deformed skin is measured and fed back for another solve:
// - the body: the gap between its contact skin (soles, seat or lowest point)
//   and the support becomes a ground bias;
// - each standing foot: the offset between its sole landmarks and its lowest
//   skin becomes that foot's target height. The offset is a smooth property
//   of the foot's shape and orientation, so the correction stays continuous
//   while a walking foot lifts off or lands;
// - each resting foot (seated, kneeling, lying): its measured gap to the
//   floor, closed over a few damped passes.

import { solvePose } from '../pose/solve.ts';
import type { SolveInput, SolveOutput } from '../pose/solve.ts';
import type { Rig } from './rig.ts';

const TOLERANCE = 0.0005; // meters
const PASSES = 4;
const MAX_BIAS = 0.12; // meters
const FOOT_DAMPING = 0.75;

const SOLE_POINTS = ['heel', 'ball_sole', 'toes'];

function soleLandmarkY(out: SolveOutput, foot: 'l' | 'r'): number {
  const side = foot === 'l' ? 'left' : 'right';
  let m = Infinity;
  for (const p of SOLE_POINTS) {
    const lm = out.landmarks.get(`${side}_${p}`);
    if (lm !== undefined) {
      m = Math.min(m, lm.pos.y);
    }
  }
  return m;
}

function clampBias(v: number): number {
  return Math.max(-MAX_BIAS, Math.min(MAX_BIAS, v));
}

export function solveOnRig(rig: Rig, input: SolveInput): SolveOutput {
  let current = input;
  let out = solvePose(current);
  rig.apply(out);
  for (let pass = 0; pass < PASSES; pass++) {
    let changed = false;
    let groundBias = current.groundBias ?? 0;
    const footBias = { l: current.footBias?.l ?? 0, r: current.footBias?.r ?? 0 };
    if (out.contact !== null) {
      const err = rig.lowestPoint(out.contact.sets) - out.contact.targetY;
      if (Number.isFinite(err) && Math.abs(err) > TOLERANCE) {
        // landmarks are within centimetres of the skin; a larger correction
        // means the measurement does not follow the body, so stop there
        groundBias = clampBias(groundBias - err);
        changed = true;
      }
    }
    for (const f of out.restingFeet) {
      const skin = rig.lowestPoint([`${f.foot}_foot`]);
      let next: number;
      if (f.standing) {
        // landmark height that puts the skin on the floor
        next = clampBias(-(skin - soleLandmarkY(out, f.foot)));
      } else {
        // static resting feet: close the measured gap; damped, since moving
        // the foot also turns it a little
        next = clampBias(footBias[f.foot] - FOOT_DAMPING * (skin - f.targetY));
      }
      if (Number.isFinite(next) && Math.abs(next - footBias[f.foot]) > TOLERANCE) {
        footBias[f.foot] = next;
        changed = true;
      }
    }
    if (!changed) {
      break;
    }
    current = { ...current, groundBias, footBias };
    out = solvePose(current);
    rig.apply(out);
  }
  return out;
}
