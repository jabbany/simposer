// A posable instance of a humanoid model. Measures the model's rest pose,
// normalizes it into character space (faces +Z, feet on y=0, target height),
// and applies solver output to the actual bones.

import { Box3, Group, Matrix3, Matrix4, Quaternion, Vector3 } from 'three';
import type { BufferAttribute, Object3D, SkinnedMesh } from 'three';
import { CANON_BONES, CANON_BY_NAME, CANON_ENDS } from './canon.ts';
import type { BoneMap } from './boneMap.ts';
import { missingRequired } from './boneMap.ts';
import type { ContactSet, RigBoneData, RigData, RigEndData } from '../pose/rigData.ts';
import type { SolveOutput } from '../pose/solve.ts';

function frame(primary: Vector3, secondaryRef: Vector3): Quaternion {
  const y = primary.clone().normalize();
  let z = secondaryRef.clone().sub(y.clone().multiplyScalar(secondaryRef.dot(y)));
  if (z.lengthSq() < 1e-6) {
    const alt = Math.abs(y.y) > 0.9 ? new Vector3(0, 0, 1) : new Vector3(0, 1, 0);
    z = alt.sub(y.clone().multiplyScalar(alt.dot(y)));
  }
  z.normalize();
  const x = new Vector3().crossVectors(y, z).normalize();
  return new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(x, y, z));
}

/** Segments approximated by capsules for self-collision, with the end they run to. */
const CAPSULE_SEGMENTS: [string, string[]][] = [
  ['hips', ['spine', 'spine_mid', 'chest']],
  ['spine', ['spine_mid', 'chest', 'neck']],
  ['spine_mid', ['chest', 'neck']],
  ['chest', ['neck']],
  ['head', ['head_end']],
  ...(['l', 'r'] as const).flatMap((s): [string, string[]][] => [
    [`${s}_upperarm`, [`${s}_forearm`]],
    [`${s}_forearm`, [`${s}_hand`]],
    [`${s}_hand`, [`${s}_middle1`, `${s}_index1`, `${s}_hand_end`]],
    [`${s}_thigh`, [`${s}_shin`]],
    [`${s}_shin`, [`${s}_foot`]],
    [`${s}_foot`, [`${s}_toes`, `${s}_toes_end`]],
  ]),
];

/** Torso segments whose capsule radius is the body's depth, not its width. */
const DEPTH_CAPSULES = new Set(['spine_mid', 'chest']);

function segmentDistance(p: Vector3, a: Vector3, b: Vector3): number {
  const ab = b.clone().sub(a);
  const t = Math.max(0, Math.min(1, p.clone().sub(a).dot(ab) / Math.max(1e-9, ab.lengthSq())));
  return p.distanceTo(a.clone().add(ab.multiplyScalar(t)));
}

export class RigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RigError';
  }
}

export class Rig {
  /** placed in the world by the scene; its local space is character space */
  readonly root: Group;
  readonly data: RigData;
  private readonly inner: Group;
  private readonly boneObjs = new Map<string, Object3D>();
  private readonly objToCanon = new Map<Object3D, string>();
  private readonly hipsParentInv: Matrix3;
  private readonly hipsRestLocal: Vector3;
  private readonly helpers: { helper: Object3D; child: Object3D; helperRest: Quaternion; childRestInv: Quaternion }[] = [];
  /** sampled skin vertices by body region, for measuring contact with the ground */
  private readonly contact = new Map<ContactSet, { mesh: SkinnedMesh; index: number }[]>();

