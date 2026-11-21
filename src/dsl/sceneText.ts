// Abstract scene DSL: a canonical, human-readable text form of a SceneDoc.
//
// The scene text is defined as "the delta script that builds this scene from
// an empty one", grouped into blocks for readability. Parsing therefore
// rewrites each block line into a delta command and reuses the delta parser
// and applier, which keeps the two languages consistent by construction.

import { applyCommands } from './apply.ts';
import type { ApplyContext } from './apply.ts';
import { parseDelta } from './commands.ts';
import { DslError, fmt, formatTarget, tokenize } from './tokens.ts';
import { emptyScene } from './types.ts';
import type { Figure, SceneDoc, TargetRef } from './types.ts';
import { BODY_PARAM_NAMES, JOINTS, formatDofPhrase } from './vocab.ts';
import type { Effector } from './vocab.ts';
import { formatDefinition, formatPoseExpr, isDefineLine, readDefineBlock } from '../pose/lang/ast.ts';

function tgt(tg: TargetRef, self: string | null): string {
  if (self !== null && (tg.kind === 'part' || tg.kind === 'figure') && tg.figure === self) {
    return tg.kind === 'part' ? `self.${tg.part}` : 'self';
  }
  return formatTarget(tg);
}

const DOF_ORDER: string[] = JOINTS.flatMap((j) => j.dofs.map((d) => `${j.name}.${d.name}`));
const EFFECTOR_ORDER: Effector[] = ['left_hand', 'right_hand', 'left_foot', 'right_foot'];

export function figureLines(f: Figure): string[] {
  const out: string[] = [];
  if (f.group !== null) {
    out.push(`group @${f.group}`);
  }
  out.push(`model ${f.model}`);
  const ov = BODY_PARAM_NAMES.filter((k) => f.bodyOverrides[k] !== undefined).map((k) => `${k} ${fmt(f.bodyOverrides[k] ?? 0)}`);
  out.push(`body ${f.body}${ov.length > 0 ? ' ' + ov.join(' ') : ''}`);
  out.push(`at ${fmt(f.x)} ${fmt(f.z)}`);
  if (f.elevation !== 0) {
    out.push(`elevation ${fmt(f.elevation)}`);
  }
  const facing = f.facing.kind === 'angle' ? fmt(f.facing.deg) : `${f.facing.kind === 'toward' ? 'toward' : 'away_from'} ${tgt(f.facing.target, f.id)}`;
  out.push(`facing ${facing}`);
  out.push(`pose ${formatPoseExpr(f.pose)}`);
  const keys = Object.keys(f.joints).sort((a, b) => DOF_ORDER.indexOf(a) - DOF_ORDER.indexOf(b));
  for (const k of keys) {
    const [j = '', d = ''] = k.split('.');
    const p = formatDofPhrase(j, d, f.joints[k] ?? 0);
    out.push(`set ${j} ${p.phrase} ${fmt(p.value)}`);
  }
  for (const e of EFFECTOR_ORDER) {
    const r = f.reaches[e];
    if (r !== undefined) {
      out.push(`reach ${e} to ${tgt(r, f.id)}`);
    }
  }
  if (f.look !== null) {
    out.push(`look at ${tgt(f.look, f.id)}`);
  }
  for (const side of ['left', 'right'] as const) {
    const h = f.hands[side];
    if (h !== undefined) {
      out.push(`hand ${side} ${h}`);
    }
  }
  return out;
}

export function serializeScene(doc: SceneDoc): string {
  const L: string[] = [];
  L.push('# simposer scene v1');
  L.push(`title "${doc.title.replace(/"/g, "'")}"`);
  L.push(`ground ${doc.ground}`);
  L.push(`style ${doc.style}`);
  const l = doc.light;
  L.push(`light azimuth ${fmt(l.azimuth)} elevation ${fmt(l.elevation)} intensity ${fmt(l.intensity)} fill ${fmt(l.fill)}`);
  L.push('');
  // poses this scene defines or redefines, on top of the default library
  for (const d of doc.poses) {
    L.push(...formatDefinition(d));
    L.push('');
  }
  const c = doc.camera;
  L.push('camera');
  L.push(`  position ${fmt(c.x)} ${fmt(c.y)} ${fmt(c.z)}`);
  L.push(c.aim.kind === 'angles' ? `  angles ${fmt(c.aim.yaw)} ${fmt(c.aim.pitch)}` : `  look_at ${formatTarget(c.aim.target)}`);
  if (c.roll !== 0) {
    L.push(`  roll ${fmt(c.roll)}`);
  }
  L.push(`  lens ${fmt(c.lens)}mm`);
  L.push(`  aperture f/${fmt(c.fstop)}`);
  L.push(c.focus.kind === 'auto' ? '  focus auto' : c.focus.kind === 'distance' ? `  focus ${fmt(c.focus.meters)}m` : `  focus ${formatTarget(c.focus.target)}`);
  L.push(`  dof ${c.dof ? 'on' : 'off'}`);
  L.push(`  frame ${c.frame}`);
  for (const p of doc.props) {
    L.push('');
    L.push(`prop ${p.id} ${p.kind} at ${fmt(p.x)} ${fmt(p.z)} facing ${fmt(p.facing)} size ${p.size.map(fmt).join(' ')}`);
  }
  for (const f of doc.figures) {
    L.push('');
    L.push(`figure ${f.id}`);
    for (const line of figureLines(f)) {
      L.push(`  ${line}`);
    }
  }
  return L.join('\n') + '\n';
}

