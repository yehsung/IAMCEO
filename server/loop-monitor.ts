export interface LoopMonitorOptions {
  now?: () => number;
  log?: (line: string) => void;
  intervalMs?: number;
  thresholdMs?: number;
  reportIntervalMs?: number;
}

/** Retain completed work until the next sample: a blocked loop cannot sample its active stack. */
export class LoopMonitor {
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly intervalMs: number;
  private readonly thresholdMs: number;
  private readonly reportIntervalMs: number;
  private readonly timer: ReturnType<typeof setInterval>;
  private sampledAt: number;
  private longest?: { name: string; durationMs: number };
  private reports = new Map<string, { count: number; maxMs: number; nextAt: number; timer?: ReturnType<typeof setTimeout> }>();
  private stopped = false;

  constructor(options: LoopMonitorOptions = {}) {
    this.now = options.now ?? (() => performance.now());
    this.log = options.log ?? (line => console.warn(line));
    this.intervalMs = Math.max(1, options.intervalMs ?? 250);
    this.thresholdMs = Math.max(0, options.thresholdMs ?? 500);
    this.reportIntervalMs = Math.max(1, options.reportIntervalMs ?? 10_000);
    this.sampledAt = this.now();
    this.timer = setInterval(() => this.sample(), this.intervalMs);
    this.timer.unref();
  }

  run<T>(name: string, work: () => T): T {
    return this.capture(name, work, true);
  }

  private capture<T>(name: string, work: () => T, reportSlow: boolean): T {
    const started = this.now();
    try { return work(); }
    finally {
      const durationMs = this.now() - started;
      // A fast request immediately before an OS/GC pause is not evidence that it blocked the loop.
      if (durationMs > this.intervalMs && (!this.longest || durationMs > this.longest.durationMs)) this.longest = { name, durationMs };
      if (reportSlow && durationMs > this.thresholdMs) this.report(`slow ${name}`, durationMs);
    }
  }

  async runAsync<T>(name: string, work: () => Promise<T>): Promise<T> {
    const started = this.now();
    try { return await this.capture(name, work, false); }
    finally {
      const durationMs = this.now() - started;
      if (durationMs > this.thresholdMs) this.report(`slow ${name}`, durationMs);
    }
  }

  sample(): void {
    if (this.stopped) return;
    const now = this.now();
    const lag = now - this.sampledAt - this.intervalMs;
    if (lag > this.thresholdMs) this.report(`lag work=${this.longest?.name ?? "unattributed"}`, lag);
    this.sampledAt = now;
    this.longest = undefined;
  }

  private report(key: string, durationMs: number): void {
    if (this.stopped) return;
    const now = this.now();
    let report = this.reports.get(key);
    if (!report) {
      // Names are fixed routes/timers, never project IDs, query strings or credentials.
      report = { count: 0, maxMs: 0, nextAt: 0 };
      this.reports.set(key, report);
    }
    report.count++;
    report.maxMs = Math.max(report.maxMs, durationMs);
    const flush = () => {
      this.log(`[loop-monitor] ${key} count=${report!.count} maxMs=${report!.maxMs.toFixed(1)}`);
      report!.count = 0;
      report!.maxMs = 0;
      report!.nextAt = this.now() + this.reportIntervalMs;
      report!.timer = undefined;
    };
    if (now >= report.nextAt && !report.timer) flush();
    else if (!report.timer) {
      report.timer = setTimeout(flush, Math.max(1, report.nextAt - now));
      report.timer.unref();
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.sample();
    this.stopped = true;
    clearInterval(this.timer);
    for (const [key, report] of this.reports) {
      clearTimeout(report.timer);
      if (report.count) this.log(`[loop-monitor] ${key} count=${report.count} maxMs=${report.maxMs.toFixed(1)}`);
    }
    this.reports.clear();
  }
}
