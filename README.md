# inbox-to-md

Sync IMAP inboxes to Markdown files — one file per email, with YAML frontmatter.

## Install

```sh
npm install -g inbox-to-md
```

Requires Node.js 20 or newer.

## Usage

```sh
inbox-to-md auth                # interactive TUI: add/edit/delete IMAP accounts and their sync paths
inbox-to-md sync                # sync INBOX + Sent mail from this month and last month
inbox-to-md compact             # compact all messages into one md
inbox-to-md archive <md dir>    # archive the emails behind the .md files in a directory
```

Flags for `inbox-to-md sync`:

```sh
inbox-to-md sync --since 2026-01-01    # sync since a specific date instead of the default window
inbox-to-md sync --force-rewrite       # re-download and overwrite already-synced files
```

## Development

Run from a checkout without building:

```sh
npm install
npm run auth                # = inbox-to-md auth
npm start                   # = inbox-to-md sync (flags go after --)
npm run compact             # = inbox-to-md compact
npm run archive <md dir>    # = inbox-to-md archive
```

## License

[MIT](LICENSE.md)