export interface SceneParseResult {
  doc: SceneDoc | null;
  errors: DslError[];
}

interface Rewritten {
  text: string;
  srcLine: number;
}

/** Parse scene text back into a document. */
export function parseScene(text: string, ctx: ApplyContext): SceneParseResult {
  const header: Rewritten[] = [];
  const props: Rewritten[] = [];
  const adds: Rewritten[] = [];
  const details: Rewritten[] = [];
  const camera: Rewritten[] = [];
  const errors: DslError[] = [];
  let block: { kind: 'camera' } | { kind: 'figure'; id: string } | null = null;
  const allLines = text.split(/\r?\n/);

  // pose definitions span several lines; they pass through to the delta
  // parser unchanged (it reads the same blocks)
  const defineLine = new Set<number>();
  for (let i = 0; i < allLines.length; i++) {
    const raw = allLines[i] ?? '';
    if (!isDefineLine(raw) || /^\s/.test(raw)) {
      continue;
    }
    let next = i + 1;
    try {
      next = readDefineBlock(allLines, i).next;
    } catch {
      // the delta parser reports the error; take lines up to "end"
      while (next < allLines.length && !/^\s*end\s*(#.*)?$/i.test(allLines[next] ?? '') && !/^\S/.test(allLines[next] ?? '')) {
        next++;
      }
      if (/^\s*end\s*(#.*)?$/i.test(allLines[next] ?? '')) {
        next++;
      }
    }
    for (let j = i; j < next; j++) {
      defineLine.add(j);
    }
    i = next - 1;
  }

  allLines.forEach((raw, idx) => {
    const lineNo = idx + 1;
    if (defineLine.has(idx)) {
      header.push({ text: raw, srcLine: lineNo });
      block = null;
      return;
    }
    const toks = tokenize(raw);
    if (toks.length === 0) {
      return;
    }
    const indented = /^\s/.test(raw);
    const head = (toks[0] ?? '').toLowerCase();
    if (!indented) {
      block = null;
      if (head === 'camera' && toks.length === 1) {
        block = { kind: 'camera' };
        return;
      }
      if (head === 'figure') {
        const id = toks[1];
        if (id === undefined || toks.length !== 2) {
          errors.push(new DslError('expected "figure <name>"', lineNo));
          return;
        }
        block = { kind: 'figure', id: id.toLowerCase() };
        adds.push({ text: `add ${id}`, srcLine: lineNo });
        return;
      }
      if (head === 'prop') {
        props.push({ text: raw.trim(), srcLine: lineNo });
        return;
      }
      header.push({ text: raw.trim(), srcLine: lineNo });
      return;
    }
    const cur = block as { kind: 'camera' } | { kind: 'figure'; id: string } | null;
    if (cur === null) {
      errors.push(new DslError('indented line outside of a camera or figure block', lineNo));
      return;
    }
    if (cur.kind === 'camera') {
      camera.push({ text: `camera ${raw.trim()}`, srcLine: lineNo });
      return;
    }
    const rest = raw.trim().replace(/^\S+/, '').trim();
    const id = cur.id;
    const mapping: Record<string, string> = {
      group: `group ${id} ${rest}`,
      model: `model ${id} ${rest}`,
      body: `body ${id} ${rest}`,
      at: `place ${id} at ${rest}`,
      elevation: `elevate ${id} ${rest}`,
      facing: `face ${id} ${rest}`,
      pose: `pose ${id} ${rest}`,
      set: `set ${id} ${rest}`,
      reach: `reach ${id} ${rest}`,
      look: `look ${id} ${rest}`,
      hand: `hand ${id} ${rest}`,
    };
    const rewritten = mapping[head];
    if (rewritten === undefined) {
      errors.push(new DslError(`unknown figure attribute "${head}"`, lineNo));
      return;
    }
    details.push({ text: rewritten, srcLine: lineNo });
  });

  // Order matters: props and figures must exist before anything targets them.
  const ordered = [...header, ...props, ...adds, ...details, ...camera];
  const parsed = parseDelta(ordered.map((r) => r.text).join('\n'));
  for (const e of parsed.errors) {
    errors.push(new DslError(e.message, ordered[e.line - 1]?.srcLine ?? 0));
  }
  if (errors.length > 0) {
    return { doc: null, errors };
  }
  const remapped = parsed.commands.map((pl) => ({ ...pl, line: ordered[pl.line - 1]?.srcLine ?? 0 }));
  const res = applyCommands(emptyScene(), remapped, ctx);
  if (res.errors.length > 0) {
    return { doc: null, errors: res.errors };
  }
  return { doc: res.doc, errors: [] };
}
