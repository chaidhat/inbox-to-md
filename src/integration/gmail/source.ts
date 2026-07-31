// The Gmail implementation of MailSource. Unlike the IMAP backend it can ask
// Gmail what changed since the last run, which is the whole reason it exists:
// a full sweep costs one metadata request per message, while an incremental
// pull costs one request per *change*.
//
// Two caches keep the fallback path cheap. Gmail's history expires, so a full
// sweep still happens periodically; when it does, the id index in state.ts
// means only genuinely new messages need fetching.

import { errorMessage } from '../../core/errors.js';
import type { EmailContent } from '../../core/markdown.js';
import { mapPool } from '../../core/pool.js';
import type {
  ArchiveOutcome,
  ArchiveRequest,
  ChangeResult,
  ListProgress,
  ListResult,
  MailSource,
  MessageRef,
  Transport,
} from '../../core/mail-source.js';
import { getAccessToken, type OAuthAccountRef } from '../oauth.js';
import { GmailApi, GmailApiError, type GmailMessage, type GmailPart } from './api.js';
import { GmailState } from './state.js';

// What the IMAP backend calls the same messages, so files stay portable
// between transports and `archive` keeps working across a transport switch.
const INBOX = 'INBOX';
const ALL_MAIL = '[Gmail]/All Mail';

// Labels that take a message out of "the mail this account has" — the same
// exclusion the IMAP backend applies to the Trash and Junk mailboxes.
const HIDDEN_LABELS = ['TRASH', 'SPAM'];

function headerValue(message: GmailMessage, name: string): string {
  const headers = message.payload?.headers ?? [];
  const match = headers.find((h) => h.name.toLowerCase() === name.toLowerCase());
  return match?.value ?? '';
}

function mailboxOf(message: GmailMessage): string {
  return (message.labelIds ?? []).includes(INBOX) ? INBOX : ALL_MAIL;
}

function isHidden(message: GmailMessage): boolean {
  return (message.labelIds ?? []).some((label) => HIDDEN_LABELS.includes(label));
}

function receivedAt(message: GmailMessage): number | null {
  const raw = Number(message.internalDate);
  return Number.isFinite(raw) ? raw : null;
}

// Gmail's search operators take a date, not a timestamp, so the query is a
// day-granular lower bound and internalDate does the precise filtering — the
// same shape as IMAP's SINCE.
function windowQuery(since: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `after:${since.getFullYear()}/${pad(since.getMonth() + 1)}/${pad(since.getDate())}`;
}

function* leaves(part: GmailPart): Generator<GmailPart> {
  if (part.parts && part.parts.length > 0) {
    for (const child of part.parts) yield* leaves(child);
    return;
  }
  yield part;
}

