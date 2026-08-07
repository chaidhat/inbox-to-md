// The Gmail HTTP API, spoken directly over fetch. No client library: the whole
// surface we need is five endpoints, and the official client would pull in a
// large dependency tree to wrap requests we already know how to make — while
// the token minting we would want from it already lives in integration/oauth.

import { errorMessage } from '../../core/errors.js';

export const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const REQUEST_TIMEOUT_MS = 30_000;

// Gmail sheds load by rejecting rather than queueing, so a burst of parallel
// reads comes back as 429s rather than as slower responses. Google's documented
// remedy is exponential backoff, and it is the only one available to a client:
// there is no way to ask how much budget is left. Five attempts spans roughly
// 8s of waiting in the worst case, which clears the per-second quota windows
// this can trip; a limit that survives none of that is a genuine outage and is
// better reported than retried forever.
const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 32_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Full jitter: every client that got throttled together would otherwise wake
// together and throttle each other again. Retry-After wins when the server
// sends one, since that is Gmail telling us what it actually wants.
function backoffMs(attempt: number, retryAfterMs: number | null): number {
  if (retryAfterMs !== null) return Math.min(retryAfterMs, MAX_BACKOFF_MS);
  return Math.random() * Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
}

// Retry-After is either delta-seconds or an HTTP date. A malformed or negative
// value is ignored rather than trusted, so a bad header degrades to our own
// backoff instead of pinning the sync or making it hammer.
function parseRetryAfter(header: string | null): number | null {
  if (header === null || header.trim() === '') return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : null;
  const date = Date.parse(header);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - Date.now());
}

// Test hook, not a proxy setting: it lets the verification harness point the
// client at a fake Gmail. Only loopback is accepted, because this variable
// decides where an OAuth bearer token gets sent — a remote value would be a
// one-line token exfiltration. Anything else fails closed rather than falling
// back to the real API, so a typo can't silently sync the wrong thing.
export function resolveApiBase(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.INBOX_TO_MD_GMAIL_API_BASE;
  if (override === undefined || override === '') return GMAIL_API_BASE;
  let url: URL;
  try {
    url = new URL(override);
  } catch {
    throw new Error(`INBOX_TO_MD_GMAIL_API_BASE is not a valid URL: ${override}`);
  }
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname)) {
    throw new Error(
      'INBOX_TO_MD_GMAIL_API_BASE must point at loopback — it is a test hook for a fake Gmail, ' +
      'not a way to send your mail and access token to another host.',
    );
  }
  return override.replace(/\/$/, '');
}

// Carries the HTTP status so callers can distinguish the cases they must
// handle from genuine failures — notably 404, which means "that thing is gone"
// rather than "something broke": from history it means the resume point has
// expired, and from a message read it means the message was deleted.
export class GmailApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason: string,
    // Only set for throttling responses that carried a Retry-After.
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'GmailApiError';
  }
}

// Throttling and server faults are the server saying "not now"; a network blip
// is the same answer from the wire. Everything else — a bad request, a revoked
// grant, a deleted message — will fail identically however many times it is
// asked, so retrying it only delays the error the caller needs to see.
function isRetryable(err: GmailApiError): boolean {
  return err.status === 429 || err.status >= 500 || err.reason === 'unreachable';
}

export interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
}

export interface GmailMessage {
  id: string;
  labelIds?: string[];
  internalDate?: string; // epoch ms, as a string
  payload?: GmailPart;
}

export interface GmailHistoryPage {
  addedIds: string[];
  removedIds: string[];
  nextPageToken?: string;
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
}

export class GmailApi {
  constructor(
    // A provider rather than a token: a sync can outlive an access token, and
    // this way the refresh happens transparently between requests.
    private readonly token: () => Promise<string>,
    private readonly base: string = resolveApiBase(),
  ) {}

