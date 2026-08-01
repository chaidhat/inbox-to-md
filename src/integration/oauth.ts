// Google OAuth 2 for IMAP, modelled on lieer (https://github.com/gauteh/lieer):
// a one-time consent flow through a loopback redirect mints a refresh token,
// and every later connection trades that refresh token for a short-lived
// access token used with IMAP XOAUTH2. Nothing here talks IMAP — see imap.ts.
//
// Two deliberate differences from lieer:
//
//   * lieer ships a shared OAuth client in its source; inbox-to-md ships none,
//     so the user supplies their own Google Cloud client (see the README). A
//     client id/secret pair for an installed app is not a secret that protects
//     data on its own — only the refresh/access tokens grant access — which is
//     why storing it in config.json next to the tokens is acceptable.
//   * lieer speaks the Gmail HTTP API; we authenticate plain IMAP instead, so
//     the grant needs the full https://mail.google.com/ scope.

import { spawn } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { createServer, type ServerResponse } from 'http';
import { dim } from '../core/ansi.js';
import { updateConfig, type OAuthAccount, type OAuthCredentials } from '../core/config.js';
import { errorMessage } from '../core/errors.js';

export interface OAuthEndpoints {
  authorization: string;
  token: string;
}

export const GOOGLE_ENDPOINTS: OAuthEndpoints = {
  authorization: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
};

// IMAP XOAUTH2 against Gmail is only granted by the full mail scope; the
// narrower gmail.* scopes cover the HTTP API only.
export const GMAIL_SCOPE = 'https://mail.google.com/';

// Connection defaults for a Google account, so `auth add --auth oauth` only
// needs a username and a sync path.
export const GMAIL_IMAP = { host: 'imap.gmail.com', port: 993, tls: true } as const;

export const DEFAULT_AUTHORIZE_TIMEOUT_MS = 300_000;

const TOKEN_REQUEST_TIMEOUT_MS = 30_000;

// Refresh a little early: a token that expires while the IMAP handshake is in
// flight would fail the whole sync for no reason.
const ACCESS_TOKEN_EXPIRY_MARGIN_MS = 60_000;

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

// Carries Google's machine-readable `error` code so callers can distinguish a
// revoked grant (invalid_grant) from a transport failure.
export class OAuthError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'OAuthError';
  }
}

function base64Url(bytes: Buffer): string {
  return bytes.toString('base64url');
}

