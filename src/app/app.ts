// Application controller: owns the scene document, history and LLM settings,
// and connects the viewport with the game-style HUD (src/ui/hud.ts).

import { applyCommands } from '../dsl/apply.ts';
import type { ApplyContext } from '../dsl/apply.ts';
import { parseDelta } from '../dsl/commands.ts';
import { bodyParams, facingDeg, headingTo } from '../dsl/geometry.ts';
import { parseScene, serializeScene } from '../dsl/sceneText.ts';
import { fmt, normDeg } from '../dsl/tokens.ts';
import { emptyScene } from '../dsl/types.ts';
import type { Figure, SceneDoc } from '../dsl/types.ts';
import {
  BODY_PRESETS, GROUND_KINDS, HAND_SHAPES, JOINTS, RENDER_STYLES,
} from '../dsl/vocab.ts';
import type { BodyParams } from '../dsl/vocab.ts';
import { LlmError, PROVIDER_DEFAULTS, makeProvider } from '../llm/providers.ts';
import type { ProviderKind, ProviderSettings } from '../llm/providers.ts';
import { translate, validateDelta } from '../llm/translate.ts';
import { formatPoseExpr, poseArgNumber, poseName } from '../pose/lang/ast.ts';
import type { PoseExpr } from '../pose/lang/ast.ts';
import { libraryFor, wholeBodyPoses } from '../pose/lang/library.ts';
import { composePose } from '../pose/lang/compose.ts';
import type { ComposedPose } from '../pose/lang/compose.ts';
import { handShapeOf } from '../pose/lang/channels.ts';
import type { Catalog } from '../rig/catalog.ts';
import type { CameraPose } from '../render/cameraController.ts';
import { Viewport } from '../render/viewport.ts';
import { checkbox, h, selectField, slider } from '../ui/dom.ts';
import { Hud } from '../ui/hud.ts';
import type { HudHost } from '../ui/hud.ts';
import { EXAMPLES } from './examples.ts';
import { History } from './history.ts';
import type { EntrySource } from './history.ts';

type HorizonMode = 'off' | 'interact' | 'always';

interface Settings {
  provider: ProviderSettings;
  showNames: boolean;
  showParts: boolean;
  showThirds: boolean;
  horizon: HorizonMode;
}

interface TransientEntry {
  request: string;
  text: string;
  state: 'pending' | 'failed';
  ts: number;
}

const LS_SCENE = 'simposer.scene';
const LS_SETTINGS = 'simposer.settings';

function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function lsSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage unavailable (private mode); persistence is a convenience only
  }
}

function loadSettings(): Settings {
  const base: Settings = { provider: { ...PROVIDER_DEFAULTS.none, apiKey: '' }, showNames: true, showParts: false, showThirds: true, horizon: 'interact' };
  const raw = lsGet(LS_SETTINGS);
  if (raw === null) {
    return base;
  }
  try {
    const s = JSON.parse(raw) as Partial<Settings>;
    return { ...base, ...s, provider: { ...base.provider, ...(s.provider ?? {}) } };
  } catch {
    return base;
  }
}

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (el === null) {
    throw new Error(`missing #${id}`);
  }
  return el;
}

export class App implements HudHost {
  readonly viewport: Viewport;
  private readonly hud: Hud;
  private doc: SceneDoc = emptyScene();
  private readonly history = new History();
  private readonly catalog: Catalog;
  private settings: Settings;
  private selected: string | null = null;
  private selectedPart: string | null = null;
  private transient: TransientEntry | null = null;
  private busy: AbortController | null = null;
  private sceneErrors: string[] = [];
  private saveTimer: number | null = null;
  private statusTimer: number | null = null;
  private grabKey: string | null = null;
  private grabCount = 0;
  private entryTimes = new Map<number, number>();

  private readonly promptEl = $('prompt') as HTMLTextAreaElement;
  private readonly logEl = $('chat-log');
  private readonly panelEl = $('panel');
  private readonly statusEl = $('status');
  private readonly targetEl = $('target-frame');

  constructor(catalog: Catalog) {
    this.catalog = catalog;
    this.settings = loadSettings();
    let hudRef: Hud | null = null;
    this.viewport = new Viewport($('viewport'), catalog, {
      onPick: (r) => this.select(r?.figure ?? null, r?.part ?? null),
      onCameraCommit: (pose, rotated) => this.onCameraCommit(pose, rotated),
      onStatus: (m, err) => this.status(m, err),
      onFrame: (dt) => hudRef?.onFrame(dt),
    });
    this.viewport.setOverlay({ names: this.settings.showNames, parts: this.settings.showParts, thirds: this.settings.showThirds, horizon: this.settings.horizon });
    this.hud = new Hud(this);
    hudRef = this.hud;
    this.bindFileDrop();
    this.restore();
  }

  // ------------------------------------------------------------------ core

  get ctx(): ApplyContext {
    return {
      knownModels: this.catalog.ids,
      defaultModel: 'human',
      defaultBodies: this.catalog.defaultBodies(),
      crowdMix: [
        { model: 'human', body: 'adult_male' },
        { model: 'human', body: 'adult_female' },
        { model: 'human', body: 'heavy_male' },
        { model: 'human', body: 'heavy_female' },
        { model: 'human', body: 'elderly' },
        { model: 'human', body: 'athletic_male' },
        { model: 'human', body: 'athletic_female' },
        { model: 'human', body: 'teen_male' },
      ],
    };
  }

  private restore(): void {
    const saved = lsGet(LS_SCENE);
    if (saved !== null) {
      const r = parseScene(saved, this.ctx);
      if (r.doc !== null) {
        this.setDoc(r.doc);
        return;
      }
    }
    const first = EXAMPLES[0];
    if (first !== undefined) {
      this.runExample(first.delta, first.request, true);
    } else {
      this.setDoc(emptyScene());
    }
  }

