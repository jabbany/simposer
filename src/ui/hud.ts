// Heads-up display with two modes, designed so the reference view stays clean:
//
//   Look mode (mouse captured): no interface at all. Moving the mouse looks
//     around; a small aim dot and the name of the figure under it appear only
//     while the mouse moves. WASD walks, click selects, P takes a snapshot.
//   Interact mode (mouse free; Esc, holding Ctrl, opening a window or the
//     chat): panels appear around the edges without covering the picture:
//     selected figure, camera rig diagram, chat, pose action bar, snapshot.
//     Click empty scene (or "Look") to go back to look mode.
//
// Releasing Ctrl while the cursor is over a panel keeps interact mode, so
// panels can be clicked without holding Ctrl (macOS turns Ctrl+click into a
// right-click).

import { Vector2 } from 'three';
import type { SceneDoc } from '../dsl/types.ts';
import { poseName } from '../pose/lang/ast.ts';
import { libraryFor } from '../pose/lang/library.ts';
import type { Viewport } from '../render/viewport.ts';
import { isEditable } from '../render/cameraController.ts';
import { CameraRig } from './cameraRig.ts';
import { h } from './dom.ts';

export type Tab = 'figure' | 'camera' | 'scene' | 'settings';

export interface HudHost {
  readonly viewport: Viewport;
  getDoc(): SceneDoc;
  getSelection(): { figure: string | null; part: string | null };
  select(figure: string | null, part: string | null): void;
  applyPreset(preset: string): void;
  addFigureAt(x: number, z: number): void;
  grabMove(x: number, z: number): void;
  grabRotate(deg: number): void;
  grabEnd(cancel: boolean): void;
  deleteSelected(): void;
  frameSelected(): void;
  undo(): void;
  redo(): void;
  send(): Promise<void>;
  snapshot(): Promise<void>;
  renderPanel(): void;
  /** called when switching between look and interact mode */
  onModeChange(interacting: boolean): void;
  status(message: string, isError: boolean): void;
}

interface Slot {
  key: string;
  code: string;
  label: string;
  preset?: string;
  action?: () => void;
  needsTarget: boolean;
  utility?: boolean;
}

const DEG = Math.PI / 180;

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (el === null) {
    throw new Error(`missing #${id}`);
  }
  return el;
}

const CONTROLS: [string, string][] = [
  ['Click scene', 'look around (mouse captured); click again to select a figure'],
  ['Esc', 'free the mouse and show the panels'],
  ['hold Ctrl', 'free the mouse while held'],
  ['W A S D', 'walk the camera, Shift faster'],
  ['Q / E', 'down / up'],
  ['Arrows', 'slow, precise moves (Alt + arrows: precise turning)'],
  ['Wheel', 'zoom the lens (Alt + wheel: dolly)'],
  ['P', 'snapshot: save the framed view as an image'],
  ['Enter', 'describe a scene or change in plain words'],
  ['1 - 9', 'pose the selected figure'],
  ['N / G / F / Del', 'add a figure / move it / frame it / remove it'],
  ['Tab', 'select the next figure'],
  ['C V J O', 'figure, camera, script, settings windows'],
  ['Ctrl+Z', 'undo (Ctrl+Shift+Z redo)'],
  ['H', 'show or hide this help'],
];

export class Hud {
  tab: Tab | null = null;
  private readonly host: HudHost;
  private readonly rig: CameraRig;
  private readonly canvas: HTMLCanvasElement;
  private readonly lockSupported: boolean;
  private captured = false;
  private intentionalRelease = false;
  private ctrlHeld = false;
  private overInteractive = false;
  private rightDrag = false;
  private touchDrag: { x: number; y: number; moved: number } | null = null;
  private grabbing = false;
  private chatActive = false;
  private lastMouse = new Vector2(0, 0);
  private lastMouseClient = { x: 0, y: 0 };
  private aimTimer = 0;
  private grabTimer = 0;
  private rigTimer = 0;
  private lastLookMove = 0;
  private readonly slots: Slot[];

  private readonly prompt = $('prompt') as HTMLTextAreaElement;
  private readonly chat = $('chat');
  private readonly windowEl = $('window');
  private readonly aimLabel = $('aim-label');
  private readonly crosshair = $('crosshair');
  private readonly hints = $('hints');
  private readonly actionbar = $('actionbar');
  private readonly help = $('help');
  private readonly flash = $('flash');

