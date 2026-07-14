// Dependency-free terminal UI primitives, in the style of a promise-based
// prompt flow: raw-mode stdin is parsed into a queue of discrete key events,
// and each screen is an async function that awaits keys and redraws itself.
//
// Two primitives carry the whole UI:
//   - pickFromMenu — vertical option list, arrow / numeric / enter.
//   - runForm      — multi-field form with up/down nav, esc-to-go-back, and an
//                    optional verify callback (red inline error on failure).

import { bold, dim, red } from './ansi.js';

const ESC = '\x1b[';
const CLEAR_SCREEN = `${ESC}2J${ESC}H`;
const HIDE_CURSOR = `${ESC}?25l`;
const SHOW_CURSOR = `${ESC}?25h`;

// ── Stdin key reader ──────────────────────────────────────────────────────
//
// Stdin chunks aren't 1-to-1 with keystrokes — a paste delivers the whole
// string in a single 'data' event, and fast typing or terminal multiplexers
// can batch keys too. We parse every chunk into a queue of discrete key
// events so paste-into-a-field actually captures every character.

export type Key =
  | { name: 'up' | 'down' | 'left' | 'right' | 'enter' | 'backspace' | 'ctrl-c' | 'ctrl-x' | 'escape' }
  | { name: 'char'; ch: string };

const keyQueue: Key[] = [];
let keyWaiter: ((k: Key) => void) | null = null;
let stdinHandler: ((chunk: Buffer | string) => void) | null = null;

function parseKeys(s: string): Key[] {
  const out: Key[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\x1b' && s[i + 1] === '[' && i + 2 < s.length) {
      // CSI sequence: \x1b[ <params> <final>. Consume parameter bytes so keys
      // like Delete (\x1b[3~) or PageUp (\x1b[5~) don't leak their trailing
      // bytes into the input as literal characters.
      let j = i + 2;
      while (j < s.length && /[0-9;]/.test(s[j])) j++;
      const final = s[j];
      if (final === 'A') out.push({ name: 'up' });
      else if (final === 'B') out.push({ name: 'down' });
      else if (final === 'C') out.push({ name: 'right' });
      else if (final === 'D') out.push({ name: 'left' });
      i = j + 1;
      continue;
    }
    if (c === '\x1b' && s[i + 1] === 'O' && i + 2 < s.length) {
      // SS3 arrows (\x1bOA…) — sent instead of CSI by terminals in
      // "application cursor keys" mode; both forms must be handled.
      const code = s[i + 2];
      if (code === 'A') out.push({ name: 'up' });
      else if (code === 'B') out.push({ name: 'down' });
      else if (code === 'C') out.push({ name: 'right' });
      else if (code === 'D') out.push({ name: 'left' });
      i += 3;
      continue;
    }
    if (c === '\x1b') { out.push({ name: 'escape' }); i++; continue; }
    if (c === '\r' || c === '\n') { out.push({ name: 'enter' }); i++; continue; }
    if (c === '\x7f' || c === '\x08') { out.push({ name: 'backspace' }); i++; continue; }
    if (c === '\x03') { out.push({ name: 'ctrl-c' }); i++; continue; }
    if (c === '\x18') { out.push({ name: 'ctrl-x' }); i++; continue; }
    const code = c.charCodeAt(0);
    if (code >= 0x20 && code !== 0x7f) { out.push({ name: 'char', ch: c }); i++; continue; }
    i++;
  }
  return out;
}

function pumpData(chunk: Buffer | string): void {
  const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  for (const k of parseKeys(s)) keyQueue.push(k);
  while (keyWaiter && keyQueue.length > 0) {
    const w = keyWaiter;
    keyWaiter = null;
    w(keyQueue.shift()!);
  }
}

export function readKey(): Promise<Key> {
  return new Promise((resolve) => {
    if (keyQueue.length > 0) return resolve(keyQueue.shift()!);
    keyWaiter = resolve;
  });
}

// ── Terminal lifecycle ────────────────────────────────────────────────────
//
// Raw mode must be undone no matter how the process ends — a crash that
// leaves the terminal raw and cursorless makes the user's shell unusable.
// restoreTerminal is idempotent and registered on exit/SIGINT/SIGTERM.

let tuiActive = false;

function restoreTerminal(): void {
  if (!tuiActive) return;
  tuiActive = false;
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdout.write(SHOW_CURSOR);
}

export function enterTui(): void {
  if (tuiActive) return;
  tuiActive = true;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  stdinHandler = pumpData;
  process.stdin.on('data', stdinHandler);
  process.stdout.write(HIDE_CURSOR);
  process.on('exit', restoreTerminal);
  // In raw mode Ctrl+C arrives as \x03 (handled in the key loop), but an
  // external kill still delivers these signals — restore before dying.
  process.on('SIGINT', () => { restoreTerminal(); process.exit(130); });
  process.on('SIGTERM', () => { restoreTerminal(); process.exit(143); });
}

