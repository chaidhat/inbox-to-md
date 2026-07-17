# inbox-to-md

Sync IMAP inboxes to Markdown files — one file per email, with YAML frontmatter.

## Usage

```sh
npm install
npm run auth                # interactive TUI: add/edit/delete IMAP accounts and their sync paths
npm start                   # sync INBOX + Sent mail from this month and last month
npm run compact             # compact all messages into one md
npm run archive <md dir>    # archive the emails behind the .md files in a directory
```

Flags for `npm start` (pass them after `--`):

```sh
npm start -- --since 2026-01-01    # sync since a specific date instead of the default window
npm start -- --force-rewrite       # re-download and overwrite already-synced files
```

## License

[MIT](LICENSE)