  constructor(model: Object3D, map: BoneMap, targetHeight: number) {
    const missing = missingRequired(map);
    if (missing.length > 0) {
      throw new RigError(`model is missing required bones: ${missing.join(', ')}`);
    }
    this.root = new Group();
    this.inner = new Group();
    this.inner.add(model);
    this.root.add(this.inner);
    for (const [canon, boneName] of Object.entries(map)) {
      const o = model.getObjectByName(boneName);
      if (o !== undefined) {
        this.boneObjs.set(canon, o);
        if (CANON_BY_NAME.has(canon)) {
          this.objToCanon.set(o, canon);
        }
      }
    }

    // --- orientation: face +Z, up +Y ---
    this.root.updateMatrixWorld(true);
    const wp = (canon: string): Vector3 => {
      const o = this.boneObjs.get(canon);
      if (o === undefined) {
        throw new RigError(`missing bone ${canon}`);
      }
      return new Vector3().setFromMatrixPosition(o.matrixWorld);
    };
    const up = wp('head').sub(wp('hips')).normalize();
    const leftRaw = wp('l_thigh').sub(wp('r_thigh')).add(wp('l_upperarm').sub(wp('r_upperarm')));
    const fwd = new Vector3().crossVectors(leftRaw, up).normalize();
    const left = new Vector3().crossVectors(up, fwd).normalize();
    const modelBasis = new Matrix4().makeBasis(left, up, fwd);
    this.inner.quaternion.setFromRotationMatrix(modelBasis).invert();
    this.root.updateMatrixWorld(true);

    // --- scale and position: feet on the ground, hips over the origin ---
    const box = new Box3().setFromObject(this.inner, true);
    const rawHeight = box.max.y - box.min.y;
    if (!(rawHeight > 1e-6)) {
      throw new RigError('model has no measurable height');
    }
    const k = targetHeight / rawHeight;
    const hips = wp('hips');
    this.inner.scale.setScalar(k);
    this.inner.position.set(-hips.x * k, -box.min.y * k, -hips.z * k);
    this.root.updateMatrixWorld(true);

    // --- rest data in character space ---
    const restPos = new Map<string, Vector3>();
    const restQuat = new Map<string, Quaternion>();
    const tmpS = new Vector3();
    for (const [canon, o] of this.boneObjs) {
      const p = new Vector3();
      const q = new Quaternion();
      o.matrixWorld.decompose(p, q, tmpS);
      restPos.set(canon, p);
      restQuat.set(canon, q);
    }

    const canonParent = (o: Object3D): string | null => {
      let p = o.parent;
      while (p !== null) {
        const c = this.objToCanon.get(p);
        if (c !== undefined) {
          return c;
        }
        p = p.parent;
      }
      return null;
    };

    const bones = new Map<string, RigBoneData>();
    const order: string[] = [];
    // CANON_BONES is listed parents-first for every supported hierarchy.
    for (const def of CANON_BONES) {
      const o = this.boneObjs.get(def.name);
      const pos = restPos.get(def.name);
      const quat = restQuat.get(def.name);
      if (o === undefined || pos === undefined || quat === undefined) {
        continue;
      }
      const parent = canonParent(o);
      const parentData = parent === null ? undefined : bones.get(parent);
      let C: Quaternion;
      if (def.zero.kind === 'inherit') {
        C = parentData?.C.clone() ?? new Quaternion();
      } else {
        const aimName = def.aim.find((a) => restPos.has(a));
        let dir: Vector3 | null = null;
        if (aimName !== undefined) {
          dir = (restPos.get(aimName) ?? pos).clone().sub(pos);
          if (dir.lengthSq() < 1e-10) {
            dir = null;
          }
        }
        if (dir === null) {
          // leaf without a child: assume it continues its parent's direction
          const pp = parent === null ? undefined : restPos.get(parent);
          dir = pp === undefined ? new Vector3(...def.zero.dir) : pos.clone().sub(pp);
        }
        const sec = new Vector3(...def.zero.secondary);
        const Fr = frame(dir, sec);
        const Fz = frame(new Vector3(...def.zero.dir), sec);
        C = Fz.multiply(Fr.invert());
      }
      const zeroOffset = parentData === undefined ? new Vector3() : pos.clone().sub(parentData.restPos).applyQuaternion(parentData.C);
      bones.set(def.name, { name: def.name, parent: parentData === undefined ? null : parent, restPos: pos, restQuat: quat, C, zeroOffset });
      order.push(def.name);
    }

    const ends = new Map<string, RigEndData>();
    for (const e of CANON_ENDS) {
      const o = this.boneObjs.get(e);
      const pos = restPos.get(e);
      if (o === undefined || pos === undefined) {
        continue;
      }
      const parent = canonParent(o);
      const pd = parent === null ? undefined : bones.get(parent);
      if (pd !== undefined && parent !== null) {
        ends.set(e, { bone: parent, zeroOffset: pos.clone().sub(pd.restPos).applyQuaternion(pd.C) });
      }
    }

    const headPos = restPos.get('head') ?? new Vector3();
    const headEnd = restPos.get('head_end');
    const headSize = headEnd !== undefined ? headEnd.distanceTo(headPos) : targetHeight * 0.12;
    const ankle = (s: 'l' | 'r'): number => Math.max(0.02, restPos.get(`${s}_foot`)?.y ?? 0.08);

    this.data = { bones, order, ends, height: targetHeight, headSize, ankleHeight: { l: ankle('l'), r: ankle('r') }, capsules: new Map() };
    this.analyzeSkin(model, restPos);

    // helper "half joint" bones (see makehuman.ts) follow half of a joint's rotation
    model.traverse((o) => {
      const halfOf = o.userData['halfOf'] as string | undefined;
      const child = halfOf === undefined ? undefined : model.getObjectByName(halfOf);
      if (child !== undefined) {
        this.helpers.push({ helper: o, child, helperRest: o.quaternion.clone(), childRestInv: child.quaternion.clone().invert() });
      }
    });

    const hipsObj = this.boneObjs.get('hips');
    if (hipsObj === undefined || hipsObj.parent === null) {
      throw new RigError('hips bone has no parent');
    }
    this.hipsRestLocal = hipsObj.position.clone();
    this.hipsParentInv = new Matrix3().setFromMatrix4(hipsObj.parent.matrixWorld).invert();

    model.traverse((o) => {
      const m = o as { isSkinnedMesh?: boolean; frustumCulled: boolean };
      if (m.isSkinnedMesh === true) {
        m.frustumCulled = false;
      }
    });
  }