  private setDoc(doc: SceneDoc, opts: { keepPanel?: boolean } = {}): void {
    this.doc = doc;
    if (this.selected !== null && !doc.figures.some((f) => f.id === this.selected)) {
      this.selected = null;
      this.selectedPart = null;
      this.viewport.select(null);
    }
    this.viewport.setDoc(doc);
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
    }
    this.saveTimer = window.setTimeout(() => lsSet(LS_SCENE, serializeScene(this.doc)), 400);
    this.renderLog();
    this.renderTarget();
    this.hud.refresh();
    if (opts.keepPanel !== true) {
      this.renderPanel();
    }
  }

  /** Parse, validate and apply a delta. Returns error strings (empty on success). */
  commit(delta: string, source: EntrySource, request: string, opts: { coalesceKey?: string; attempts?: number; keepPanel?: boolean; fresh?: boolean } = {}): string[] {
    const parsed = parseDelta(delta);
    if (parsed.errors.length > 0) {
      return parsed.errors.map((e) => `line ${e.line}: ${e.message}`);
    }
    const before = opts.fresh === true ? emptyScene() : this.doc;
    const res = applyCommands(before, parsed.commands, this.ctx);
    if (res.errors.length > 0) {
      return res.errors.map((e) => `line ${e.line}: ${e.message}`);
    }
    const entry = this.history.push({
      source, request, delta, before: this.doc, after: res.doc,
      coalesceKey: opts.coalesceKey ?? null, attempts: opts.attempts ?? 0,
    });
    this.entryTimes.set(entry.id, Date.now());
    if (res.touched.length === 1 && res.touched[0] !== undefined && source !== 'ui' && source !== 'camera') {
      this.selected = res.touched[0];
      this.selectedPart = null;
      this.viewport.select(this.selected);
    }
    this.setDoc(res.doc, { keepPanel: opts.keepPanel });
    return [];
  }

  private runExample(delta: string, request: string, fresh: boolean): void {
    const errs = this.commit(delta, 'example', request, { fresh });
    if (errs.length > 0) {
      this.status(`example failed: ${errs.join('; ')}`, true);
    }
  }

  undo(): void {
    const d = this.history.undo();
    if (d !== null) {
      this.setDoc(d);
    }
  }

  redo(): void {
    const d = this.history.redo();
    if (d !== null) {
      this.setDoc(d);
    }
  }

  status(msg: string, isError: boolean): void {
    this.statusEl.textContent = msg;
    this.statusEl.classList.toggle('error', isError);
    if (this.statusTimer !== null) {
      window.clearTimeout(this.statusTimer);
    }
    if (msg.length > 0) {
      this.statusTimer = window.setTimeout(() => {
        this.statusEl.textContent = '';
      }, isError ? 7000 : 3500);
    }
  }

  // ------------------------------------------------------------------ HUD host

  getDoc(): SceneDoc {
    return this.doc;
  }

  getSelection(): { figure: string | null; part: string | null } {
    return { figure: this.selected, part: this.selectedPart };
  }

  select(fig: string | null, part: string | null): void {
    const changed = fig !== this.selected;
    this.selected = fig;
    this.selectedPart = part;
    this.viewport.select(fig);
    this.renderTarget();
    this.hud.refresh();
    if (changed && this.hud.tab === 'figure') {
      this.renderPanel();
    }
  }

  private uiCommit(delta: string, desc: string, coalesceKey?: string): void {
    const errs = this.commit(delta, 'ui', desc, { coalesceKey, keepPanel: this.hud.tab !== 'figure' });
    if (errs.length > 0) {
      this.status(errs.join('; '), true);
    }
  }

  applyPreset(preset: string): void {
    if (this.selected === null) {
      return;
    }
    this.uiCommit(`pose ${this.selected} ${preset}`, `${this.selected}: ${preset.replace(/_/g, ' ')}`);
  }

  addFigureAt(x: number, z: number): void {
    let n = 1;
    while (this.doc.figures.some((f) => f.id === `person_${n}`) || this.doc.props.some((p) => p.id === `person_${n}`)) {
      n++;
    }
    const id = `person_${n}`;
    const cam = this.viewport.controller.pose;
    const facing = Math.round(headingTo(x, z, cam.x, cam.z));
    const body = n % 2 === 0 ? 'adult_male' : 'adult_female';
    const errs = this.commit(`add ${id} model human body ${body} at ${fmt(round(x, 2))} ${fmt(round(z, 2))} facing ${facing}`, 'ui', `added ${id}`);
    if (errs.length > 0) {
      this.status(errs.join('; '), true);
    } else {
      this.select(id, null);
      this.status(`Added ${id}. Press 1-9 to pose it, G to move it, Enter to describe it.`, false);
    }
  }

  grabMove(x: number, z: number): void {
    if (this.selected === null) {
      return;
    }
    if (this.grabKey === null) {
      this.history.seal();
      this.grabKey = `grab:${++this.grabCount}`;
    }
    const f = this.doc.figures.find((q) => q.id === this.selected);
    if (f !== undefined && Math.hypot(f.x - x, f.z - z) < 0.01) {
      return;
    }
    this.commit(`place ${this.selected} at ${fmt(round(x, 2))} ${fmt(round(z, 2))}`, 'ui', `moved ${this.selected}`, { coalesceKey: this.grabKey, keepPanel: true });
  }

  grabRotate(deg: number): void {
    const f = this.doc.figures.find((q) => q.id === this.selected);
    if (f === undefined) {
      return;
    }
    if (this.grabKey === null) {
      this.history.seal();
      this.grabKey = `grab:${++this.grabCount}`;
    }
    this.commit(`face ${f.id} ${fmt(Math.round(normDeg(facingDeg(this.doc, f) + deg)))}`, 'ui', `moved ${f.id}`, { coalesceKey: this.grabKey, keepPanel: true });
  }

  grabEnd(cancel: boolean): void {
    if (cancel && this.grabKey !== null) {
      const top = this.history.entries[this.history.entries.length - 1];
      if (top !== undefined && top.coalesceKey === this.grabKey) {
        this.undo();
      }
    }
    this.grabKey = null;
    this.history.seal();
    this.renderPanel();
  }

  deleteSelected(): void {
    if (this.selected === null) {
      return;
    }
    const id = this.selected;
    this.uiCommit(`remove ${id}`, `removed ${id}`);
    this.status(`Removed ${id}. Ctrl+Z to undo.`, false);
  }

  frameSelected(): void {
    const f = this.doc.figures.find((q) => q.id === this.selected);
    if (f === undefined) {
      return;
    }
    const cam = this.viewport.controller.pose;
    const az = Math.round(normDeg(headingTo(f.x, f.z, cam.x, cam.z) - facingDeg(this.doc, f)));
    this.uiCommit(`camera orbit ${f.id} azimuth ${az} elevation 5`, `framed ${f.id}`);
  }

  async snapshot(): Promise<void> {
    await this.saveImage();
  }

  onModeChange(interacting: boolean): void {
    // no selection tint while looking: it would change the reference shading
    this.viewport.setSelectionTint(interacting);
  }

  // ------------------------------------------------------------------ chat

  async send(): Promise<void> {
    const text = this.promptEl.value.trim();
    if (text.length === 0 || this.busy !== null) {
      return;
    }
    this.promptEl.value = '';
    this.promptEl.style.height = '';
    // 1. Direct DSL: if every line parses and applies, no LLM is needed.
    const parsed = parseDelta(text);
    if (parsed.errors.length === 0 && parsed.commands.length > 0) {
      const errs = validateDelta(this.doc, text, this.ctx);
      if (errs.length === 0) {
        this.commit(text, 'dsl', text);
        return;
      }
      if (makeProvider(this.settings.provider) === null) {
        this.showFailure(text, errs.join('\n'));
        return;
      }
    }
    // 2. Natural language via the configured provider.
    const provider = makeProvider(this.settings.provider);
    if (provider === null) {
      this.showFailure(text, 'To use plain-language requests, choose a language model in Settings (press O).\nYou can also type commands directly, e.g. "pose runner wave".');
      return;
    }
    this.busy = new AbortController();
    this.transient = { request: text, text: `asking ${this.settings.provider.model}...`, state: 'pending', ts: Date.now() };
    this.renderLog();
    try {
      const history = this.history.entries.filter((e) => e.source === 'nl').map((e) => ({ request: e.request, delta: e.delta }));
      const res = await translate(text, this.doc, {
        provider,
        models: this.catalog.entries.map((e) => ({ id: e.id, description: e.description })),
        ctx: this.ctx,
        history,
        signal: this.busy.signal,
        onAttempt: (n) => {
          if (this.transient !== null && n > 1) {
            this.transient.text = `repairing (attempt ${n})...`;
            this.renderLog();
          }
        },
      });
      this.transient = null;
      const errs = this.commit(res.delta, 'nl', text, { attempts: res.attempts });
      if (errs.length > 0) {
        this.showFailure(text, errs.join('\n'));
      }
    } catch (e) {
      const msg = e instanceof LlmError || e instanceof Error ? e.message : String(e);
      this.showFailure(text, msg);
    } finally {
      this.busy = null;
    }
  }

  private showFailure(request: string, text: string): void {
    this.transient = { request, text, state: 'failed', ts: Date.now() };
    this.renderLog();
  }

  // ------------------------------------------------------------------ camera

  private onCameraCommit(pose: CameraPose, rotated: boolean): void {
    const c = this.doc.camera;
    const lines = [`camera position ${fmt(round(pose.x, 2))} ${fmt(round(pose.y, 2))} ${fmt(round(pose.z, 2))}`];
    if (rotated || c.aim.kind === 'angles') {
      lines.push(`camera angles ${fmt(round(normDeg(pose.yaw), 1))} ${fmt(round(pose.pitch, 1))}`);
    }
    if (Math.abs(pose.lens - c.lens) > 0.05) {
      lines.push(`camera lens ${fmt(round(pose.lens, 1))}mm`);
    }
    this.commit(lines.join('\n'), 'camera', 'moved the camera', { coalesceKey: 'camera-walk', keepPanel: this.hud.tab !== 'camera' });
  }

  // ------------------------------------------------------------------ rendering

  private renderTarget(): void {
    const el = this.targetEl;
    el.replaceChildren();
    const f = this.doc.figures.find((q) => q.id === this.selected);
    if (f === undefined) {
      el.append(
        h('div', { class: 'name', style: 'color: var(--muted); font-size: 15px' }, 'No figure selected'),
        h('div', { class: 'sub' }, 'Aim at a figure and click, press Tab to cycle, or N to add one.'),
        h('div', { class: 'sub' }, `${this.doc.figures.length} figure${this.doc.figures.length === 1 ? '' : 's'} in "${this.doc.title}"`),
      );
      return;
    }
    const bp = bodyParams(f);
    const model = this.catalog.get(f.model)?.label ?? f.model;
    const poseDef = libraryFor(this.doc.poses).get(poseName(f.pose));
    const phase = poseArgNumber(f.pose, 'phase');
    // a pose with arguments other than the phase is shown as written
    const customized = f.pose.k === 'call' && f.pose.args.some((a) => a.name !== 'phase');
    const poseText = `${poseDef !== undefined && poseDef.description.length > 0 ? poseDef.description : poseName(f.pose).replace(/_/g, ' ')}${phase !== undefined ? ` (phase ${phase})` : ''}`;
    const extras: string[] = [];
    const nJoints = Object.keys(f.joints).length;
    if (nJoints > 0) {
      extras.push(`${nJoints} joint adjustment${nJoints === 1 ? '' : 's'}`);
    }
    for (const [eff, t] of Object.entries(f.reaches)) {
      if (t !== undefined) {
        const target = t.kind === 'part' ? `${t.figure === f.id ? 'own' : t.figure} ${t.part.replace(/_/g, ' ')}` : t.kind;
        extras.push(`${eff.replace(/_/g, ' ')} on ${target}`);
      }
    }
    if (f.look !== null) {
      extras.push(`looking at ${f.look.kind === 'part' ? `${f.look.figure}'s ${f.look.part.replace(/_/g, ' ')}` : f.look.kind === 'figure' ? f.look.figure : f.look.kind}`);
    }
    const dot = ` ${String.fromCharCode(183)} `; // middle dot
    const children: (HTMLElement | null)[] = [
      h('div', { class: 'name' }, f.id),
      h('div', { class: 'sub' }, `${model}${dot}${f.body.replace(/_/g, ' ')}${dot}${bp.height.toFixed(2)} m`),
      h('div', { class: 'sub' }, `Pose: ${poseText}`),
      customized ? h('div', { class: 'sub' }, h('code', {}, formatPoseExpr(f.pose))) : null,
      extras.length > 0 ? h('div', { class: 'sub' }, extras.join(', ')) : null,
      this.selectedPart !== null ? h('div', { class: 'sub' }, 'Part: ', h('b', {}, this.selectedPart.replace(/_/g, ' ')), h('button', {
        class: 'small', style: 'margin-left:6px', title: 'Insert into the chat box',
        onclick: () => this.insertIntoPrompt(`${f.id}.${this.selectedPart ?? ''}`),
      }, 'use in chat')) : null,
      h('div', { class: 'row' },
        h('button', { class: 'small', onclick: () => this.hud.openWindow('figure') }, 'Edit ', h('kbd', {}, 'C')),
        h('button', { class: 'small', onclick: () => this.frameSelected() }, 'Frame ', h('kbd', {}, 'F')),
        h('button', { class: 'small', onclick: () => this.deleteSelected() }, 'Remove ', h('kbd', {}, 'Del')),
      ),
    ];
    el.append(...children.filter((c): c is HTMLElement => c !== null));
  }

  private insertIntoPrompt(text: string): void {
    const ta = this.promptEl;
    const pad = ta.value.length > 0 && !/\s$/.test(ta.value) ? ' ' : '';
    ta.value = `${ta.value}${pad}${text} `;
    this.hud.openChat();
  }

  private renderLog(): void {
    ($('undo') as HTMLButtonElement).disabled = !this.history.canUndo;
    ($('redo') as HTMLButtonElement).disabled = !this.history.canRedo;
    const p = this.settings.provider;
    $('provider-label').textContent = p.kind === 'none' ? 'commands only (no language model)' : `${p.kind}: ${p.model}`;
    const el = this.logEl;
    el.replaceChildren();
    const who: Record<EntrySource, string> = { nl: 'You', dsl: 'You (commands)', ui: 'Edit', camera: 'Camera', scene: 'Script', example: 'Example' };
    for (const e of this.history.entries.slice(-30)) {
      const meta = e.attempts > 1 ? `${e.attempts} attempts` : '';
      el.append(h('div', { class: 'entry', 'data-ts': this.entryTimes.get(e.id) ?? 0 },
        h('div', { class: 'req' }, h('span', { class: 'who' }, `${who[e.source]}:`), e.request),
        meta.length > 0 ? h('div', { class: 'meta' }, meta) : null,
        e.source === 'nl' || e.source === 'dsl' || e.source === 'example' ? h('pre', {}, e.delta) : null));
    }
    if (this.transient !== null) {
      const t = this.transient;
      el.append(h('div', { class: `entry ${t.state}`, 'data-ts': t.ts }, h('div', { class: 'req' }, h('span', { class: 'who' }, 'You:'), t.request), h('pre', {}, t.text)));
    }
    el.scrollTop = el.scrollHeight;
  }

  renderPanel(): void {
    const tab = this.hud.tab;
    const p = this.panelEl;
    const focused = document.activeElement;
    if (tab === null) {
      return;
    }
    if (tab === 'scene' && focused instanceof HTMLTextAreaElement && p.contains(focused)) {
      return; // do not clobber in-progress script edits
    }
    const scroll = p.scrollTop;
    p.replaceChildren();
    switch (tab) {
      case 'scene':
        this.renderScenePanel(p);
        break;
      case 'figure':
        this.renderFigurePanel(p);
        break;
      case 'camera':
        this.renderCameraPanel(p);
        break;
      case 'settings':
        this.renderSettingsPanel(p);
        break;
    }
    p.scrollTop = scroll;
  }

  private renderScenePanel(p: HTMLElement): void {
    const ta = h('textarea', { class: 'scene-text', spellcheck: 'false', 'aria-label': 'Scene script' });
    ta.value = serializeScene(this.doc);
    const errs = h('div', { class: 'errors' }, this.sceneErrors.join('\n'));
    const apply = (): void => {
      const r = parseScene(ta.value, this.ctx);
      if (r.doc === null) {
        this.sceneErrors = r.errors.map((e) => `line ${e.line}: ${e.message}`);
        errs.textContent = this.sceneErrors.join('\n');
        return;
      }
      this.sceneErrors = [];
      const entry = this.history.push({ source: 'scene', request: 'edited the scene script', delta: '# (whole scene replaced)', before: this.doc, after: r.doc, coalesceKey: null, attempts: 0 });
      this.entryTimes.set(entry.id, Date.now());
      ta.blur();
      this.setDoc(r.doc);
    };
    p.append(
      h('h3', {}, 'Example scenes'),
      h('div', { class: 'btns' }, ...EXAMPLES.map((ex) => h('button', { class: 'small', title: ex.request, onclick: () => this.runExample(ex.delta, ex.request, ex.fresh) }, ex.label))),
      h('h3', {}, 'Scene script'),
      h('p', { class: 'muted' }, 'The whole scene as readable commands. Edit and press Apply; it follows the same rules as chat commands.'),
      ta,
      h('div', { class: 'row' },
        h('button', { class: 'primary', onclick: apply }, 'Apply script'),
        h('button', { onclick: () => this.downloadText(serializeScene(this.doc), `${slug(this.doc.title)}.scene.txt`) }, 'Export'),
        h('button', { onclick: () => this.importScene() }, 'Import'),
        h('button', { onclick: () => this.runExample('title "Untitled"', 'new scene', true) }, 'New'),
      ),
      errs,
    );
  }

  private renderFigurePanel(p: HTMLElement): void {
    const f = this.doc.figures.find((q) => q.id === this.selected);
    if (f === undefined) {
      p.append(h('p', { class: 'muted' }, 'No figure selected. Close this window, aim at a figure and click, or pick one here:'));
      if (this.doc.figures.length > 0) {
        p.append(h('div', { class: 'btns' }, ...this.doc.figures.map((q) => h('button', { class: 'small', onclick: () => { this.select(q.id, null); this.renderPanel(); } }, q.id))));
      }
      return;
    }
    const id = f.id;
    const ui = (delta: string, key: string | null, desc: string): void => {
      const errs = this.commit(delta, 'ui', desc, { coalesceKey: key ?? undefined, keepPanel: true });
      if (errs.length > 0) {
        this.status(errs.join('; '), true);
      }
    };
    const entry = this.catalog.get(f.model);
    const bp = bodyParams(f);

    p.append(h('h3', {}, `Figure: ${id}`));
    p.append(checkbox('Show body part labels', this.settings.showParts, (v) => {
      this.settings.showParts = v;
      this.saveSettings();
      this.viewport.setOverlay({ parts: v });
    }));
    p.append(selectField('model', this.catalog.entries.map((e) => ({ value: e.id, label: e.label })), f.model, (v) => {
      ui(`model ${id} ${v}`, null, `model ${v}`);
      this.renderPanel();
    }));
    p.append(selectField('body type', BODY_PRESETS.map((b) => ({ value: b.name, label: `${b.name.replace(/_/g, ' ')} - ${b.description}` })), f.body, (v) => {
      ui(`body ${id} ${v}`, null, `body ${v}`);
      this.renderPanel();
    }));

    p.append(h('h3', {}, 'Pose'));
    const lib = libraryFor(this.doc.poses);
    const current = poseName(f.pose);
    const options = wholeBodyPoses(lib).map((x) => ({ value: x.name, label: `${x.name.replace(/_/g, ' ')}${x.description.length > 0 ? ` - ${x.description}` : ''}` }));
    if (!options.some((o) => o.value === current)) {
      options.unshift({ value: current, label: current.replace(/_/g, ' ') });
    }
    p.append(selectField('pose', options, current, (v) => {
      ui(`pose ${id} ${v}`, null, `pose ${v}`);
      this.renderPanel();
    }));
    if (f.pose.k === 'call' && f.pose.args.some((a) => a.name !== 'phase')) {
      p.append(h('p', { class: 'muted' }, h('code', {}, formatPoseExpr(f.pose))));
    }
    if (lib.get(current)?.params.some((x) => x.name === 'phase') === true) {
      p.append(slider({ label: 'stride moment', min: 0, max: 0.99, step: 0.01, value: poseArgNumber(f.pose, 'phase') ?? 0, onInput: (v) => ui(`phase ${id} ${fmt(v)}`, `phase:${id}`, 'phase') }));
    }
    const composed = this.composed(f.pose);
    for (const side of ['left', 'right'] as const) {
      const shape = f.hands[side] ?? handShapeOf(composed.dofs, side) ?? 'relaxed';
      p.append(selectField(`${side} hand`, HAND_SHAPES.map((s) => ({ value: s, label: s })), shape, (v) => ui(`hand ${id} ${side} ${v}`, null, `${side} hand ${v}`)));
    }
    for (const eff of Object.keys(f.reaches)) {
      p.append(h('div', { class: 'row' }, h('span', { class: 'muted' }, `${eff.replace(/_/g, ' ')} is placed by a reach`),
        h('button', { class: 'small', onclick: () => { ui(`release ${id} ${eff}`, null, `release ${eff}`); this.renderPanel(); } }, 'release')));
    }
    if (f.look !== null) {
      p.append(h('div', { class: 'row' }, h('span', { class: 'muted' }, 'looking at a target'), h('button', { class: 'small', onclick: () => { ui(`look ${id} forward`, null, 'look forward'); this.renderPanel(); } }, 'look forward')));
    }

    p.append(h('h3', {}, 'Placement'));
    p.append(slider({ label: 'x', min: -20, max: 20, step: 0.05, value: f.x, onInput: (v) => ui(`place ${id} at ${fmt(v)} ${fmt(this.fig(id)?.z ?? f.z)}`, `place:${id}`, 'moved') }));
    p.append(slider({ label: 'z', min: -20, max: 20, step: 0.05, value: f.z, onInput: (v) => ui(`place ${id} at ${fmt(this.fig(id)?.x ?? f.x)} ${fmt(v)}`, `place:${id}`, 'moved') }));
    p.append(slider({ label: 'facing', min: -180, max: 180, step: 1, value: Math.round(facingDeg(this.doc, f)), highlight: f.facing.kind !== 'angle', onInput: (v) => ui(`face ${id} ${fmt(v)}`, `face:${id}`, 'turned') }));
    p.append(slider({ label: 'standing on', min: 0, max: 2, step: 0.01, value: f.elevation, format: (v) => `${v}m`, onInput: (v) => ui(`elevate ${id} ${fmt(v)}`, `elev:${id}`, 'elevated') }));

    p.append(h('h3', {}, 'Joints'), h('p', { class: 'muted' }, 'Highlighted values override the pose. A limb with a reach is placed automatically.'));
    const base = composed.dofs;
    for (const j of JOINTS) {
      const det = h('details', { class: 'joint' });
      const overridden = j.dofs.some((d) => f.joints[`${j.name}.${d.name}`] !== undefined);
      det.append(h('summary', {}, j.name.replace(/_/g, ' '), overridden ? ' *' : ''));
      for (const d of j.dofs) {
        const key = `${j.name}.${d.name}`;
        const val = f.joints[key] ?? base[key] ?? 0;
        det.append(slider({
          label: d.name.replace(/_/g, ' '), min: d.min, max: d.max, step: 1, value: Math.round(val * 10) / 10,
          highlight: f.joints[key] !== undefined,
          onInput: (v) => ui(`set ${id} ${j.name} ${d.name} ${fmt(v)}`, `set:${id}:${key}`, `${j.name} ${d.name}`),
        }));
      }
      if (overridden) {
        det.append(h('button', { class: 'small', onclick: (e: Event) => { e.preventDefault(); ui(`reset ${id} ${j.name}`, null, `reset ${j.name}`); this.renderPanel(); } }, 'reset'));
      }
      p.append(det);
    }

    p.append(h('h3', {}, 'Body'));
    if (entry?.kind !== 'human') {
      p.append(h('p', { class: 'muted' }, 'This rigged model only follows height. Switch the model to "Human figure" for full body shaping.'));
    }
    const ranges: [keyof BodyParams, string, number, number, number, (v: number) => string][] = [
      ['height', 'height', 0.8, 2.2, 0.01, (v) => `${v.toFixed(2)} m`],
      ['age', 'age', 3, 90, 1, (v) => `${v} years`],
      ['femininity', 'male - female', 0, 1, 0.05, (v) => (v < 0.2 ? 'male' : v > 0.8 ? 'female' : 'mixed')],
      ['build', 'weight', 0.7, 1.5, 0.01, (v) => (v < 0.9 ? 'slim' : v > 1.15 ? 'heavy' : 'average')],
      ['muscle', 'muscle', 0.7, 1.45, 0.01, (v) => (v < 0.9 ? 'soft' : v > 1.15 ? 'muscular' : 'average')],
      ['bust', 'chest / bust', 60, 140, 1, (v) => `${v} cm`],
      ['hip', 'hips', 60, 140, 1, (v) => `${v} cm`],
      ['heads', 'stylize: heads tall', 0, 9, 0.1, (v) => (v < 1.5 ? 'natural' : v.toFixed(1))],
      ['leg_length', 'stylize: leg length', 0.8, 1.3, 0.01, (v) => v.toFixed(2)],
    ];
    for (const [k, label, min, max, step, format] of ranges) {
      if (entry?.kind !== 'human' && k !== 'height') {
        continue;
      }
      p.append(slider({ label, min, max, step, value: bp[k], format, highlight: f.bodyOverrides[k] !== undefined, onInput: (v) => ui(`body ${id} ${k} ${fmt(v)}`, `body:${id}:${k}`, `body ${k}`) }));
    }
    p.append(h('div', { class: 'row', style: 'margin-top:8px' },
      h('button', { class: 'small', onclick: () => { ui(`reset ${id} all`, null, 'reset pose adjustments'); this.renderPanel(); } }, 'reset adjustments'),
      h('button', { class: 'small', onclick: () => this.deleteSelected() }, 'remove figure'),
    ));
  }

  private fig(id: string): Figure | undefined {
    return this.doc.figures.find((q) => q.id === id);
  }

  /** A figure's pose as joint angles, before figure-level edits. */
  private composed(pose: PoseExpr): ComposedPose {
    try {
      return composePose(libraryFor(this.doc.poses), pose);
    } catch {
      return composePose(libraryFor([]), { k: 'word', w: 'stand' });
    }
  }

  private renderCameraPanel(p: HTMLElement): void {
    const c = this.doc.camera;
    const cam = (delta: string, key: string | null, desc: string): void => {
      const errs = this.commit(delta, 'ui', desc, { coalesceKey: key ?? undefined, keepPanel: true });
      if (errs.length > 0) {
        this.status(errs.join('; '), true);
      }
    };
    p.append(h('h3', {}, 'Lens'));
    p.append(slider({ label: 'focal length', min: 12, max: 200, step: 1, value: c.lens, format: (v) => `${v}mm`, onInput: (v) => cam(`camera lens ${v}mm`, 'cam:lens', 'lens') }));
    p.append(h('div', { class: 'btns' }, ...[16, 24, 35, 50, 85, 135].map((mm) => h('button', { class: 'small', onclick: () => { cam(`camera lens ${mm}mm`, null, `lens ${mm}mm`); this.renderPanel(); } }, `${mm}mm`))));
    p.append(h('p', { class: 'muted' }, 'Wide (16-24mm) exaggerates perspective; 50mm is natural; 85mm+ flattens, good for portraits.'));
    p.append(h('h3', {}, 'Focus'));
    p.append(checkbox('Depth of field blur', c.dof, (v) => cam(`camera dof ${v ? 'on' : 'off'}`, null, 'dof')));
    p.append(selectField('aperture', [1.4, 1.8, 2, 2.8, 4, 5.6, 8, 11, 16, 22].map((n) => ({ value: String(n), label: `f/${n}${n <= 2 ? ' (very blurry background)' : n >= 11 ? ' (everything sharp)' : ''}` })), String(c.fstop), (v) => {
      cam(`camera aperture f/${v}`, null, `aperture f/${v}`);
      this.renderPanel();
    }));
    const focusOpts = [{ value: 'auto', label: 'auto (what you aim at)' }, ...this.doc.figures.map((f) => ({ value: `${f.id}.face`, label: `${f.id} (face)` }))];
    const focusVal = c.focus.kind === 'target' && c.focus.target.kind === 'part' ? `${c.focus.target.figure}.${c.focus.target.part}` : 'auto';
    p.append(selectField('focus on', focusOpts, focusVal, (v) => cam(`camera focus ${v}`, null, `focus ${v}`)));
    p.append(slider({ label: 'focus distance', min: 0.3, max: 30, step: 0.1, value: c.focus.kind === 'distance' ? c.focus.meters : 5, highlight: c.focus.kind === 'distance', format: (v) => `${v}m`, onInput: (v) => cam(`camera focus ${fmt(v)}`, 'cam:focus', 'focus distance') }));

    p.append(h('h3', {}, 'Framing'));
    p.append(selectField('frame', ['free', '3:2', '2:3', '4:5', '5:4', '1:1', '16:9', '9:16'].map((x) => ({ value: x, label: x === 'free' ? 'free (whole screen)' : x })), c.frame, (v) => cam(`camera frame ${v}`, null, `frame ${v}`)));
    p.append(checkbox('Rule of thirds guide (while panels are shown)', this.settings.showThirds, (v) => {
      this.settings.showThirds = v;
      this.saveSettings();
      this.viewport.setOverlay({ thirds: v });
    }));
    p.append(selectField('horizon line', [
      { value: 'off', label: 'off' },
      { value: 'interact', label: 'while panels are shown' },
      { value: 'always', label: 'always (also while looking)' },
    ], this.settings.horizon, (v) => {
      this.settings.horizon = v as HorizonMode;
      this.saveSettings();
      this.viewport.setOverlay({ horizon: this.settings.horizon });
    }));
    p.append(slider({ label: 'tilt (dutch)', min: -35, max: 35, step: 1, value: c.roll, format: (v) => `${v} deg`, onInput: (v) => cam(`camera roll ${v}`, 'cam:roll', 'roll') }));
    p.append(slider({ label: 'height', min: 0.05, max: 12, step: 0.05, value: c.y, format: (v) => `${v}m`, onInput: (v) => cam(`camera height ${fmt(v)}`, 'cam:height', 'camera height') }));
    if (this.selected !== null) {
      const sel = this.selected;
      p.append(h('div', { class: 'btns' },
        h('button', { class: 'small', onclick: () => cam(`camera orbit ${sel} azimuth 20 elevation 5`, null, `frame ${sel}`) }, `front of ${sel}`),
        h('button', { class: 'small', onclick: () => cam(`camera orbit ${sel} azimuth 180 elevation 5`, null, `behind ${sel}`) }, 'from behind'),
        h('button', { class: 'small', onclick: () => cam(`camera orbit ${sel} azimuth 30 elevation -25`, null, `low angle on ${sel}`) }, 'low angle'),
        h('button', { class: 'small', onclick: () => cam(`camera orbit ${sel} azimuth 20 elevation 55`, null, `high angle on ${sel}`) }, 'high angle'),
      ));
    }
    p.append(h('div', { class: 'row', style: 'margin-top:8px' }, h('button', { class: 'primary', onclick: () => void this.saveImage() }, 'Save image')));

    p.append(h('h3', {}, 'Light and look'));
    const l = this.doc.light;
    p.append(slider({ label: 'sun direction', min: -180, max: 180, step: 1, value: l.azimuth, format: (v) => `${v} deg`, onInput: (v) => cam(`light azimuth ${v}`, 'light:az', 'light') }));
    p.append(slider({ label: 'sun height', min: 2, max: 90, step: 1, value: l.elevation, format: (v) => `${v} deg`, onInput: (v) => cam(`light elevation ${v}`, 'light:el', 'light') }));
    p.append(slider({ label: 'sun strength', min: 0, max: 6, step: 0.1, value: l.intensity, onInput: (v) => cam(`light intensity ${fmt(v)}`, 'light:in', 'light') }));
    p.append(slider({ label: 'fill light', min: 0, max: 1.5, step: 0.05, value: l.fill, onInput: (v) => cam(`light fill ${fmt(v)}`, 'light:fill', 'light') }));
    p.append(selectField('shading', RENDER_STYLES.map((s) => ({ value: s, label: s === 'flat' ? 'flat (low poly planes)' : s === 'toon' ? 'toon (3-tone shadows)' : 'smooth' })), this.doc.style, (v) => cam(`style ${v}`, null, `style ${v}`)));
    p.append(selectField('ground', GROUND_KINDS.map((s) => ({ value: s, label: s })), this.doc.ground, (v) => cam(`ground ${v}`, null, `ground ${v}`)));
  }

  private renderSettingsPanel(p: HTMLElement): void {
    const s = this.settings.provider;
    p.append(h('h3', {}, 'Language model'));
    p.append(h('p', { class: 'muted' }, 'Plain-language requests are translated into scene commands by a language model. Typed commands never need one.'));
    p.append(selectField('provider', [
      { value: 'none', label: 'None (commands only)' },
      { value: 'ollama', label: 'Ollama (local, native API)' },
      { value: 'openai', label: 'OpenAI-compatible (LM Studio, llama.cpp, vLLM, hosted...)' },
      { value: 'anthropic', label: 'Anthropic API' },
    ], s.kind, (v) => {
      const kind = v as ProviderKind;
      this.settings.provider = { ...PROVIDER_DEFAULTS[kind], apiKey: kind === s.kind ? s.apiKey : '' };
      this.saveSettings();
      this.renderPanel();
    }));
    if (s.kind !== 'none') {
      const text = (label: string, key: 'model' | 'baseUrl' | 'apiKey', type = 'text'): HTMLElement => {
        const input = h('input', { type, value: s[key], 'aria-label': label, autocomplete: 'off' });
        input.addEventListener('change', () => {
          this.settings.provider = { ...this.settings.provider, [key]: input.value.trim() };
          this.saveSettings();
        });
        return h('div', { class: 'field' }, h('label', {}, label), input);
      };
      p.append(text('model', 'model'), text('base URL', 'baseUrl'), text('API key', 'apiKey', 'password'));
      p.append(h('p', { class: 'muted' }, 'The key is kept in this browser\'s localStorage and sent only to the base URL above.'));
      if (s.kind === 'openai') {
        p.append(h('div', { class: 'btns' },
          h('button', { class: 'small', onclick: () => this.setProvider({ kind: 'openai', baseUrl: 'http://localhost:1234/v1', model: 'local-model' }) }, 'LM Studio'),
          h('button', { class: 'small', onclick: () => this.setProvider({ kind: 'openai', baseUrl: 'http://localhost:8080/v1', model: 'default' }) }, 'llama.cpp'),
        ));
      }
      if (s.kind === 'ollama' || s.kind === 'openai') {
        p.append(h('p', { class: 'muted' }, 'Local servers must allow this page\'s origin (LM Studio: enable CORS; Ollama: OLLAMA_ORIGINS).'));
      }
    }

    p.append(h('h3', {}, 'Display'));
    p.append(checkbox('Figure name tags', this.settings.showNames, (v) => {
      this.settings.showNames = v;
      this.saveSettings();
      this.viewport.setOverlay({ names: v });
    }));
    p.append(checkbox('Body part labels on the selected figure', this.settings.showParts, (v) => {
      this.settings.showParts = v;
      this.saveSettings();
      this.viewport.setOverlay({ parts: v });
    }));
    p.append(slider({
      label: 'mouse sensitivity', min: 0.03, max: 0.3, step: 0.01, value: this.viewport.controller.sensitivity,
      onInput: (v) => {
        this.viewport.controller.sensitivity = v;
      },
    }));

    p.append(h('h3', {}, 'Models'));
    p.append(h('ul', { class: 'models' }, ...this.catalog.entries.map((e) => h('li', {},
      h('b', {}, e.id), ` - ${e.description}`, e.source.length > 0 ? h('span', { class: 'muted' }, ` (${e.source})`) : null,
      e.imported ? h('button', { class: 'small', onclick: () => void this.catalog.removeImported(e.id).then(() => this.renderPanel()) }, 'remove') : null,
    ))));
    const zone = h('div', { class: 'dropzone' }, 'Drop a rigged humanoid .glb here (Mixamo, Quaternius, VRM-style, UE-style names), or ', h('button', { class: 'small', onclick: () => this.pickModelFile() }, 'choose file'));
    zone.addEventListener('dragenter', () => zone.classList.add('over'));
    zone.addEventListener('dragleave', () => zone.classList.remove('over'));
    zone.addEventListener('drop', () => zone.classList.remove('over'));
    p.append(zone);
  }

  private setProvider(patch: Partial<ProviderSettings>): void {
    this.settings.provider = { ...this.settings.provider, ...patch };
    this.saveSettings();
    this.renderPanel();
  }

  private saveSettings(): void {
    lsSet(LS_SETTINGS, JSON.stringify(this.settings));
    this.renderLog();
  }

  // ------------------------------------------------------------------ files

  private bindFileDrop(): void {
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      const files = [...(e.dataTransfer?.files ?? [])].filter((f) => /\.glb$/i.test(f.name));
      for (const f of files) {
        void this.importModel(f);
      }
    });
  }

  private async importModel(file: File): Promise<void> {
    this.status(`importing ${file.name}...`, false);
    try {
      const e = await this.catalog.importFile(file);
      this.status(`imported model "${e.id}"`, false);
      if (this.hud.tab === 'settings') {
        this.renderPanel();
      }
    } catch (err) {
      this.status(err instanceof Error ? err.message : String(err), true);
    }
  }

  private pickModelFile(): void {
    const input = h('input', { type: 'file', accept: '.glb' });
    input.addEventListener('change', () => {
      const f = input.files?.[0];
      if (f !== undefined) {
        void this.importModel(f);
      }
    });
    input.click();
  }

  private importScene(): void {
    const input = h('input', { type: 'file', accept: '.txt,text/plain' });
    input.addEventListener('change', () => {
      const f = input.files?.[0];
      if (f === undefined) {
        return;
      }
      void f.text().then((text) => {
        const r = parseScene(text, this.ctx);
        if (r.doc === null) {
          this.sceneErrors = r.errors.map((e) => `line ${e.line}: ${e.message}`);
          this.renderPanel();
          return;
        }
        const entry = this.history.push({ source: 'scene', request: `imported ${f.name}`, delta: '# (whole scene replaced)', before: this.doc, after: r.doc, coalesceKey: null, attempts: 0 });
        this.entryTimes.set(entry.id, Date.now());
        this.setDoc(r.doc);
      });
    });
    input.click();
  }

  private downloadText(text: string, name: string): void {
    this.download(new Blob([text], { type: 'text/plain' }), name);
  }

  private download(blob: Blob, name: string): void {
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: name });
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  private async saveImage(): Promise<void> {
    try {
      const blob = await this.viewport.snapshot();
      const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
      const name = `${slug(this.doc.title)}-${stamp}.png`;
      this.download(blob, name);
      this.status(`Saved ${name}`, false);
    } catch (e) {
      this.status(e instanceof Error ? e.message : String(e), true);
    }
  }
}

function round(n: number, d: number): number {
  const k = Math.pow(10, d);
  return Math.round(n * k) / k;
}

function slug(s: string): string {
  const r = s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return r.length > 0 ? r : 'scene';
}
