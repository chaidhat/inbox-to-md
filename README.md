# inbox-to-md

Sync IMAP inboxes to Markdown files — one file per email, with YAML frontmatter.

## Usage

```sh
npm install
npm run auth   # interactive TUI: add/edit/delete IMAP accounts and their sync paths
npm start      # sync INBOX + Sent mail from this month and last month
npm run archive <md dir>   # archive the emails behind the .md files in a directory
```

To sync from a specific date instead of the default (1st of last month):

```sh
npm start -- --since 2026-01-01
```

To re-download already-synced emails and overwrite their `.md` files in place
(e.g. after a change to the frontmatter format):

```sh
npm start -- --force-rewrite
```

`npm run auth` verifies credentials by logging in over IMAP before saving.
Accounts are stored in `~/.config/inbox-to-md/config.json` (created with
`0600` permissions — passwords are stored in plaintext, keep this file private).

`npm start` writes each email as `YYYY-MM-DD-subject-slug.md` into the
account's configured sync path, covering both INBOX and the Sent mailbox
(auto-detected via the IMAP special-use flag or common names); frontmatter
records which mailbox each email came from. Re-runs are idempotent: emails already on
disk (matched by `message-id` frontmatter) are skipped, and deleting a file
re-syncs that email on the next run. Deletions are mirrored too: after a
clean sync, a file whose email is no longer on the server is deleted — but
only when its date is safely inside the sync window and its mailbox was
synced this run, so files outside the window are never touched. Attachments
are listed but never downloaded. One failing account doesn't stop the
others; the exit code is non-zero if anything failed.

`npm run archive <md dir>` takes a directory of synced `.md` files, finds
each file's email on the server (by `message-id`, in the mailbox it was
synced from), moves it to the account's Archive mailbox (special-use flag,
Gmail's All Mail, or common names), and deletes the file once the move is
confirmed. Only INBOX mail is archivable: files whose `mailbox` frontmatter
is anything else (e.g. Sent) are rejected — archiving them would just strip
their label server-side for no benefit. Files whose email can't be found, or
that fail to move, are kept and reported with a non-zero exit code.

## Build

```sh
npm run build   # compile to dist/ with tsc
```