// Parses the client_secret.json that Google Cloud hands out for a Desktop app
// client ("installed"), tolerating the "web" wrapper and a bare pair.
export function parseClientSecretFile(path: string): OAuthClient {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read client secret file ${path}: ${errorMessage(err)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${path} is not valid JSON (${errorMessage(err)})`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`${path} is not a JSON object`);
  }

  const root = parsed as Record<string, unknown>;
  const section = (root.installed ?? root.web ?? root) as Record<string, unknown>;
  const clientId = section.client_id;
  const clientSecret = section.client_secret;
  if (typeof clientId !== 'string' || clientId === '' || typeof clientSecret !== 'string' || clientSecret === '') {
    throw new Error(
      `${path} has no "client_id"/"client_secret" — expected the client_secret.json downloaded ` +
      `for a Google Cloud "Desktop app" OAuth client.`,
    );
  }
  return { clientId, clientSecret };
}

interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
}

async function postToken(endpoints: OAuthEndpoints, params: Record<string, string>): Promise<TokenResponse> {
  let response: Response;
  try {
    response = await fetch(endpoints.token, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new OAuthError(`Cannot reach ${endpoints.token}: ${errorMessage(err)}`, 'unreachable');
  }

  // Read as text first so a proxy's HTML error page produces a clear message
  // rather than a JSON parse stack. The body is never echoed: a 200 body holds
  // tokens, and even error bodies are not worth putting in logs.
  const body = await response.text();
  let parsed: TokenResponse;
  try {
    parsed = JSON.parse(body) as TokenResponse;
  } catch {
    throw new OAuthError(
      `Token endpoint ${endpoints.token} returned a non-JSON response (HTTP ${response.status})`,
      'malformed_response',
    );
  }

  if (!response.ok) {
    const failure = parsed as { error?: unknown; error_description?: unknown };
    const code = typeof failure.error === 'string' ? failure.error : `http_${response.status}`;
    const description = typeof failure.error_description === 'string' ? `: ${failure.error_description}` : '';
    throw new OAuthError(`Google rejected the token request (${code})${description}`, code);
  }
  return parsed;
}

interface MintedAccessToken {
  accessToken: string;
  expiresAt: number;
}

function readAccessToken(response: TokenResponse, endpoints: OAuthEndpoints): MintedAccessToken {
  if (typeof response.access_token !== 'string' || response.access_token === '') {
    throw new OAuthError(`${endpoints.token} returned no access_token`, 'malformed_response');
  }
  // Treat a missing/odd expires_in as "expires now" rather than guessing long:
  // the next connect just refreshes again, which is cheap and always correct.
  const expiresIn = typeof response.expires_in === 'number' && Number.isFinite(response.expires_in)
    ? response.expires_in
    : 0;
  return { accessToken: response.access_token, expiresAt: Date.now() + expiresIn * 1000 };
}

function respondToBrowser(res: ServerResponse, status: number, heading: string, detail: string): void {
  const page = `<!doctype html><meta charset="utf-8"><title>inbox-to-md</title>` +
    `<body style="font:16px system-ui;margin:3rem;max-width:34rem">` +
    `<h1 style="font-size:1.25rem">${heading}</h1><p>${detail}</p></body>`;
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', connection: 'close' });
  res.end(page);
}

// Opens the consent URL in the user's browser. Best-effort: the URL is always
// printed too, so a failure here is a warning and never blocks the flow.
function openInBrowser(url: string): void {
  const [command, args] = process.platform === 'darwin'
    ? ['open', [url]]
    : process.platform === 'win32'
      // `start` is a cmd builtin, and the URL's `&` would otherwise be read as
      // a command separator; quoting is safe because the URL we build is
      // percent-encoded and so can never contain a double quote.
      ? ['cmd', ['/c', 'start', '""', `"${url}"`]]
      : ['xdg-open', [url]];
  try {
    const child = spawn(command, args as string[], { stdio: 'ignore', detached: true });
    child.on('error', (err) => {
      process.stderr.write(dim(`Could not launch ${command}: ${errorMessage(err)} — open the URL above yourself.`) + '\n');
    });
    child.unref();
  } catch (err) {
    process.stderr.write(dim(`Could not launch ${command}: ${errorMessage(err)} — open the URL above yourself.`) + '\n');
  }
}

interface LoopbackRedirect {
  code: string;
  redirectUri: string;
}

// Runs the loopback half of the flow: listens on an ephemeral 127.0.0.1 port
// (Google allows any loopback port for installed apps, so nothing has to be
// pre-registered), hands the consent URL to `announce`, and resolves with the
// authorization code Google redirects back.
async function awaitAuthorizationCode(
  buildUrl: (redirectUri: string) => string,
  announce: (url: string) => void,
  state: string,
  timeoutMs: number,
): Promise<LoopbackRedirect> {
  const server = createServer();
  try {
    const redirectUri = await new Promise<string>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address === null || typeof address === 'string') {
          reject(new Error('loopback server reported no port'));
          return;
        }
        resolve(`http://127.0.0.1:${address.port}`);
      });
    });

    const code = await new Promise<string>((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      // Whichever of redirect / error / timeout happens first wins; the rest
      // become no-ops, and the timer is always cleared.
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      timer = setTimeout(() => {
        finish(() => reject(new Error(
          `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the Google authorization redirect. ` +
          `Re-run the command, or pass --timeout <seconds> for longer.`,
        )));
      }, timeoutMs);
      timer.unref(); // the listening server already keeps the process alive

      server.on('error', (err) => finish(() => reject(err)));
      server.on('request', (req, res) => {
        const url = new URL(req.url ?? '/', redirectUri);
        if (url.pathname !== '/') {
          // Browsers ask for /favicon.ico; answering 404 keeps those out of the flow.
          res.writeHead(404, { connection: 'close' });
          res.end();
          return;
        }

        const failure = url.searchParams.get('error');
        const returnedState = url.searchParams.get('state');
        const returnedCode = url.searchParams.get('code');

        if (returnedState !== state) {
          // Either a stale tab from an earlier attempt or a forged redirect —
          // fail the whole flow rather than trusting the code.
          respondToBrowser(res, 400, 'Authorization failed', 'The redirect did not match this session. Re-run the command.');
          finish(() => reject(new Error('Authorization redirect had an unexpected state parameter — nothing was saved.')));
          return;
        }
        if (failure !== null) {
          respondToBrowser(res, 400, 'Authorization failed', `Google reported: ${failure}. You can close this tab.`);
          finish(() => reject(new Error(`Google denied the authorization request (${failure})`)));
          return;
        }
        if (returnedCode === null || returnedCode === '') {
          respondToBrowser(res, 400, 'Authorization failed', 'No authorization code was returned. You can close this tab.');
          finish(() => reject(new Error('Authorization redirect carried no code — nothing was saved.')));
          return;
        }

        respondToBrowser(res, 200, 'inbox-to-md is authorized', 'You can close this tab and return to the terminal.');
        finish(() => resolve(returnedCode));
      });

      announce(buildUrl(redirectUri));
    });

    return { code, redirectUri };
  } finally {
    server.close();
    server.closeAllConnections();
  }
}

