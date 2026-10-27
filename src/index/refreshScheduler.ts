/**
 * Coalesces bursts of file events into at most one run per interval. The timer is not reset by later
 * events, so a transcript that is written continuously still refreshes instead of waiting for silence.
 */
export class RefreshScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly intervalMs: number,
    private readonly run: () => void,
  ) {}

  notify(): void {
    if (this.timer) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.run();
    }, this.intervalMs);
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}