  // Retries what the server said it might serve later, and nothing else. Every
  // request this class makes is safe to repeat: the reads are reads, and the
  // one write removes a label, which lands the same way however often it is
  // applied.
  private async request(path: string, init?: RequestInit): Promise<unknown> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.attempt(path, init);
      } catch (err) {
        if (!(err instanceof GmailApiError) || attempt >= MAX_ATTEMPTS || !isRetryable(err)) throw err;
        await sleep(backoffMs(attempt, err.retryAfterMs));
      }
    }
  }

  private async attempt(path: string, init?: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${this.base}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${await this.token()}`, accept: 'application/json', ...init?.headers },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new GmailApiError(`Cannot reach the Gmail API: ${errorMessage(err)}`, 0, 'unreachable');
    }

    // Read as text first so an HTML error page from a proxy produces a clear
    // message rather than a JSON parse stack. Bodies are never echoed: a
    // success body is the user's mail.
    const body = await response.text();
    let parsed: unknown;
    try {
      parsed = body === '' ? {} : JSON.parse(body);
    } catch {
      throw new GmailApiError(
        `Gmail API returned a non-JSON response (HTTP ${response.status})`,
        response.status,
        'malformed_response',
      );
    }

    if (!response.ok) {
      const failure = parsed as { error?: { message?: unknown; status?: unknown } };
      const reason = typeof failure.error?.status === 'string' ? failure.error.status : `http_${response.status}`;
      const detail = typeof failure.error?.message === 'string' ? `: ${failure.error.message}` : '';
      throw new GmailApiError(
        `Gmail API rejected the request (${reason})${detail}`,
        response.status,
        reason,
        parseRetryAfter(response.headers.get('retry-after')),
      );
    }
    return parsed;
  }

  // One page of message ids. Gmail caps pages at 500; the caller paginates.
  // Spam and Trash are excluded by default, which is the exclusion the IMAP
  // backend has to implement by hand.
  async listMessages(query: string, pageToken?: string): Promise<{ ids: string[]; nextPageToken?: string }> {
    const params = new URLSearchParams({ q: query, maxResults: '500' });
    if (pageToken !== undefined) params.set('pageToken', pageToken);
    const body = asRecord(await this.request(`/messages?${params.toString()}`));
    const messages = Array.isArray(body.messages) ? body.messages : [];
    return {
      ids: messages.map((m) => asRecord(m).id).filter((id): id is string => typeof id === 'string'),
      nextPageToken: typeof body.nextPageToken === 'string' ? body.nextPageToken : undefined,
    };
  }

  // `metadata` returns headers and labels without the body — enough to
  // identify a message during listing. `full` returns the parts too.
  async getMessage(id: string, format: 'metadata' | 'full'): Promise<GmailMessage> {
    const params = new URLSearchParams({ format });
    if (format === 'metadata') {
      for (const header of ['Message-ID', 'From', 'To', 'Subject', 'Date']) {
        params.append('metadataHeaders', header);
      }
    }
    return await this.request(`/messages/${encodeURIComponent(id)}?${params.toString()}`) as GmailMessage;
  }

  // Changes since `startHistoryId`. A 404 means Gmail has expired that resume
  // point; the caller falls back to a full listing rather than treating it as
  // an error.
  async listHistory(startHistoryId: string, pageToken?: string): Promise<GmailHistoryPage> {
    const params = new URLSearchParams({ startHistoryId, maxResults: '500' });
    for (const type of ['messageAdded', 'messageDeleted', 'labelAdded', 'labelRemoved']) {
      params.append('historyTypes', type);
    }
    if (pageToken !== undefined) params.set('pageToken', pageToken);
    const body = asRecord(await this.request(`/history?${params.toString()}`));

    const addedIds: string[] = [];
    const removedIds: string[] = [];
    for (const entry of Array.isArray(body.history) ? body.history : []) {
      const record = asRecord(entry);
      for (const added of Array.isArray(record.messagesAdded) ? record.messagesAdded : []) {
        const id = asRecord(asRecord(added).message).id;
        if (typeof id === 'string') addedIds.push(id);
      }
      for (const deleted of Array.isArray(record.messagesDeleted) ? record.messagesDeleted : []) {
        const id = asRecord(asRecord(deleted).message).id;
        if (typeof id === 'string') removedIds.push(id);
      }
      // A label change can move a message into or out of our view: gaining
      // TRASH or SPAM removes it, losing them brings it back. Any other label
      // change may have moved it between INBOX and All Mail, so it is
      // re-examined rather than assumed unchanged.
      for (const [key, direction] of [['labelsAdded', 'add'], ['labelsRemoved', 'remove']] as const) {
        for (const change of Array.isArray(record[key]) ? (record[key] as unknown[]) : []) {
          const changeRecord = asRecord(change);
          const id = asRecord(changeRecord.message).id;
          if (typeof id !== 'string') continue;
          const labels = Array.isArray(changeRecord.labelIds) ? changeRecord.labelIds : [];
          const touchesHidden = labels.some((l) => l === 'TRASH' || l === 'SPAM');
          if (!touchesHidden) addedIds.push(id);
          else if (direction === 'add') removedIds.push(id);
          else addedIds.push(id);
        }
      }
    }
    return {
      addedIds,
      removedIds,
      nextPageToken: typeof body.nextPageToken === 'string' ? body.nextPageToken : undefined,
    };
  }

  // The account's current historyId — the resume point a clean sync saves.
  async currentHistoryId(): Promise<string | null> {
    const profile = asRecord(await this.request('/profile'));
    return typeof profile.historyId === 'string' ? profile.historyId : null;
  }

  async removeLabels(id: string, removeLabelIds: string[]): Promise<void> {
    await this.request(`/messages/${encodeURIComponent(id)}/modify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ removeLabelIds }),
    });
  }
}
