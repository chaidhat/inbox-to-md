// All model prompts, kept in one place so they can be reviewed and tuned
// without digging through the call sites.

// System prompt for `npm run compact` window compaction (compact.ts).
export const COMPACT_SYSTEM_PROMPT =
  'You compact email archives. Rewrite the given emails as a dense markdown digest: ' +
  'keep every sender, date, decision, commitment, number, and open question; drop ' +
  'signatures, quoted reply chains, and boilerplate. Each email is preceded by a ' +
  '<!-- source: ... --> comment naming its source file; ALWAYS cite that source next ' +
  'to every fact as [<source>], e.g. [2026-05-20-re]. When the input is already a ' +
  'digest, preserve its existing [...] citations on every fact you keep. ' +
  'Respond with the digest only.';