export function exitTui(): void {
  restoreTerminal();
  if (stdinHandler) {
    process.stdin.removeListener('data', stdinHandler);
    stdinHandler = null;
  }
  process.stdin.pause();
  process.stdout.write(CLEAR_SCREEN);
}

function exitOnCtrlC(): never {
  restoreTerminal();
  process.stdout.write('\n');
  process.exit(130);
}

// ── Header ────────────────────────────────────────────────────────────────

function renderHeader(): string {
  return `${bold('inbox-to-md')}\n${dim('Sync IMAP inboxes to markdown files.')}\n\n`;
}

// ── Menu primitive ────────────────────────────────────────────────────────

export interface MenuOption<V extends string = string> {
  label: string;
  value: V;
}

// Escape is reported rather than swallowed so each caller decides what "back"
// means (quit the menu loop, cancel a delete, …). Ctrl+X is only reported
// when the caller opts in — it's the "remove" gesture on the account list.
export type MenuResult<V extends string> =
  | { kind: 'pick'; value: V }
  | { kind: 'ctrl-x'; value: V }
  | { kind: 'escape' };

function renderMenu<V extends string>(
  title: string,
  options: MenuOption<V>[],
  selected: number,
  footer: string | null,
): string {
  let out = CLEAR_SCREEN;
  out += renderHeader();
  out += `${title}\n`;
  for (let i = 0; i < options.length; i++) {
    const cursor = i === selected ? '>' : ' ';
    const label = `${cursor} [${i + 1}] ${options[i].label}`;
    out += (i === selected ? bold(label) : label) + '\n';
  }
  if (footer) out += '\n' + dim(footer) + '\n';
  return out;
}

export async function pickFromMenu<V extends string>(
  title: string,
  options: MenuOption<V>[],
  footer: string | null = null,
  opts: { enableCtrlX?: boolean } = {},
): Promise<MenuResult<V>> {
  let selected = 0;
  process.stdout.write(renderMenu(title, options, selected, footer));
  while (true) {
    const key = await readKey();
    if (key.name === 'ctrl-c') exitOnCtrlC();
    if (key.name === 'escape') return { kind: 'escape' };
    if (key.name === 'up') {
      selected = (selected - 1 + options.length) % options.length;
    } else if (key.name === 'down') {
      selected = (selected + 1) % options.length;
    } else if (key.name === 'char' && /^[1-9]$/.test(key.ch)) {
      const idx = parseInt(key.ch, 10) - 1;
      if (idx >= 0 && idx < options.length) return { kind: 'pick', value: options[idx].value };
      continue;
    } else if (key.name === 'enter') {
      return { kind: 'pick', value: options[selected].value };
    } else if (key.name === 'ctrl-x' && opts.enableCtrlX) {
      return { kind: 'ctrl-x', value: options[selected].value };
    } else {
      continue;
    }
    process.stdout.write(renderMenu(title, options, selected, footer));
  }
}

// ── Form primitive ────────────────────────────────────────────────────────

export type FieldKind = 'text' | 'secret' | 'number' | 'select';

export interface FormField {
  key: string;
  label: string;
  kind: FieldKind;
  value: string;
  options?: string[]; // required when kind === 'select'
  hint?: string;      // dim sub-label shown under the field (optional)
}

export interface FormSpec {
  title: string;
  hint?: string;
  fields: FormField[];
  // '' suppresses the Save row entirely; Enter then submits from any field.
  submitLabel?: string;
  // Returns null on success or an error string to display in red. Caller stays
  // in the form on failure for retry; on success runForm resolves with values.
  verify?: (values: Record<string, string>) => Promise<string | null>;
}

const CURSOR_BLOCK = '█';

// The block marker is one terminal cell, so it can be appended to display
// strings without re-running width math. Only added on the focused field so
// the user can see exactly where the next keystroke will land.
function fieldValueDisplay(f: FormField, focused: boolean): string {
  if (f.kind === 'secret') return '*'.repeat(f.value.length) + (focused ? CURSOR_BLOCK : '');
  if (f.kind === 'select') {
    const opts = f.options || [];
    const current = f.value || opts[0] || '';
    return focused ? `< ${current} >` : current;
  }
  return f.value + (focused ? CURSOR_BLOCK : '');
}

