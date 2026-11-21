// First-person camera movement (the "player" of the HUD):
//   W/A/S/D walk, Q/E down/up, Shift = faster
//   Arrow keys = slow, precise moves (Up/Down forward/back, Left/Right strafe)
//   Alt + arrows = slow, precise turning
// Looking around comes from the HUD (pointer-locked mouse) via look().
// Changes are reported continuously via onChange and, once input settles,
// via onCommit so the app can record them in the scene document.

const DEG = Math.PI / 180;

export interface CameraPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  lens: number;
}

export interface CameraControllerEvents {
  onChange: () => void;
  onCommit: (pose: CameraPose, rotated: boolean) => void;
}

export function isEditable(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) {
    return false;
  }
  return t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT';
}

const MOVE_KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];

export class CameraController {
  pose: CameraPose = { x: 0, y: 1.5, z: 6, yaw: 180, pitch: 0, lens: 35 };
  /** set by the viewport: true while the camera aim follows a target */
  aimLocked = false;
  /** mouse look sensitivity in degrees per pixel at 35mm */
  sensitivity = 0.11;
  private readonly keys = new Set<string>();
  private dirty = false;
  private rotated = false;
  private settleTimer: number | null = null;
  private readonly events: CameraControllerEvents;

  constructor(events: CameraControllerEvents) {
    this.events = events;
    window.addEventListener('keydown', (e) => {
      if (isEditable(e.target) || e.metaKey || e.ctrlKey) {
        return;
      }
      if (MOVE_KEYS.includes(e.code)) {
        this.keys.add(e.code);
        e.preventDefault();
      }
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
        this.keys.add('Shift');
      }
      if (e.code === 'AltLeft' || e.code === 'AltRight') {
        this.keys.add('Alt');
      }
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
        this.keys.delete('Shift');
      }
      if (e.code === 'AltLeft' || e.code === 'AltRight') {
        this.keys.delete('Alt');
      }
    });
    window.addEventListener('blur', () => this.keys.clear());
  }

  /** Stop all keyboard movement (e.g. when a text field takes focus). */
  releaseKeys(): void {
    this.keys.clear();
  }

  /** Mouse look in screen pixels. Narrow lenses turn slower, like a real camera. */
  look(dx: number, dy: number): void {
    if (dx === 0 && dy === 0) {
      return;
    }
    const sens = this.sensitivity * Math.sqrt(35 / this.pose.lens);
    this.pose.yaw -= dx * sens;
    this.pose.pitch = Math.max(-89, Math.min(89, this.pose.pitch - dy * sens));
    this.aimLocked = false;
    this.touch(true);
  }

  /** Set part of the pose directly (camera rig widget drags). */
  setPose(patch: Partial<CameraPose>): void {
    const rotated = patch.yaw !== undefined || patch.pitch !== undefined;
    Object.assign(this.pose, patch);
    this.pose.y = Math.max(0.05, this.pose.y);
    this.pose.pitch = Math.max(-89, Math.min(89, this.pose.pitch));
    if (rotated) {
      this.aimLocked = false;
    }
    this.touch(rotated);
  }

  /** Mouse wheel: zoom the lens. */
  zoom(deltaY: number): void {
    this.pose.lens = Math.max(10, Math.min(300, this.pose.lens * Math.exp(-deltaY * 0.0012)));
    this.touch(false);
  }

  /** Move along the view direction (horizontal). */
  dolly(meters: number): void {
    const f = this.forward();
    this.pose.x += f.x * meters;
    this.pose.z += f.z * meters;
    this.touch(false);
  }

  private forward(): { x: number; z: number } {
    return { x: Math.sin(this.pose.yaw * DEG), z: Math.cos(this.pose.yaw * DEG) };
  }

  private touch(rotated: boolean): void {
    this.dirty = true;
    this.rotated = this.rotated || rotated;
    this.events.onChange();
    if (this.settleTimer !== null) {
      window.clearTimeout(this.settleTimer);
    }
    this.settleTimer = window.setTimeout(() => this.settle(), 450);
  }

  private settle(): void {
    this.settleTimer = null;
    if ([...this.keys].some((k) => MOVE_KEYS.includes(k))) {
      this.settleTimer = window.setTimeout(() => this.settle(), 200);
      return;
    }
    if (this.dirty) {
      this.dirty = false;
      const rotated = this.rotated;
      this.rotated = false;
      this.events.onCommit({ ...this.pose }, rotated);
    }
  }

  /** Advance keyboard movement; returns true if the pose changed. */
  update(dt: number): boolean {
    if (this.keys.size === 0) {
      return false;
    }
    const k = (c: string): boolean => this.keys.has(c);
    const fast = k('Shift') ? 3 : 1;
    const walk = 2.2 * fast * dt;
    const fine = 0.35 * fast * dt;
    const fineTurn = 12 * fast * dt;
    const f = this.forward();
    const r = { x: -f.z, z: f.x }; // camera right
    let moved = false;
    let rotated = false;
    const move = (fx: number, rx: number, up: number, step: number): void => {
      this.pose.x += (f.x * fx + r.x * rx) * step;
      this.pose.z += (f.z * fx + r.z * rx) * step;
      this.pose.y = Math.max(0.05, this.pose.y + up * step * 0.7);
      moved = true;
    };
    if (k('KeyW')) {
      move(1, 0, 0, walk);
    }
    if (k('KeyS')) {
      move(-1, 0, 0, walk);
    }
    if (k('KeyD')) {
      move(0, 1, 0, walk);
    }
    if (k('KeyA')) {
      move(0, -1, 0, walk);
    }
    if (k('KeyE')) {
      move(0, 0, 1, walk);
    }
    if (k('KeyQ')) {
      move(0, 0, -1, walk);
    }
    if (k('Alt')) {
      if (k('ArrowLeft')) {
        this.pose.yaw += fineTurn;
        rotated = true;
      }
      if (k('ArrowRight')) {
        this.pose.yaw -= fineTurn;
        rotated = true;
      }
      if (k('ArrowUp')) {
        this.pose.pitch = Math.min(89, this.pose.pitch + fineTurn);
        rotated = true;
      }
      if (k('ArrowDown')) {
        this.pose.pitch = Math.max(-89, this.pose.pitch - fineTurn);
        rotated = true;
      }
    } else {
      if (k('ArrowUp')) {
        move(1, 0, 0, fine);
      }
      if (k('ArrowDown')) {
        move(-1, 0, 0, fine);
      }
      if (k('ArrowRight')) {
        move(0, 1, 0, fine);
      }
      if (k('ArrowLeft')) {
        move(0, -1, 0, fine);
      }
    }
    if (rotated) {
      this.aimLocked = false;
    }
    if (moved || rotated) {
      this.touch(rotated);
    }
    return moved || rotated;
  }
}
