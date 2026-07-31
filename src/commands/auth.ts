// `inbox-to-md auth <action>` — account management for agents, scripts, and
// people. Inputs are strict flags, successful results are JSON on stdout, and
// failures are JSON on stderr with a nonzero exit status. There is no
// interactive mode: the only step that ever needs a human is the Google
// consent screen, and its URL is printed to stderr so stdout stays pure JSON.
//
// Secrets (passwords, refresh tokens, access tokens) are accepted but never
// included in output.

import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import {
  buildAccount,
  ensureSyncDir,
  parseFields,
  verifyAccount,
  type AccountFieldValues,
  type CredentialInput,
  type ParsedFields,
} from '../core/account-auth.js';
import {
  CONFIG_PATH,
  expandTilde,
  loadConfig,
  updateConfig,
  type Account,
  type AuthMethod,
  type Config,
  type OAuthAccount,
} from '../core/config.js';
import { errorMessage } from '../core/errors.js';
import type { Transport } from '../core/mail-source.js';
import { resolveTransport } from '../integration/open.js';
import {
  authorize,
  DEFAULT_AUTHORIZE_TIMEOUT_MS,
  GMAIL_IMAP,
  parseClientSecretFile,
  type OAuthClient,
} from '../integration/oauth.js';

type Action = 'list' | 'add' | 'edit' | 'delete' | 'reauth';
const ACTIONS: Action[] = ['list', 'add', 'edit', 'delete', 'reauth'];

type ValueFlag =
  | 'auth' | 'id' | 'label' | 'host' | 'port' | 'tls' | 'username' | 'password' | 'sync-path'
  | 'transport' | 'client-id' | 'client-secret' | 'client-secret-file' | 'timeout';
type BooleanFlag = 'password-stdin' | 'no-browser';

const VALUE_FLAGS = new Set<ValueFlag>([
  'auth', 'id', 'label', 'host', 'port', 'tls', 'username', 'password', 'sync-path',
  'transport', 'client-id', 'client-secret', 'client-secret-file', 'timeout',
]);
const BOOLEAN_FLAGS = new Set<BooleanFlag>(['password-stdin', 'no-browser']);

interface Flags {
  value: Partial<Record<ValueFlag, string>>;
  bool: Set<BooleanFlag>;
}

// Flags each action accepts. `add` narrows further once --auth is known, so
// password flags cannot leak into an OAuth account or vice versa.
const COMMON_FIELD_FLAGS: ValueFlag[] = ['label', 'host', 'port', 'tls', 'username', 'sync-path', 'transport'];
const OAUTH_CLIENT_FLAGS: ValueFlag[] = ['client-id', 'client-secret', 'client-secret-file', 'timeout'];

const USAGE = `Usage: inbox-to-md auth <action> [options]

Actions:
  list
  add     --auth password --label <label> --host <host> [--port <port>] [--tls yes|no]
          --username <username> (--password <password> | --password-stdin)
          --sync-path <path>
  add     --auth oauth --label <label> --username <email> --sync-path <path>
          (--client-secret-file <client_secret.json> | --client-id <id> --client-secret <secret>)
          [--host ${GMAIL_IMAP.host}] [--port ${GMAIL_IMAP.port}] [--tls yes|no]
          [--no-browser] [--timeout <seconds>]
  edit    --id <id> [--label <label>] [--host <host>] [--port <port>] [--tls yes|no]
          [--username <username>] [--password <password> | --password-stdin]
          [--sync-path <path>]
  reauth  --id <id> [--client-secret-file <client_secret.json>]
          [--client-id <id> --client-secret <secret>] [--no-browser] [--timeout <seconds>]
  delete  --id <id>

Options:
  --auth password|oauth   how the account authenticates (required for add)
  --transport imap|gmail  how the account reaches its mail. Defaults to gmail for
                          Google OAuth accounts (incremental, far fewer requests)
                          and imap for everything else.
  --password-stdin        read the password from stdin without prompting
  --no-browser            print the authorization URL instead of opening a browser
  --timeout <seconds>     how long to wait for the authorization redirect (default ${DEFAULT_AUTHORIZE_TIMEOUT_MS / 1000})
  -h, --help              show this help

Results are JSON on stdout. Errors are JSON on stderr. Passwords and OAuth tokens
are never output. Prefer --password-stdin because --password may be visible in
process listings and shell history.

OAuth requires your own Google Cloud OAuth client with the https://mail.google.com/
scope — see the README section "OAuth (Google)". \`reauth\` re-runs the consent flow
for an existing account, reusing its stored client unless a new one is given.`;