export interface AuthorizeOptions {
  client: OAuthClient;
  // Pre-selects the Google account on the consent screen. Not a security
  // control: the user can still pick another account, which is why the IMAP
  // verification afterwards is what actually proves the username.
  loginHint?: string;
  openBrowser: boolean;
  timeoutMs?: number;
  endpoints?: OAuthEndpoints;
  // Where to show the consent URL. Defaults to stderr so stdout stays pure
  // JSON for scripts.
  announce?: (url: string) => void;
}

function defaultAnnounce(url: string): void {
  process.stderr.write(
    `\nOpen this URL to authorize inbox-to-md (waiting for the redirect):\n\n${url}\n\n` +
    dim('Google shows an "unverified app" warning for your own OAuth client — continue past it.') + '\n',
  );
}

// Runs the full consent flow and returns credentials ready to store. PKCE is
// used even though the client has a secret: the authorization code travels
// through a loopback port that any local process could race for, and the
// verifier is what makes a stolen code useless.
export async function authorize(options: AuthorizeOptions): Promise<OAuthCredentials> {
  const endpoints = options.endpoints ?? GOOGLE_ENDPOINTS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_AUTHORIZE_TIMEOUT_MS;
  const announce = options.announce ?? defaultAnnounce;

  const verifier = base64Url(randomBytes(64));
  const challenge = base64Url(createHash('sha256').update(verifier).digest());
  const state = base64Url(randomBytes(24));

  const buildUrl = (redirectUri: string): string => {
    const url = new URL(endpoints.authorization);
    url.search = new URLSearchParams({
      client_id: options.client.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: GMAIL_SCOPE,
      // offline + consent: without both, a re-authorization of an account that
      // already granted access comes back without a refresh_token.
      access_type: 'offline',
      prompt: 'consent',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      ...(options.loginHint ? { login_hint: options.loginHint } : {}),
    }).toString();
    return url.toString();
  };

  const { code, redirectUri } = await awaitAuthorizationCode(
    buildUrl,
    (url) => {
      announce(url);
      if (options.openBrowser) openInBrowser(url);
    },
    state,
    timeoutMs,
  );

  const response = await postToken(endpoints, {
    client_id: options.client.clientId,
    client_secret: options.client.clientSecret,
    code,
    code_verifier: verifier,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  });

  if (typeof response.refresh_token !== 'string' || response.refresh_token === '') {
    throw new OAuthError(
      'Google returned no refresh_token, so the account could not be stored for unattended sync. ' +
      'Revoke inbox-to-md at https://myaccount.google.com/permissions and try again.',
      'no_refresh_token',
    );
  }
  // Fail here rather than at IMAP login time, where a missing scope surfaces
  // as an opaque authentication failure.
  if (typeof response.scope === 'string' && !response.scope.split(' ').includes(GMAIL_SCOPE)) {
    throw new OAuthError(
      `The granted scopes (${response.scope}) do not include ${GMAIL_SCOPE}, which IMAP access requires. ` +
      `Add that scope to the OAuth client's consent screen and authorize again.`,
      'insufficient_scope',
    );
  }

  const minted = readAccessToken(response, endpoints);
  return {
    clientId: options.client.clientId,
    clientSecret: options.client.clientSecret,
    refreshToken: response.refresh_token,
    accessToken: minted.accessToken,
    accessTokenExpiresAt: minted.expiresAt,
  };
}