  constructor(host: HudHost) {
    this.host = host;
    this.canvas = host.viewport.renderer.domElement;
    this.lockSupported = 'requestPointerLock' in HTMLElement.prototype && window.matchMedia('(pointer: fine)').matches;
    this.rig = new CameraRig(host);
    this.slots = [
      { key: '1', code: 'Digit1', label: 'Stand', preset: 'stand', needsTarget: true },
      { key: '2', code: 'Digit2', label: 'Walk', preset: 'walk', needsTarget: true },
      { key: '3', code: 'Digit3', label: 'Run', preset: 'run', needsTarget: true },
      { key: '4', code: 'Digit4', label: 'Sit', preset: 'sit_chair', needsTarget: true },
      { key: '5', code: 'Digit5', label: 'Crouch', preset: 'crouch', needsTarget: true },
      { key: '6', code: 'Digit6', label: 'Kneel', preset: 'kneel', needsTarget: true },
      { key: '7', code: 'Digit7', label: 'Point', preset: 'point', needsTarget: true },
      { key: '8', code: 'Digit8', label: 'Wave', preset: 'wave', needsTarget: true },
      { key: '9', code: 'Digit9', label: 'Arms crossed', preset: 'arms_crossed', needsTarget: true },
      { key: 'N', code: 'KeyN', label: 'Add figure', action: () => this.addFigure(), needsTarget: false, utility: true },
      { key: 'G', code: 'KeyG', label: 'Move', action: () => this.toggleGrab(), needsTarget: true, utility: true },
      { key: 'F', code: 'KeyF', label: 'Frame', action: () => this.host.frameSelected(), needsTarget: true, utility: true },
      { key: 'Del', code: 'Delete', label: 'Remove', action: () => this.host.deleteSelected(), needsTarget: true, utility: true },
    ];
    this.help.append(h('table', {}, ...CONTROLS.map(([k, v]) => h('tr', {}, h('td', {}, k), h('td', {}, v)))));
    this.bind();
    this.renderActionBar();
    this.updateMode();
  }

  // ------------------------------------------------------------ capture

  private requestCapture(): void {
    if (!this.lockSupported || this.captured) {
      return;
    }
    try {
      const r = this.canvas.requestPointerLock() as unknown;
      if (r instanceof Promise) {
        r.catch(() => this.updateMode());
      }
    } catch {
      this.updateMode();
    }
  }

  private release(): void {
    if (this.captured) {
      this.intentionalRelease = true;
      document.exitPointerLock();
    }
  }

  private onLockChange(): void {
    const was = this.captured;
    this.captured = document.pointerLockElement === this.canvas;
    if (this.captured) {
      this.help.classList.add('hidden');
      this.host.viewport.controller.releaseKeys();
    }
    this.intentionalRelease = false;
    if (was !== this.captured) {
      this.aimLabel.classList.remove('show');
      this.crosshair.classList.remove('on-target');
      this.host.onModeChange(!this.captured);
    }
    this.updateMode();
  }

  get interacting(): boolean {
    return !this.captured;
  }

  private updateMode(): void {
    document.body.classList.toggle('captured', this.captured);
    document.body.classList.toggle('window-open', this.tab !== null);
    const sel = this.host.getSelection().figure;
    let text: string;
    if (this.grabbing) {
      text = '<b>Moving</b>: aim to place, <b>wheel</b> rotates, <b>click</b> or <b>G</b> drops, <b>Esc</b> cancels';
    } else if (!this.lockSupported) {
      text = '<b>Drag</b> to look around, <b>tap</b> a figure to select it';
    } else {
      text = '<b>Click the scene</b> to look around &middot; <b>Enter</b> describe a change &middot; <b>H</b> help';
      if (sel === null) {
        text += ' &middot; <b>N</b> add a figure';
      }
    }
    this.hints.innerHTML = text;
    for (const el of this.actionbar.querySelectorAll<HTMLElement>('.slot')) {
      el.classList.toggle('disabled', el.dataset['needsTarget'] === '1' && sel === null);
    }
  }

  // ------------------------------------------------------------ windows and chat

  openWindow(tab: Tab): void {
    this.tab = tab;
    this.windowEl.classList.remove('hidden');
    for (const b of this.windowEl.querySelectorAll<HTMLButtonElement>('#tabs button')) {
      b.classList.toggle('active', b.dataset['tab'] === tab);
    }
    this.release();
    this.host.renderPanel();
    this.updateMode();
  }

  closeWindow(): void {
    this.tab = null;
    this.windowEl.classList.add('hidden');
    this.updateMode();
  }

  private toggleWindow(tab: Tab): void {
    if (this.tab === tab) {
      this.closeWindow();
    } else {
      this.openWindow(tab);
    }
  }

