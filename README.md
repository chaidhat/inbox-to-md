# inbox-to-md

Sync IMAP inboxes to Markdown files — one file per email, with YAML frontmatter.

## Usage

```sh
npm install
npm run auth   # interactive TUI: add/edit/delete IMAP accounts and their sync paths
npm start      # sync all INBOX mail from this month and last month
```

`npm run auth` verifies credentials by logging in over IMAP before saving.
Accounts are stored in `~/.config/inbox-to-md/config.json` (created with
`0600` permissions — passwords are stored in plaintext, keep this file private).

`npm start` writes each email as `YYYY-MM-DD-subject-slug.md` into the
account's configured sync path. Re-runs are idempotent: emails already on
disk (matched by `message-id` frontmatter) are skipped, and deleting a file
re-syncs that email on the next run. Attachments are listed but never
downloaded. One failing account doesn't stop the others; the exit code is
non-zero if anything failed.

## Build

```sh
npm run build   # compile to dist/ with tsc
```
