// Linear undo/redo history of applied deltas. Every change to the scene,
// whatever its source, is recorded as a delta script plus before/after docs.

import type { SceneDoc } from '../dsl/types.ts';

export type EntrySource = 'nl' | 'dsl' | 'ui' | 'camera' | 'scene' | 'example';

export interface HistoryEntry {
  id: number;
  source: EntrySource;
  /** what the user typed (natural language or DSL), or a UI description */
  request: string;
  /** the delta that was applied */
  delta: string;
  before: SceneDoc;
  after: SceneDoc;
  /** consecutive entries with the same key merge (slider drags, camera walks) */
  coalesceKey: string | null;
  /** LLM attempts used, when relevant */
  attempts: number;
}

export class History {
  private past: HistoryEntry[] = [];
  private future: HistoryEntry[] = [];
  private nextId = 1;

  get entries(): readonly HistoryEntry[] {
    return this.past;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  push(e: Omit<HistoryEntry, 'id'>): HistoryEntry {
    const top = this.past[this.past.length - 1];
    this.future = [];
    if (top !== undefined && e.coalesceKey !== null && top.coalesceKey === e.coalesceKey) {
      top.after = e.after;
      top.delta = mergeDelta(top.delta, e.delta);
      top.request = e.request;
      return top;
    }
    const entry: HistoryEntry = { ...e, id: this.nextId++ };
    this.past.push(entry);
    if (this.past.length > 200) {
      this.past.shift();
    }
    return entry;
  }

  /** Break coalescing so the next push starts a new entry. */
  seal(): void {
    const top = this.past[this.past.length - 1];
    if (top !== undefined) {
      top.coalesceKey = null;
    }
  }

  undo(): SceneDoc | null {
    const e = this.past.pop();
    if (e === undefined) {
      return null;
    }
    this.future.push(e);
    return e.before;
  }

  redo(): SceneDoc | null {
    const e = this.future.pop();
    if (e === undefined) {
      return null;
    }
    this.past.push(e);
    return e.after;
  }

  clear(): void {
    this.past = [];
    this.future = [];
  }
}

/** When coalescing, later commands replace earlier ones with the same head. */
function mergeDelta(a: string, b: string): string {
  const head = (line: string): string => {
    const t = line.trim().split(/\s+/);
    // e.g. "set runner left_elbow bend" or "camera lens"
    if (t[0] === 'set' || t[0] === 'adjust') {
      return t.slice(0, 4).join(' ');
    }
    if (t[0] === 'body') {
      return t.slice(0, 3).join(' ');
    }
    return t.slice(0, 2).join(' ');
  };
  const out = new Map<string, string>();
  for (const line of [...a.split('\n'), ...b.split('\n')]) {
    if (line.trim().length > 0) {
      const k = head(line);
      out.delete(k);
      out.set(k, line);
    }
  }
  return [...out.values()].join('\n');
}
