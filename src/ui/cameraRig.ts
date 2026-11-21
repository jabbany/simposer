// Camera rig widget: shows how the camera relates to the scene, in the style
// of CAD / set-design camera diagrams.
//
//   Plan (top view): figures and props, the camera body pointing along its
//     yaw, the horizontal view cone of the framed picture, the focus plane
//     and the depth-of-field band, and the distance to the subject.
//   Elevation (side view along the view direction): ground, camera height,
//     tilt, the vertical view cone, the eye-level / horizon line, and figure
//     silhouettes at their true heights and distances.
//   Readouts: lens, field of view, aperture, height, tilt, roll, subject
//     distance, focus and depth of field, plus a plain-language shot name.
//
// The diagrams are also controls: drag the camera in the plan to move it,
// drag elsewhere in the plan to aim, drag the camera in the side view to
// change height, drag elsewhere in the side view to tilt, wheel to zoom.

import type { Figure, SceneDoc } from '../dsl/types.ts';
import { bodyParams, facingDeg } from '../dsl/geometry.ts';
import type { Viewport } from '../render/viewport.ts';

const DEG = Math.PI / 180;
const ACCENT = '#f0b46a';
const BLUE = '#7fb3e6';
const TEXT = '#eef0f2';
const MUTED = 'rgba(238,240,242,0.55)';
const GRID = 'rgba(255,255,255,0.07)';
/** circle of confusion for a full-frame sensor, meters */
const COC = 0.00003;

export interface RigHost {
  readonly viewport: Viewport;
  getDoc(): SceneDoc;
  getSelection(): { figure: string | null; part: string | null };
}

interface Subject {
  fig: Figure;
  height: number;
  /** eye height above ground */
  eye: number;
  dist: number;
}

interface View2D {
  /** world units -> pixels */
  scale: number;
  /** world coordinate shown at the canvas origin */
  ox: number;
  oy: number;
}

type Drag = { kind: 'move' | 'aim' | 'height' | 'tilt'; frozen: View2D } | null;

function setupCanvas(c: HTMLCanvasElement): CanvasRenderingContext2D | null {
  const ctx = c.getContext('2d');
  if (ctx === null) {
    return null;
  }
  const dpr = Math.min(2, window.devicePixelRatio);
  const w = Math.round(c.clientWidth * dpr);
  const h = Math.round(c.clientHeight * dpr);
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, c.clientWidth, c.clientHeight);
  return ctx;
}

function fmtM(m: number): string {
  if (!Number.isFinite(m)) {
    return 'inf';
  }
  return m < 10 ? `${m.toFixed(2)} m` : `${m.toFixed(1)} m`;
}

/** Depth of field limits for focal length f (m), f-number n, focus distance s (m). */
export function depthOfField(f: number, n: number, s: number): { near: number; far: number } {
  const hyper = (f * f) / (n * COC) + f;
  const near = (s * (hyper - f)) / (hyper + s - 2 * f);
  const far = s >= hyper ? Infinity : (s * (hyper - f)) / (hyper - s);
  return { near, far };
}

export class CameraRig {
  private readonly host: RigHost;
  private readonly plan = document.getElementById('rig-plan') as HTMLCanvasElement;
  private readonly side = document.getElementById('rig-side') as HTMLCanvasElement;
  private readonly shotEl = document.getElementById('rig-shot') as HTMLElement;
  private readonly readout = document.getElementById('rig-readout') as HTMLElement;
  private planView: View2D = { scale: 20, ox: 0, oy: 0 };
  private sideView: View2D = { scale: 20, ox: 0, oy: 0 };
  private drag: Drag = null;
  private lastReadout = '';

  constructor(host: RigHost) {
    this.host = host;
    this.bindPlan();
    this.bindSide();
    for (const c of [this.plan, this.side]) {
      c.addEventListener('wheel', (e) => {
        e.preventDefault();
        this.host.viewport.controller.zoom(e.deltaY);
      }, { passive: false });
    }
  }

  // ------------------------------------------------------------ geometry helpers

  private pose() {
    return this.host.viewport.controller.pose;
  }

  private forward(): { x: number; z: number } {
    const p = this.pose();
    return { x: Math.sin(p.yaw * DEG), z: Math.cos(p.yaw * DEG) };
  }

