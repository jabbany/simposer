// Human figures from the CC0 MakeHuman base mesh, targets and game-engine
// rig (kit built by tools/build-makehuman.mjs).
//
// Body parameters map onto MakeHuman's macro modifiers:
//   femininity -> gender, age (years) -> baby/child/young/old,
//   muscle -> min/average/max muscle, build -> min/average/max weight,
//   bust relative to hip -> cup size (female).
// Height is applied by the rig (uniform scale). Stylized proportions
// (`heads`, `leg_length`) are applied as smooth spatial deformations so the
// joint helpers move consistently with the skin. Joints are then recomputed
// from the morphed mesh, so the skeleton always fits the body.

import {
  Bone, BufferGeometry, Float32BufferAttribute, Group, Skeleton, SkinnedMesh, Uint16BufferAttribute, Vector3,
} from 'three';
import type { Material, Object3D } from 'three';
import type { BodyParams } from '../dsl/vocab.ts';
import type { BoneMap } from './boneMap.ts';
import { autoMapBones } from './boneMap.ts';

interface KitBone {
  name: string;
  parent: number;
  head: number[];
  tail: number[];
}

interface KitJson {
  format: string;
  vertexCount: number;
  triangleCount: number;
  quantization: number;
  positions: number;
  indices: number;
  skinIndex: number;
  skinWeight: number;
  landmarks: { chin: number; crown: number };
  bones: KitBone[];
  targets: { name: string; count: number; indices: number; deltas: number }[];
}

interface Target {
  indices: Uint16Array;
  deltas: Int16Array;
}

type Three = { min: number; average: number; max: number };

/**
 * Joints that get a helper "half" bone: [parent, child]. The helper sits at
 * the child's joint, follows half of the child's rotation (see Rig.apply), and
 * takes over the skin both bones share. Spreading the bend over two steps
 * keeps creases (groin, back of the knee, elbow, armpit, wrist) from folding.
 */
const HALF_JOINTS: [string, string][] = [
  ...(['l', 'r'] as const).flatMap((s): [string, string][] => [
    ['pelvis', `thigh_${s}`],
    [`thigh_${s}`, `calf_${s}`],
    [`calf_${s}`, `foot_${s}`],
    [`clavicle_${s}`, `upperarm_${s}`],
    [`upperarm_${s}`, `lowerarm_${s}`],
    [`lowerarm_${s}`, `hand_${s}`],
  ]),
  ['neck_01', 'head'],
];

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/** MakeHuman's split of a 0..1 slider into min/average/max weights. */
function three(v: number): Three {
  const x = clamp01(v);
  return x < 0.5 ? { min: 1 - 2 * x, average: 2 * x, max: 0 } : { min: 0, average: 2 - 2 * x, max: 2 * x - 1 };
}

/** Age in years to MakeHuman's baby/child/young/old weights (1, 11, 25, 90 years). */
function ageWeights(years: number): Record<'baby' | 'child' | 'young' | 'old', number> {
  const y = Math.max(1, Math.min(90, years));
  const v = y <= 11 ? ((y - 1) / 10) * 0.1875 : y <= 25 ? 0.1875 + ((y - 11) / 14) * 0.3125 : 0.5 + ((y - 25) / 65) * 0.5;
  if (v < 0.1875) {
    return { baby: 1 - v / 0.1875, child: v / 0.1875, young: 0, old: 0 };
  }
  if (v < 0.5) {
    const t = (v - 0.1875) / 0.3125;
    return { baby: 0, child: 1 - t, young: t, old: 0 };
  }
  const t = (v - 0.5) / 0.5;
  return { baby: 0, child: 0, young: 1 - t, old: t };
}

export class HumanKit {
  private readonly json: KitJson;
  /** all MakeHuman vertices, including invisible helpers used for joints */
  private readonly base: Float32Array;
  /** rendered vertices only: original index of each, and triangles over them */
  private readonly renderVerts: Uint16Array;
  private readonly index: Uint16Array;
  private readonly skinIndex: Uint16Array;
  private readonly skinWeight: Float32Array;
  private readonly targets = new Map<string, Target>();

