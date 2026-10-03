/**
 * One job at a time per key, and only the newest waiting job survives. A
 * slider drag sends a burst of edits; each used to start its own re-execute,
 * verify and global check, which raced each other and could land an older
 * verdict after a newer one. Now the job in flight finishes, every edit that
 * arrived meanwhile collapses into the latest, and that one runs next.
 */
export class LatestWinsQueue<T> {
  private running = new Set<string>();
  private waiting = new Map<string, T>();

  constructor(
    private run: (key: string, job: T) => Promise<void>,
    private onError: (key: string, err: unknown) => void = () => {},
  ) {}

  push(key: string, job: T): void {
    if (this.running.has(key)) {
      this.waiting.set(key, job);
      return;
    }
    void this.drain(key, job);
  }

  private async drain(key: string, first: T): Promise<void> {
    this.running.add(key);
    let job: T | undefined = first;
    while (job !== undefined) {
      try {
        await this.run(key, job);
      } catch (err) {
        this.onError(key, err);
      }
      job = this.waiting.get(key);
      this.waiting.delete(key);
    }
    this.running.delete(key);
  }
}