  /** The figure the shot is "about": the selection, else the one nearest the view centre. */
  private subject(): Subject | null {
    const doc = this.host.getDoc();
    const p = this.pose();
    const f = this.forward();
    const make = (fig: Figure): Subject => {
      const height = bodyParams(fig).height;
      const eyeWorld = this.host.viewport.partWorld(fig.id, 'eyes');
      const eye = eyeWorld?.y ?? fig.elevation + height * 0.93;
      return { fig, height, eye, dist: Math.hypot(fig.x - p.x, fig.z - p.z) };
    };
    const sel = doc.figures.find((q) => q.id === this.host.getSelection().figure);
    if (sel !== undefined) {
      return make(sel);
    }
    let best: Figure | null = null;
    let bestScore = Infinity;
    const fov = this.host.viewport.frameFov();
    for (const fig of doc.figures) {
      const dx = fig.x - p.x;
      const dz = fig.z - p.z;
      const along = dx * f.x + dz * f.z;
      if (along <= 0.1) {
        continue;
      }
      const off = Math.abs(Math.atan2(dx * -f.z + dz * f.x, along));
      if (off > fov.h / 2) {
        continue;
      }
      const score = off * 3 + Math.hypot(dx, dz) * 0.05;
      if (score < bestScore) {
        bestScore = score;
        best = fig;
      }
    }
    return best === null ? null : make(best);
  }

  // ------------------------------------------------------------ input

  private planToWorld(e: PointerEvent, v: View2D): { x: number; z: number } {
    const r = this.plan.getBoundingClientRect();
    return { x: v.ox + (e.clientX - r.left) / v.scale, z: v.oy + (e.clientY - r.top) / v.scale };
  }

  private sideToWorld(e: PointerEvent, v: View2D): { d: number; y: number } {
    const r = this.side.getBoundingClientRect();
    return { d: v.ox + (e.clientX - r.left) / v.scale, y: v.oy - (e.clientY - r.top) / v.scale };
  }

