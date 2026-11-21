// [natural language] -> [delta DSL] with validation. The LLM only proposes
// text; the deterministic parser and applier decide whether it is valid, and
// their error messages are fed back for a bounded number of repair rounds.

import { applyCommands } from '../dsl/apply.ts';
import type { ApplyContext } from '../dsl/apply.ts';
import { parseDelta } from '../dsl/commands.ts';
import { serializeScene } from '../dsl/sceneText.ts';
import type { SceneDoc } from '../dsl/types.ts';
import { buildRepairMessage, buildSystemPrompt, buildUserMessage, extractDsl } from './prompt.ts';
import type { ModelInfo } from './prompt.ts';
import type { ChatMessage, LlmProvider } from './providers.ts';
import { LlmError } from './providers.ts';

export interface HistoryTurn {
  request: string;
  delta: string;
}

export interface TranslateOptions {
  provider: LlmProvider;
  models: ModelInfo[];
  ctx: ApplyContext;
  history: HistoryTurn[];
  maxRepairs?: number;
  signal?: AbortSignal;
  onAttempt?: (attempt: number, reply: string) => void;
}

export interface TranslateResult {
  delta: string;
  attempts: number;
}

/** Check a delta against the current scene. Returns readable error strings. */
export function validateDelta(doc: SceneDoc, delta: string, ctx: ApplyContext): string[] {
  const parsed = parseDelta(delta);
  const errors = parsed.errors.map((e) => `line ${e.line}: ${e.message}`);
  if (parsed.commands.length === 0 && errors.length === 0) {
    errors.push('no commands');
  }
  if (errors.length > 0) {
    return errors;
  }
  const lines = delta.split(/\r?\n/);
  return applyCommands(doc, parsed.commands, ctx).errors.map((e) => `line ${e.line} "${(lines[e.line - 1] ?? '').trim()}": ${e.message}`);
}

export async function translate(request: string, doc: SceneDoc, opts: TranslateOptions): Promise<TranslateResult> {
  const system = buildSystemPrompt(opts.models);
  const messages: ChatMessage[] = [];
  // Recent turns give the model context for pronouns ("make her ...").
  for (const h of opts.history.slice(-3)) {
    messages.push({ role: 'user', content: `Request: ${h.request}` });
    messages.push({ role: 'assistant', content: `\`\`\`dsl\n${h.delta}\n\`\`\`` });
  }
  messages.push({ role: 'user', content: buildUserMessage(serializeScene(doc), request) });
  const maxRepairs = opts.maxRepairs ?? 2;
  let lastErrors: string[] = [];
  for (let attempt = 1; attempt <= maxRepairs + 1; attempt++) {
    const reply = await opts.provider.complete({ system, messages, maxTokens: 1200, signal: opts.signal });
    opts.onAttempt?.(attempt, reply);
    const delta = extractDsl(reply);
    lastErrors = validateDelta(doc, delta, opts.ctx);
    if (lastErrors.length === 0) {
      return { delta, attempts: attempt };
    }
    messages.push({ role: 'assistant', content: reply });
    messages.push({ role: 'user', content: buildRepairMessage(lastErrors) });
  }
  throw new LlmError(`could not produce valid commands:\n${lastErrors.join('\n')}`);
}
