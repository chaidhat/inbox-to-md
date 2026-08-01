// A small pool of IMAP connections, so downloads can run in parallel.
//
// One IMAP connection can only serve one fetch at a time: a mailbox is
// *selected* on the connection, so two concurrent fetches in different
// mailboxes would re-select underneath each other. Parallelism therefore means
// more connections, not more requests on one — which is what this pool is for.
//
// Connections are created lazily and never handed to two callers at once.

import type { ImapFlow, MailboxLockObject } from 'imapflow';
import { closeImapClient, connectImap, type ImapTarget } from './client.js';

// One connection plus the mailbox it currently has selected. Holding the lock
// across calls turns what would be a SELECT per message into one per mailbox.
export class ImapConnection {
  private lock: { path: string; lock: MailboxLockObject } | null = null;

  constructor(readonly client: ImapFlow) {}

  async select(path: string): Promise<void> {
    if (this.lock?.path === path) return;
    this.lock?.lock.release();
    this.lock = null;
    this.lock = { path, lock: await this.client.getMailboxLock(path) };
  }

  // Whether this connection is still worth reusing. imapflow marks a client
  // unusable once its socket is gone, and handing that back out would fail
  // every later lease that happened to draw it.
  get usable(): boolean {
    return this.client.usable;
  }

  async close(): Promise<void> {
    this.lock?.lock.release();
    this.lock = null;
    await closeImapClient(this.client);
  }
}

type Waiter = {
  resolve: (conn: ImapConnection) => void;
  reject: (err: unknown) => void;
};

export class ImapConnectionPool {
  private readonly idle: ImapConnection[] = [];
  private readonly waiters: Waiter[] = [];
  // Live connections, leased or idle: the set `close` tears down. `opening`
  // counts the ones still being connected, which `limit` must also bound.
  private readonly live = new Set<ImapConnection>();
  private opening = 0;
  private closed = false;

  // `first` is already connected: opening it is how the caller found out the
  // account works at all, so the pool adopts it rather than opening a second.
  private constructor(
    private readonly account: ImapTarget,
    private readonly limit: number,
    first: ImapConnection,
  ) {
    this.live.add(first);
    this.idle.push(first);
  }

  static async open(account: ImapTarget, limit: number): Promise<ImapConnectionPool> {
    return new ImapConnectionPool(account, limit, new ImapConnection(await connectImap(account)));
  }

  // Leases a connection, growing the pool up to `limit` before making a caller
  // wait. Every acquire must be paired with a `release`.
  async acquire(): Promise<ImapConnection> {
    if (this.closed) throw new Error('IMAP connection pool is closed');

    const reusable = this.takeIdle();
    if (reusable) return reusable;

    if (this.live.size + this.opening < this.limit) {
      const opened = await this.grow();
      if (opened) return opened;
    }

    return new Promise<ImapConnection>((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  // Returns a connection to the pool, handing it straight to whoever is next in
  // line. A connection whose socket died is discarded instead, and the slot it
  // frees is used to open a replacement for anyone still waiting.
  release(conn: ImapConnection): void {
    if (this.closed || !conn.usable) {
      this.live.delete(conn);
      void conn.close();
      this.serveWaiters();
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve(conn);
    else this.idle.push(conn);
  }

  async close(): Promise<void> {
    this.closed = true;
    // Anyone still parked would otherwise wait on a pool that will never hand
    // anything back.
    for (const waiter of this.waiters.splice(0)) waiter.reject(new Error('IMAP connection pool is closed'));
    const connections = [...this.live];
    this.live.clear();
    this.idle.length = 0;
    await Promise.all(connections.map((conn) => conn.close()));
  }

  // Pops the newest idle connection, discarding any that died while parked.
  private takeIdle(): ImapConnection | null {
    for (;;) {
      const conn = this.idle.pop();
      if (conn === undefined) return null;
      if (conn.usable) return conn;
      this.live.delete(conn);
      void conn.close();
    }
  }

  // Opens one more connection. Returns null when the server refused it, which
  // is not fatal: servers cap simultaneous connections (Gmail allows 15), and
  // the caller can share the connections the pool already holds. A pool with
  // none left to share has genuinely failed, so that refusal propagates.
  private async grow(): Promise<ImapConnection | null> {
    this.opening++;
    try {
      const conn = new ImapConnection(await connectImap(this.account));
      this.live.add(conn);
      return conn;
    } catch (err) {
      if (this.live.size === 0) throw err;
      return null;
    } finally {
      this.opening--;
    }
  }

  // Called after a connection is discarded: its slot is free, so try to open a
  // replacement for the head of the queue. A failure to reconnect leaves the
  // waiter parked for the next release rather than failing the whole sync.
  private serveWaiters(): void {
    if (this.closed || this.waiters.length === 0) return;
    if (this.live.size + this.opening >= this.limit) return;
    void this.grow().then(
      (conn) => {
        if (conn === null) return;
        const waiter = this.waiters.shift();
        if (waiter) waiter.resolve(conn);
        else this.idle.push(conn);
      },
      () => {
        // The pool is empty and cannot reconnect: nothing will ever be
        // released, so waiting forever is the one outcome to avoid.
        for (const waiter of this.waiters.splice(0)) {
          waiter.reject(new Error('lost every IMAP connection to this account'));
        }
      },
    );
  }
}