  private bindPlan(): void {
    const c = this.plan;
    c.addEventListener('pointerdown', (e) => {
      const v = { ...this.planView };
      const p = this.pose();
      const w = this.planToWorld(e, v);
      const near = Math.hypot(w.x - p.x, w.z - p.z) * v.scale < 14;
      this.drag = { kind: near ? 'move' : 'aim', frozen: v };
      c.setPointerCapture(e.pointerId);
      this.applyPlanDrag(e);
    });
    c.addEventListener('pointermove', (e) => {
      if (this.drag !== null && (this.drag.kind === 'move' || this.drag.kind === 'aim')) {
        this.applyPlanDrag(e);
      }
      c.style.cursor = this.drag?.kind === 'move' ? 'grabbing' : 'crosshair';
    });
    const end = (e: PointerEvent): void => {
      if (this.drag !== null) {
        this.drag = null;
        c.releasePointerCapture(e.pointerId);
      }
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
  }

  private applyPlanDrag(e: PointerEvent): void {
    if (this.drag === null) {
      return;
    }
    const w = this.planToWorld(e, this.drag.frozen);
    const p = this.pose();
    const ctl = this.host.viewport.controller;
    if (this.drag.kind === 'move') {
      ctl.setPose({ x: w.x, z: w.z });
    } else if (this.drag.kind === 'aim' && Math.hypot(w.x - p.x, w.z - p.z) > 0.05) {
      ctl.setPose({ yaw: Math.atan2(w.x - p.x, w.z - p.z) / DEG });
    }
  }

  private bindSide(): void {
    const c = this.side;
    c.addEventListener('pointerdown', (e) => {
      const v = { ...this.sideView };
      const p = this.pose();
      const w = this.sideToWorld(e, v);
      const near = Math.hypot(w.d, w.y - p.y) * v.scale < 14;
      this.drag = { kind: near ? 'height' : 'tilt', frozen: v };
      c.setPointerCapture(e.pointerId);
      this.applySideDrag(e);
    });
    c.addEventListener('pointermove', (e) => {
      if (this.drag !== null && (this.drag.kind === 'height' || this.drag.kind === 'tilt')) {
        this.applySideDrag(e);
      }
    });
    const end = (e: PointerEvent): void => {
      if (this.drag !== null) {
        this.drag = null;
        c.releasePointerCapture(e.pointerId);
      }
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
  }

  private applySideDrag(e: PointerEvent): void {
    if (this.drag === null) {
      return;
    }
    const w = this.sideToWorld(e, this.drag.frozen);
    const p = this.pose();
    const ctl = this.host.viewport.controller;
    if (this.drag.kind === 'height') {
      ctl.setPose({ y: Math.max(0.05, w.y) });
    } else if (w.d > 0.05) {
      ctl.setPose({ pitch: Math.atan2(w.y - p.y, w.d) / DEG });
    }
  }

  // ------------------------------------------------------------ drawing

  update(): void {
    if (this.plan.offsetParent === null) {
      return; // hidden (look mode or small screen)
    }
    const subject = this.subject();
    this.drawPlan(subject);
    this.drawSide(subject);
    this.updateText(subject);
  }

  private fitPlan(points: { x: number; z: number }[], w: number, h: number): View2D {
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const pt of points) {
      minX = Math.min(minX, pt.x);
      maxX = Math.max(maxX, pt.x);
      minZ = Math.min(minZ, pt.z);
      maxZ = Math.max(maxZ, pt.z);
    }
    const pad = 1.2;
    minX -= pad;
    maxX += pad;
    minZ -= pad;
    maxZ += pad;
    const scale = Math.min(w / Math.max(2, maxX - minX), h / Math.max(2, maxZ - minZ));
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    const target = { scale, ox: cx - w / 2 / scale, oy: cz - h / 2 / scale };
    // ease toward the new fit so the diagram does not jump while walking
    const cur = this.planView;
    const k = 0.15;
    return {
      scale: cur.scale + (target.scale - cur.scale) * k,
      ox: cur.ox + (target.ox - cur.ox) * k,
      oy: cur.oy + (target.oy - cur.oy) * k,
    };
  }

  private drawPlan(subject: Subject | null): void {
    const c = this.plan;
    const ctx = setupCanvas(c);
    if (ctx === null) {
      return;
    }
    const W = c.clientWidth;
    const H = c.clientHeight;
    const doc = this.host.getDoc();
    const p = this.pose();
    const f = this.forward();
    const fov = this.host.viewport.frameFov();
    const focus = this.host.viewport.focusDistance();
    // what must be visible: the camera, nearby figures and props, the focus point
    const pts: { x: number; z: number }[] = [{ x: p.x, z: p.z }, { x: p.x + f.x * Math.min(focus, 25), z: p.z + f.z * Math.min(focus, 25) }];
    for (const fig of doc.figures) {
      if (Math.hypot(fig.x - p.x, fig.z - p.z) < 25) {
        pts.push({ x: fig.x, z: fig.z });
      }
    }
    for (const pr of doc.props) {
      if (Math.hypot(pr.x - p.x, pr.z - p.z) < 25) {
        pts.push({ x: pr.x, z: pr.z });
      }
    }
    const v = this.drag?.frozen ?? this.fitPlan(pts, W, H);
    this.planView = v;
    const sx = (x: number): number => (x - v.ox) * v.scale;
    const sy = (z: number): number => (z - v.oy) * v.scale;

    // grid at a readable spacing
    const step = v.scale > 40 ? 0.5 : v.scale > 15 ? 1 : v.scale > 6 ? 2 : 5;
    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = Math.floor(v.ox / step) * step; x < v.ox + W / v.scale; x += step) {
      ctx.moveTo(Math.round(sx(x)) + 0.5, 0);
      ctx.lineTo(Math.round(sx(x)) + 0.5, H);
    }
    for (let z = Math.floor(v.oy / step) * step; z < v.oy + H / v.scale; z += step) {
      ctx.moveTo(0, Math.round(sy(z)) + 0.5);
      ctx.lineTo(W, Math.round(sy(z)) + 0.5);
    }
    ctx.stroke();

    // depth of field band and focus plane
    const cam = doc.camera;
    const r = Math.hypot(W, H) / v.scale + 5;
    const left = { x: Math.sin(p.yaw * DEG + fov.h / 2), z: Math.cos(p.yaw * DEG + fov.h / 2) };
    const right = { x: Math.sin(p.yaw * DEG - fov.h / 2), z: Math.cos(p.yaw * DEG - fov.h / 2) };
    const coneAt = (d: number): [number, number, number, number] => {
      const k = d / Math.cos(fov.h / 2);
      return [p.x + left.x * k, p.z + left.z * k, p.x + right.x * k, p.z + right.z * k];
    };
    if (cam.dof) {
      const dof = depthOfField(p.lens / 1000, cam.fstop, focus);
      const near = Math.min(dof.near, r);
      const far = Math.min(dof.far, r);
      const [a1x, a1z, b1x, b1z] = coneAt(near);
      const [a2x, a2z, b2x, b2z] = coneAt(far);
      ctx.fillStyle = 'rgba(127,179,230,0.16)';
      ctx.beginPath();
      ctx.moveTo(sx(a1x), sy(a1z));
      ctx.lineTo(sx(a2x), sy(a2z));
      ctx.lineTo(sx(b2x), sy(b2z));
      ctx.lineTo(sx(b1x), sy(b1z));
      ctx.closePath();
      ctx.fill();
    }
    // view cone
    const [lx, lz, rx, rz] = coneAt(r);
    ctx.fillStyle = 'rgba(240,180,106,0.10)';
    ctx.beginPath();
    ctx.moveTo(sx(p.x), sy(p.z));
    ctx.lineTo(sx(lx), sy(lz));
    ctx.lineTo(sx(rx), sy(rz));
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(240,180,106,0.7)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(sx(p.x), sy(p.z));
    ctx.lineTo(sx(lx), sy(lz));
    ctx.moveTo(sx(p.x), sy(p.z));
    ctx.lineTo(sx(rx), sy(rz));
    ctx.stroke();
    // focus plane
    const [fa, fb, fc, fd] = coneAt(focus);
    ctx.strokeStyle = BLUE;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(sx(fa), sy(fb));
    ctx.lineTo(sx(fc), sy(fd));
    ctx.stroke();
    ctx.setLineDash([]);

    // props
    ctx.fillStyle = 'rgba(154,163,173,0.55)';
    for (const pr of doc.props) {
      ctx.save();
      ctx.translate(sx(pr.x), sy(pr.z));
      ctx.rotate(-pr.facing * DEG);
      ctx.fillRect((-pr.size[0] / 2) * v.scale, (-pr.size[2] / 2) * v.scale, pr.size[0] * v.scale, pr.size[2] * v.scale);
      ctx.restore();
    }

    // figures: shoulders-width ellipse with a facing tick
    for (const fig of doc.figures) {
      const isSub = subject?.fig.id === fig.id;
      const yaw = facingDeg(doc, fig) * DEG;
      const bp = bodyParams(fig);
      const halfW = Math.max(3, bp.height * 0.13 * v.scale);
      ctx.save();
      ctx.translate(sx(fig.x), sy(fig.z));
      ctx.rotate(-yaw);
      ctx.fillStyle = isSub ? ACCENT : 'rgba(127,179,230,0.8)';
      ctx.beginPath();
      ctx.ellipse(0, 0, halfW, halfW * 0.55, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = isSub ? ACCENT : 'rgba(127,179,230,0.8)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(0, halfW * 1.6);
      ctx.stroke();
      ctx.restore();
    }

    // distance to subject
    if (subject !== null) {
      ctx.strokeStyle = 'rgba(240,180,106,0.85)';
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(sx(p.x), sy(p.z));
      ctx.lineTo(sx(subject.fig.x), sy(subject.fig.z));
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = TEXT;
      ctx.font = '10.5px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(fmtM(subject.dist), (sx(p.x) + sx(subject.fig.x)) / 2, (sy(p.z) + sy(subject.fig.z)) / 2 - 5);
      ctx.fillStyle = ACCENT;
      ctx.fillText(subject.fig.id, sx(subject.fig.x), sy(subject.fig.z) - 10);
    }

    this.drawCameraGlyph(ctx, sx(p.x), sy(p.z), Math.atan2(f.x, f.z), true);

    // scale bar
    ctx.fillStyle = MUTED;
    ctx.fillRect(8, H - 9, step * v.scale, 2);
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`${step} m`, 10 + step * v.scale, H - 5);
    ctx.textAlign = 'right';
    ctx.fillText('TOP', W - 6, 12);
  }

