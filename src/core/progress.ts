// Progress bars for the long-running engines (sync, compact).
//
// Bars render on stderr, and only when stderr is a TTY — piping a run to a
// file or another command produces clean text, the same degradation rule the
// ansi.ts helpers follow. Off-TTY every bar is a silent no-op, so callers
// never branch on isTTY themselves.
//
// A terminal can only carry one writer at a time: anything printed while a bar
// is on screen splices into the middle of it. So every message an engine emits
// during a bar must go through `log()`, which lifts the line above the bars.
// Results that outlive the run (per-account summaries, output paths) stay on
// stdout via console.log, printed once no bar is active.

import cliProgress from 'cli-progress';

// Labels are padded to a common width so stacked bars line up; a longer one is
// truncated rather than pushing every other bar out of alignment.
const LABEL_WIDTH = 22;
const BAR_WIDTH = 24;
const FORMAT = '  {label} |{bar}| {value}/{total} {status}';

export interface ProgressBar {
  /** Advance by one. `status` replaces the trailing text when given. */
  increment(status?: string): void;
  /** Jump to an absolute value, for backends that report their own count. */
  update(value: number, status?: string): void;
  /** Revise the total when it is only discovered as the work proceeds. */
  setTotal(total: number): void;
}

const SILENT_BAR: ProgressBar = {
  increment() {},
  update() {},
  setTotal() {},
};

function padLabel(label: string): string {
  if (label.length > LABEL_WIDTH) return label.slice(0, LABEL_WIDTH - 1) + '…';
  return label.padEnd(LABEL_WIDTH);
}

// An absent payload leaves the bar's current text alone, so callers can
// advance a bar without restating its status every time.
function payload(status: string | undefined): { status: string } | undefined {
  return status === undefined ? undefined : { status };
}

// A set of bars drawn together, one per phase of a run. Finished bars stay on
// screen at their final value: the stack of them is the record of what ran,
// which is what the plain progress line used to leave behind.
export class ProgressGroup {
  private readonly bars: cliProgress.MultiBar | null;

  constructor() {
    this.bars = process.stderr.isTTY
      ? new cliProgress.MultiBar(
          {
            format: FORMAT,
            barsize: BAR_WIDTH,
            autopadding: true,
            clearOnComplete: false,
            // Restored by cli-progress on stop() and on SIGINT/SIGTERM
            // (gracefulExit), so Ctrl-C can't leave the terminal cursorless.
            hideCursor: true,
            // Without this a 0-total bar renders as complete, which reads as
            // "done" for work that never started.
            emptyOnZero: true,
          },
          cliProgress.Presets.shades_grey,
        )
      : null;
  }

  // A bar with nothing to count would just be a 0/0 line, so it is silently
  // dropped — the caller's summary still reports the empty phase.
  bar(label: string, total: number): ProgressBar {
    if (this.bars === null || total <= 0) return SILENT_BAR;
    const bar = this.bars.create(total, 0, { label: padLabel(label), status: '' });
    return {
      increment: (status) => bar.increment(1, payload(status)),
      update: (value, status) => bar.update(value, payload(status)),
      setTotal: (total) => bar.setTotal(total),
    };
  }

  // Prints a line above the bars. Use for anything an engine reports mid-run:
  // errors, warnings, per-phase notes.
  //
  // cli-progress only queues the line and flushes it on its next redraw, and
  // its stop() renders the bars *without* draining that queue — so a run that
  // finishes before the next redraw drops the message entirely. An error that
  // silently disappears is worse than no bar at all, so every line is flushed
  // on the spot.
  log(line: string): void {
    if (this.bars === null) {
      console.error(line);
      return;
    }
    this.bars.log(line.endsWith('\n') ? line : line + '\n');
    this.flush();
  }

  // Ends rendering and restores the cursor. Callers must reach this on every
  // path — put it in a `finally`.
  stop(): void {
    this.flush(); // anything queued by a future code path, not just log()
    this.bars?.stop();
  }

  private flush(): void {
    if (this.bars?.isActive === true) this.bars.update();
  }
}
