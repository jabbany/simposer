// Materials for each render style. "toon" uses a 3-step ramp so shadow
// shapes read as flat planes, "flat" uses faceted normals.

import { Color, DataTexture, MeshStandardMaterial, MeshToonMaterial, NearestFilter, RedFormat } from 'three';
import type { Material } from 'three';
import type { RenderStyle } from '../dsl/vocab.ts';
import { dqsDepthMaterial, useDualQuaternionSkinning } from './dqs.ts';

let toonRamp: DataTexture | null = null;

function ramp(): DataTexture {
  if (toonRamp === null) {
    toonRamp = new DataTexture(new Uint8Array([70, 160, 255]), 3, 1, RedFormat);
    toonRamp.minFilter = NearestFilter;
    toonRamp.magFilter = NearestFilter;
    toonRamp.needsUpdate = true;
  }
  return toonRamp;
}

export const FIGURE_COLOR = new Color(0xd9cbb8);
export const SELECTED_COLOR = new Color(0xf0b46a);

/** Figure materials use dual quaternion skinning so bent and twisted limbs keep their volume. */
export function figureMaterial(style: RenderStyle, selected: boolean): Material {
  const color = selected ? SELECTED_COLOR : FIGURE_COLOR;
  if (style === 'toon') {
    return useDualQuaternionSkinning(new MeshToonMaterial({ color, gradientMap: ramp() }));
  }
  return useDualQuaternionSkinning(new MeshStandardMaterial({ color, roughness: 0.75, metalness: 0, flatShading: style === 'flat' }));
}

let depth: Material | null = null;

/** Shared shadow-pass material matching the figure deformation. */
export function figureDepthMaterial(): Material {
  if (depth === null) {
    depth = dqsDepthMaterial();
  }
  return depth;
}

export function propMaterial(style: RenderStyle): Material {
  const color = new Color(0x9aa3ad);
  if (style === 'toon') {
    return new MeshToonMaterial({ color, gradientMap: ramp() });
  }
  return new MeshStandardMaterial({ color, roughness: 0.9, flatShading: style === 'flat' });
}