  /**
   * Classify skin vertices by the canonical bone that moves them most, then
   * (1) keep samples per region for contact measurement and (2) measure the
   * limb thickness around each bone segment for the collision capsules.
   */
  private analyzeSkin(model: Object3D, restPos: Map<string, Vector3>): void {
    const canonOf = (o: Object3D | null): string | null => {
      let p = o;
      while (p !== null) {
        const c = this.objToCanon.get(p);
        if (c !== undefined) {
          return c;
        }
        p = p.parent;
      }
      return null;
    };
    const dists = new Map<string, number[]>();
    const hipsY = restPos.get('hips')?.y ?? 0;
    // upper 40% of the thigh (rest pose, legs straight down)
    const seatThighLimit = (side: string | null): number => {
      const hip = side === null ? undefined : restPos.get(`${side}_thigh`);
      const knee = side === null ? undefined : restPos.get(`${side}_shin`);
      if (hip === undefined || knee === undefined) {
        return -Infinity;
      }
      return hip.y - 0.4 * (hip.y - knee.y);
    };
    const add =(set: ContactSet, mesh: SkinnedMesh, index: number): void => {
      let list = this.contact.get(set);
      if (list === undefined) {
        list = [];
        this.contact.set(set, list);
      }
      list.push({ mesh, index });
    };
    const meshes: SkinnedMesh[] = [];
    model.traverse((o) => {
      if ((o as SkinnedMesh).isSkinnedMesh === true) {
        meshes.push(o as SkinnedMesh);
      }
    });
    const segEnd = new Map<string, string>();
    for (const [bone, ends] of CAPSULE_SEGMENTS) {
      const to = ends.find((e) => restPos.has(e));
      if (restPos.has(bone) && to !== undefined) {
        segEnd.set(bone, to);
        dists.set(bone, []);
      }
    }
    const v = new Vector3();
    for (const mesh of meshes) {
      const boneCanon = mesh.skeleton.bones.map((b) => canonOf(b));
      const pos = mesh.geometry.getAttribute('position') as BufferAttribute;
      const si = mesh.geometry.getAttribute('skinIndex') as BufferAttribute | undefined;
      const sw = mesh.geometry.getAttribute('skinWeight') as BufferAttribute | undefined;
      if (si === undefined || sw === undefined) {
        continue;
      }
      for (let i = 0; i < pos.count; i++) {
        let best = -1;
        let bestW = 0;
        for (let k = 0; k < 4; k++) {
          const w = sw.getComponent(i, k);
          if (w > bestW) {
            bestW = w;
            best = si.getComponent(i, k);
          }
        }
        const canon = best < 0 ? null : (boneCanon[best] ?? null);
        if (canon === null) {
          continue;
        }
        mesh.getVertexPosition(i, v);
        v.applyMatrix4(mesh.matrixWorld); // rest pose, character space (root is identity here)
        const side = canon.startsWith('l_') ? 'l' : canon.startsWith('r_') ? 'r' : null;
        const part = side === null ? canon : canon.slice(2);
        // hands and feet are measured separately: they are placed by IK
        if (side !== null && (part === 'foot' || part === 'toes')) {
          add(`${side}_foot`, mesh, i);
        } else if (side !== null && (part === 'hand' || /^(thumb|index|middle|ring|pinky)\d$/.test(part))) {
          add(`${side}_hand`, mesh, i);
        } else if (i % 5 === 0) {
          add('body', mesh, i);
        }
        // the seat: buttocks and the back of the upper thigh. Not the whole
        // thigh: with sloping thighs the knee end would hang below the seat
        if (v.y < hipsY && (canon === 'hips' || (part === 'thigh' && v.y > seatThighLimit(side)))) {
          add('seat', mesh, i);
        }
        const to = segEnd.get(canon);
        const a = restPos.get(canon);
        const b = to === undefined ? undefined : restPos.get(to);
        if (a !== undefined && b !== undefined && bestW > 0.6) {
          if (DEPTH_CAPSULES.has(canon)) {
            // front-to-back depth, not width: arms cross in front of the
            // chest, and a round capsule as wide as the shoulders would push
            // them far off the body
            const t = Math.max(0, Math.min(1, (v.y - a.y) / Math.max(1e-6, b.y - a.y)));
            dists.get(canon)?.push(Math.abs(v.z - (a.z + t * (b.z - a.z))));
          } else {
            dists.get(canon)?.push(segmentDistance(v, a, b));
          }
        }
      }
    }
    for (const [bone, list] of dists) {
      const to = segEnd.get(bone);
      if (to === undefined || list.length < 8) {
        continue;
      }
      list.sort((a, b) => a - b);
      // a little under the median: capsules should touch, not overlap, at
      // rest. Depth samples run from the flanks (0) to the front/back surface,
      // so the surface is near the top of the distribution.
      const torso = bone === 'hips' || bone === 'spine' || bone === 'spine_mid' || bone === 'chest';
      const q = DEPTH_CAPSULES.has(bone) ? 0.8 : torso ? 0.45 : 0.5;
      const radius = list[Math.floor(list.length * q)] ?? 0;
      // the chest capsule stops short of the neck, which is far thinner
      this.data.capsules.set(bone, bone === 'chest' ? { to, radius, length: 0.6 } : { to, radius });
    }
  }