function decodePart(part: GmailPart): string {
  const data = part.body?.data;
  if (data === undefined) return '';
  // Gmail has already undone the content-transfer-encoding; what remains is
  // the raw bytes in the part's own charset, base64url-wrapped.
  const bytes = Buffer.from(data, 'base64url');
  const contentType = part.headers?.find((h) => h.name.toLowerCase() === 'content-type')?.value ?? '';
  const charset = /charset="?([\w.+-]+)"?/i.exec(contentType)?.[1] ?? 'utf-8';
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

export class GmailMailSource implements MailSource {
  readonly transport: Transport = 'gmail';

  // Each fetch is an independent HTTPS request against a stateless API, so
  // they parallelize freely and throughput scales almost linearly with this
  // number: measured against a real account, 128 messages took 22.4s at 1,
  // 2.9s at 8, and 0.67s at 64.
  //
  // 64 is above Gmail's published per-user budget of 250 quota units/second
  // (messages.get costs 5, so ~50 requests/second). A short burst rides
  // through on the moving average; a long sync will draw 429s, and nothing
  // here retries them yet — see the note on GmailApiError in api.ts.
  readonly maxConcurrentFetches = 64;

  private constructor(
    private readonly api: GmailApi,
    private readonly state: GmailState,
  ) {}

  // Minting a token up front turns a revoked grant into one clear error here,
  // rather than an opaque failure on the first request. The API client is
  // handed a token *provider*, not a token: a sync can outlive an access
  // token, and getAccessToken refreshes transparently between requests.
  static async open(account: OAuthAccountRef, syncPath: string): Promise<GmailMailSource> {
    await getAccessToken(account);
    return new GmailMailSource(new GmailApi(() => getAccessToken(account)), GmailState.load(syncPath));
  }

  // Resolves a Gmail id to a ref, using the index when it can and a metadata
  // request when it cannot. Returns null for messages that are out of the
  // window or hidden in Trash/Spam.
  private async resolve(gmailId: string, since: Date, useCache: boolean): Promise<MessageRef | null> {
    if (useCache) {
      const known = this.state.known(gmailId);
      if (known !== undefined) {
        return { handle: gmailId, messageId: known.messageId, mailbox: known.mailbox };
      }
    }
    const message = await this.api.getMessage(gmailId, 'metadata');
    if (isHidden(message)) {
      this.state.forget(gmailId);
      return null;
    }
    const received = receivedAt(message);
    if (received !== null && received < since.getTime()) return null;

    const ref: MessageRef = {
      handle: gmailId,
      messageId: headerValue(message, 'Message-ID').trim(),
      mailbox: mailboxOf(message),
    };
    this.state.remember(gmailId, { messageId: ref.messageId, mailbox: ref.mailbox });
    return ref;
  }

  async listWindow(since: Date, onProgress: ListProgress): Promise<ListResult> {
    const problems: string[] = [];
    const refs: MessageRef[] = [];
    const reported = new Set<string>();

    let ids: string[] = [];
    try {
      let pageToken: string | undefined;
      do {
        const page = await this.api.listMessages(windowQuery(since), pageToken);
        ids.push(...page.ids);
        pageToken = page.nextPageToken;
      } while (pageToken !== undefined);
    } catch (err) {
      return { refs, complete: false, problems: [`cannot list messages: ${errorMessage(err)}`] };
    }

    // Resolving is one metadata request per id that the index can't answer, so
    // it runs at the same width as fetching. Dedupe and ordering are decided
    // afterwards, over results the pool hands back in id order — doing it
    // inside the pool would make which duplicate wins depend on which request
    // happened to return first.
    type Resolved =
      | { ok: true; ref: MessageRef | null }
      | { ok: false; problem: string };

    let checked = 0;
    const resolved = await mapPool<string, Resolved>(ids, this.maxConcurrentFetches, async (id) => {
      try {
        return { ok: true, ref: await this.resolve(id, since, true) };
      } catch (err) {
        // One unreadable message must not cost the account the rest, but it
        // does mean this listing is not the whole picture.
        return { ok: false, problem: `error reading message ${id}: ${errorMessage(err)}` };
      } finally {
        onProgress('all mail', ++checked, ids.length);
      }
    });

    let complete = true;
    for (const outcome of resolved) {
      if (!outcome.ok) {
        complete = false;
        problems.push(outcome.problem);
        continue;
      }
      const ref = outcome.ref;
      if (ref === null) continue;
      if (ref.messageId !== '') {
        if (reported.has(ref.messageId)) continue;
        reported.add(ref.messageId);
      }
      refs.push(ref);
    }
    return { refs, complete, problems };
  }

  async listChanges(since: Date, onProgress: ListProgress): Promise<ChangeResult | null> {
    const startHistoryId = this.state.historyId;
    if (startHistoryId === null) return null; // nothing to resume from

    const addedIds: string[] = [];
    const removedIds: string[] = [];
    try {
      let pageToken: string | undefined;
      do {
        const page = await this.api.listHistory(startHistoryId, pageToken);
        addedIds.push(...page.addedIds);
        removedIds.push(...page.removedIds);
        pageToken = page.nextPageToken;
      } while (pageToken !== undefined);
    } catch (err) {
      // Gmail expires old history; that is a fallback, not a failure.
      if (err instanceof GmailApiError && err.status === 404) return null;
      throw err;
    }

    const added: MessageRef[] = [];
    const seen = new Set<string>();
    const unique = [...new Set(addedIds)];
    let checked = 0;
    // Never trust the cache here: the whole point of a change record is that
    // this message's labels — and so its mailbox — may have moved. Unlike the
    // full listing this one lets an error propagate, because an incremental
    // result with a hole in it would advance the resume point past a message
    // that was never written.
    const resolved = await mapPool(unique, this.maxConcurrentFetches, async (id) => {
      try {
        return await this.resolve(id, since, false);
      } finally {
        onProgress('changes', ++checked, unique.length);
      }
    });
    for (const ref of resolved) {
      if (ref === null) continue;
      if (ref.messageId !== '') {
        if (seen.has(ref.messageId)) continue;
        seen.add(ref.messageId);
      }
      added.push(ref);
    }

    // Deletions arrive as Gmail ids; the engine deletes files by Message-ID,
    // so anything the index cannot translate is left alone rather than guessed
    // at. A message both changed and deleted in the same window stays.
    const removedMessageIds = [...new Set(removedIds)]
      .filter((id) => !seen.has(this.state.messageIdFor(id) ?? ''))
      .map((id) => this.state.messageIdFor(id))
      .filter((messageId): messageId is string => messageId !== null && messageId !== '');

    return { added, removedMessageIds };
  }

  async fetchContent(ref: MessageRef): Promise<EmailContent> {
    const message = await this.api.getMessage(ref.handle, 'full');
    const payload = message.payload;
    if (payload === undefined) throw new Error('Gmail returned no payload');

    let text = '';
    let html = '';
    const attachments = [];
    for (const part of leaves(payload)) {
      const mimeType = (part.mimeType ?? '').toLowerCase();
      const filename = part.filename ?? '';
      if (filename !== '') {
        attachments.push({
          name: filename,
          size: part.body?.size ?? 0,
          contentType: mimeType || 'application/octet-stream',
        });
        continue;
      }
      if (mimeType === 'text/plain' && text === '') text = decodePart(part);
      else if (mimeType === 'text/html' && html === '') html = decodePart(part);
    }

    const rawDate = headerValue(message, 'Date');
    const parsedDate = rawDate === '' ? null : new Date(rawDate);
    const received = receivedAt(message);
    const date = parsedDate !== null && !Number.isNaN(parsedDate.getTime())
      ? parsedDate
      : (received !== null ? new Date(received) : null);

    // The index is refreshed from the authoritative copy while we have it, so
    // a later re-download does not reuse a stale mailbox.
    const messageId = headerValue(message, 'Message-ID').trim();
    this.state.remember(ref.handle, { messageId, mailbox: mailboxOf(message) });

    return {
      from: headerValue(message, 'From'),
      to: headerValue(message, 'To'),
      subject: headerValue(message, 'Subject'),
      date,
      messageId,
      text,
      html,
      attachments,
    };
  }

  // Archiving in Gmail is removing the INBOX label — there is no folder to
  // move to, which is why the IMAP backend has to move into All Mail to
  // achieve the same thing.
  async archive(requests: ArchiveRequest[]): Promise<ArchiveOutcome[]> {
    const outcomes: ArchiveOutcome[] = [];
    for (const request of requests) {
      try {
        const bare = request.messageId.replace(/^<|>$/g, '');
        const found = await this.api.listMessages(`rfc822msgid:${bare}`);
        if (found.ids.length === 0) {
          outcomes.push({ status: 'not-found' });
          continue;
        }
        for (const id of found.ids) {
          await this.api.removeLabels(id, [INBOX]);
        }
        outcomes.push({ status: 'archived', destination: `${INBOX} → ${ALL_MAIL}` });
      } catch (err) {
        outcomes.push({ status: 'error', detail: errorMessage(err) });
      }
    }
    return outcomes;
  }

  async commit(): Promise<void> {
    try {
      this.state.setHistoryId(await this.api.currentHistoryId());
    } catch {
      // Without a fresh resume point the next run does a full sweep. That is
      // slower, never wrong, so it is not worth failing a clean sync over.
      this.state.setHistoryId(null);
    }
  }

  async close(): Promise<void> {
    // The id index is a pure cache and worth keeping even after a failed run;
    // the resume point is only advanced by commit().
    this.state.save();
  }
}
