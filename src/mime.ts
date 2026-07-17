// MIME body-structure helpers: pick which part of an email to download and
// decode it. The sync engine fetches BODYSTRUCTURE first and then downloads
// only the text part it needs, so attachment bytes (base64-encoded and often
// megabytes) never cross the wire; attachments are described from the
// structure metadata alone.

import type { MessageStructureObject } from 'imapflow';

// The one body part worth downloading: the first non-attachment text/plain
// part, falling back to text/html.
export interface TextPartRef {
  part: string;      // IMAP part specifier for BODY[part]
  encoding: string;  // content-transfer-encoding, lowercased
  charset: string;
  isHtml: boolean;
}

export interface AttachmentInfo {
  name: string;
  size: number;
  contentType: string;
}

function leafNodes(root: MessageStructureObject): MessageStructureObject[] {
  if (root.childNodes && root.childNodes.length > 0) {
    return root.childNodes.flatMap((child) => leafNodes(child));
  }
  return [root];
}

// A non-multipart message has a single unnumbered node; IMAP addresses its
// body as part "1".
export function findTextPart(root: MessageStructureObject): TextPartRef | null {
  let plain: TextPartRef | null = null;
  let html: TextPartRef | null = null;
  for (const node of leafNodes(root)) {
    const type = (node.type ?? '').toLowerCase();
    if ((node.disposition ?? '').toLowerCase() === 'attachment') continue;
    const ref: TextPartRef = {
      part: node.part ?? '1',
      encoding: (node.encoding ?? '').toLowerCase(),
      charset: node.parameters?.charset ?? 'utf-8',
      isHtml: type === 'text/html',
    };
    if (type === 'text/plain' && plain === null) plain = ref;
    else if (type === 'text/html' && html === null) html = ref;
  }
  return plain ?? html;
}

// Attachments are described from structure metadata only — their bytes are
// never downloaded. Anything explicitly marked as an attachment counts, as
// does any named non-text part (inline images and the like).
export function collectAttachments(root: MessageStructureObject): AttachmentInfo[] {
  const attachments: AttachmentInfo[] = [];
  for (const node of leafNodes(root)) {
    const type = (node.type ?? '').toLowerCase();
    const name = node.dispositionParameters?.filename ?? node.parameters?.name ?? null;
    const isAttachment =
      (node.disposition ?? '').toLowerCase() === 'attachment' ||
      (name !== null && !type.startsWith('text/'));
    if (!isAttachment) continue;
    attachments.push({
      name: name ?? '(unnamed)',
      size: node.size ?? 0,
      contentType: type || 'application/octet-stream',
    });
  }
  return attachments;
}

// =XX hex escapes, soft line breaks (=\r\n or =\n) removed; a stray '=' that
// fits neither form is kept literally, as decoders conventionally do.
function decodeQuotedPrintable(raw: Buffer): Buffer {
  const s = raw.toString('latin1');
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '=') {
      out.push(s.charCodeAt(i));
      continue;
    }
    if (s[i + 1] === '\r' && s[i + 2] === '\n') { i += 2; continue; }
    if (s[i + 1] === '\n') { i += 1; continue; }
    const hex = s.slice(i + 1, i + 3);
    if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
      out.push(parseInt(hex, 16));
      i += 2;
      continue;
    }
    out.push(0x3d); // '='
  }
  return Buffer.from(out);
}

// Decodes a raw body part (as stored on the server) to a string: undo the
// content-transfer-encoding, then the charset. Unknown charsets fall back to
// UTF-8 rather than failing the whole email — mojibake in one message is
// recoverable, a sync error is noise on every run.
export function decodeTextPart(raw: Buffer, encoding: string, charset: string): string {
  let bytes: Buffer;
  switch (encoding) {
    case 'base64':
      bytes = Buffer.from(raw.toString('latin1'), 'base64'); // Buffer.from skips whitespace
      break;
    case 'quoted-printable':
      bytes = decodeQuotedPrintable(raw);
      break;
    default: // 7bit / 8bit / binary
      bytes = raw;
  }
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}
