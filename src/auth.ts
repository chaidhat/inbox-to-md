// `npm run auth` — interactive account management. A menu loop lists the
// configured accounts; Enter edits (or adds), Ctrl+X deletes with a
// confirmation, Esc quits. The add/edit form verifies by actually logging in
// over IMAP before anything is saved.

import { randomUUID } from 'crypto';
import { mkdirSync } from 'fs';
import { isAbsolute } from 'path';
import { dim, red } from './ansi.js';
import { CONFIG_PATH, expandTilde, loadConfig, saveConfig, type Config, type ImapAccount } from './config.js';
import { closeImapClient, createImapClient, describeImapError } from './imap.js';
import { enterTui, exitTui, pickFromMenu, runForm, type FormField, type MenuOption } from './tui.js';

const MENU_FOOTER = '[↑/↓] select · [enter] edit/add · [ctrl+x] delete · [esc] quit';
const FORM_FOOTER = '[↑/↓] move · [enter] verify & save · [esc] back without saving';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Verifies form values: local validation first (cheap, specific messages),
// then a real IMAP login — imapflow authenticates during connect(), so
// success proves host, port, TLS mode, and credentials in one shot.
// Returns null on success or the error string to show in red.
async function verifyAccount(values: Record<string, string>): Promise<string | null> {
  if (values.label.trim() === '') return 'Label is required';
  if (values.host.trim() === '') return 'IMAP host is required';
  const port = parseInt(values.port, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 'Port must be between 1 and 65535';
  if (values.username.trim() === '') return 'Username is required';
  if (values.password === '') return 'Password is required';

  const syncPath = expandTilde(values.syncPath.trim());
  if (syncPath === '') return 'Sync path is required';
  if (!isAbsolute(syncPath)) return 'Sync path must be absolute (or start with ~)';
  // Create the directory now so a bad path fails here, visibly, instead of
  // at sync time.
  try {
    mkdirSync(syncPath, { recursive: true });
  } catch (err) {
    return `Cannot create ${syncPath}: ${errorMessage(err)}`;
  }

  const client = createImapClient({
    host: values.host.trim(),
    port,
    tls: values.tls === 'yes',
    username: values.username.trim(),
    password: values.password,
  });
  try {
    await client.connect();
  } catch (err) {
    return describeImapError(err, values.host.trim(), port);
  }
  await closeImapClient(client);
  return null;
}

function accountFields(existing: ImapAccount | null): FormField[] {
  return [
    { key: 'label', label: 'Label', kind: 'text', value: existing?.label ?? '' },
    { key: 'host', label: 'IMAP host', kind: 'text', value: existing?.host ?? '', hint: 'e.g. imap.gmail.com' },
    { key: 'port', label: 'Port', kind: 'number', value: String(existing?.port ?? 993) },
    { key: 'tls', label: 'TLS', kind: 'select', value: existing ? (existing.tls ? 'yes' : 'no') : 'yes', options: ['yes', 'no'] },
    { key: 'username', label: 'Username', kind: 'text', value: existing?.username ?? '' },
    { key: 'password', label: 'Password', kind: 'secret', value: existing?.password ?? '' },
    { key: 'syncPath', label: 'Sync path', kind: 'text', value: existing?.syncPath ?? '', hint: '~ is expanded; the directory is created if missing' },
  ];
}

// Runs the add/edit form; on verified submit, upserts the account and saves
// to disk immediately so a later crash can't lose it.
async function editAccount(config: Config, index: number | null): Promise<void> {
  const existing = index === null ? null : config.accounts[index];
  const result = await runForm({
    title: existing ? `Edit account: ${existing.label}` : 'Add account',
    hint: FORM_FOOTER,
    fields: accountFields(existing),
    submitLabel: '',
    verify: verifyAccount,
  });
  if (result === 'back') return;

  const account: ImapAccount = {
    id: existing?.id ?? randomUUID(),
    label: result.label.trim(),
    host: result.host.trim(),
    port: parseInt(result.port, 10),
    tls: result.tls === 'yes',
    username: result.username.trim(),
    password: result.password,
    syncPath: expandTilde(result.syncPath.trim()),
  };
  if (index === null) config.accounts.push(account);
  else config.accounts[index] = account;
  saveConfig(config);
}

async function confirmDelete(config: Config, index: number): Promise<void> {
  const account = config.accounts[index];
  const result = await pickFromMenu(
    `Delete "${account.label}"? Synced markdown files are not deleted.`,
    [
      { label: 'Cancel', value: 'cancel' }, // default row: a reflexive double-Enter is safe
      { label: 'Delete', value: 'delete' },
    ],
    '[↑/↓] select · [enter] confirm · [esc] cancel',
  );
  if (result.kind === 'pick' && result.value === 'delete') {
    config.accounts.splice(index, 1);
    saveConfig(config);
  }
}

async function menuLoop(config: Config): Promise<void> {
  while (true) {
    const options: MenuOption[] = [
      ...config.accounts.map((a, i) => ({
        label: `${a.label} (${a.username} @ ${a.host})`,
        value: `account:${i}`,
      })),
      { label: 'Add account', value: 'add' },
      { label: 'Quit', value: 'quit' },
    ];
    const result = await pickFromMenu('Accounts:', options, MENU_FOOTER, { enableCtrlX: true });
    if (result.kind === 'escape') return;
    const accountIndex = result.value.startsWith('account:')
      ? parseInt(result.value.slice('account:'.length), 10)
      : null;
    if (result.kind === 'ctrl-x') {
      if (accountIndex !== null) await confirmDelete(config, accountIndex);
      continue;
    }
    if (result.value === 'quit') return;
    if (result.value === 'add') {
      await editAccount(config, null);
      continue;
    }
    if (accountIndex !== null) await editAccount(config, accountIndex);
  }
}

async function main(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('`npm run auth` needs an interactive terminal.');
    process.exitCode = 1;
    return;
  }
  const config = loadConfig(); // before enterTui so a parse error prints normally
  enterTui();
  try {
    await menuLoop(config);
  } finally {
    exitTui();
  }
  const n = config.accounts.length;
  console.log(`${n} account${n === 1 ? '' : 's'} configured.`);
  console.log(dim(`Config: ${CONFIG_PATH}`));
  console.log(dim('Run `npm start` to sync.'));
}

main().catch((err) => {
  console.error(red(errorMessage(err)));
  process.exitCode = 1;
});