interface PublicAccount {
  id: string;
  label: string;
  host: string;
  port: number;
  tls: boolean;
  username: string;
  syncPath: string;
  auth: AuthMethod;
  // The transport actually in effect, derived when the account does not pin
  // one — so `auth list` answers "how will this sync?" rather than making the
  // reader re-derive it from the host and auth method.
  transport: Transport;
  clientId?: string; // OAuth accounts only; a client id is not a secret
}

// Built field by field rather than by stripping a copy, so a future credential
// field cannot accidentally end up in output.
function publicAccount(account: Account): PublicAccount {
  const safe: PublicAccount = {
    id: account.id,
    label: account.label,
    host: account.host,
    port: account.port,
    tls: account.tls,
    username: account.username,
    syncPath: account.syncPath,
    auth: account.auth,
    transport: resolveTransport(account),
  };
  if (account.auth === 'oauth') safe.clientId = account.oauth.clientId;
  return safe;
}

// Indented so a person reading the terminal can scan the result. Each stream
// still carries exactly one JSON document per run, so `jq` and friends parse
// it unchanged.
function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n';
}

function output(value: unknown): void {
  process.stdout.write(formatJson(value));
}

class HandledError extends Error {}

function fail(message: string): never {
  process.stderr.write(formatJson({ ok: false, error: message }));
  process.exitCode = 1;
  throw new HandledError();
}

function parseArgs(argv: string[]): { action: Action; flags: Flags } | { help: true } {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') return { help: true };

  const action = argv[0];
  if (!ACTIONS.includes(action as Action)) {
    fail(`Unknown action "${action}". Expected ${ACTIONS.join(', ')}.`);
  }

  const flags: Flags = { value: {}, bool: new Set() };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') return { help: true };
    if (!arg.startsWith('--')) fail(`Unexpected argument "${arg}".`);

    const equals = arg.indexOf('=');
    const name = arg.slice(2, equals === -1 ? undefined : equals);

    if (BOOLEAN_FLAGS.has(name as BooleanFlag)) {
      if (equals !== -1) fail(`--${name} does not take a value.`);
      if (flags.bool.has(name as BooleanFlag)) fail(`Duplicate flag "--${name}".`);
      flags.bool.add(name as BooleanFlag);
      continue;
    }
    if (!VALUE_FLAGS.has(name as ValueFlag)) fail(`Unknown flag "--${name}".`);
    if (flags.value[name as ValueFlag] !== undefined) fail(`Duplicate flag "--${name}".`);

    const value = equals === -1 ? argv[++i] : arg.slice(equals + 1);
    if (value === undefined) fail(`--${name} requires a value.`);
    flags.value[name as ValueFlag] = value;
  }

  if (flags.value.password !== undefined && flags.bool.has('password-stdin')) {
    fail('Use only one of --password or --password-stdin.');
  }
  return { action: action as Action, flags };
}

// Rejects anything the action (or, for `add`, the chosen auth method) does not
// accept, so a misplaced flag is an error rather than a silent no-op.
function rejectFlags(context: string, flags: Flags, allowedValues: ValueFlag[], allowedBooleans: BooleanFlag[]): void {
  const allowedValueSet = new Set(allowedValues);
  const unexpectedValue = [...VALUE_FLAGS].find((name) => flags.value[name] !== undefined && !allowedValueSet.has(name));
  if (unexpectedValue !== undefined) fail(`${context} does not accept --${unexpectedValue}.`);

  const allowedBooleanSet = new Set(allowedBooleans);
  const unexpectedBoolean = [...flags.bool].find((name) => !allowedBooleanSet.has(name));
  if (unexpectedBoolean !== undefined) fail(`${context} does not accept --${unexpectedBoolean}.`);
}

function required(flags: Flags, name: ValueFlag): string {
  const value = flags.value[name];
  if (value === undefined) fail(`--${name} is required.`);
  return value;
}

function requireAuthMethod(flags: Flags): AuthMethod {
  const value = required(flags, 'auth');
  if (value !== 'password' && value !== 'oauth') {
    fail(`--auth must be "password" or "oauth" (got "${value}").`);
  }
  return value;
}

