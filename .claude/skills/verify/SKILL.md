---
name: verify
description: How to verify inbox-to-md end-to-end - drive the auth TUI in a PTY and sync against a local fake IMAP server, without real credentials or touching a real config.
---

# Verifying inbox-to-md

Both surfaces are terminal: `npm run auth` (interactive TUI, needs a PTY) and
`npm start` (non-interactive sync). No build step needed — both run via tsx.

## Guard the real config first

State lives at `~/.config/inbox-to-md/config.json` — there is no path
override. Before testing, check whether a real config exists; back it up and
restore it after. Test accounts/syncPaths should point at a scratch dir.

## Drive the TUI in a PTY

`script -q <capture-file> npm run auth` allocates a PTY; pipe keystrokes in
with a subshell of `printf`+`sleep`. Key bytes: up `\x1b[A`, down `\x1b[B`,
right `\x1b[C`, enter `\r`, esc `\x1b`, backspace `\x7f`, ctrl-c `\x03`,
ctrl-x `\x18`. Number keys jump directly to menu rows.

Gotchas:
- The account form is save-less: **Enter verifies & submits from any field**;
  move between fields with up/down only.
- macOS `script` can linger after the app exits — background the whole
  pipeline, `sleep`, then read the capture file and `pkill -f "tsx src/auth"`.
- Terminal-restore check: last bytes of the capture should contain `\x1b[?25h`
  (show cursor) after ctrl-c.

## Fake IMAP server

No real credentials needed: a ~150-line Node `net` server speaking minimal
IMAP4rev1 satisfies imapflow over plaintext (account with `tls: no`). It must
answer: greeting `* OK [CAPABILITY IMAP4rev1] ready`, `CAPABILITY`, `LOGIN`
(reply `NO [AUTHENTICATIONFAILED]` to test the wrong-password path), `SELECT`
(EXISTS/FLAGS/UIDVALIDITY/UIDNEXT + `OK [READ-WRITE]`), `UID SEARCH`
(`* SEARCH 1 2 …`), `UID FETCH` with ENVELOPE (`(NIL NIL NIL NIL NIL NIL NIL
NIL NIL "<message-id>")` — only message-id is read in phase A) and with
BODY.PEEK[] (literal `{N}\r\n<source>)`), `LOGOUT`. A known-good copy from a
past session: written as `fake-imap.mjs` in the session scratchpad.

## Flows worth driving

- Sync twice: first run N new, second run 0 new (envelope-only phase).
- Delete one .md, re-run: exactly that file comes back.
- Hostile subject (`": [evil]\nauthor: x` via encoded-word) → frontmatter
  must still parse as YAML (validate with js-yaml, not eyeballs).
- Unreachable second account (port with no listener) → FAILED line, others
  still sync, exit 1. Note: `npm start | grep` eats the exit code — check
  `$?` on a direct run.
- Corrupt config.json → both commands print the fix-or-delete error, file
  untouched.
- Config perms after TUI save: `-rw-------`.