  /** Camera body with a lens pointing along `angle` (radians from +Z toward +X in plan). */
  private drawCameraGlyph(ctx: CanvasRenderingContext2D, x: number, y: number, angle: number, plan: boolean): void {
    ctx.save();
    ctx.translate(x, y);
    // plan: world +Z is screen down; side: angle is the tilt, 0 = pointing right
    ctx.rotate(plan ? -angle : -angle);
    ctx.fillStyle = TEXT;
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 1;
    if (plan) {
      ctx.fillRect(-6, -9, 12, 9);
      ctx.strokeRect(-6, -9, 12, 9);
      ctx.beginPath();
      ctx.moveTo(-3, 0);
      ctx.lineTo(3, 0);
      ctx.lineTo(5, 6);
      ctx.lineTo(-5, 6);
      ctx.closePath();
    } else {
      ctx.fillRect(-10, -5, 10, 10);
      ctx.strokeRect(-10, -5, 10, 10);
      ctx.beginPath();
      ctx.moveTo(0, -3);
      ctx.lineTo(6, -5);
      ctx.lineTo(6, 5);
      ctx.lineTo(0, 3);
      ctx.closePath();
    }
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  private drawSide(subject: Subject | null): void {
    const c = this.side;
    const ctx = setupCanvas(c);
    if (ctx === null) {
      return;
    }
    const W = c.clientWidth;
    const H = c.clientHeight;
    const doc = this.host.getDoc();
    const p = this.pose();
    const f = this.forward();
    const fov = this.host.viewport.frameFov();
    // figures in front of the camera, with their distance along the view direction
    const inView: { fig: Figure; d: number; h: number }[] = [];
    for (const fig of doc.figures) {
      const dx = fig.x - p.x;
      const dz = fig.z - p.z;
      const d = dx * f.x + dz * f.z;
      const lat = Math.abs(dx * -f.z + dz * f.x);
      if (d > 0.1 && lat < d * Math.tan(fov.h / 2) + 0.5) {
        inView.push({ fig, d, h: bodyParams(fig).height + fig.elevation });
      }
    }
    const maxD = Math.max(3, subject?.dist ?? 0, ...inView.map((q) => q.d)) * 1.15;
    const maxY = Math.max(2, p.y, ...inView.map((q) => q.h)) * 1.2;
    const scaleTarget = Math.min((W - 36) / maxD, (H - 14) / maxY);
    const target: View2D = { scale: scaleTarget, ox: -30 / scaleTarget, oy: (H - 10) / scaleTarget };
    const cur = this.sideView;
    const v = this.drag?.frozen ?? {
      scale: cur.scale + (target.scale - cur.scale) * 0.15,
      ox: cur.ox + (target.ox - cur.ox) * 0.15,
      oy: cur.oy + (target.oy - cur.oy) * 0.15,
    };
    this.sideView = v;
    const sx = (d: number): number => (d - v.ox) * v.scale;
    const sy = (y: number): number => (v.oy - y) * v.scale;

    // ground
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    ctx.fillRect(0, sy(0), W, H - sy(0));
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath();
    ctx.moveTo(0, sy(0) + 0.5);
    ctx.lineTo(W, sy(0) + 0.5);
    ctx.stroke();

    // vertical view cone
    const pitch = p.pitch * DEG;
    const len = (W + H) / v.scale;
    const top = pitch + fov.v / 2;
    const bot = pitch - fov.v / 2;
    ctx.fillStyle = 'rgba(240,180,106,0.10)';
    ctx.beginPath();
    ctx.moveTo(sx(0), sy(p.y));
    ctx.lineTo(sx(Math.cos(top) * len), sy(p.y + Math.sin(top) * len));
    ctx.lineTo(sx(Math.cos(bot) * len), sy(p.y + Math.sin(bot) * len));
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(240,180,106,0.7)';
    ctx.beginPath();
    ctx.moveTo(sx(0), sy(p.y));
    ctx.lineTo(sx(Math.cos(top) * len), sy(p.y + Math.sin(top) * len));
    ctx.moveTo(sx(0), sy(p.y));
    ctx.lineTo(sx(Math.cos(bot) * len), sy(p.y + Math.sin(bot) * len));
    ctx.stroke();

    // horizon / eye level of the camera
    ctx.strokeStyle = 'rgba(240,180,106,0.9)';
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(0, sy(p.y) + 0.5);
    ctx.lineTo(W, sy(p.y) + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = ACCENT;
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText('horizon (eye level)', W - 5, sy(p.y) - 3);

    // figure silhouettes at true height
    for (const q of inView.sort((a, b) => b.d - a.d)) {
      const isSub = subject?.fig.id === q.fig.id;
      const hgt = q.h - q.fig.elevation;
      const x = sx(q.d);
      const base = sy(q.fig.elevation);
      const s = v.scale;
      ctx.fillStyle = isSub ? 'rgba(240,180,106,0.9)' : 'rgba(127,179,230,0.55)';
      const headR = hgt * 0.065 * s;
      ctx.beginPath();
      ctx.arc(x, base - hgt * 0.935 * s, headR, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.roundRect(x - hgt * 0.1 * s, base - hgt * 0.86 * s, hgt * 0.2 * s, hgt * 0.38 * s, headR * 0.6);
      ctx.fill();
      ctx.fillRect(x - hgt * 0.075 * s, base - hgt * 0.5 * s, hgt * 0.15 * s, hgt * 0.5 * s);
    }

    // camera height dimension
    const camX = sx(0);
    ctx.strokeStyle = MUTED;
    ctx.beginPath();
    ctx.moveTo(camX - 12.5, sy(0));
    ctx.lineTo(camX - 12.5, sy(p.y));
    ctx.stroke();
    ctx.save();
    ctx.translate(camX - 15, (sy(0) + sy(p.y)) / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = TEXT;
    ctx.textAlign = 'center';
    ctx.fillText(fmtM(p.y), 0, 0);
    ctx.restore();

    this.drawCameraGlyph(ctx, camX, sy(p.y), pitch, false);
    ctx.fillStyle = MUTED;
    ctx.textAlign = 'right';
    ctx.fillText('SIDE', W - 6, H - 4);
  }

  private updateText(subject: Subject | null): void {
    const doc = this.host.getDoc();
    const cam = doc.camera;
    const p = this.pose();
    const fov = this.host.viewport.frameFov();
    const focus = this.host.viewport.focusDistance();
    const dof = depthOfField(p.lens / 1000, cam.fstop, focus);

    // plain-language shot description
    let angle: string;
    if (p.pitch < -60) {
      angle = "Bird's-eye view";
    } else if (p.pitch > 50) {
      angle = "Worm's-eye view";
    } else if (subject !== null && p.y > subject.eye + 0.25 && p.pitch < -3) {
      angle = 'High angle';
    } else if (subject !== null && p.y < subject.eye - 0.3 && p.pitch > 3) {
      angle = 'Low angle';
    } else if (p.pitch < -20) {
      angle = 'High angle';
    } else if (p.pitch > 20) {
      angle = 'Low angle';
    } else {
      angle = 'Eye level';
    }
    if (Math.abs(cam.roll) > 3) {
      angle += ', dutch tilt';
    }
    let shot = '';
    if (subject !== null) {
      const frameH = 2 * subject.dist * Math.tan(fov.v / 2);
      const r = frameH / subject.height;
      const size = r >= 2.5 ? 'long shot' : r >= 1.05 ? 'full shot' : r >= 0.7 ? 'medium-full shot' : r >= 0.45 ? 'medium shot' : r >= 0.22 ? 'close-up' : 'extreme close-up';
      shot = `, ${size} of ${subject.fig.id}`;
    }
    const text = `${angle}${shot}`;
    if (this.shotEl.textContent !== text) {
      this.shotEl.textContent = text;
    }

    const cell = (label: string, value: string): string => `<div><span>${label}</span><b>${value}</b></div>`;
    const html = [
      cell('Lens', `${Math.round(p.lens)} mm`),
      cell('Field of view', `${Math.round(fov.h / DEG)} x ${Math.round(fov.v / DEG)} deg`),
      cell('Aperture', cam.dof ? `f/${cam.fstop}` : `f/${cam.fstop} (no blur)`),
      cell('Height', fmtM(p.y)),
      cell('Tilt', `${p.pitch >= 0 ? '+' : ''}${p.pitch.toFixed(0)} deg`),
      cell('Roll', `${cam.roll.toFixed(0)} deg`),
      cell('Subject', subject === null ? '-' : fmtM(subject.dist)),
      cell('Focus', fmtM(focus)),
      cell('In focus', `${fmtM(dof.near)} - ${fmtM(dof.far)}`),
    ].join('');
    if (html !== this.lastReadout) {
      this.lastReadout = html;
      this.readout.innerHTML = html;
    }
  }
}
