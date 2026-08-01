// One phrasing for "turn a caught value into something printable". Every
// catch block in this codebase reports rather than swallows, and what lands in
// a catch is not necessarily an Error — libraries and `throw` of a plain value
// both reach here — so String() is the fallback rather than an assumption.

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