  private constructor(json: KitJson, bin: ArrayBuffer) {
    this.json = json;
    const n = json.vertexCount;
    this.base = new Float32Array(bin, json.positions, n * 3);
    // Compact to the vertices the triangles use; helper geometry (clothing
    // proxies, joint cubes) stays out of the rendered mesh and its bounds.
    const tri = new Uint16Array(bin, json.indices, json.triangleCount * 3);
    const remap = new Int32Array(n).fill(-1);
    const used: number[] = [];
    for (const v of tri) {
      if (remap[v] === -1) {
        remap[v] = used.length;
        used.push(v);
      }
    }
    this.renderVerts = Uint16Array.from(used);
    this.index = Uint16Array.from(tri, (v) => remap[v] ?? 0);
    const si = new Uint8Array(bin, json.skinIndex, n * 4);
    const sw = new Uint8Array(bin, json.skinWeight, n * 4);
    this.skinIndex = new Uint16Array(used.length * 4);
    this.skinWeight = new Float32Array(used.length * 4);
    used.forEach((v, i) => {
      for (let k = 0; k < 4; k++) {
        this.skinIndex[i * 4 + k] = si[v * 4 + k] ?? 0;
        this.skinWeight[i * 4 + k] = (sw[v * 4 + k] ?? 0) / 255;
      }
    });
    this.addHalfJointWeights();
    for (const t of json.targets) {
      this.targets.set(t.name, { indices: new Uint16Array(bin, t.indices, t.count), deltas: new Int16Array(bin, t.deltas, t.count * 3) });
    }
  }

  /**
   * Move the skin shared between each HALF_JOINTS parent and child onto the
   * helper bone: with shared weight t = min(wParent, wChild), the parent and
   * child each give up t and the helper gets 2t (the total stays 1). Helper
   * bones are numbered after the kit bones, in HALF_JOINTS order.
   */
  private addHalfJointWeights(): void {
    const names = this.json.bones.map((b) => b.name);
    const n = this.renderVerts.length;
    HALF_JOINTS.forEach(([parent, child], h) => {
      const pi = names.indexOf(parent);
      const ci = names.indexOf(child);
      if (pi < 0 || ci < 0) {
        return;
      }
      const helper = names.length + h;
      for (let v = 0; v < n; v++) {
        let sp = -1;
        let sc = -1;
        for (let k = 0; k < 4; k++) {
          const b = this.skinIndex[v * 4 + k];
          const w = this.skinWeight[v * 4 + k] ?? 0;
          if (w > 0 && b === pi) {
            sp = k;
          } else if (w > 0 && b === ci) {
            sc = k;
          }
        }
        if (sp < 0 || sc < 0) {
          continue;
        }
        const wp = this.skinWeight[v * 4 + sp] ?? 0;
        const wc = this.skinWeight[v * 4 + sc] ?? 0;
        const t = Math.min(wp, wc);
        if (t < 0.02) {
          continue;
        }
        // the smaller of the two slots becomes the helper
        const [free, keep] = wp <= wc ? [sp, sc] : [sc, sp];
        this.skinWeight[v * 4 + keep] = Math.max(wp, wc) - t;
        this.skinIndex[v * 4 + free] = helper;
        this.skinWeight[v * 4 + free] = 2 * t;
      }
    });
  }

  static async load(baseUrl: string): Promise<HumanKit> {
    const [jr, br] = await Promise.all([fetch(`${baseUrl}/kit.json`), fetch(`${baseUrl}/kit.bin`)]);
    if (!jr.ok || !br.ok) {
      throw new Error(`could not load the human figure kit (HTTP ${jr.status}/${br.status}). Run: node tools/fetch-makehuman.mjs && node tools/build-makehuman.mjs`);
    }
    return HumanKit.fromData(await jr.json(), await br.arrayBuffer());
  }

  static fromData(json: unknown, bin: ArrayBuffer): HumanKit {
    const j = json as KitJson;
    if (j.format !== 'simposer-makehuman-kit') {
      throw new Error('unexpected human kit format');
    }
    return new HumanKit(j, bin);
  }

