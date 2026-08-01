// The IMAP implementation of MailSource: everything that knows about
// mailboxes, UIDs, and BODYSTRUCTURE lives here, so the sync and archive
// engines never see any of it.

import type { ImapFlow, MailboxLockObject, MessageEnvelopeObject } from 'imapflow';
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
import { closeImapClient, connectImap, describeImapError, hasSpecialUse, type ImapTarget } from './client.js';
import { collectAttachments, decodeTextPart, findTextPart } from './mime.js';

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

export class ImapMailSource implements MailSource {
  readonly transport: Transport = 'imap';

  private lock: { path: string; lock: MailboxLockObject } | null = null;

  private constructor(private readonly client: ImapFlow) {}

  // Connection failures are phrased here rather than by the caller: only this
  // layer knows an IMAP error well enough to turn it into advice.
  static async open(account: ImapTarget): Promise<ImapMailSource> {
    try {
      return new ImapMailSource(await connectImap(account));
    } catch (err) {
      throw new Error(describeImapError(err, account));
    }
  }

  // Mailboxes are held open across calls and only re-selected when the target
  // changes: listing and downloading walk one mailbox at a time, so this turns
  // what would be a SELECT per message into one per mailbox.
  private async select(path: string): Promise<void> {
    if (this.lock?.path === path) return;
    this.lock?.lock.release();
    this.lock = null;
    this.lock = { path, lock: await this.client.getMailboxLock(path) };
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
  private async listMailboxes(): Promise<string[]> {
    const boxes = await this.client.list();
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

  async listWindow(since: Date, onProgress: ListProgress): Promise<ListResult> {
    const refs: MessageRef[] = [];
    const problems: string[] = [];
    // A message visible from several mailboxes is reported once. INBOX is
    // walked first, so that is the mailbox it gets recorded under.
    const reported = new Set<string>();
    let complete = true;

    let mailboxes: string[];
    try {
      mailboxes = await this.listMailboxes();
    } catch (err) {
      return { refs, complete: false, problems: [`cannot list mailboxes: ${errorMessage(err)}`] };
    }

    for (const mailbox of mailboxes) {
      try {
        await this.select(mailbox);
        const uids = await this.client.search({ since }, { uid: true });
        if (!uids || uids.length === 0) continue;
        let checked = 0;
        for await (const msg of this.client.fetch(uids, { envelope: true }, { uid: true })) {
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
  async fetchContent(ref: MessageRef): Promise<EmailContent> {
    await this.select(ref.mailbox);
    const uid = Number(ref.handle);
    const msg = await this.client.fetchOne(uid, { envelope: true, bodyStructure: true }, { uid: true });
    if (!msg || !msg.envelope || !msg.bodyStructure) throw new Error('server returned no envelope/body structure');

    let text = '';
    let html = '';
    const textRef = findTextPart(msg.bodyStructure);
    if (textRef) {
      const partMsg = await this.client.fetchOne(uid, { bodyParts: [textRef.part] }, { uid: true });
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
  private async findArchiveMailbox(): Promise<string | null> {
    const boxes = await this.client.list();
    const bySpecialUse = boxes.find((b) => hasSpecialUse(b, '\\Archive') || hasSpecialUse(b, '\\All'));
    if (bySpecialUse) return bySpecialUse.path;
    const byName = boxes.find((b) => /^archives?$/i.test(b.name));
    return byName ? byName.path : null;
  }

  async archive(requests: ArchiveRequest[]): Promise<ArchiveOutcome[]> {
    const outcomes: ArchiveOutcome[] = requests.map(() => ({ status: 'not-found' as const }));
    if (requests.length === 0) return outcomes;

    const archiveBox = await this.findArchiveMailbox();
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
        await this.select(mailbox);
      } catch {
        continue; // this account has no such mailbox; another account may
      }
      for (const index of indexes) {
        try {
          const uids = await this.client.search(
            { header: { 'message-id': requests[index].messageId } },
            { uid: true },
          );
          if (!uids || uids.length === 0) continue; // stays 'not-found'
          // A source already inside the Archive mailbox needs no move — the
          // email is archived; the caller just cleans up the file.
          if (mailbox !== archiveBox) {
            await this.client.messageMove(uids, archiveBox, { uid: true });
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
    this.lock?.lock.release();
    this.lock = null;
    await closeImapClient(this.client);
  }
}
