---
name: verify
description: How to verify inbox-to-md end-to-end - drive the auth CLI and sync against a local fake IMAP server and fake Google OAuth endpoints, without real credentials or touching a real config.
---

# Verifying inbox-to-md

Every surface is non-interactive: `inbox-to-md auth <action>` (flags in, JSON out)
and `sync`/`compact`/`archive`. No PTY tricks are needed. Run the built
`dist/cli.js` (`npm run build` first) so you test what ships; `tsx src/*.ts`
works for quick iteration.

## Guard the real config

State lives at `~/.config/inbox-to-md/config.json` and there is no path
override — but `homedir()` follows `$HOME`, so run everything with
`HOME=<scratch dir>`. That isolates the real config completely; never back up
and restore it instead.

## Fake IMAP server

A ~150-line Node `net` server speaking minimal IMAP4rev1 satisfies imapflow over
plaintext (account with `tls: no`). It must answer: greeting
`* OK [CAPABILITY IMAP4rev1] ready`, `CAPABILITY`, `LOGIN` (reply
`NO [AUTHENTICATIONFAILED]` to test the wrong-password path), `LIST`, `LSUB`,
`SELECT` (EXISTS/FLAGS/UIDVALIDITY/UIDNEXT + `OK [READ-WRITE]`), `UID SEARCH`
(`* SEARCH 1 2 …`), `UID FETCH` with ENVELOPE (`(NIL NIL NIL NIL NIL NIL NIL
NIL NIL "<message-id>")` — only message-id is read in phase A) and with the
body part named by BODYSTRUCTURE, `LOGOUT`. Skipping `LSUB` makes every sync
fail with a bare "Command failed". A known-good copy from a past session:
`fake-imap.mjs` in the session scratchpad.

LIST gotcha: imapflow first sends `LIST "" ""` (root/delimiter discovery) and
builds every mailbox path from the reply — that command must return ONLY
`* LIST (\Noselect) "/" ""`, not the mailbox list, or paths get a bogus
prefix and SELECT hits the wrong mailbox. Answer the real `LIST … *` with the
mailbox lines (mark Sent with the `\Sent` flag). Make unknown SELECT return
`NO` so a wrong path fails loudly instead of silently syncing INBOX twice.

To test OAuth accounts the same server needs `AUTH=XOAUTH2` in its CAPABILITY
and must handle `<tag> AUTHENTICATE XOAUTH2 <base64>` inline (imapflow sends the
SASL initial response with the command). The payload decodes to
`user=<u>\x01auth=Bearer <token>\x01\x01`. To reject a token, send
`+ <base64 json>`, wait for imapflow's empty continuation line, then
`<tag> NO [AUTHENTICATIONFAILED]` — that is the shape Gmail uses, and it is what
makes `describeImapError` produce the reauth hint.

## Fake Google OAuth

`authorize()` and `getAccessToken()` in `src/oauth.ts` take an `endpoints`
argument that defaults to Google. There is no env override on purpose — a test
harness injects its own endpoints by importing the module directly (`dist/oauth.js`
from a scratch `.mjs` script). A fake server needs `/authorize` (302 straight back
to `redirect_uri` with `code` + the same `state`, standing in for the browser) and
`/token` (checking client id/secret, PKCE S256 verifier vs. challenge,
`redirect_uri`, and the grant type). `authorize({announce})` receives the consent
URL, so the harness plays the browser with `fetch(url)` — undici follows the
redirect to the loopback port.

Worth covering there: refresh-token reuse vs. cached token, early refresh inside
the expiry margin, revoked token → `invalid_grant` naming `auth reauth --id`,
forged `state`, timeout, a grant missing `https://mail.google.com/`, and a
rejected client.

The shipped CLI always talks to the real Google, so end-to-end OAuth through
`dist/cli.js` can only be checked up to the redirect: run
`auth add --auth oauth --client-id … --client-secret … --no-browser --timeout 3`
and assert the printed URL (scope, `access_type=offline`, `prompt=consent`,
`code_challenge_method=S256`, loopback `redirect_uri`) and the clean timeout.

## Flows worth driving

- `auth add --auth password` against the fake server: JSON `ok`, no password in
  output, config `0600`, `version: 2`.
- Wrong password → JSON error on stderr, exit 1, nothing stored.
- `sync` twice: first run N new, second run 0 new (envelope-only phase).
- Delete one .md, re-run: exactly that file comes back.
- OAuth account whose cached `accessToken` is still valid → `sync` authenticates
  via XOAUTH2 and never contacts Google; a stale token → exit 1 with the reauth hint.
- Cross-method flag rejection: `--password` on `--auth oauth`, `--client-id` on
  `--auth password`, missing `--auth`, `reauth` on a password account.
- Hostile subject (`": [evil]\nauthor: x` via encoded-word) → frontmatter
  must still parse as YAML (validate with js-yaml, not eyeballs).
- Unreachable second account (port with no listener) → FAILED line, others
  still sync, exit 1. Note: `sync | grep` eats the exit code — check `$?` on a
  direct run.
- A v1 config (no `auth` field) still loads as password accounts, is not
  rewritten on read, and becomes v2 on the next write.
- Corrupt config.json → every command prints the fix-or-delete error, file
  untouched.