function readPassword(flags: Flags, requiredForAction: boolean): string | undefined {
  const literal = flags.value.password;
  if (literal !== undefined) return literal;
  if (!flags.bool.has('password-stdin')) {
    if (requiredForAction) fail('Use --password or --password-stdin.');
    return undefined;
  }
  if (process.stdin.isTTY) fail('--password-stdin requires piped input; it never prompts.');
  return readFileSync(0, 'utf8').replace(/\r?\n$/, '');
}

function parseTimeoutMs(flags: Flags): number {
  const value = flags.value.timeout;
  if (value === undefined) return DEFAULT_AUTHORIZE_TIMEOUT_MS;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 3600) {
    fail('--timeout must be a whole number of seconds between 1 and 3600.');
  }
  return Number(value) * 1000;
}

// Resolves the Google OAuth client to authorize against. `fallback` is the
// client already stored on the account (reauth), used when no client flags are
// given.
function resolveOAuthClient(flags: Flags, fallback: OAuthClient | null): OAuthClient {
  const file = flags.value['client-secret-file'];
  const clientId = flags.value['client-id'];
  const clientSecret = flags.value['client-secret'];

  if (file !== undefined) {
    if (clientId !== undefined || clientSecret !== undefined) {
      fail('Use either --client-secret-file or --client-id with --client-secret, not both.');
    }
    return parseClientSecretFile(expandTilde(file));
  }
  if (clientId !== undefined && clientSecret !== undefined) {
    if (clientId === '' || clientSecret === '') fail('--client-id and --client-secret cannot be empty.');
    return { clientId, clientSecret };
  }
  if (clientId !== undefined || clientSecret !== undefined) {
    fail('--client-id and --client-secret must be given together.');
  }
  if (fallback !== null) return fallback;
  fail(
    'OAuth needs your own Google Cloud OAuth client: pass --client-secret-file <client_secret.json>, ' +
    'or --client-id and --client-secret. See the README section "OAuth (Google)".',
  );
}

// Runs the consent flow for `fields`, which have already been validated so the
// user is never sent to a browser for an account that cannot be saved.
async function authorizeOAuth(flags: Flags, fields: ParsedFields, client: OAuthClient): Promise<CredentialInput> {
  ensureSyncDir(fields.syncPath);
  const oauth = await authorize({
    client,
    loginHint: fields.username,
    openBrowser: !flags.bool.has('no-browser'),
    timeoutMs: parseTimeoutMs(flags),
  });
  return { auth: 'oauth', oauth };
}

function findAccount(config: Config, id: string): { account: Account; index: number } {
  const index = config.accounts.findIndex((account) => account.id === id);
  if (index === -1) fail(`No account found with id "${id}".`);
  return { account: config.accounts[index], index };
}

// Writes by account id rather than by the index it had when the config was
// loaded: `add --auth oauth` holds its snapshot across the whole consent
// screen, and a sync caching a refreshed token in the meantime would shift
// those positions out from under us.
async function commit(account: Account, action: string): Promise<void> {
  await updateConfig((config) => {
    const index = config.accounts.findIndex((a) => a.id === account.id);
    if (index === -1) config.accounts.push(account);
    else config.accounts[index] = account;
  });
  output({ ok: true, action, account: publicAccount(account), configPath: CONFIG_PATH });
}

async function add(config: Config, flags: Flags): Promise<void> {
  const method = requireAuthMethod(flags);

  if (method === 'password') {
    rejectFlags('add --auth password', flags, ['auth', ...COMMON_FIELD_FLAGS, 'password'], ['password-stdin']);
    const fields = parseFields({
      label: required(flags, 'label'),
      host: required(flags, 'host'),
      port: flags.value.port ?? '993',
      tls: flags.value.tls ?? 'yes',
      username: required(flags, 'username'),
      syncPath: required(flags, 'sync-path'),
      transport: flags.value.transport,
    });
    const credential: CredentialInput = { auth: 'password', password: readPassword(flags, true)! };
    const draft = buildAccount(fields, credential);
    await verifyAccount(draft);
    await commit({ id: randomUUID(), ...draft }, 'added');
    return;
  }

  rejectFlags('add --auth oauth', flags, ['auth', ...COMMON_FIELD_FLAGS, ...OAUTH_CLIENT_FLAGS], ['no-browser']);
  const client = resolveOAuthClient(flags, null);
  // Gmail's IMAP endpoint is the default because a Google OAuth token is only
  // useful there; --host stays available for Workspace setups that differ.
  const fields = parseFields({
    label: required(flags, 'label'),
    host: flags.value.host ?? GMAIL_IMAP.host,
    port: flags.value.port ?? String(GMAIL_IMAP.port),
    tls: flags.value.tls ?? (GMAIL_IMAP.tls ? 'yes' : 'no'),
    username: required(flags, 'username'),
    syncPath: required(flags, 'sync-path'),
    transport: flags.value.transport,
  });
  const draft = buildAccount(fields, await authorizeOAuth(flags, fields, client));
  await verifyAccount(draft);
  await commit({ id: randomUUID(), ...draft }, 'added');
}

