import type { BodyParams, Effector, GroundKind, HandShape, PropKind, RenderStyle } from './vocab.ts';
import type { PoseDef, PoseExpr } from '../pose/lang/ast.ts';

/** Something a figure can face, look at, or reach for. */
export type TargetRef =
  | { kind: 'part'; figure: string; part: string }
  | { kind: 'figure'; figure: string }
  | { kind: 'prop'; prop: string }
  | { kind: 'point'; x: number; y: number; z: number }
  | { kind: 'camera' };

export type FacingSpec =
  | { kind: 'angle'; deg: number }
  | { kind: 'toward'; target: TargetRef }
  | { kind: 'away'; target: TargetRef };

export interface Figure {
  id: string;
  group: string | null;
  model: string;
  body: string;
  /** per-parameter overrides on top of the body preset */
  bodyOverrides: Partial<BodyParams>;
  x: number;
  z: number;
  /** meters above the ground (standing on a box, etc.) */
  elevation: number;
  facing: FacingSpec;
  /** pose expression in the pose language, e.g. `walk(phase = 0.3)` (see docs/pose-system.md) */
  pose: PoseExpr;
  /** key `joint.dof` (canonical names) -> degrees. Absolute, overrides the pose (top layer). */
  joints: Record<string, number>;
  reaches: Partial<Record<Effector, TargetRef>>;
  look: TargetRef | null;
  hands: Partial<Record<'left' | 'right', HandShape>>;
}

export type CameraAim =
  | { kind: 'angles'; yaw: number; pitch: number }
  | { kind: 'target'; target: TargetRef };

export type CameraFocus =
  | { kind: 'distance'; meters: number }
  | { kind: 'target'; target: TargetRef }
  | { kind: 'auto' };

export interface CameraSpec {
  x: number;
  y: number;
  z: number;
  aim: CameraAim;
  /** roll in degrees (dutch angle) */
  roll: number;
  /** focal length in mm on a 36x24 full-frame sensor */
  lens: number;
  /** f-number */
  fstop: number;
  focus: CameraFocus;
  /** render depth of field blur */
  dof: boolean;
  /** frame aspect for the guide overlay, e.g. "3:2" */
  frame: string;
}

export interface Prop {
  id: string;
  kind: PropKind;
  x: number;
  z: number;
  facing: number;
  size: [number, number, number];
}

export interface LightSpec {
  azimuth: number;
  elevation: number;
  intensity: number;
  /** ambient fill 0..1 */
  fill: number;
}

export interface SceneDoc {
  title: string;
  ground: GroundKind;
  style: RenderStyle;
  light: LightSpec;
  camera: CameraSpec;
  figures: Figure[];
  props: Prop[];
  /** pose definitions made or redefined by this scene, on top of the default library */
  poses: PoseDef[];
}

export function emptyScene(): SceneDoc {
  return {
    title: 'Untitled',
    ground: 'grid',
    style: 'smooth',
    light: { azimuth: 135, elevation: 50, intensity: 2.2, fill: 0.45 },
    camera: {
      x: 0, y: 1.5, z: 6,
      aim: { kind: 'angles', yaw: 180, pitch: -4 },
      roll: 0,
      lens: 35,
      fstop: 8,
      focus: { kind: 'auto' },
      dof: false,
      frame: 'free',
    },
    figures: [],
    props: [],
    poses: [],
  };
}

export function cloneScene(doc: SceneDoc): SceneDoc {
  return structuredClone(doc);
}
