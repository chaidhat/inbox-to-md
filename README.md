# inbox-to-md

Sync inboxes to Markdown files and compacts them for agent use — one file per email.

Accounts connect over IMAP and authenticate either with **OAuth** (Google, like
[lieer](https://github.com/gauteh/lieer)) or with a **password / app password**. You
choose per account when you add it. Everything is done from the command line;
there is no interactive setup.

## Disclaimer

inbox-to-md will:

1. Download mail from `INBOX` and `Sent` and write it to Markdown files on your computer.
2. Delete a local Markdown file when its email has disappeared from the server (`sync`), so the directory mirrors the mailbox.
3. Move `INBOX` messages to the account's `Archive` mailbox, and delete the local file, but **only** for the files you point `inbox-to-md archive` at.
4. Send the text of your synced emails to Anthropic when you run `inbox-to-md compact`, which summarizes them with Claude through the Claude Agent SDK and your local Claude Code login.

inbox-to-md will not and can not:

1. Delete mail on the server, send mail, or modify a message's content or flags.
2. Upload your mail anywhere other than the summarization described above, which only runs when you run `compact`.

Credentials — IMAP passwords and OAuth refresh tokens — are stored **in plaintext**
in `~/.config/inbox-to-md/config.json`, written `0600` inside a `0700` directory.
Attachments are never downloaded; only message text is fetched.

While inbox-to-md is used daily against real mailboxes, it comes with **NO WARRANTIES**.

## Agent skill

This tool is designed to be used by agents. The repo includes a [`hello` skill](SKILL.md) that shows how an agent can install and use `inbox-to-md` to sync and compact mail, then turn the resulting digests into a personalized greeting and task summary. Please use that!

## Install and run

Requires Node.js 20 or newer.

Install the CLI globally from npm:

```sh
npm i -g inbox-to-md
```

Add an account, then sync it:

```sh
inbox-to-md auth add --auth oauth ...     # or --auth password; see below
inbox-to-md sync
```

You can also run the latest published version without installing it globally:

```sh
npx inbox-to-md auth list
npx inbox-to-md sync
```

## Commands

```sh
inbox-to-md auth <action>       # manage accounts non-interactively (flags + JSON)
inbox-to-md sync                # sync INBOX and Sent mail from this month and last month
inbox-to-md compact             # compact all messages into one Markdown file
inbox-to-md archive <md dir>    # archive the emails represented by files in a directory
```

Sync from a specific date or overwrite messages that have already been downloaded:

```sh
inbox-to-md sync --since 2026-01-01
inbox-to-md sync --force-rewrite
```

## Authentication

`inbox-to-md auth` takes flags and returns JSON on stdout; errors are JSON on stderr
with a nonzero exit status. It never prompts, so it is safe to drive from a script or
an agent. Accounts are verified with a real IMAP login before they are saved, and
passwords and tokens are never included in the output.

```sh
inbox-to-md auth list
inbox-to-md auth edit --id <account-id> --sync-path ~/mail/Gmail
inbox-to-md auth delete --id <account-id>
inbox-to-md auth --help
```

### OAuth (Google)

OAuth avoids storing a password that unlocks the whole account: the stored refresh
token only grants mail access, and you can revoke it at
[Google Account permissions](https://myaccount.google.com/permissions) at any time.

inbox-to-md ships **no** OAuth client of its own — unlike lieer, which shares one
openly — so you create your own in Google Cloud. It is free, and it keeps your API
quota and consent screen yours:

1. [Create a project on GCP](https://cloud.google.com/resource-manager/docs/creating-managing-projects), or use an existing one.
2. [Configure the OAuth consent screen](https://console.cloud.google.com/apis/credentials/consent): name the app (e.g. "inbox-to-md"), and add the `https://mail.google.com/` scope. That scope is what IMAP access needs; the narrower `gmail.*` scopes only work with Google's HTTP API. Add your own address as a test user.
3. [Create the OAuth 2 credentials](https://console.cloud.google.com/apis/credentials) with 'Create Credentials' > 'OAuth client ID', application type **Desktop app**. You do **not** need to verify the app — you will just see an "unverified app" warning during consent, which you can continue past.
4. Download the client as `client_secret.json`.

Then add the account. The command prints an authorization URL, opens it in your
browser, and waits for Google to redirect back to a loopback port on your machine:

```sh
inbox-to-md auth add --auth oauth \
  --label Gmail \
  --username you@gmail.com \
  --client-secret-file ~/client_secret.json \
  --sync-path ~/code/obsidian/Emails/Gmail
```

Host `imap.gmail.com`, port `993`, and TLS default to Gmail's settings; pass `--host`,
`--port`, or `--tls no` to override them. Use `--no-browser` to only print the URL
(useful over SSH — forward the loopback port, or open the URL on the machine running
the command), and `--timeout <seconds>` to wait longer than the default 300s.

`--client-id` and `--client-secret` work instead of `--client-secret-file`. A Desktop-app
client secret is not a secret that protects your mail on its own — only the refresh and
access tokens do — which is why it is stored alongside them.

If a grant is revoked or expires, sync fails with a message naming the fix:

```sh
inbox-to-md auth reauth --id <account-id>
```

### Password (IMAP or app password)

For providers without OAuth support, or for a Gmail
[app password](https://support.google.com/accounts/answer/185833):

```sh
printf '%s\n' "$IMAP_APP_PASSWORD" | inbox-to-md auth add \
  --auth password \
  --label Fastmail \
  --host imap.fastmail.com \
  --username you@example.com \
  --password-stdin \
  --sync-path ~/code/obsidian/Emails/Fastmail
```

Port `993` and TLS default to `yes`. A literal `--password <password>` is supported, but
`--password-stdin` avoids exposing the secret in process listings or shell history.

## License

[MIT](LICENSE.md)
