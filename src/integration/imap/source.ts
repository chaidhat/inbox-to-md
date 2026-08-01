// The IMAP implementation of MailSource: everything that knows about
// mailboxes, UIDs, and BODYSTRUCTURE lives here, so the sync and archive
// engines never see any of it.

import type { MessageEnvelopeObject } from 'imapflow';
import { errorMessage } from '../../core/errors.js';
import type { EmailContent } from '../../core/markdown.js';
import type {
  ArchiveOutcome,
  ArchiveRequest,
  ListProgress,
  ListResult,
  MailSource,
  MessageRef,
  Transport,
} from '../../core/mail-source.js';
import { describeImapError, hasSpecialUse, type ImapTarget } from './client.js';
import { collectAttachments, decodeTextPart, findTextPart } from './mime.js';
import { type ImapConnection, ImapConnectionPool } from './pool.js';

// Where deleted and filtered mail goes. Skipped so a full sync means "the mail
// this account has", not "everything the server still holds a copy of" — which
// also matches Gmail's All Mail, whose contents exclude both.
const EXCLUDED_SPECIAL_USE = ['\\Trash', '\\Junk'];
// Name fallback for servers that advertise no special-use flags at all.
const EXCLUDED_MAILBOX_NAME = /^(trash|deleted items|deleted messages|bin|spam|junk|bulk mail)$/i;

function formatAddressList(list: MessageEnvelopeObject['from']): string {
  return (list ?? [])
    .map((a) => (a.name ? `${a.name} <${a.address ?? ''}>` : (a.address ?? '')))
    .join(', ');
}

// How many downloads run at once, and so how many connections the pool may
// open. One IMAP connection serves one fetch at a time, so this is a count of
// sockets against the user's server — kept just under the 15 that Gmail and
// most other providers allow per account, leaving room for anything else the
// user has connected.
const FETCH_CONCURRENCY = 14;

export class ImapMailSource implements MailSource {
  readonly transport: Transport = 'imap';

  readonly maxConcurrentFetches = FETCH_CONCURRENCY;

  private constructor(private readonly pool: ImapConnectionPool) {}

  // Connection failures are phrased here rather than by the caller: only this
  // layer knows an IMAP error well enough to turn it into advice.
  static async open(account: ImapTarget): Promise<ImapMailSource> {
    try {
      return new ImapMailSource(await ImapConnectionPool.open(account, FETCH_CONCURRENCY));
    } catch (err) {
      throw new Error(describeImapError(err, account));
    }
  }

  // Runs `work` on a leased connection, always returning it to the pool. Mailbox
  // selection is per connection, so nothing outside this may touch one.
  private async withConnection<T>(work: (conn: ImapConnection) => Promise<T>): Promise<T> {
    const conn = await this.pool.acquire();
    try {
      return await work(conn);
    } finally {
      this.pool.release(conn);
    }
  }

  // Every mailbox worth syncing, INBOX first. The order matters: a message
  // that is in the inbox as well as somewhere else is reported once, from
  // whichever mailbox reached it first, and recording it as INBOX is what lets
  // `archive` find it later.
  //
  // A server that advertises \All (Gmail) is walked as INBOX plus that one
  // mailbox: All Mail already holds every labelled message, so walking the
  // labels as well would re-list the same messages once per label. Anything
  // else is enumerated mailbox by mailbox.
  private async listMailboxes(conn: ImapConnection): Promise<string[]> {
    const boxes = await conn.client.list();
    const selectable = boxes.filter((b) => !b.flags.has('\\Noselect') && !b.flags.has('\\NonExistent'));

    const allMail = selectable.find((b) => hasSpecialUse(b, '\\All'));
    const rest = allMail !== undefined
      ? [allMail]
      : selectable.filter(
        (b) => !EXCLUDED_SPECIAL_USE.some((flag) => hasSpecialUse(b, flag)) && !EXCLUDED_MAILBOX_NAME.test(b.name),
      );

    // INBOX is case-insensitive per RFC 3501 and a server may list it in any
    // case, so filter it out of the rest rather than trusting an exact match.
    return ['INBOX', ...rest.map((b) => b.path).filter((path) => path.toUpperCase() !== 'INBOX')];
  }

  // Listing walks the mailboxes in order on a single leased connection: the
  // order is what decides which mailbox a message is recorded under, so it
  // cannot be spread across connections.
  async listWindow(since: Date, onProgress: ListProgress): Promise<ListResult> {
    return this.withConnection((conn) => this.listWindowOn(conn, since, onProgress));
  }

