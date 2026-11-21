// three.js viewport: turns a SceneDoc into a posed 3D scene, renders it with
// a photographic camera, and handles picking and labels.

import {
  AmbientLight, ACESFilmicToneMapping, Color, DirectionalLight, Group, HemisphereLight, Mesh, PCFShadowMap,
  PerspectiveCamera, Quaternion, Raycaster, Scene, SRGBColorSpace, Vector2, Vector3, WebGLRenderer,
} from 'three';
import type { Material, MeshStandardMaterial, Object3D, SkinnedMesh } from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { CameraSpec, Figure, Prop, SceneDoc, TargetRef } from '../dsl/types.ts';
import { bodyParams } from '../dsl/geometry.ts';
import type { Effector, GroundKind, RenderStyle } from '../dsl/vocab.ts';
import { PARTS } from '../dsl/vocab.ts';
import { solveOnRig } from '../rig/posing.ts';
import { libraryFor } from '../pose/lang/library.ts';
import { composePose } from '../pose/lang/compose.ts';
import type { ComposedPose } from '../pose/lang/compose.ts';
import { handShapeChannels } from '../pose/lang/channels.ts';
import type { ReachTarget, SolveInput, SolveOutput, Support } from '../pose/solve.ts';
import { LANDMARK_BY_NAME } from '../pose/landmarks.ts';
import type { Catalog } from '../rig/catalog.ts';
import { Rig } from '../rig/rig.ts';
import { CameraController } from './cameraController.ts';
import type { CameraPose } from './cameraController.ts';
import { buildGround, buildProp } from './environment.ts';
import { FIGURE_COLOR, SELECTED_COLOR, figureDepthMaterial, figureMaterial, propMaterial } from './materials.ts';

const DEG = Math.PI / 180;

interface FigureView {
  id: string;
  key: string;
  root: Group;
  rig: Rig | null;
  material: Material;
  error: string | null;
  solved: SolveOutput | null;
  token: number;
  nameTag: CSS2DObject;
}

export interface PickResult {
  figure: string;
  part: string | null;
  /** world-space hit point */
  point: Vector3;
}

export interface ViewportEvents {
  /** a name tag or part label was clicked */
  onPick: (r: PickResult | null) => void;
  onCameraCommit: (pose: CameraPose, rotated: boolean) => void;
  onStatus: (message: string, isError: boolean) => void;
  /** called every frame after the camera update, before rendering */
  onFrame: (dt: number) => void;
}

const LIMB_JOINT_PREFIX: Record<Effector, string[]> = {
  left_hand: ['left_arm.', 'left_elbow.'],
  right_hand: ['right_arm.', 'right_elbow.'],
  left_foot: ['left_leg.', 'left_knee.'],
  right_foot: ['right_leg.', 'right_knee.'],
};

function parseAspect(frame: string): number | null {
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(frame);
  if (!m) {
    return null;
  }
  const w = Number(m[1]);
  const h = Number(m[2]);
  return w > 0 && h > 0 ? w / h : null;
}

export class Viewport {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(40, 1, 0.05, 400);
  readonly controller: CameraController;
  private readonly composer: EffectComposer;
  private readonly bokeh: BokehPass;
  private readonly labels: CSS2DRenderer;
  private readonly container: HTMLElement;
  private readonly frameEl: HTMLDivElement;
  private readonly sun = new DirectionalLight(0xffffff, 2);
  private readonly hemi = new HemisphereLight(0xe6eef8, 0x8a8170, 0.6);
  private readonly ambient = new AmbientLight(0xffffff, 0.15);
  private ground: Group | null = null;
  private groundKind: GroundKind | null = null;
  private readonly propsGroup = new Group();
  private readonly partLabels = new Group();
  private readonly figures = new Map<string, FigureView>();
  private readonly events: ViewportEvents;
  private readonly catalog: Catalog;
  private doc: SceneDoc | null = null;
  private lastCameraSpec = '';
  private style: RenderStyle = 'smooth';
  private selected: string | null = null;
  private showNames = true;
  private showParts = false;
  private showThirds = true;
  private horizonMode: 'off' | 'interact' | 'always' = 'interact';
  private tintSelection = true;
  private readonly horizonEl: HTMLDivElement;
  private needsPose = false;
  private cameraDependent = false;
  private lastTime = performance.now();
  private frameRect = { x: 0, y: 0, w: 1, h: 1 };