function renderForm(
  spec: FormSpec,
  focused: number,
  errorLine: string | null,
  status: string | null,
): string {
  let out = CLEAR_SCREEN;
  out += renderHeader();
  out += `${spec.title}\n`;
  out += '\n';

  // Align all value columns to the widest label so the form reads like a
  // table. Width is computed on the raw text (no ANSI) — bold codes are
  // applied after padding so they don't throw off the math.
  const labelWidth = spec.fields.reduce((w, f) => Math.max(w, `  ${f.label}:`.length), 0);
  for (let i = 0; i < spec.fields.length; i++) {
    const f = spec.fields[i];
    const isFocus = i === focused;
    const cursor = isFocus ? '>' : ' ';
    const labelStr = `${cursor} ${f.label}:`;
    const labelOut = isFocus ? bold(labelStr) : labelStr;
    const padding = ' '.repeat(Math.max(0, labelWidth - labelStr.length));
    out += labelOut + padding + '  ' + fieldValueDisplay(f, isFocus) + '\n';
    if (f.hint) out += ' '.repeat(labelWidth + 2) + dim(f.hint) + '\n';
  }

  if (spec.submitLabel !== '') {
    out += '\n';
    const isFocus = focused === spec.fields.length;
    const cursor = isFocus ? '>' : ' ';
    const labelStr = `${cursor} [ ${spec.submitLabel || 'Save'} ]`;
    out += (isFocus ? bold(labelStr) : labelStr) + '\n';
  }

  if (spec.hint) out += '\n' + dim(spec.hint) + '\n';
  if (status) out += '\n' + status + '\n';
  if (errorLine) out += '\n' + red(errorLine) + '\n';
  return out;
}

// Multi-field form runner. Up/Down moves between fields (and the Save row
// when present). Enter on a field advances to the next, or submits when the
// form is Save-less or every field is already filled. Left/Right cycles
// select options. Esc returns 'back' without saving.
export async function runForm(spec: FormSpec): Promise<Record<string, string> | 'back'> {
  // Init select fields with their first option if the caller left value blank.
  for (const f of spec.fields) {
    if (f.kind === 'select' && !f.value && f.options && f.options.length > 0) {
      f.value = f.options[0];
    }
  }
  const rowCount = spec.fields.length + (spec.submitLabel === '' ? 0 : 1);
  const saveRow = spec.fields.length; // index of Save row, even if hidden
  let focused = 0;
  let errorLine: string | null = null;
  let status: string | null = null;

  const draw = (): void => {
    process.stdout.write(renderForm(spec, focused, errorLine, status));
  };
  draw();

  const collect = (): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const f of spec.fields) out[f.key] = f.value;
    return out;
  };

  const trySubmit = async (): Promise<Record<string, string> | null> => {
    if (!spec.verify) return collect();
    status = dim('Verifying…');
    errorLine = null;
    draw();
    const err = await spec.verify(collect());
    status = null;
    if (err === null) return collect();
    errorLine = err;
    // Clear secret fields so they don't show an old, wrong asterisk count.
    for (const f of spec.fields) if (f.kind === 'secret') f.value = '';
    draw();
    return null;
  };

  const allFieldsFilled = (): boolean =>
    spec.fields.every((f) => (f.kind === 'select' ? !!f.value : f.value.trim() !== ''));

  while (true) {
    const key = await readKey();
    if (key.name === 'ctrl-c') exitOnCtrlC();
    if (key.name === 'escape') return 'back';

    const onSave = focused === saveRow && spec.submitLabel !== '';
    const field = focused < spec.fields.length ? spec.fields[focused] : null;

    if (key.name === 'up') {
      focused = (focused - 1 + rowCount) % rowCount;
      draw();
      continue;
    }
    if (key.name === 'down') {
      focused = (focused + 1) % rowCount;
      draw();
      continue;
    }

    if (onSave) {
      if (key.name === 'enter') {
        const submitted = await trySubmit();
        if (submitted) return submitted;
      }
      continue;
    }

    if (!field) continue;

    if (key.name === 'enter') {
      if (spec.submitLabel === '' || allFieldsFilled()) {
        // Save-less form: Enter saves from any field (move with ↑/↓). With a
        // Save row, Enter still submits once every field has a value so the
        // user doesn't have to navigate down past every input.
        const submitted = await trySubmit();
        if (submitted) return submitted;
      } else if (focused < spec.fields.length - 1) {
        focused += 1;
        draw();
      } else {
        focused = saveRow;
        draw();
      }
      continue;
    }

    if (key.name === 'left' || key.name === 'right') {
      if (field.kind === 'select' && field.options && field.options.length > 0) {
        const idx = field.options.indexOf(field.value);
        const step = key.name === 'right' ? 1 : -1;
        const next = (idx + step + field.options.length) % field.options.length;
        field.value = field.options[next];
        draw();
      }
      continue;
    }

    if (key.name === 'backspace') {
      if (field.kind === 'select') continue;
      if (field.value.length > 0) field.value = field.value.slice(0, -1);
      draw();
      continue;
    }

    if (key.name === 'char') {
      if (field.kind === 'select') continue;
      if (field.kind === 'number' && !/[0-9]/.test(key.ch)) continue;
      field.value += key.ch;
      draw();
      continue;
    }
  }
}
