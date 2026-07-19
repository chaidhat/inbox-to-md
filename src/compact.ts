// `npm run compact` — for each account, hierarchically compact its synced
// emails down to a single markdown digest under TARGET_TOKENS tokens
// (docs/algo-1.md), written to <syncPath>/compacted/final.md.
//
// Each layer: greedily pack the input strings into windows of at most
// TARGET_TOKENS tokens, have Claude compact each window in parallel, save
// each result as compacted/k_<layer>/<m>.md, then recurse on the compacted
// strings until everything fits in one window.
//
// Model calls go through the Claude Agent SDK, which runs on the local
// Claude Code installation and its login — usage bills to the Claude
// subscription, no ANTHROPIC_API_KEY or .env needed. The Agent SDK has no
// count_tokens endpoint, so token counts are a conservative local estimate;
// windows are soft bounds (the model's context is vastly larger than a
// window), so estimation error only shifts where windows split.

import { query } from '@anthropic-ai/claude-agent-sdk';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { loadConfig } from './config.js';
import { COMPACT_SYSTEM_PROMPT } from './prompts.js';
import { listSyncedEmails, readSyncedEmail } from './ref-emails.js';

const MODEL = 'claude-sonnet-5';
const TARGET_TOKENS = 100_000;
// A window must fit the model's context alongside the system prompt and
// leave room for the response (Sonnet 5: 1M context, 128K max output), so
// windows are capped independently of TARGET_TOKENS, with generous headroom
// for token-estimation error. The 0.98 keeps a window under the cap once
// parts are joined (concatenation boundaries can add ~1 token each).
const MODEL_WINDOW_CAP = 400_000;
const WINDOW_TOKEN_BUDGET = Math.floor(Math.min(TARGET_TOKENS, MODEL_WINDOW_CAP) * 0.98);
const CONCURRENCY = 8;

// Synced emails inline attachments as base64 data URIs — megabytes of
// encoded bytes that carry nothing a text digest can use, blow the token
// budget, and trip the API's usage-policy classifier (a prompt that is
// mostly opaque base64 looks like obfuscated content). Strip them before
// compaction, keeping the alt text as a trace that an attachment existed.
function stripInlineAttachments(email: string): string {
  return email.replace(
    /\(data:[\w.+-]+\/[\w.+-]+;base64,[A-Za-z0-9+/=\s]+\)/g,
    '(attachment omitted)',
  );
}

// English prose averages ~4 chars/token; email archives (headers, URLs,
// encoded content) tokenize denser, so estimate conservatively at 3.5 —
// overestimating tokens only makes windows smaller, never over budget.
export function estimateTokens(str: string): number {
  if (str.trim() === '') return 0;
  return Math.ceil(str.length / 3.5);
}

// Saved window digests start with a checksum of the window's *input* text,
// so a re-run only reuses a digest when the underlying window content is
// unchanged (new/edited emails shift window boundaries and must recompact).
// The header is stripped before the digest feeds the next layer.
const CHECKSUM_RE = /^<!-- input-checksum: ([0-9a-f]{64}) -->\n/;

