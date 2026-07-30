---
name: hello
description: Install inbox-to-md when needed, set up OAuth or password authentication, sync and compact the inbox, then read the compacted output into context and greet the user. Invoked as /hello, including on first use when the CLI or an account is not configured.
---

# hello

## Install inbox-to-md when needed

1. Run `node --version` and require Node.js 20 or newer. If Node.js is missing or too old, tell the user what is required and stop instead of changing their Node installation automatically.
2. Run `command -v inbox-to-md` and `inbox-to-md --version`. If both succeed, use `inbox-to-md` for the rest of the workflow.
3. If the CLI is unavailable, run `npm install --global inbox-to-md`, then verify it with `inbox-to-md --version`. Do not use `sudo` or weaken filesystem permissions to make a global install work.
4. If the global install fails because the npm prefix is not writable, verify the no-install fallback with `npx --yes inbox-to-md --version` and substitute `npx --yes inbox-to-md` for `inbox-to-md` in every command below. Report any other installation failure and stop.

## Set up authentication when needed

1. Run `inbox-to-md auth list` and inspect its JSON output to determine whether at least one account is configured. The output intentionally excludes passwords and OAuth tokens; do not read secrets from the config file into the conversation.
2. If no account is configured, tell the user that setup will verify a real IMAP login before saving anything. Ask these questions for each account:
   - What label should identify the account?
   - Who is the email provider (Gmail, Google Workspace, Outlook, Fastmail, or another provider)?
   - What is the email address or IMAP username?
   - Where should Markdown mail be stored? Suggest `~/code/obsidian/Emails/<account-name>` while allowing another absolute or `~`-prefixed path.
   - For a non-Google provider: what IMAP host, port, and TLS setting does it require? Offer to help find the provider's official settings if the user does not know. Common defaults are port `993` with TLS enabled.
3. Never ask the user to paste a password, app password, OAuth token, verification code, or other secret into chat. Ask them to make a password available through a secure local mechanism, such as an environment variable or password-manager command, so it can be piped to `auth add --password-stdin`. Never put a literal password in a command, tool call, stdout, or log.
4. For a Gmail or Google Workspace account, prefer `--auth oauth` and explain what it involves. It needs the user's own Google Cloud OAuth client, because inbox-to-md ships none:
   - Ask whether they already have a `client_secret.json` for a Desktop-app OAuth client with the `https://mail.google.com/` scope. If not, walk them through the four steps in the README section "OAuth (Google)" — create/choose a GCP project, configure the consent screen with that scope, create a **Desktop app** OAuth client, download `client_secret.json`. Ask for the file's path, never its contents.
   - Warn that the command blocks: it prints an authorization URL, opens the browser, and waits up to 300 seconds (`--timeout <seconds>` to extend) for the user to finish consent. Google shows an "unverified app" warning for their own client, which is expected. Tell them to complete it, then wait for the command to return.
   - If the user cannot use a browser on this machine, add `--no-browser` and give them the printed URL.
