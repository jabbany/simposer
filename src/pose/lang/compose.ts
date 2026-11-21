// From an evaluated pose to what the solver needs: joint and finger angles,
// reach goals, and how the body is grounded (from the declared supports).

import type { Effector } from '../../dsl/vocab.ts';
import type { GroundMode } from '../solve.ts';
import { SUPPORT_PARTS } from './channels.ts';
import type { SupportPart } from './channels.ts';
import { evaluatePose } from './evaluate.ts';
import type { GoalPart, PoseLibrary, PoseValue } from './evaluate.ts';
import type { PoseExpr } from './ast.ts';

export interface ComposedPose {
  /** joint and finger channels, degrees (unset channels are neutral) */
  dofs: Record<string, number>;
  reaches: Partial<Record<Effector, GoalPart[]>>;
  supports: Partial<Record<SupportPart, number>>;
  ground: GroundMode;
  /** extra height above the supports (jumps) */
  lift: number;
  /** sits on a seat when there is one under the figure */
  sit: boolean;
}

export function composeValue(v: PoseValue): ComposedPose {
  const dofs: Record<string, number> = {};
  const supports: Partial<Record<SupportPart, number>> = {};
  let lift = 0;
  for (const [k, val] of v.ch) {
    if (k.startsWith('support.')) {
      const part = k.slice('support.'.length) as SupportPart;
      if ((SUPPORT_PARTS as readonly string[]).includes(part) && val > 0) {
        supports[part] = val;
      }
    } else if (k === 'body.lift') {
      lift = val;
    } else {
      dofs[k] = val;
    }
  }
  const reaches: Partial<Record<Effector, GoalPart[]>> = {};
  for (const [eff, g] of v.goals) {
    if (g.length > 0) {
      reaches[eff] = g;
    }
  }
  // grounding from the supports (the solver's ground modes)
  const has = (p: SupportPart): boolean => (supports[p] ?? 0) > 0;
  const feet = has('left_foot') || has('right_foot');
  let ground: GroundMode = 'feet';
  let sit = false;
  if (has('seat')) {
    // seat and feet: sitting on a chair (or standing if there is none);
    // seat alone: sitting on the floor
    if (feet) {
      sit = true;
    } else {
      ground = 'seat';
    }
  } else if (has('left_knee') || has('right_knee') || has('left_hand') || has('right_hand') || has('back') || has('front')) {
    ground = 'lowest';
  }
  return { dofs, reaches, supports, ground, lift, sit };
}

export function composePose(lib: PoseLibrary, e: PoseExpr): ComposedPose {
  return composeValue(evaluatePose(lib, e));
}
