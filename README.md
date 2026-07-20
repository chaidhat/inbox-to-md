# inbox-to-md

Sync IMAP inboxes to Markdown files and compacts them for agent use — one file per email.

## Agent skill

This tool is designed to be used by agents. The repo includes a [`hello` skill](SKILL.md) that shows how an agent can install and use `inbox-to-md` to sync and compact mail, then turn the resulting digests into a personalized greeting and task summary. Please use that!


## Install and run

Requires Node.js 20 or newer.

Install the CLI globally from npm:

```sh
npm i -g inbox-to-md
```

Configure an IMAP account, then sync it:

```sh
inbox-to-md auth
inbox-to-md sync
```

You can also run the latest published version without installing it globally:

```sh
npx inbox-to-md auth
npx inbox-to-md sync
```

## Commands

```sh
inbox-to-md auth                # add, edit, or delete IMAP accounts and sync paths
inbox-to-md authcli <action>    # manage accounts non-interactively with flags and JSON
inbox-to-md sync                # sync INBOX and Sent mail from this month and last month
inbox-to-md compact             # compact all messages into one Markdown file
inbox-to-md archive <md dir>    # archive the emails represented by files in a directory
```

Sync from a specific date or overwrite messages that have already been downloaded:

```sh
inbox-to-md sync --since 2026-01-01
inbox-to-md sync --force-rewrite
```

### Non-interactive authentication

`authcli` manages accounts with flags and returns JSON on stdout. Added and edited accounts are verified over IMAP before they are saved, and passwords are never included in output.

```sh
inbox-to-md authcli list

printf '%s\n' "$IMAP_APP_PASSWORD" | inbox-to-md authcli add \
  --label Gmail \
  --host imap.gmail.com \
  --username you@example.com \
  --password-stdin \
  --sync-path ~/code/obsidian/Emails/Gmail

inbox-to-md authcli edit --id <account-id> --sync-path ~/mail/Gmail
inbox-to-md authcli delete --id <account-id>
```

Port `993` and TLS default to `yes`. A literal `--password <password>` is supported, but `--password-stdin` avoids exposing the secret in process listings or shell history. Run `inbox-to-md authcli --help` for full usage.

## License

[MIT](LICENSE.md)