function checksum(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

// Returns the saved digest if it was produced from this exact window text,
// or null when missing, stale, checksum-less (pre-checksum run), or a
// failure placeholder — all of which mean the window must be recompacted.
function readReusableDigest(outPath: string, windowText: string): string | null {
  if (!existsSync(outPath)) return null;
  const existing = readFileSync(outPath, 'utf8');
  const match = CHECKSUM_RE.exec(existing);
  if (match === null || match[1] !== checksum(windowText)) return null;
  const digest = existing.slice(match[0].length);
  if (digest.startsWith('> [!warning]')) return null;
  return digest;
}

// One model call: compact a single window's text. Returns the digest, or a
// failure reason string (never both) so the caller can record why a window
// was skipped without killing the run. Tools are disabled and the turn count
// capped: this is a pure text-in/text-out completion, not an agentic session.
async function compactWindow(
  windowText: string,
): Promise<{ text: string } | { failure: string }> {
  for await (const message of query({
    prompt: windowText,
    options: {
      model: MODEL,
      systemPrompt: COMPACT_SYSTEM_PROMPT,
      tools: [],
      maxTurns: 1,
    },
  })) {
    if (message.type !== 'result') continue;
    if (message.subtype !== 'success') {
      return { failure: `${message.subtype}: ${message.errors.join('; ')}` };
    }
    if (message.is_error) {
      return { failure: `api error (status ${message.api_error_status ?? 'unknown'}): ${message.result}` };
    }
    if (message.stop_reason === 'refusal') return { failure: 'model refused' };
    if (message.result === '') return { failure: 'empty result' };
    return { text: message.result };
  }
  return { failure: 'stream ended without a result message' };
}

// One layer of the recursion over one account's emails. `outputDir` is that
// account's compacted/ directory; `layer` is internal bookkeeping for its
// k_<layer>/ subpaths — callers pass only (strs, target, outputDir).
export async function compact(
  strs: string[],
  targetNumberOfTokens: number,
  outputDir: string,
  layer = 0,
): Promise<string> {
  const budget = Math.min(targetNumberOfTokens, WINDOW_TOKEN_BUDGET);

  const counts = strs.map(estimateTokens);
  const total = counts.reduce((sum, c) => sum + c, 0);
  if (total <= targetNumberOfTokens) {
    // Base case: everything already fits in one window.
    return strs.join('');
  }

  // Greedy sliding window over the running token sum: extend j until adding
  // the next string would exceed the budget, then start a new window at j.
  // A single string over budget can't share a window and may not even fit
  // the model's context (one 2M-token email exists in this archive), so it
  // is sliced into budget-sized character chunks — chars per token derived
  // from the estimator — and each chunk becomes a window.
  const windows: string[] = [];
  let windowParts: string[] = [];
  let windowTokens = 0;
  for (let k = 0; k < strs.length; k++) {
    if (counts[k] > budget) {
      if (windowParts.length > 0) {
        windows.push(windowParts.join(''));
        windowParts = [];
        windowTokens = 0;
      }
      const chunkChars = Math.max(1, Math.floor((strs[k].length * budget) / counts[k]));
      for (let pos = 0; pos < strs[k].length; pos += chunkChars) {
        windows.push(strs[k].slice(pos, pos + chunkChars));
      }
      continue;
    }
    if (windowParts.length > 0 && windowTokens + counts[k] > budget) {
      windows.push(windowParts.join(''));
      windowParts = [];
      windowTokens = 0;
    }
    windowParts.push(strs[k]);
    windowTokens += counts[k];
  }
  if (windowParts.length > 0) windows.push(windowParts.join(''));

  console.log(`layer ${layer}: ${strs.length} inputs (~${total} tokens) → ${windows.length} windows`);

  const layerDir = join(outputDir, `k_${layer}`);
  mkdirSync(layerDir, { recursive: true });

  // Compact each window with the model, in bounded-concurrency batches (each
  // call spawns a Claude Code subprocess, so keep the fan-out modest).
  const compacted: string[] = [];
  for (let start = 0; start < windows.length; start += CONCURRENCY) {
    const batch = windows.slice(start, start + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (windowText, offset) => {
        const m = start + offset;
        // Resume support: a digest left by an earlier run is reused only if
        // its recorded input checksum still matches this window's text.
        // Failure placeholders don't count — a re-run retries those windows.
        const outPath = join(layerDir, `${m}.md`);
        const reusable = readReusableDigest(outPath, windowText);
        if (reusable !== null) {
          console.log(`layer ${layer}: reusing existing window ${m}`);
          return reusable;
        }
        const checksumHeader = `<!-- input-checksum: ${checksum(windowText)} -->\n`;
        const result = await compactWindow(windowText);
        // A refusal on one window (e.g. a phishing email in the archive)
        // must not kill the run: record it visibly and keep going.
        if ('failure' in result) {
          console.warn(`layer ${layer}: window ${m} NOT compacted (${result.failure}) — placeholder written`);
          const placeholder = `> [!warning] Window ${m} of layer ${layer} was not compacted (${result.failure}); its content is omitted from this digest.\n`;
          writeFileSync(outPath, checksumHeader + placeholder);
          return placeholder;
        }
        writeFileSync(outPath, checksumHeader + result.text);
        console.log(`layer ${layer}: compacted window ${m}`);
        return result.text;
      }),
    );
    compacted.push(...results);
  }

  return compact(compacted, targetNumberOfTokens, outputDir, layer + 1);
}

export async function main(): Promise<void> {
  let compactedAny = false;
  for (const account of loadConfig().accounts) {
    const synced = listSyncedEmails(account.syncPath);
    if (synced.length === 0) {
      console.warn(`${account.username}: no synced emails found — skipping`);
      continue;
    }
    compactedAny = true;
    console.log(`compacting ${synced.length} emails from ${account.username} to <= ${TARGET_TOKENS} tokens with ${MODEL}`);
    // Each email is prefixed with its citation key so the model can attribute
    // every digest fact to its source file (see COMPACT_SYSTEM_PROMPT).
    const emails = synced.map(
      (email) =>
        `\n<!-- source: ${email.citationKey} -->\n${stripInlineAttachments(readSyncedEmail(email))}`,
    );
    const outputDir = join(account.syncPath, 'compacted');
    const digest = await compact(emails, TARGET_TOKENS, outputDir);
    mkdirSync(outputDir, { recursive: true });
    const finalPath = join(outputDir, 'final.md');
    writeFileSync(finalPath, digest);
    console.log(`${account.username}: final digest written to ${finalPath}`);
  }
  if (!compactedAny) {
    console.error('no synced emails found for any account — run `npm start` first');
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