  /** Morphed vertex positions for a set of body parameters. */
  private morph(p: BodyParams): Float32Array {
    const pos = Float32Array.from(this.base);
    const q = this.json.quantization;
    const add = (name: string, w: number): void => {
      if (w < 1e-4) {
        return;
      }
      const t = this.targets.get(name);
      if (t === undefined) {
        return;
      }
      const s = q * w;
      const { indices, deltas } = t;
      for (let k = 0; k < indices.length; k++) {
        const v = (indices[k] ?? 0) * 3;
        pos[v] = (pos[v] ?? 0) + (deltas[k * 3] ?? 0) * s;
        pos[v + 1] = (pos[v + 1] ?? 0) + (deltas[k * 3 + 1] ?? 0) * s;
        pos[v + 2] = (pos[v + 2] ?? 0) + (deltas[k * 3 + 2] ?? 0) * s;
      }
    };
    const fem = clamp01(p.femininity);
    const genders: [string, number][] = [['female', fem], ['male', 1 - fem]];
    const ages = ageWeights(p.age);
    const muscle = three(0.5 + (p.muscle - 1) * 1.2);
    const weight = three(0.5 + (p.build - 1) * 1.4);
    const levels = (t: Three, word: string): [string, number][] => [[`min${word}`, t.min], [`average${word}`, t.average], [`max${word}`, t.max]];
    for (const [g, gw] of genders) {
      for (const [a, aw] of Object.entries(ages)) {
        if (gw * aw < 1e-4) {
          continue;
        }
        add(`neutral-${g}-${a}`, gw * aw);
        for (const [m, mw] of levels(muscle, 'muscle')) {
          for (const [w, ww] of levels(weight, 'weight')) {
            add(`universal-${g}-${a}-${m}-${w}`, gw * aw * mw * ww);
          }
        }
      }
    }
    // cup size from the bust-to-hip ratio; female shape only, and only from puberty on
    const puberty = smoothstep(11, 15, p.age);
    const cupValue = 0.5 + (p.bust / Math.max(1, p.hip) - 0.94) * 4;
    const cup = three(0.5 + (cupValue - 0.5) * puberty);
    const cupAges: [string, number][] = [['child', ages.baby + ages.child], ['young', ages.young], ['old', ages.old]];
    for (const [a, aw] of cupAges) {
      for (const [m, mw] of levels(muscle, 'muscle')) {
        for (const [w, ww] of levels(weight, 'weight')) {
          const k = fem * aw * mw * ww * puberty;
          add(`breast-female-${a}-${m}-${w}-mincup`, k * cup.min);
          add(`breast-female-${a}-${m}-${w}-maxcup`, k * cup.max);
        }
      }
    }
    return pos;
  }

  private jointOf(pos: Float32Array, verts: number[]): Vector3 {
    const v = new Vector3();
    for (const i of verts) {
      v.x += pos[i * 3] ?? 0;
      v.y += pos[i * 3 + 1] ?? 0;
      v.z += pos[i * 3 + 2] ?? 0;
    }
    return v.multiplyScalar(1 / Math.max(1, verts.length));
  }

  /** Stylized proportions: head size (heads tall) and leg length, as smooth deformations. */
  private stylize(pos: Float32Array, p: BodyParams): void {
    const bones = this.json.bones;
    const find = (n: string): KitBone | undefined => bones.find((b) => b.name === n);
    const neck = find('neck_01');
    const thighL = find('thigh_l');
    const thighR = find('thigh_r');
    if (neck === undefined || thighL === undefined || thighR === undefined) {
      return;
    }
    const n = this.json.vertexCount;
    const { chin, crown } = this.json.landmarks;
    const lowest = (): number => {
      let m = Infinity;
      for (const v of this.renderVerts) {
        m = Math.min(m, pos[v * 3 + 1] ?? 0);
      }
      return m;
    };
    let minY = lowest();
    // legs first: stretch below the hip joints, excluding the hands beside the thighs
    const L = Math.max(0.75, Math.min(1.35, p.leg_length));
    if (Math.abs(L - 1) > 0.005) {
      const hipY = (this.jointOf(pos, thighL.head).y + this.jointOf(pos, thighR.head).y) / 2;
      for (let i = 0; i < n; i++) {
        const x = pos[i * 3] ?? 0;
        const y = pos[i * 3 + 1] ?? 0;
        if (y >= hipY) {
          continue;
        }
        const s = smoothstep(hipY, hipY - 0.08, y) * (1 - smoothstep(0.2, 0.27, Math.abs(x)));
        pos[i * 3 + 1] = y - (hipY - y) * (L - 1) * s;
      }
      minY = lowest();
    }
    // head: scale about the base of the neck so the figure is `heads` head-heights tall
    const chinY = pos[chin * 3 + 1] ?? 0;
    const crownY = pos[crown * 3 + 1] ?? 0;
    const hh = crownY - chinY;
    const total = crownY - minY;
    if (hh <= 0 || p.heads <= 1.5) {
      return;
    }
    const k = Math.max(0.7, Math.min(2.8, (total - hh) / (hh * (p.heads - 1))));
    if (Math.abs(k - 1) < 0.01) {
      return;
    }
    const pivot = this.jointOf(pos, neck.head);
    for (let i = 0; i < n; i++) {
      const y = pos[i * 3 + 1] ?? 0;
      if (y <= pivot.y) {
        continue;
      }
      const s = 1 + (k - 1) * smoothstep(pivot.y, chinY, y);
      pos[i * 3] = pivot.x + ((pos[i * 3] ?? 0) - pivot.x) * s;
      pos[i * 3 + 1] = pivot.y + (y - pivot.y) * s;
      pos[i * 3 + 2] = pivot.z + ((pos[i * 3 + 2] ?? 0) - pivot.z) * s;
    }
  }