5. If the user prefers a password, or the provider has no OAuth support, use `--auth password`:
   - Gmail app passwords require [2-Step Verification](https://myaccount.google.com/signinoptions/two-step-verification), then [Google App Passwords](https://myaccount.google.com/apppasswords). Have them create one named `inbox-to-md` and make it available through the secure local mechanism used for `--password-stdin`. Google displays an app password only once; generate a new one if it is lost, and a Google Account password change revokes existing ones.
   - If the App Passwords option is unavailable, explain that Google says this can happen for organization-managed accounts, accounts whose 2-Step Verification uses only security keys, or accounts enrolled in Advanced Protection. Have a Google Workspace user ask their administrator whether app passwords and IMAP access are permitted, or use OAuth instead. Do not suggest weakening account security.
   - Personal Gmail accounts have IMAP access enabled automatically; there is no separate "Enable IMAP" step. See [Google's Gmail client guidance](https://support.google.com/mail/answer/7126229) and [app-password guidance](https://support.google.com/accounts/answer/185833).
6. Add each account with `inbox-to-md auth add` and the collected flags. Parse the JSON result from stdout; the command verifies the connection before saving and never prompts. If it fails, parse the JSON error from stderr, help correct the non-secret settings, and retry without asking the user to reveal a secret.
7. Run `inbox-to-md auth list` again and continue only when its JSON output reports at least one configured account.

## Use the auth CLI

List configured accounts first. The JSON includes stable account IDs and each account's `auth` method, but no secrets:

```sh
inbox-to-md auth list
```

Add a Google account with OAuth. Host `imap.gmail.com`, port `993`, and TLS default to Gmail's settings:

```sh
inbox-to-md auth add --auth oauth \
  --label Gmail \
  --username you@gmail.com \
  --client-secret-file ~/client_secret.json \
  --sync-path ~/code/obsidian/Emails/Gmail
```

Add a password account by piping its password from a secure local source. Port `993` and TLS `yes` are defaults; pass `--port` or `--tls no` only when the provider requires different settings:

```sh
printf '%s\n' "$IMAP_APP_PASSWORD" | inbox-to-md auth add \
  --auth password \
  --label Fastmail \
  --host imap.fastmail.com \
  --username you@example.com \
  --password-stdin \
  --sync-path ~/code/obsidian/Emails/Fastmail
```

Treat an exit code of `0` and JSON with `"ok":true` on stdout as success. On failure, read the JSON error from stderr and use its message to correct the request. Never echo or log a password. Although `--password <password>` is supported, prefer `--password-stdin` because command-line arguments may appear in process listings and shell history.

Each listed account reports a `transport`, which is how it fetches mail: `gmail` (the Gmail HTTP API, chosen automatically for Google OAuth accounts because it syncs only what changed since the last run) or `imap` (everything else). It is derived, so nothing needs configuring; pass `--transport imap` to `add` or `edit` to force the IMAP path for a Google account.

Use the ID returned by `add` or `list` to edit or delete an account. `edit` preserves fields that are not supplied and re-verifies the resulting login before saving. `delete` removes only the configuration entry, not already-synced Markdown files. If a sync fails with a message about a revoked or expired OAuth grant, re-run consent with `reauth` — it blocks on the browser exactly like `add --auth oauth`.

```sh
inbox-to-md auth edit \
  --id <account-id> \
  --sync-path ~/code/obsidian/Emails/Personal

inbox-to-md auth reauth --id <account-id>
inbox-to-md auth delete --id <account-id>
```

Run `inbox-to-md auth --help` when exact flag syntax is needed.

## Sync, compact, and greet

1. Run `inbox-to-md sync` with Bash. If it fails, report the error output and stop.
2. Run `inbox-to-md compact` with Bash. If it fails, report the error output and stop.
3. Read the final digest for every inbox with the Read tool: each account directory under `~/code/obsidian/Emails/` (e.g. `Schols`, `UCLA`) has one at `<account>/compacted/final.md`. Find them with `ls ~/code/obsidian/Emails/*/compacted/final.md` and read each; if an account has no final.md, mention that instead of failing.
4. Read ALL daily notes: every date-named file directly in `~/code/obsidian/Daily/` (files are named `YYYY-MM-DD.md`; ignore the `Old` subdirectory). These hold the user's tasks; a task is open if its checkbox is unchecked (`- [ ]`). The same task often repeats across days — dedupe and treat the most recent mention as current.
5. Check memory for task-status updates: read `~/.claude/projects/-Users-chai-code-inbox-to-md/memory/task-status-updates.md` if it exists (and any other memory the index flags as task-related). Tasks recorded there as done or delegated must be excluded from the open-task list even if the daily notes or digests still show them open.
6. Say hi to the user, list the open tasks consolidated across all daily notes (grouped sensibly, e.g. by project, most recent/urgent first), and give a brief summary of what each inbox's compacted digest contains.
7. For the rest of the session: whenever the user says a task is done or delegated (e.g. "X is signed", "forwarded Y to dad"), record it in `task-status-updates.md` (append with today's date, following the file's existing format) and drop it from the open-task list. Prune entries whose source notes/digests no longer list them as open.