  openChat(): void {
    this.chatActive = true;
    this.release();
    this.host.viewport.controller.releaseKeys();
    this.prompt.focus();
  }

  private closeChat(): void {
    this.chatActive = false;
    this.prompt.blur();
    this.updateMode();
  }

  private toggleHelp(): void {
    this.help.classList.toggle('hidden');
    if (!this.help.classList.contains('hidden')) {
      this.release();
    }
  }

  // ------------------------------------------------------------ actions

  private selectedOrWarn(): string | null {
    const sel = this.host.getSelection().figure;
    if (sel === null) {
      this.host.status('Select a figure first: aim at it and click (or press Tab).', true);
    }
    return sel;
  }

  private runSlot(s: Slot): void {
    if (s.needsTarget && this.selectedOrWarn() === null) {
      return;
    }
    if (s.preset !== undefined) {
      this.host.applyPreset(s.preset);
    } else {
      s.action?.();
    }
  }

  private aimNdc(): Vector2 {
    return this.captured || !this.lockSupported ? new Vector2(0, 0) : this.lastMouse.clone();
  }

  private addFigure(): void {
    const vp = this.host.viewport;
    const hit = vp.groundAt(this.aimNdc(), 30);
    const cam = vp.controller.pose;
    // no ground under the aim point (looking up): place 3 m ahead
    const x = hit?.x ?? cam.x + Math.sin(cam.yaw * DEG) * 3;
    const z = hit?.z ?? cam.z + Math.cos(cam.yaw * DEG) * 3;
    this.host.addFigureAt(x, z);
  }

  private toggleGrab(): void {
    if (this.grabbing) {
      this.grabbing = false;
      this.host.grabEnd(false);
    } else if (this.selectedOrWarn() !== null) {
      this.grabbing = true;
    }
    this.updateMode();
  }

  private cycleTarget(dir: 1 | -1): void {
    const doc = this.host.getDoc();
    if (doc.figures.length === 0) {
      return;
    }
    const cam = this.host.viewport.controller.pose;
    // order by angle from the view direction so Tab starts with what you look at
    const scored = doc.figures.map((f) => {
      const a = Math.atan2(f.x - cam.x, f.z - cam.z) / DEG;
      const d = Math.abs(((a - cam.yaw + 540) % 360) - 180) + Math.hypot(f.x - cam.x, f.z - cam.z) * 0.5;
      return { id: f.id, d };
    }).sort((a, b) => a.d - b.d);
    const cur = this.host.getSelection().figure;
    const i = scored.findIndex((s) => s.id === cur);
    const next = scored[(i + dir + scored.length) % scored.length] ?? scored[0];
    if (next !== undefined) {
      this.host.select(next.id, null);
    }
  }

  async snapshot(): Promise<void> {
    this.flash.classList.remove('go');
    void this.flash.offsetWidth; // restart the animation
    this.flash.classList.add('go');
    await this.host.snapshot();
  }

  // ------------------------------------------------------------ input