async function edit(config: Config, flags: Flags): Promise<void> {
  rejectFlags('edit', flags, ['id', ...COMMON_FIELD_FLAGS, 'password'], ['password-stdin']);
  const { account: existing, index } = findAccount(config, required(flags, 'id'));

  const fields = parseFields({
    label: flags.value.label ?? existing.label,
    host: flags.value.host ?? existing.host,
    port: flags.value.port ?? String(existing.port),
    tls: flags.value.tls ?? (existing.tls ? 'yes' : 'no'),
    username: flags.value.username ?? existing.username,
    syncPath: flags.value['sync-path'] ?? existing.syncPath,
    transport: flags.value.transport ?? existing.transport,
  });

  let credential: CredentialInput;
  if (existing.auth === 'password') {
    const password = readPassword(flags, false);
    credential = { auth: 'password', password: password ?? existing.password };
  } else {
    if (flags.value.password !== undefined || flags.bool.has('password-stdin')) {
      fail(`Account "${existing.id}" authenticates with OAuth — run \`inbox-to-md auth reauth --id ${existing.id}\` instead of setting a password.`);
    }
    credential = { auth: 'oauth', oauth: existing.oauth };
  }

  const draft = buildAccount(fields, credential);
  await verifyAccount(draft);
  await commit({ id: existing.id, ...draft }, 'edited');
}

// Re-runs the consent flow for an existing OAuth account, keeping its
// connection settings. The old refresh token is only replaced once the new
// grant has been verified over IMAP.
async function reauth(config: Config, flags: Flags): Promise<void> {
  rejectFlags('reauth', flags, ['id', ...OAUTH_CLIENT_FLAGS], ['no-browser']);
  const { account: existing, index } = findAccount(config, required(flags, 'id'));
  if (existing.auth !== 'oauth') {
    fail(`Account "${existing.id}" authenticates with a password — use \`inbox-to-md auth edit --id ${existing.id} --password-stdin\`.`);
  }
  const oauthAccount: OAuthAccount = existing;
  const client = resolveOAuthClient(flags, {
    clientId: oauthAccount.oauth.clientId,
    clientSecret: oauthAccount.oauth.clientSecret,
  });
  const fields = parseFields({
    label: oauthAccount.label,
    host: oauthAccount.host,
    port: String(oauthAccount.port),
    tls: oauthAccount.tls ? 'yes' : 'no',
    username: oauthAccount.username,
    syncPath: oauthAccount.syncPath,
    transport: oauthAccount.transport,
  });
  const draft = buildAccount(fields, await authorizeOAuth(flags, fields, client));
  await verifyAccount(draft);
  await commit({ id: oauthAccount.id, ...draft }, 'reauthorized');
}

async function remove(config: Config, flags: Flags): Promise<void> {
  rejectFlags('delete', flags, ['id'], []);
  // Looked up first so an unknown id is reported without taking the lock, then
  // deleted by id inside it — same reason `commit` does not trust an index.
  const { account } = findAccount(config, required(flags, 'id'));
  await updateConfig((current) => {
    const index = current.accounts.findIndex((a) => a.id === account.id);
    if (index !== -1) current.accounts.splice(index, 1);
  });
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
    rejectFlags('list', flags, [], []);
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
  } else if (action === 'reauth') {
    await reauth(config, flags);
  } else {
    await remove(config, flags);
  }
}

main().catch((err: unknown) => {
  if (err instanceof HandledError) return;
  process.stderr.write(formatJson({ ok: false, error: errorMessage(err) }));
  process.exitCode = 1;
});
