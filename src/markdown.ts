// Email → markdown rendering: frontmatter, filenames, and the scanner that
// reads frontmatter values back out of existing files. Writer and scanner
// live together so the frontmatter format has exactly one owner.

import { createHash } from 'crypto';
import { closeSync, openSync, readSync } from 'fs';
import TurndownService from 'turndown';
import type { AttachmentInfo } from './mime.js';

const turndown = new TurndownService();

// Inline images arrive as data: URIs — megabytes of base64 that a text
// digest can't use. Replace them with a marker instead of copying the
// payload into the markdown.
turndown.addRule('dataUriImage', {
  filter: (node) => node.nodeName === 'IMG' && /^data:/i.test(node.getAttribute('src') ?? ''),
  replacement: () => '*(inline image)*',
});

// Every frontmatter value goes through JSON.stringify: a JSON string is a
// valid YAML double-quoted scalar, and it escapes quotes, newlines, and
// control characters — so a hostile subject like `"\nauthor: x` cannot
// inject frontmatter keys.
function yamlValue(s: string): string {
  return JSON.stringify(s);
}

// Everything renderEmail needs, decoupled from any IMAP/parser library:
// the sync engine assembles this from the envelope, body structure, and the
// one downloaded text part.
export interface EmailContent {
  from: string;
  to: string;
  subject: string;
  date: Date | null;
  messageId: string;
  text: string; // decoded text/plain body, '' if the email has none
  html: string; // decoded text/html body, used only when text is empty
  attachments: AttachmentInfo[];
}

export function slugify(s: string): string {
  const slug = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/, '');
  return slug || 'no-subject';
}

function localDateStamp(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// Deterministic stand-in identity for emails with no Message-ID header: the
// filename itself becomes the dedupe key, so it must hash the same fields on
// every run.
export function fallbackHash(from: string, dateIso: string, subject: string): string {
  return createHash('sha256').update(`${from}\n${dateIso}\n${subject}`).digest('hex').slice(0, 8);
}

export function buildFilename(date: Date, subject: string, hash?: string): string {
  const suffix = hash ? `-${hash}` : '';
  return `${localDateStamp(date)}-${slugify(subject)}${suffix}.md`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function renderEmail(email: EmailContent, fallbackDate: Date, mailbox: string): string {
  const date = email.date ?? fallbackDate;

  let body: string;
  if (email.text.trim() !== '') {
    body = email.text.trim();
  } else if (email.html !== '') {
    body = turndown.turndown(email.html).trim() || '*(no body)*';
  } else {
    body = '*(no body)*';
  }

  let out = '---\n';
  out += `from: ${yamlValue(email.from)}\n`;
  out += `to: ${yamlValue(email.to)}\n`;
  out += `subject: ${yamlValue(email.subject)}\n`;
  out += `date: ${yamlValue(date.toISOString())}\n`;
  out += `message-id: ${yamlValue(email.messageId)}\n`;
  out += `mailbox: ${yamlValue(mailbox)}\n`;
  out += '---\n\n';
  out += body + '\n';

  if (email.attachments.length > 0) {
    out += '\n## Attachments\n\n';
    for (const att of email.attachments) {
      out += `- ${att.name} (${formatSize(att.size)}, ${att.contentType})\n`;
    }
  }
  return out;
}

// Reads a frontmatter value back out of a previously written file. Scans only
// the frontmatter block — an email body is arbitrary text and could contain a
// line that looks like frontmatter, so matching past the closing --- would
// let a hostile email poison the dedupe set. `key` must be a literal key we
// wrote ourselves (it is interpolated into a regex unescaped).
export function extractFrontmatterValue(fileHead: string, key: string): string | null {
  if (!fileHead.startsWith('---\n')) return null;
  const end = fileHead.indexOf('\n---', 4);
  const frontmatter = end === -1 ? fileHead : fileHead.slice(0, end);
  const match = frontmatter.match(new RegExp(`^${key}: (".*")$`, 'm'));
  if (!match) return null;
  try {
    const value = JSON.parse(match[1]) as string;
    return value === '' ? null : value;
  } catch {
    return null;
  }
}

export function extractMessageId(fileHead: string): string | null {
  return extractFrontmatterValue(fileHead, 'message-id');
}

// How much of each file to read when scanning for frontmatter values.
// Frontmatter is a handful of single-line quoted scalars, but from/to lists
// with many recipients can get long — 8 KB leaves a wide margin.
const FRONTMATTER_SCAN_BYTES = 8192;

// Reads just the head of a previously written file, enough to cover its
// frontmatter. Returns null when the file can't be opened (e.g. it vanished
// between readdir and open).
export function readFrontmatterHead(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return null;
  }
  try {
    const buffer = Buffer.alloc(FRONTMATTER_SCAN_BYTES);
    const bytes = readSync(fd, buffer, 0, FRONTMATTER_SCAN_BYTES, 0);
    return buffer.toString('utf8', 0, bytes);
  } finally {
    closeSync(fd);
  }
}