  private bind(): void {
    document.addEventListener('pointerlockchange', () => this.onLockChange());
    document.addEventListener('pointerlockerror', () => {
      this.host.status('Could not capture the mouse; click the scene to try again.', true);
      this.updateMode();
    });

    document.addEventListener('mousemove', (e) => {
      if (this.captured) {
        this.host.viewport.controller.look(e.movementX, e.movementY);
        this.lastLookMove = performance.now();
        return;
      }
      this.lastMouse = this.host.viewport.ndcFromClient(e.clientX, e.clientY);
      this.lastMouseClient = { x: e.clientX, y: e.clientY };
      const t = e.target instanceof Element ? e.target : null;
      this.overInteractive = t !== null && t.closest('#interact > *, .name-tag, .part-label') !== null;
      if (this.rightDrag) {
        this.host.viewport.controller.look(e.movementX, e.movementY);
      }
    });
    this.canvas.addEventListener('mousedown', (e) => {
      if (!this.lockSupported) {
        return;
      }
      if (e.button === 2) {
        if (this.captured) {
          // right click: inspect what is under the aim point
          const hit = this.host.viewport.pickAt(new Vector2(0, 0));
          if (hit !== null) {
            this.host.select(hit.figure, hit.part);
            this.openWindow('figure');
          }
        } else {
          this.rightDrag = true;
        }
        return;
      }
      if (e.button !== 0) {
        return;
      }
      if (this.grabbing) {
        this.toggleGrab();
        return;
      }
      if (this.captured) {
        const hit = this.host.viewport.pickAt(new Vector2(0, 0));
        this.host.select(hit?.figure ?? null, hit?.part ?? null);
        return;
      }
      // interact mode: click a figure to select it, click empty space to look around
      const hit = this.host.viewport.pickAt(this.host.viewport.ndcFromClient(e.clientX, e.clientY));
      if (hit !== null && !e.ctrlKey) {
        this.host.select(hit.figure, hit.part);
      } else if (hit === null) {
        if (this.chatActive) {
          this.closeChat();
        }
        this.requestCapture();
      }
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 2) {
        this.rightDrag = false;
      }
    });
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (this.grabbing) {
        this.host.grabRotate(e.deltaY > 0 ? -10 : 10);
      } else if (e.altKey) {
        this.host.viewport.controller.dolly(-e.deltaY * 0.004);
      } else {
        this.host.viewport.controller.zoom(e.deltaY);
      }
    }, { passive: false });

    // touch / no pointer lock: drag to look, tap to select
    this.canvas.addEventListener('pointerdown', (e) => {
      if (this.lockSupported) {
        return;
      }
      this.touchDrag = { x: e.clientX, y: e.clientY, moved: 0 };
      this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (this.touchDrag === null) {
        return;
      }
      const dx = e.clientX - this.touchDrag.x;
      const dy = e.clientY - this.touchDrag.y;
      this.touchDrag = { x: e.clientX, y: e.clientY, moved: this.touchDrag.moved + Math.abs(dx) + Math.abs(dy) };
      this.host.viewport.controller.look(-dx, -dy);
    });
    this.canvas.addEventListener('pointerup', (e) => {
      if (this.touchDrag === null) {
        return;
      }
      if (this.touchDrag.moved < 6) {
        const hit = this.host.viewport.pickAt(this.host.viewport.ndcFromClient(e.clientX, e.clientY));
        this.host.select(hit?.figure ?? null, hit?.part ?? null);
      }
      this.touchDrag = null;
    });

    // macOS turns Ctrl+click into a context-menu click; treat it as a normal click on controls
    document.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!e.ctrlKey || this.captured) {
        return;
      }
      const t = e.target instanceof Element ? e.target.closest('button, summary, input[type=checkbox], select, .name-tag, .part-label') : null;
      if (t instanceof HTMLSelectElement) {
        t.focus();
      } else if (t instanceof HTMLElement) {
        t.click();
      }
    });

    window.addEventListener('keydown', (e) => this.onKeyDown(e));
    window.addEventListener('keyup', (e) => {
      if (e.key === 'Control' && this.ctrlHeld) {
        this.ctrlHeld = false;
        const typing = isEditable(document.activeElement);
        if (!this.overInteractive && !typing && this.tab === null && !this.chatActive) {
          this.requestCapture();
        }
        this.updateMode();
      }
    });
    window.addEventListener('blur', () => {
      this.ctrlHeld = false;
      this.rightDrag = false;
    });

    // chat box
    this.prompt.addEventListener('focus', () => {
      this.chatActive = true;
    });
    this.prompt.addEventListener('blur', () => {
      this.chatActive = false;
    });
    this.prompt.addEventListener('input', () => {
      this.prompt.style.height = 'auto';
      this.prompt.style.height = `${Math.min(140, this.prompt.scrollHeight)}px`;
    });
    this.prompt.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        if (this.prompt.value.trim().length > 0) {
          void this.host.send();
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.closeChat();
      }
    });
    $('send').addEventListener('click', () => void this.host.send());
    $('undo').addEventListener('click', () => this.host.undo());
    $('redo').addEventListener('click', () => this.host.redo());
    $('history-btn').addEventListener('click', () => {
      this.chat.classList.toggle('expanded');
      const log = $('chat-log');
      log.scrollTop = log.scrollHeight;
    });
    $('snapshot').addEventListener('click', () => void this.snapshot());
    $('look-btn').addEventListener('click', () => this.requestCapture());
    $('help-btn').addEventListener('click', () => this.toggleHelp());

    for (const b of this.windowEl.querySelectorAll<HTMLButtonElement>('#tabs button')) {
      b.addEventListener('click', () => this.openWindow((b.dataset['tab'] ?? 'figure') as Tab));
    }
    $('window-close').addEventListener('click', () => this.closeWindow());
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Control') {
      if (!this.ctrlHeld) {
        this.ctrlHeld = true;
        this.release();
        this.updateMode();
      }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') {
      if (isEditable(e.target)) {
        return;
      }
      e.preventDefault();
      if (e.shiftKey) {
        this.host.redo();
      } else {
        this.host.undo();
      }
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey || isEditable(e.target)) {
      return;
    }
    switch (e.code) {
      case 'Enter':
      case 'NumpadEnter':
        e.preventDefault();
        this.openChat();
        return;
      case 'Escape':
        if (this.grabbing) {
          this.grabbing = false;
          this.host.grabEnd(true);
          this.updateMode();
        } else if (!this.help.classList.contains('hidden')) {
          this.help.classList.add('hidden');
        } else if (this.tab !== null) {
          this.closeWindow();
        } else if (this.host.getSelection().figure !== null) {
          this.host.select(null, null);
        }
        return;
      case 'Tab':
        e.preventDefault();
        this.cycleTarget(e.shiftKey ? -1 : 1);
        return;
      case 'KeyP':
        void this.snapshot();
        return;
      case 'KeyH':
        this.toggleHelp();
        return;
      case 'KeyC':
        this.toggleWindow('figure');
        return;
      case 'KeyV':
        this.toggleWindow('camera');
        return;
      case 'KeyJ':
        this.toggleWindow('scene');
        return;
      case 'KeyO':
        this.toggleWindow('settings');
        return;
      case 'Backspace':
        this.host.deleteSelected();
        return;
      default: {
        const s = this.slots.find((x) => x.code === e.code);
        if (s !== undefined) {
          e.preventDefault();
          this.runSlot(s);
        }
      }
    }
  }

  // ------------------------------------------------------------ rendering

  private renderActionBar(): void {
    const els: HTMLElement[] = [];
    const lib = libraryFor(this.host.getDoc().poses);
    this.slots.forEach((s, i) => {
      if (s.utility === true && this.slots[i - 1]?.utility !== true) {
        els.push(h('div', { class: 'slot-sep' }));
      }
      const desc = s.preset !== undefined ? lib.get(s.preset)?.description ?? s.label : s.label;
      els.push(h('button', {
        class: `slot${s.utility === true ? ' utility' : ''}`,
        title: `${desc} (${s.key})`,
        'data-preset': s.preset ?? '',
        'data-needs-target': s.needsTarget ? '1' : '0',
        onclick: () => this.runSlot(s),
      }, h('span', { class: 'k' }, s.key), s.label));
    });
    this.actionbar.replaceChildren(...els);
  }

  /** Called by the app whenever the document or selection changes. */
  refresh(): void {
    const sel = this.host.getSelection().figure;
    const fig = this.host.getDoc().figures.find((f) => f.id === sel);
    for (const el of this.actionbar.querySelectorAll<HTMLElement>('.slot')) {
      el.classList.toggle('active', fig !== undefined && el.dataset['preset'] === poseName(fig.pose));
    }
    this.updateMode();
  }

  /** Per-frame update from the viewport loop. */
  onFrame(dt: number): void {
    // the aim dot shows only briefly after the mouse moves in look mode
    const recent = performance.now() - this.lastLookMove < 1200;
    this.crosshair.classList.toggle('show', this.captured && (recent || this.grabbing));
    this.aimTimer -= dt;
    if (this.aimTimer <= 0) {
      this.aimTimer = 0.1;
      this.updateAim(recent);
    }
    if (this.grabbing) {
      this.grabTimer -= dt;
      if (this.grabTimer <= 0) {
        this.grabTimer = 0.06;
        const p = this.host.viewport.groundAt(this.aimNdc(), 30);
        if (p !== null) {
          this.host.grabMove(p.x, p.z);
        }
      }
    }
    if (!this.captured) {
      this.rigTimer -= dt;
      if (this.rigTimer <= 0) {
        this.rigTimer = 1 / 30;
        this.rig.update();
      }
    }
  }

  private updateAim(recent: boolean): void {
    const vp = this.host.viewport;
    const usable = this.captured ? recent : this.lockSupported && !this.overInteractive;
    const hit = usable && !this.grabbing ? vp.pickAt(this.aimNdc()) : null;
    this.crosshair.classList.toggle('on-target', hit !== null);
    this.aimLabel.classList.toggle('show', hit !== null);
    if (hit === null) {
      return;
    }
    if (this.captured) {
      this.aimLabel.style.left = '50%';
      this.aimLabel.style.top = 'calc(50% + 16px)';
    } else {
      this.aimLabel.style.left = `${this.lastMouseClient.x}px`;
      this.aimLabel.style.top = `${this.lastMouseClient.y + 20}px`;
    }
    const part = hit.part === null ? '' : ` ${String.fromCharCode(183)} ${hit.part.replace(/_/g, ' ')}`; // middle dot
    this.aimLabel.replaceChildren(h('b', {}, hit.figure), part);
  }
}