// An account whose tokens we may need to refresh. `id` is absent while
// `auth add`/`auth reauth` is still verifying a not-yet-saved account.
export type OAuthAccountRef = Omit<OAuthAccount, 'id'> & { id?: string };

async function cacheAccessToken(id: string, minted: MintedAccessToken): Promise<void> {
  // Best effort: a token we cannot cache only costs one extra refresh next
  // run, so a read-only config or a concurrent edit must not fail a sync — but
  // it is reported rather than swallowed. The update is locked because parallel
  // account syncs reach here at the same time, each holding only its own
  // account's news.
  try {
    await updateConfig((config) => {
      const account = config.accounts.find((a) => a.id === id);
      if (account === undefined || account.auth !== 'oauth') return;
      account.oauth.accessToken = minted.accessToken;
      account.oauth.accessTokenExpiresAt = minted.expiresAt;
    });
  } catch (err) {
    process.stderr.write(dim(`Warning: could not cache the refreshed access token: ${errorMessage(err)}`) + '\n');
  }
}

// Returns a usable access token, refreshing through Google when the cached one
// is missing or about to expire.
export async function getAccessToken(
  account: OAuthAccountRef,
  endpoints: OAuthEndpoints = GOOGLE_ENDPOINTS,
): Promise<string> {
  const credentials = account.oauth;
  if (
    credentials.accessToken !== undefined &&
    credentials.accessTokenExpiresAt !== undefined &&
    credentials.accessTokenExpiresAt - ACCESS_TOKEN_EXPIRY_MARGIN_MS > Date.now()
  ) {
    return credentials.accessToken;
  }

  let response: TokenResponse;
  try {
    response = await postToken(endpoints, {
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      refresh_token: credentials.refreshToken,
      grant_type: 'refresh_token',
    });
  } catch (err) {
    if (err instanceof OAuthError && err.code === 'invalid_grant') {
      const target = account.id === undefined ? '' : ` --id ${account.id}`;
      throw new OAuthError(
        `Google rejected the stored refresh token for ${account.label} (it was revoked, expired, or the ` +
        `OAuth client changed). Re-authorize with \`inbox-to-md auth reauth${target}\`.`,
        err.code,
      );
    }
    throw err;
  }

  const minted = readAccessToken(response, endpoints);
  // Keep the in-memory account current so the rest of this run reuses it.
  credentials.accessToken = minted.accessToken;
  credentials.accessTokenExpiresAt = minted.expiresAt;
  if (account.id !== undefined) await cacheAccessToken(account.id, minted);
  return minted.accessToken;
}
