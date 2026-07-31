# inbox-to-md

Sync inboxes to Markdown files and compacts them for agent use — one file per email.

Accounts connect over IMAP and authenticate either with **OAuth** (Google, like
[lieer](https://github.com/gauteh/lieer)) or with a **password / app password**. You
choose per account when you add it. Everything is done from the command line;
there is no interactive setup.

## Disclaimer

inbox-to-md will:

1. Download mail from `inbox` and `sent` and write it to Markdown files on your computer.
2. Compact your mail into a markdown below a certain token count, via Anthropic.

inbox-to-md will not and can not:

1. Delete mail on the server, send mail, or modify a message's content or flags.
2. Upload your mail anywhere other than to Anthropic during `compact`.

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
inbox-to-md sync                # sync all mail from this month and last month
inbox-to-md compact             # compact all messages into one Markdown file
inbox-to-md archive <md dir>    # archive the emails represented by files in a directory
```

Sync from a specific date or overwrite messages that have already been downloaded:

```sh
inbox-to-md sync --since 2026-01-01
inbox-to-md sync --force-rewrite
```

`sync` and `compact` draw progress bars while they work — one per phase, so a
long run shows what it is doing rather than sitting silent. The bars and any
mid-run errors go to stderr and only appear on a terminal: redirecting a run to
a file leaves stdout carrying just the summary lines, so pipe both streams
(`inbox-to-md compact > run.log 2>&1`) if you want the detail too.

`sync` covers every mailbox the account can see within the date window — inbox,
sent, and any other folder or label — except Trash and Spam. A message that
appears in several mailboxes is written once, with the mailbox it was first seen
in recorded in its frontmatter. An email that disappears from the server is
removed from disk on the next clean sync.

### Concurrency

Accounts sync in parallel (up to 4 at a time), each drawing its own progress
bars. Within an account, how many messages are fetched at once is the backend's
call: the `gmail` transport does 8, because each fetch is an independent HTTPS
request, while `imap` does one, because it holds a single connection whose
selected mailbox two concurrent fetches would move underneath each other.
`compact` keeps 8 model calls in flight within a layer; layers are sequential
by nature, since each one compacts the previous one's output.

Because parallel accounts can finish an OAuth token refresh at the same moment,
config writes take a lock (`config.json.lock`) and are applied as one
read-modify-write. That also makes it safe to run `auth add` while a sync is
going. If a run is killed hard, a stale lock is taken over after 30 seconds.

### Transports

Mail is fetched over one of two backends:

| | `gmail` | `imap` |
| --- | --- | --- |
| Used for | Google accounts authenticated with OAuth | everything else |
| How it syncs | asks Gmail what changed since the last run | lists the window every run |
| Needs | the OAuth grant you already have | host, port, TLS |

Google OAuth accounts use `gmail` automatically — no migration and no
re-consent, because the `https://mail.google.com/` scope already covers the
Gmail API. It is chosen because it syncs *incrementally*: after the first run it
asks only for what changed, so an unchanged mailbox costs one request instead of
one per message. When Google expires the resume point, it falls back to a full
listing on its own.

Everything else uses `imap`, which is also the fallback if you prefer it:

```sh
inbox-to-md auth edit --id <account-id> --transport imap
inbox-to-md auth list        # "transport" shows what each account will use
```

The Gmail backend keeps its resume point in `.inbox-to-md-gmail.json` inside the
sync directory. It is a cache, never a source of truth — delete it (or the whole
directory) and the next run rebuilds it.

## Authentication

`inbox-to-md auth` takes flags and returns indented JSON on stdout; errors are JSON on
stderr with a nonzero exit status. It never prompts, so it is safe to drive from a script or
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