  constructor(container: HTMLElement, catalog: Catalog, events: ViewportEvents) {
    this.container = container;
    this.catalog = catalog;
    this.events = events;
    this.renderer = new WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFShadowMap;
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.tabIndex = 0;

    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = 'label-layer';
    container.appendChild(this.labels.domElement);

    this.frameEl = document.createElement('div');
    this.frameEl.className = 'frame-guide';
    container.appendChild(this.frameEl);

    this.horizonEl = document.createElement('div');
    this.horizonEl.className = 'horizon-line interact';
    const horizonLabel = document.createElement('span');
    horizonLabel.textContent = 'horizon / eye level';
    this.horizonEl.appendChild(horizonLabel);
    container.appendChild(this.horizonEl);

    this.scene.background = new Color(0xdfe3e8);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.02;
    this.scene.add(this.sun, this.sun.target, this.hemi, this.ambient, this.propsGroup, this.partLabels);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bokeh = new BokehPass(this.scene, this.camera, { focus: 5, aperture: 0.002, maxblur: 0.02 });
    this.composer.addPass(this.bokeh);
    this.composer.addPass(new OutputPass());

    this.controller = new CameraController({
      onChange: () => {
        if (this.cameraDependent) {
          this.needsPose = true;
        }
      },
      onCommit: (pose, rotated) => this.events.onCameraCommit(pose, rotated),
    });

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  // ------------------------------------------------------------------ setup

  private resize(): void {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.labels.setSize(w, h);
    this.camera.aspect = w / h;
    this.updateFrameGuide();
    this.applyLens();
  }

  private updateFrameGuide(): void {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    const aspect = parseAspect(this.doc?.camera.frame ?? 'free');
    let fw = w;
    let fh = h;
    if (aspect !== null) {
      const margin = 0.94;
      if (w / h > aspect) {
        fh = h * margin;
        fw = fh * aspect;
      } else {
        fw = w * margin;
        fh = fw / aspect;
      }
    }
    this.frameRect = { x: (w - fw) / 2, y: (h - fh) / 2, w: fw, h: fh };
    const s = this.frameEl.style;
    s.left = `${this.frameRect.x}px`;
    s.top = `${this.frameRect.y}px`;
    s.width = `${fw}px`;
    s.height = `${fh}px`;
    this.frameEl.classList.toggle('framed', aspect !== null);
    this.frameEl.classList.toggle('thirds', this.showThirds);
  }

  /** Field of view of the framed picture (radians), as a 36x24mm camera would see it. */
  frameFov(): { v: number; h: number } {
    const lens = this.controller.pose.lens;
    const aspect = parseAspect(this.doc?.camera.frame ?? 'free') ?? this.frameRect.w / Math.max(1, this.frameRect.h);
    const sensorV = aspect < 1 ? 36 : 24;
    const v = 2 * Math.atan(sensorV / (2 * lens));
    return { v, h: 2 * Math.atan(Math.tan(v / 2) * aspect) };
  }

  /** Vertical FOV such that the frame guide matches a 36x24mm sensor at the lens focal length. */
  private applyLens(): void {
    const lens = this.controller.pose.lens;
    const aspect = parseAspect(this.doc?.camera.frame ?? 'free');
    const sensorV = aspect !== null && aspect < 1 ? 36 : 24;
    const frameHalf = Math.atan(sensorV / (2 * lens));
    const vh = Math.max(1, this.container.clientHeight);
    const fov = 2 * Math.atan(Math.tan(frameHalf) * (vh / this.frameRect.h));
    this.camera.fov = fov / DEG;
    this.camera.updateProjectionMatrix();
  }

  setOverlay(opts: { names?: boolean; parts?: boolean; thirds?: boolean; horizon?: 'off' | 'interact' | 'always' }): void {
    if (opts.horizon !== undefined) {
      this.horizonMode = opts.horizon;
      this.horizonEl.classList.toggle('interact', opts.horizon === 'interact');
    }
    if (opts.names !== undefined) {
      this.showNames = opts.names;
      for (const v of this.figures.values()) {
        v.nameTag.visible = this.showNames;
      }
    }
    if (opts.parts !== undefined) {
      this.showParts = opts.parts;
      this.rebuildPartLabels();
    }
    if (opts.thirds !== undefined) {
      this.showThirds = opts.thirds;
      this.updateFrameGuide();
    }
  }

  // ------------------------------------------------------------------ document sync

  setDoc(doc: SceneDoc): void {
    const styleChanged = doc.style !== this.style;
    this.doc = doc;
    this.style = doc.style;
    if (this.groundKind !== doc.ground) {
      if (this.ground !== null) {
        this.scene.remove(this.ground);
      }
      this.ground = buildGround(doc.ground);
      this.groundKind = doc.ground;
      this.scene.add(this.ground);
    }
    this.applyLight();
    this.syncProps(doc.props);
    const camJson = JSON.stringify(doc.camera);
    if (camJson !== this.lastCameraSpec) {
      this.lastCameraSpec = camJson;
      this.applyCameraSpec(doc.camera);
    }
    this.updateFrameGuide();
    this.applyLens();
    this.syncFigures(doc.figures, styleChanged);
    this.cameraDependent = doc.figures.some((f) => dependsOnCamera(f));
    this.needsPose = true;
  }

  private applyLight(): void {
    if (this.doc === null) {
      return;
    }
    const l = this.doc.light;
    const az = l.azimuth * DEG;
    const el = l.elevation * DEG;
    this.sun.position.set(Math.sin(az) * Math.cos(el) * 20, Math.sin(el) * 20, Math.cos(az) * Math.cos(el) * 20);
    this.sun.intensity = l.intensity;
    this.hemi.intensity = 0.25 + l.fill;
    this.ambient.intensity = 0.1 * l.fill;
  }

  private syncProps(props: Prop[]): void {
    this.propsGroup.clear();
    const mat = propMaterial(this.style);
    for (const p of props) {
      this.propsGroup.add(buildProp(p, mat));
    }
  }

  private applyCameraSpec(c: CameraSpec): void {
    const p = this.controller.pose;
    p.x = c.x;
    p.y = c.y;
    p.z = c.z;
    p.lens = c.lens;
    if (c.aim.kind === 'angles') {
      p.yaw = c.aim.yaw;
      p.pitch = c.aim.pitch;
      this.controller.aimLocked = false;
    } else {
      this.controller.aimLocked = true;
    }
  }

  private figureKey(f: Figure): string {
    const entry = this.catalog.get(f.model);
    const bp = bodyParams(f);
    const body = entry?.kind === 'human' ? JSON.stringify(bp) : String(bp.height);
    return `${f.model}|${body}|${this.style}`;
  }

  private syncFigures(figs: Figure[], styleChanged: boolean): void {
    const ids = new Set(figs.map((f) => f.id));
    for (const [id, v] of this.figures) {
      if (!ids.has(id)) {
        this.scene.remove(v.root);
        v.nameTag.element.remove();
        this.figures.delete(id);
      }
    }
    for (const f of figs) {
      const key = this.figureKey(f);
      let v = this.figures.get(f.id);
      if (v === undefined) {
        const tagEl = document.createElement('div');
        tagEl.className = 'name-tag';
        tagEl.textContent = f.id;
        tagEl.addEventListener('click', () => this.events.onPick({ figure: f.id, part: null, point: new Vector3(f.x, 0, f.z) }));
        const nameTag = new CSS2DObject(tagEl);
        nameTag.visible = this.showNames;
        const root = new Group();
        root.name = `figure:${f.id}`;
        root.userData['figureId'] = f.id;
        root.add(nameTag);
        v = { id: f.id, key: '', root, rig: null, material: figureMaterial(this.style, this.tintSelection && f.id === this.selected), error: null, solved: null, token: 0, nameTag };
        this.figures.set(f.id, v);
        this.scene.add(root);
      }
      if (v.key !== key || styleChanged) {
        v.key = key;
        void this.buildFigure(v, f);
      }
    }
  }

  private async buildFigure(v: FigureView, f: Figure): Promise<void> {
    const token = ++v.token;
    v.material = figureMaterial(this.style, this.tintSelection && f.id === this.selected);
    const bp = bodyParams(f);
    this.events.onStatus(`loading ${f.model} for ${f.id}...`, false);
    try {
      const inst = await this.catalog.instantiate(f.model, bp, v.material);
      if (token !== v.token) {
        return;
      }
      const rig = new Rig(inst.object, inst.map, bp.height);
      if (v.rig !== null) {
        v.root.remove(v.rig.root);
      }
      rig.root.traverse((o) => {
        o.userData['figureId'] = f.id;
        const sm = o as SkinnedMesh;
        if (sm.isSkinnedMesh === true) {
          sm.customDepthMaterial = figureDepthMaterial();
        }
      });
      v.root.add(rig.root);
      v.rig = rig;
      v.error = null;
      v.nameTag.position.set(0, bp.height + 0.18, 0);
      this.needsPose = true;
      this.events.onStatus('', false);
    } catch (e) {
      if (token !== v.token) {
        return;
      }
      v.error = e instanceof Error ? e.message : String(e);
      this.events.onStatus(`${f.id}: ${v.error}`, true);
    }
  }

  select(id: string | null): void {
    this.selected = id;
    this.applyTint();
    this.rebuildPartLabels();
  }

  /** Tinting the selected figure helps editing but would distort the reference shading. */
  setSelectionTint(on: boolean): void {
    this.tintSelection = on;
    this.applyTint();
  }

  private applyTint(): void {
    for (const [fid, v] of this.figures) {
      const sel = fid === this.selected;
      const m = v.material as MeshStandardMaterial;
      m.color.copy(sel && this.tintSelection ? SELECTED_COLOR : FIGURE_COLOR);
      v.nameTag.element.classList.toggle('selected', sel);
    }
  }

  /** Place the horizon guide where the camera's eye level meets the picture. */
  private updateHorizon(): void {
    const el = this.horizonEl;
    if (this.horizonMode === 'off') {
      el.style.display = 'none';
      return;
    }
    const p = this.controller.pose;
    // any point at camera height straight ahead lies on the horizon's image
    const far = new Vector3(p.x + Math.sin(p.yaw * DEG) * 10, p.y, p.z + Math.cos(p.yaw * DEG) * 10);
    const ndc = far.project(this.camera);
    if (Math.abs(p.pitch) > 80 || ndc.z > 1 || Math.abs(ndc.y) > 1.2) {
      el.style.display = 'none';
      return;
    }
    el.style.display = '';
    const hgt = this.container.clientHeight;
    const y = ((1 - ndc.y) / 2) * hgt;
    el.style.top = `${y}px`;
    el.style.transform = `rotate(${-(this.doc?.camera.roll ?? 0)}deg)`;
  }

  // ------------------------------------------------------------------ targets

  private landmarkWorld(figId: string, part: string): { pos: Vector3; normal: Vector3 | null } | null {
    const v = this.figures.get(figId);
    if (v === undefined || v.solved === null) {
      return null;
    }
    const lm = v.solved.landmarks.get(part);
    if (lm === undefined) {
      return null;
    }
    v.root.updateMatrixWorld();
    const pos = v.root.localToWorld(lm.pos.clone());
    const normal = lm.normal === null ? null : lm.normal.clone().applyQuaternion(v.root.getWorldQuaternion(new Quaternion()));
    return { pos, normal };
  }

  private locateWorld(t: TargetRef): { pos: Vector3; normal: Vector3 | null } | null {
    const doc = this.doc;
    if (doc === null) {
      return null;
    }
    switch (t.kind) {
      case 'point':
        return { pos: new Vector3(t.x, t.y, t.z), normal: null };
      case 'camera':
        return { pos: this.camera.position.clone(), normal: null };
      case 'prop': {
        const p = doc.props.find((q) => q.id === t.prop);
        return p === undefined ? null : { pos: new Vector3(p.x, p.size[1], p.z), normal: new Vector3(0, 1, 0) };
      }
      case 'figure':
      case 'part': {
        const part = t.kind === 'part' ? t.part : 'chest';
        const lw = this.landmarkWorld(t.figure, part);
        if (lw !== null) {
          return lw;
        }
        const f = doc.figures.find((q) => q.id === t.figure);
        if (f === undefined) {
          return null;
        }
        return { pos: new Vector3(f.x, f.elevation + bodyParams(f).height * 0.72, f.z), normal: null };
      }
    }
  }

  private facingRad(f: Figure): number {
    if (f.facing.kind === 'angle') {
      return f.facing.deg * DEG;
    }
    const t = f.facing.target;
    let pos: Vector3 | null = null;
    if (t.kind === 'figure' || t.kind === 'part') {
      const other = this.doc?.figures.find((q) => q.id === t.figure);
      pos = other === undefined ? null : new Vector3(other.x, 0, other.z);
    } else {
      pos = this.locateWorld(t)?.pos ?? null;
    }
    if (pos === null || (Math.abs(pos.x - f.x) < 1e-6 && Math.abs(pos.z - f.z) < 1e-6)) {
      return 0;
    }
    const a = Math.atan2(pos.x - f.x, pos.z - f.z);
    return f.facing.kind === 'toward' ? a : a + Math.PI;
  }

  // ------------------------------------------------------------------ posing

  private poseAll(): void {
    const doc = this.doc;
    if (doc === null) {
      return;
    }
    for (const f of doc.figures) {
      const v = this.figures.get(f.id);
      if (v === undefined) {
        continue;
      }
      v.root.position.set(f.x, f.elevation, f.z);
      v.root.rotation.set(0, this.facingRad(f), 0);
      v.root.updateMatrixWorld(true);
    }
    // pass 1: everyone; pass 2: figures that reference other figures' bodies
    for (const f of doc.figures) {
      this.solveFigure(f);
    }
    for (const f of doc.figures) {
      if (referencesOthers(f)) {
        this.solveFigure(f);
      }
    }
    this.updateShadowBounds();
    this.rebuildPartLabels();
  }

  private solveFigure(f: Figure): void {
    const v = this.figures.get(f.id);
    if (v === undefined || v.rig === null) {
      return;
    }
    let pose: ComposedPose;
    try {
      pose = composePose(libraryFor(this.doc?.poses ?? []), f.pose);
    } catch (e) {
      // the applier validates poses, so this only happens with a broken library
      console.warn(`pose of ${f.id}:`, e);
      pose = composePose(libraryFor([]), { k: 'word', w: 'stand' });
    }
    // figure-level edits (set, hand, reach) are the top layer over the pose
    const dofs: Record<string, number> = { ...pose.dofs, ...f.joints };
    for (const side of ['left', 'right'] as const) {
      const shape = f.hands[side];
      if (shape !== undefined) {
        for (const [k, v] of handShapeChannels(side, shape)) {
          dofs[k] = v;
        }
      }
    }
    const jointKeys = Object.keys(f.joints);
    const reaches: Partial<Record<Effector, ReachTarget>> = {};
    for (const [eff, goal] of Object.entries(pose.reaches) as [Effector, { part: string; weight: number }[]][]) {
      const overridden = jointKeys.some((k) => (LIMB_JOINT_PREFIX[eff] ?? []).some((p) => k.startsWith(p)));
      if (overridden || goal.length === 0) {
        continue;
      }
      const only = goal.length === 1 && goal[0] !== undefined && goal[0].weight === 1 ? goal[0].part : null;
      reaches[eff] = only !== null ? { point: null, selfPart: only, normal: null } : { point: null, selfPart: null, normal: null, blend: goal };
    }
    const invQ = v.root.getWorldQuaternion(new Quaternion()).invert();
    for (const [eff, tg] of Object.entries(f.reaches) as [Effector, TargetRef][]) {
      if (tg.kind === 'part' && tg.figure === f.id) {
        reaches[eff] = { point: null, selfPart: tg.part, normal: null };
        continue;
      }
      const loc = this.locateWorld(tg);
      if (loc === null) {
        continue;
      }
      // a point on the floor is a surface too: hands and feet should lie on it
      const normal = loc.normal ?? (tg.kind === 'point' && loc.pos.y < 0.03 ? new Vector3(0, 1, 0) : null);
      reaches[eff] = {
        point: v.root.worldToLocal(loc.pos.clone()),
        selfPart: null,
        normal: normal === null ? null : normal.clone().applyQuaternion(invQ),
      };
    }
    let look: Vector3 | null = null;
    if (f.look !== null) {
      const loc = this.locateWorld(f.look);
      if (loc !== null) {
        look = v.root.worldToLocal(loc.pos.clone());
      }
    }
    const input: SolveInput = {
      rig: v.rig.data,
      dofs,
      reaches,
      look,
      ground: pose.ground,
      lift: pose.lift,
      sit: pose.sit,
      support: this.supportUnder(f, pose.sit),
    };
    // solve, apply, then correct contacts by measuring the deformed skin
    const out = solveOnRig(v.rig, input);
    v.solved = out;
    v.root.traverse((o) => {
      const sm = o as SkinnedMesh;
      if (sm.isSkinnedMesh === true) {
        // recomputed lazily on the next raycast
        (sm as unknown as { boundingSphere: unknown; boundingBox: unknown }).boundingSphere = null;
        (sm as unknown as { boundingSphere: unknown; boundingBox: unknown }).boundingBox = null;
      }
    });
    const top = out.landmarks.get('top_of_head');
    if (top !== undefined) {
      v.nameTag.position.copy(top.pos).add(new Vector3(0, 0.18, 0));
    }
  }

  /**
   * Surfaces under a figure in its character space: a box, step or table top
   * to stand on, or a chair, bench or box seat when the pose sits.
   */
  private supportUnder(f: Figure, sits: boolean): Support {
    const props = this.doc?.props ?? [];
    let floor = 0;
    let seat: number | null = null;
    let seatScore = Infinity;
    for (const p of props) {
      // figure position in the prop's local frame
      const a = -p.facing * DEG;
      const dx = f.x - p.x;
      const dz = f.z - p.z;
      const lx = dx * Math.cos(a) + dz * Math.sin(a);
      const lz = -dx * Math.sin(a) + dz * Math.cos(a);
      const top = p.kind === 'chair' ? Math.min(p.size[1], 0.46) : p.size[1];
      if (sits) {
        // the pelvis may sit a little off the figure's origin: allow some
        // padding, and take the best centred seat (a table only when there
        // is no other seat), not the highest surface nearby
        const pad = 0.12;
        if (Math.abs(lx) > p.size[0] / 2 + pad || Math.abs(lz) > p.size[2] / 2 + pad) {
          continue;
        }
        if (p.kind !== 'chair' && p.kind !== 'bench' && p.kind !== 'box' && p.kind !== 'step' && p.kind !== 'table') {
          continue;
        }
        const offCentre = Math.max(Math.abs(lx) / (p.size[0] / 2 + pad), Math.abs(lz) / (p.size[2] / 2 + pad));
        const score = offCentre + (p.kind === 'table' ? 1 : 0);
        if (score < seatScore) {
          seatScore = score;
          seat = top;
        }
      } else if (p.kind === 'box' || p.kind === 'step' || p.kind === 'table') {
        // standing on top: only when the figure stands over the surface
        if (Math.abs(lx) <= p.size[0] / 2 && Math.abs(lz) <= p.size[2] / 2) {
          floor = Math.max(floor, top);
        }
      }
    }
    return { floorY: floor - f.elevation, seatY: seat === null ? null : seat - f.elevation };
  }

  private updateShadowBounds(): void {
    let r = 6;
    let cx = 0;
    let cz = 0;
    const figs = this.doc?.figures ?? [];
    if (figs.length > 0) {
      cx = figs.reduce((a, f) => a + f.x, 0) / figs.length;
      cz = figs.reduce((a, f) => a + f.z, 0) / figs.length;
      r = Math.max(4, ...figs.map((f) => Math.hypot(f.x - cx, f.z - cz) + 2.5));
    }
    const cam = this.sun.shadow.camera;
    cam.left = -r;
    cam.right = r;
    cam.top = r;
    cam.bottom = -r;
    cam.near = 0.5;
    cam.far = 60;
    cam.updateProjectionMatrix();
    this.sun.target.position.set(cx, 0, cz);
    const l = this.doc?.light;
    if (l !== undefined) {
      const az = l.azimuth * DEG;
      const el = l.elevation * DEG;
      this.sun.position.set(cx + Math.sin(az) * Math.cos(el) * 25, Math.sin(el) * 25, cz + Math.cos(az) * Math.cos(el) * 25);
    }
  }

  // ------------------------------------------------------------------ labels and picking

  private rebuildPartLabels(): void {
    for (const c of [...this.partLabels.children]) {
      if (c instanceof CSS2DObject) {
        c.element.remove();
      }
    }
    this.partLabels.clear();
    if (!this.showParts || this.selected === null) {
      return;
    }
    const fid = this.selected;
    for (const p of PARTS) {
      if (LANDMARK_BY_NAME.get(p.name)?.hidden === true) {
        continue;
      }
      const lw = this.landmarkWorld(fid, p.name);
      if (lw === null) {
        continue;
      }
      const el = document.createElement('div');
      el.className = 'part-label';
      el.innerHTML = `<span class="dot"></span><span class="txt"></span>`;
      const txt = el.querySelector('.txt');
      if (txt !== null) {
        txt.textContent = p.name;
      }
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        this.events.onPick({ figure: fid, part: p.name, point: lw.pos.clone() });
      });
      const o = new CSS2DObject(el);
      o.position.copy(lw.pos);
      this.partLabels.add(o);
    }
  }

  /** Convert client (CSS pixel) coordinates to normalized device coordinates. */
  ndcFromClient(clientX: number, clientY: number): Vector2 {
    const rect = this.renderer.domElement.getBoundingClientRect();
    return new Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  }

  /** Which figure and body part is under a screen point (NDC; (0,0) is the crosshair). */
  pickAt(ndc: Vector2): PickResult | null {
    const ray = new Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const roots: Object3D[] = [...this.figures.values()].map((v) => v.root);
    const hit = ray.intersectObjects(roots, true).find((h) => (h.object as Mesh).isMesh === true);
    if (hit === undefined) {
      return null;
    }
    const fid = hit.object.userData['figureId'] as string | undefined;
    if (fid === undefined) {
      return null;
    }
    let best: string | null = null;
    let bestD = Infinity;
    for (const p of PARTS) {
      const lw = this.landmarkWorld(fid, p.name);
      if (lw === null) {
        continue;
      }
      const d = lw.pos.distanceTo(hit.point);
      if (d < bestD) {
        bestD = d;
        best = p.name;
      }
    }
    return { figure: fid, part: best, point: hit.point.clone() };
  }

  /** Where a screen ray meets the ground (y = 0), if within `maxDist` meters. */
  groundAt(ndc: Vector2, maxDist = 40): Vector3 | null {
    const ray = new Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const o = ray.ray.origin;
    const d = ray.ray.direction;
    if (d.y > -1e-4) {
      return null;
    }
    const t = -o.y / d.y;
    if (t > maxDist) {
      return null;
    }
    return o.clone().add(d.clone().multiplyScalar(t));
  }

  /** Current posed position of a landmark in world space, if available. */
  partWorld(figId: string, part: string): Vector3 | null {
    return this.landmarkWorld(figId, part)?.pos ?? null;
  }

  // ------------------------------------------------------------------ frame loop

  private updateCamera(): void {
    const doc = this.doc;
    const p = this.controller.pose;
    if (doc !== null && this.controller.aimLocked && doc.camera.aim.kind === 'target') {
      const loc = this.locateWorld(doc.camera.aim.target);
      if (loc !== null) {
        const d = loc.pos.clone().sub(new Vector3(p.x, p.y, p.z));
        if (d.lengthSq() > 1e-8) {
          p.yaw = Math.atan2(d.x, d.z) / DEG;
          p.pitch = Math.atan2(d.y, Math.hypot(d.x, d.z)) / DEG;
        }
      }
    }
    this.camera.position.set(p.x, p.y, p.z);
    const dir = new Vector3(Math.sin(p.yaw * DEG) * Math.cos(p.pitch * DEG), Math.sin(p.pitch * DEG), Math.cos(p.yaw * DEG) * Math.cos(p.pitch * DEG));
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.camera.position.clone().add(dir));
    const roll = doc?.camera.roll ?? 0;
    if (roll !== 0) {
      this.camera.rotateZ(roll * DEG);
    }
    this.applyLens();
  }

  /** Distance (m) the lens is focused at, resolving auto and target focus. */
  focusDistance(): number {
    const doc = this.doc;
    const viewDir = new Vector3();
    this.camera.getWorldDirection(viewDir);
    const along = (pos: Vector3): number => Math.max(0.2, pos.clone().sub(this.camera.position).dot(viewDir));
    if (doc === null) {
      return 5;
    }
    const f = doc.camera.focus;
    if (f.kind === 'distance') {
      return f.meters;
    }
    if (f.kind === 'target') {
      const loc = this.locateWorld(f.target);
      if (loc !== null) {
        return along(loc.pos);
      }
    }
    if (doc.camera.aim.kind === 'target') {
      const loc = this.locateWorld(doc.camera.aim.target);
      if (loc !== null) {
        return along(loc.pos);
      }
    }
    // auto: the figure nearest the center of the view
    let best = 5;
    let bestScore = Infinity;
    for (const fig of doc.figures) {
      const pos = new Vector3(fig.x, fig.elevation + 1.2, fig.z);
      const d = along(pos);
      const off = pos.clone().sub(this.camera.position).normalize().angleTo(viewDir);
      if (off < bestScore && off < 0.6) {
        bestScore = off;
        best = d;
      }
    }
    return best;
  }

  private frame(): void {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastTime) / 1000);
    this.lastTime = now;
    this.controller.update(dt);
    this.updateCamera();
    this.updateHorizon();
    this.events.onFrame(dt);
    if (this.needsPose) {
      this.needsPose = false;
      this.poseAll();
    }
    const cam = this.doc?.camera;
    if (cam !== undefined && cam.dof) {
      const S = this.focusDistance();
      const fm = this.controller.pose.lens / 1000;
      const coc = (fm * fm) / (cam.fstop * Math.max(0.01, S - fm) * S);
      const u = this.bokeh.uniforms as unknown as Record<string, { value: number }>;
      const set = (k: string, val: number): void => {
        const uu = u[k];
        if (uu !== undefined) {
          uu.value = val;
        }
      };
      set('focus', S);
      set('aperture', (1.25 * coc) / 0.024 * (this.container.clientHeight / this.frameRect.h));
      set('maxblur', 0.025);
      this.composer.render();
    } else {
      this.renderer.render(this.scene, this.camera);
    }
    this.labels.render(this.scene, this.camera);
  }

  /** Render the framed region to a PNG blob. */
  async snapshot(): Promise<Blob> {
    this.frame();
    const src = this.renderer.domElement;
    const ratio = src.width / Math.max(1, this.container.clientWidth);
    const r = this.frameRect;
    const out = document.createElement('canvas');
    out.width = Math.round(r.w * ratio);
    out.height = Math.round(r.h * ratio);
    const ctx = out.getContext('2d');
    if (ctx === null) {
      throw new Error('2d canvas unavailable');
    }
    ctx.drawImage(src, r.x * ratio, r.y * ratio, r.w * ratio, r.h * ratio, 0, 0, out.width, out.height);
    return new Promise((resolve, reject) => {
      out.toBlob((b) => (b === null ? reject(new Error('could not encode image')) : resolve(b)), 'image/png');
    });
  }
}

function dependsOnCamera(f: Figure): boolean {
  const isCam = (t: TargetRef | null | undefined): boolean => t !== null && t !== undefined && t.kind === 'camera';
  return isCam(f.look) || (f.facing.kind !== 'angle' && isCam(f.facing.target)) || Object.values(f.reaches).some((t) => isCam(t));
}

function referencesOthers(f: Figure): boolean {
  const other = (t: TargetRef | null | undefined): boolean => t !== null && t !== undefined && (t.kind === 'figure' || t.kind === 'part') && t.figure !== f.id;
  return other(f.look) || Object.values(f.reaches).some((t) => other(t));
}
