// Minimal ANSI helpers — keeps the TUI dep-free. Functions return the input
// unchanged when stdout isn't a TTY so piping to a file or another command
// produces clean text.

const tty = process.stdout.isTTY;

function wrap(open: number, close: number) {
  return (s: string) => (tty ? `\x1b[${open}m${s}\x1b[${close}m` : s);
}

export const bold = wrap(1, 22);
export const dim = wrap(2, 22);
export const red = wrap(31, 39);
export const green = wrap(32, 39);
export const cyan = wrap(36, 39);
