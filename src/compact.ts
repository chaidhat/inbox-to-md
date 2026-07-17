// `npm run compact` — hierarchically compact every synced email down to a
// single markdown digest under TARGET_TOKENS tokens (docs/algo-1.md).
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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { loadConfig } from './config.js';
import { COMPACT_SYSTEM_PROMPT } from './prompts.js';
import { getEmail, getEmailCitationKey, getNumberOfEmails } from './ref-emails.js';

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
// Digest output lives alongside the synced emails, not in the repo. The
// digest spans all accounts but needs one home; the first account's syncPath
// is used.
const OUTPUT_DIR = join(loadConfig().accounts[0]?.syncPath ?? '.', 'compacted');

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

// One layer of the recursion. `layer` is internal bookkeeping for the
// compacted/k_<layer>/ output paths; callers pass only (strs, target).
export async function compact(
  strs: string[],
  targetNumberOfTokens: number,
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

  const layerDir = join(OUTPUT_DIR, `k_${layer}`);
  mkdirSync(layerDir, { recursive: true });

  // Compact each window with the model, in bounded-concurrency batches (each
  // call spawns a Claude Code subprocess, so keep the fan-out modest).
  const compacted: string[] = [];
  for (let start = 0; start < windows.length; start += CONCURRENCY) {
    const batch = windows.slice(start, start + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (windowText, offset) => {
        const m = start + offset;
        // Resume support: windowing is deterministic for the same inputs, so
        // a digest left by an earlier interrupted run is still valid. Failure
        // placeholders don't count — a re-run retries those windows.
        const outPath = join(layerDir, `${m}.md`);
        if (existsSync(outPath)) {
          const existing = readFileSync(outPath, 'utf8');
          if (!existing.startsWith('> [!warning]')) {
            console.log(`layer ${layer}: reusing existing window ${m}`);
            return existing;
          }
        }
        const result = await compactWindow(windowText);
        // A refusal on one window (e.g. a phishing email in the archive)
        // must not kill the run: record it visibly and keep going.
        if ('failure' in result) {
          console.warn(`layer ${layer}: window ${m} NOT compacted (${result.failure}) — placeholder written`);
          const placeholder = `> [!warning] Window ${m} of layer ${layer} was not compacted (${result.failure}); its content is omitted from this digest.\n`;
          writeFileSync(outPath, placeholder);
          return placeholder;
        }
        writeFileSync(outPath, result.text);
        console.log(`layer ${layer}: compacted window ${m}`);
        return result.text;
      }),
    );
    compacted.push(...results);
  }

  return compact(compacted, targetNumberOfTokens, layer + 1);
}

export async function main(): Promise<void> {
  const n = getNumberOfEmails();
  if (n === 0) {
    console.error('no synced emails found — run `npm start` first');
    process.exitCode = 1;
    return;
  }
  console.log(`compacting ${n} emails to <= ${TARGET_TOKENS} tokens with ${MODEL}`);
  // Each email is prefixed with its citation key so the model can attribute
  // every digest fact to its source file (see COMPACT_SYSTEM_PROMPT).
  const emails = Array.from(
    { length: n },
    (_, k) =>
      `\n<!-- source: ${getEmailCitationKey(k)} -->\n${stripInlineAttachments(getEmail(k))}`,
  );
  const digest = await compact(emails, TARGET_TOKENS);
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const finalPath = join(OUTPUT_DIR, 'final.md');
  writeFileSync(finalPath, digest);
  console.log(`done — final digest written to ${finalPath}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