  build(p: BodyParams, material: Material): { object: Object3D; map: BoneMap } {
    const pos = this.morph(p);
    this.stylize(pos, p);

    // skeleton from the morphed joint helpers; rest rotations are identity
    const kb = this.json.bones;
    const heads = kb.map((b) => this.jointOf(pos, b.head));
    const tails = kb.map((b) => this.jointOf(pos, b.tail));
    const bones: Bone[] = kb.map((b) => {
      const bone = new Bone();
      bone.name = b.name;
      return bone;
    });
    kb.forEach((b, i) => {
      const bone = bones[i] as Bone;
      const head = heads[i] as Vector3;
      if (b.parent >= 0) {
        (bones[b.parent] as Bone).add(bone);
        bone.position.copy(head).sub(heads[b.parent] as Vector3);
      } else {
        bone.position.copy(head);
      }
    });
    // helper half-joint bones, indexed after the kit bones (matches addHalfJointWeights)
    const helpers: Bone[] = HALF_JOINTS.map(([parent, child]) => {
      const helper = new Bone();
      helper.name = `${child}_half`;
      helper.userData['halfOf'] = child;
      const pi = kb.findIndex((b) => b.name === parent);
      const ci = kb.findIndex((b) => b.name === child);
      if (pi >= 0 && ci >= 0) {
        (bones[pi] as Bone).add(helper);
        helper.position.copy(heads[ci] as Vector3).sub(heads[pi] as Vector3);
      }
      return helper;
    });

    // end points used to measure directions and the head size
    const endFor = (boneName: string, endName: string): void => {
      const i = kb.findIndex((b) => b.name === boneName);
      if (i < 0) {
        return;
      }
      const end = new Bone();
      end.name = endName;
      end.position.copy(tails[i] as Vector3).sub(heads[i] as Vector3);
      (bones[i] as Bone).add(end);
    };
    endFor('head', 'head_end');
    for (const s of ['l', 'r']) {
      endFor(`ball_${s}`, `ball_${s}_end`);
      for (const f of ['thumb', 'index', 'middle', 'ring', 'pinky']) {
        endFor(`${f}_03_${s}`, `${f}_end_${s}`);
      }
    }

    const rendered = new Float32Array(this.renderVerts.length * 3);
    this.renderVerts.forEach((v, i) => {
      rendered[i * 3] = pos[v * 3] ?? 0;
      rendered[i * 3 + 1] = pos[v * 3 + 1] ?? 0;
      rendered[i * 3 + 2] = pos[v * 3 + 2] ?? 0;
    });
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(rendered, 3));
    geo.setIndex(Array.from(this.index));
    geo.setAttribute('skinIndex', new Uint16BufferAttribute(this.skinIndex, 4));
    geo.setAttribute('skinWeight', new Float32BufferAttribute(this.skinWeight, 4));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();

    const root = new Group();
    root.name = 'human';
    const rootBone = bones.find((_, i) => (kb[i] as KitBone).parent < 0) as Bone;
    root.add(rootBone);
    const mesh = new SkinnedMesh(geo, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    root.add(mesh);
    root.updateMatrixWorld(true);
    mesh.bind(new Skeleton([...bones, ...helpers]));
    return { object: root, map: autoMapBones(root) };
  }
}
