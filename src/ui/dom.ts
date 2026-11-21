// Tiny DOM helpers.

type Attr = string | number | boolean | undefined | null | ((e: Event) => void);
type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, Attr> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) {
      continue;
    }
    if (typeof v === 'function') {
      el.addEventListener(k.replace(/^on/, '').toLowerCase(), v);
    } else if (k === 'class') {
      el.className = String(v);
    } else if (k === 'value' && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) {
      el.value = String(v);
    } else if (k === 'checked' && el instanceof HTMLInputElement) {
      el.checked = v === true;
    } else {
      el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) {
      continue;
    }
    el.append(c);
  }
  return el;
}

export interface SliderOpts {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  highlight?: boolean;
  format?: (v: number) => string;
  onInput: (v: number) => void;
  onCommit?: (v: number) => void;
  extra?: Node;
}

export function slider(o: SliderOpts): HTMLElement {
  const fmt = o.format ?? ((v: number) => String(Math.round(v * 100) / 100));
  const val = h('span', { class: 'val' }, fmt(o.value));
  const input = h('input', { type: 'range', min: o.min, max: o.max, step: o.step, value: o.value, 'aria-label': o.label });
  input.addEventListener('input', () => {
    const v = Number(input.value);
    val.textContent = fmt(v);
    o.onInput(v);
  });
  input.addEventListener('change', () => o.onCommit?.(Number(input.value)));
  const label = h('label', { title: o.label }, o.label);
  if (o.extra !== undefined) {
    label.append(' ', o.extra);
  }
  return h('div', { class: `field${o.highlight === true ? ' overridden' : ''}` }, label, input, val);
}

export function selectField(label: string, options: { value: string; label: string }[], value: string, onChange: (v: string) => void): HTMLElement {
  const sel = h('select', { 'aria-label': label });
  for (const o of options) {
    sel.append(h('option', { value: o.value }, o.label));
  }
  sel.value = value;
  sel.addEventListener('change', () => onChange(sel.value));
  return h('div', { class: 'field' }, h('label', {}, label), sel);
}

export function checkbox(label: string, checked: boolean, onChange: (v: boolean) => void): HTMLElement {
  const input = h('input', { type: 'checkbox', checked });
  input.addEventListener('change', () => onChange(input.checked));
  return h('label', { class: 'muted', style: 'display:flex;gap:6px;align-items:center;margin:4px 0' }, input, label);
}
