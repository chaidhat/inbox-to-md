// `inbox-to-md authcli` — non-interactive account management for agents and
// scripts. Inputs are strict flags, successful results are JSON on stdout,
// and failures are JSON on stderr with a nonzero exit status. Passwords are
// accepted but never included in output.

import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { parseAndVerifyAccount, type AccountValues } from './account-auth.js';
import { CONFIG_PATH, loadConfig, saveConfig, type Config, type ImapAccount } from './config.js';

type Action = 'list' | 'add' | 'edit' | 'delete';
type FlagName = 'id' | 'label' | 'host' | 'port' | 'tls' | 'username' | 'password' | 'sync-path';
type Flags = Partial<Record<FlagName, string>> & { passwordStdin: boolean };

const VALUE_FLAGS = new Set<FlagName>([
  'id', 'label', 'host', 'port', 'tls', 'username', 'password', 'sync-path',
]);

const USAGE = `Usage: inbox-to-md authcli <action> [options]

Actions:
  list
  add     --label <label> --host <host> [--port <port>] [--tls yes|no]
          --username <username> (--password <password> | --password-stdin)
          --sync-path <path>
  edit    --id <id> [--label <label>] [--host <host>] [--port <port>]
          [--tls yes|no] [--username <username>]
          [--password <password> | --password-stdin] [--sync-path <path>]
  delete  --id <id>

Options:
  --password-stdin   read the password from stdin without prompting
  -h, --help         show this help

Results are JSON on stdout. Errors are JSON on stderr. Passwords are never output.
Prefer --password-stdin because --password may be visible in process listings and shell history.`;

interface PublicAccount {
  id: string;
  label: string;
  host: string;
  port: number;
  tls: boolean;
  username: string;
  syncPath: string;
}

function publicAccount(account: ImapAccount): PublicAccount {
  const { password: _password, ...safe } = account;
  return safe;
}

function output(value: unknown): void {
  process.stdout.write(JSON.stringify(value) + '\n');
}

function fail(message: string): never {
  process.stderr.write(JSON.stringify({ ok: false, error: message }) + '\n');
  process.exitCode = 1;
  throw new HandledError();
}

class HandledError extends Error {}

function parseArgs(argv: string[]): { action: Action; flags: Flags } | { help: true } {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') return { help: true };

  const action = argv[0];
  if (!['list', 'add', 'edit', 'delete'].includes(action)) {
    fail(`Unknown action "${action}". Expected list, add, edit, or delete.`);
  }

  const flags: Flags = { passwordStdin: false };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') return { help: true };
    if (arg === '--password-stdin') {
      if (flags.passwordStdin) fail('Duplicate flag "--password-stdin".');
      flags.passwordStdin = true;
      continue;
    }
    if (!arg.startsWith('--')) fail(`Unexpected argument "${arg}".`);

    const equals = arg.indexOf('=');
    const name = arg.slice(2, equals === -1 ? undefined : equals) as FlagName;
    if (!VALUE_FLAGS.has(name)) fail(`Unknown flag "--${name}".`);
    if (flags[name] !== undefined) fail(`Duplicate flag "--${name}".`);

    const value = equals === -1 ? argv[++i] : arg.slice(equals + 1);
    if (value === undefined) fail(`--${name} requires a value.`);
    flags[name] = value;
  }

  if (flags.password !== undefined && flags.passwordStdin) {
    fail('Use only one of --password or --password-stdin.');
  }
  return { action: action as Action, flags };
}

function rejectFlags(action: Action, flags: Flags, allowed: FlagName[]): void {
  const allowedSet = new Set(allowed);
  const unexpected = [...VALUE_FLAGS].filter((name) => flags[name] !== undefined && !allowedSet.has(name));
  if (flags.passwordStdin && !allowedSet.has('password')) unexpected.push('password-stdin' as FlagName);
  if (unexpected.length > 0) fail(`${action} does not accept --${unexpected[0]}.`);
}

function required(flags: Flags, name: FlagName): string {
  const value = flags[name];
  if (value === undefined) fail(`--${name} is required.`);
  return value;
}

function readPassword(flags: Flags, requiredForAction: boolean): string | undefined {
  if (flags.password !== undefined) return flags.password;
  if (!flags.passwordStdin) {
    if (requiredForAction) fail('Use --password or --password-stdin.');
    return undefined;
  }
  if (process.stdin.isTTY) fail('--password-stdin requires piped input; it never prompts.');
  return readFileSync(0, 'utf8').replace(/\r?\n$/, '');
}

function findAccount(config: Config, id: string): { account: ImapAccount; index: number } {
  const index = config.accounts.findIndex((account) => account.id === id);
  if (index === -1) fail(`No account found with id "${id}".`);
  return { account: config.accounts[index], index };
}

async function add(config: Config, flags: Flags): Promise<void> {
  rejectFlags('add', flags, ['label', 'host', 'port', 'tls', 'username', 'password', 'sync-path']);
  const values: AccountValues = {
    label: required(flags, 'label'),
    host: required(flags, 'host'),
    port: flags.port ?? '993',
    tls: flags.tls ?? 'yes',
    username: required(flags, 'username'),
    password: readPassword(flags, true)!,
    syncPath: required(flags, 'sync-path'),
  };
  const account: ImapAccount = { id: randomUUID(), ...await parseAndVerifyAccount(values) };
  config.accounts.push(account);
  saveConfig(config);
  output({ ok: true, action: 'added', account: publicAccount(account), configPath: CONFIG_PATH });
}

async function edit(config: Config, flags: Flags): Promise<void> {
  rejectFlags('edit', flags, ['id', 'label', 'host', 'port', 'tls', 'username', 'password', 'sync-path']);
  const { account: existing, index } = findAccount(config, required(flags, 'id'));
  const password = readPassword(flags, false);
  const values: AccountValues = {
    label: flags.label ?? existing.label,
    host: flags.host ?? existing.host,
    port: flags.port ?? String(existing.port),
    tls: flags.tls ?? (existing.tls ? 'yes' : 'no'),
    username: flags.username ?? existing.username,
    password: password ?? existing.password,
    syncPath: flags['sync-path'] ?? existing.syncPath,
  };
  const account: ImapAccount = { id: existing.id, ...await parseAndVerifyAccount(values) };
  config.accounts[index] = account;
  saveConfig(config);
  output({ ok: true, action: 'edited', account: publicAccount(account), configPath: CONFIG_PATH });
}

function remove(config: Config, flags: Flags): void {
  rejectFlags('delete', flags, ['id']);
  const { account, index } = findAccount(config, required(flags, 'id'));
  config.accounts.splice(index, 1);
  saveConfig(config);
  output({ ok: true, action: 'deleted', account: publicAccount(account), configPath: CONFIG_PATH });
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if ('help' in parsed) {
    console.log(USAGE);
    return;
  }

  const { action, flags } = parsed;
  const config = loadConfig();
  if (action === 'list') {
    rejectFlags('list', flags, []);
    output({
      ok: true,
      action: 'listed',
      accounts: config.accounts.map(publicAccount),
      configPath: CONFIG_PATH,
    });
  } else if (action === 'add') {
    await add(config, flags);
  } else if (action === 'edit') {
    await edit(config, flags);
  } else {
    remove(config, flags);
  }
}

main().catch((err) => {
  if (err instanceof HandledError) return;
  process.stderr.write(JSON.stringify({
    ok: false,
    error: err instanceof Error ? err.message : String(err),
  }) + '\n');
  process.exitCode = 1;
});