  /**
   * Lowest point (character-space y) of the deformed skin in the given
   * regions. Must be called after apply(); uses the current bone matrices.
   */
  lowestPoint(sets: ContactSet[]): number {
    this.root.updateMatrixWorld(true);
    const v = new Vector3();
    let min = Infinity;
    for (const set of sets) {
      for (const { mesh, index } of this.contact.get(set) ?? []) {
        mesh.getVertexPosition(index, v);
        v.applyMatrix4(mesh.matrixWorld);
        this.root.worldToLocal(v);
        min = Math.min(min, v.y);
      }
    }
    return min;
  }

  /** Apply solver output. Assumes root's world transform is the figure placement. */
  apply(out: SolveOutput): void {
    const hipsObj = this.boneObjs.get('hips');
    if (hipsObj !== undefined) {
      hipsObj.position.copy(this.hipsRestLocal).add(out.hipsDelta.clone().applyMatrix3(this.hipsParentInv));
    }
    const visit = (o: Object3D, parentQ: Quaternion): void => {
      const canon = this.objToCanon.get(o);
      let q: Quaternion;
      const desired = canon === undefined ? undefined : out.quats.get(canon);
      if (desired !== undefined) {
        o.quaternion.copy(parentQ.clone().invert().multiply(desired));
        q = desired;
      } else {
        q = parentQ.clone().multiply(o.quaternion);
      }
      for (const c of o.children) {
        visit(c, q);
      }
    };
    visit(this.inner, new Quaternion());
    const half = new Quaternion();
    for (const h of this.helpers) {
      half.copy(h.childRestInv).multiply(h.child.quaternion);
      h.helper.quaternion.copy(h.helperRest).multiply(new Quaternion().slerp(half, 0.5));
    }
  }
}