  private async listWindowOn(conn: ImapConnection, since: Date, onProgress: ListProgress): Promise<ListResult> {
    const refs: MessageRef[] = [];
    const problems: string[] = [];
    // A message visible from several mailboxes is reported once. INBOX is
    // walked first, so that is the mailbox it gets recorded under.
    const reported = new Set<string>();
    let complete = true;

    let mailboxes: string[];
    try {
      mailboxes = await this.listMailboxes(conn);
    } catch (err) {
      return { refs, complete: false, problems: [`cannot list mailboxes: ${errorMessage(err)}`] };
    }

    for (const mailbox of mailboxes) {
      try {
        await conn.select(mailbox);
        const uids = await conn.client.search({ since }, { uid: true });
        if (!uids || uids.length === 0) continue;
        let checked = 0;
        for await (const msg of conn.client.fetch(uids, { envelope: true }, { uid: true })) {
          onProgress(mailbox, ++checked, uids.length);
          const messageId = (msg.envelope?.messageId ?? '').trim();
          if (messageId !== '') {
            if (reported.has(messageId)) continue;
            reported.add(messageId);
          }
          refs.push({ handle: String(msg.uid), messageId, mailbox });
        }
      } catch (err) {
        // One failing mailbox must not cost the account its other mail, but it
        // does mean this listing is not the whole picture.
        complete = false;
        problems.push(`error on ${mailbox}: ${errorMessage(err)}`);
      }
    }
    return { refs, complete, problems };
  }

  // Downloads one email using body structure instead of full source: the
  // envelope covers the headers, the structure describes the attachments, and
  // only the single text part is actually fetched — so attachment bytes never
  // leave the server.
  //
  // Each download runs on its own leased connection, so `maxConcurrentFetches`
  // of them can be in flight at once.
  async fetchContent(ref: MessageRef): Promise<EmailContent> {
    return this.withConnection((conn) => this.fetchContentOn(conn, ref));
  }

  private async fetchContentOn(conn: ImapConnection, ref: MessageRef): Promise<EmailContent> {
    await conn.select(ref.mailbox);
    const uid = Number(ref.handle);
    const msg = await conn.client.fetchOne(uid, { envelope: true, bodyStructure: true }, { uid: true });
    if (!msg || !msg.envelope || !msg.bodyStructure) throw new Error('server returned no envelope/body structure');

    let text = '';
    let html = '';
    const textRef = findTextPart(msg.bodyStructure);
    if (textRef) {
      const partMsg = await conn.client.fetchOne(uid, { bodyParts: [textRef.part] }, { uid: true });
      const raw = partMsg ? partMsg.bodyParts?.get(textRef.part) : undefined;
      if (!raw) throw new Error(`server returned no body part ${textRef.part}`);
      const decoded = decodeTextPart(raw, textRef.encoding, textRef.charset);
      if (textRef.isHtml) html = decoded;
      else text = decoded;
    }

    return {
      from: formatAddressList(msg.envelope.from),
      to: formatAddressList(msg.envelope.to),
      subject: msg.envelope.subject ?? '',
      date: msg.envelope.date ?? null,
      messageId: (msg.envelope.messageId ?? '').trim(),
      text,
      html,
      attachments: collectAttachments(msg.bodyStructure),
    };
  }

  // Locates the account's Archive mailbox: the RFC 6154 special-use flag when
  // the server provides one, Gmail's All Mail (\All — moving there is how
  // Gmail archives), or the usual names. Returns null when nothing matches; we
  // never create a mailbox on the user's server on our own.
  private async findArchiveMailbox(conn: ImapConnection): Promise<string | null> {
    const boxes = await conn.client.list();
    const bySpecialUse = boxes.find((b) => hasSpecialUse(b, '\\Archive') || hasSpecialUse(b, '\\All'));
    if (bySpecialUse) return bySpecialUse.path;
    const byName = boxes.find((b) => /^archives?$/i.test(b.name));
    return byName ? byName.path : null;
  }

  // Archiving groups its work by mailbox and moves messages out of them, so
  // like listing it runs on one connection rather than racing itself.
  async archive(requests: ArchiveRequest[]): Promise<ArchiveOutcome[]> {
    if (requests.length === 0) return [];
    return this.withConnection((conn) => this.archiveOn(conn, requests));
  }

  private async archiveOn(conn: ImapConnection, requests: ArchiveRequest[]): Promise<ArchiveOutcome[]> {
    const outcomes: ArchiveOutcome[] = requests.map(() => ({ status: 'not-found' as const }));

    const archiveBox = await this.findArchiveMailbox(conn);
    if (archiveBox === null) throw new Error('no Archive mailbox found on this account');

    // One mailbox open per distinct source mailbox, not per message.
    const byMailbox = new Map<string, number[]>();
    requests.forEach((request, index) => {
      const group = byMailbox.get(request.mailbox);
      if (group) group.push(index);
      else byMailbox.set(request.mailbox, [index]);
    });

    for (const [mailbox, indexes] of byMailbox) {
      try {
        await conn.select(mailbox);
      } catch {
        continue; // this account has no such mailbox; another account may
      }
      for (const index of indexes) {
        try {
          const uids = await conn.client.search(
            { header: { 'message-id': requests[index].messageId } },
            { uid: true },
          );
          if (!uids || uids.length === 0) continue; // stays 'not-found'
          // A source already inside the Archive mailbox needs no move — the
          // email is archived; the caller just cleans up the file.
          if (mailbox !== archiveBox) {
            await conn.client.messageMove(uids, archiveBox, { uid: true });
          }
          outcomes[index] = { status: 'archived', destination: `${mailbox} → ${archiveBox}` };
        } catch (err) {
          outcomes[index] = { status: 'error', detail: errorMessage(err) };
        }
      }
    }
    return outcomes;
  }

  async close(): Promise<void> {
    await this.pool.close();
  }
}
