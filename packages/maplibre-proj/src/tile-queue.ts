interface QueueEntry {
  key: string;
  execute: () => Promise<void>;
  onDrop: () => void;
}

export class TileQueue {
  private queue: QueueEntry[] = [];
  private inflight = 0;
  private readonly maxConcurrency: number;

  constructor(maxConcurrency: number) {
    this.maxConcurrency = maxConcurrency;
  }

  enqueue(
    key: string,
    abortController: AbortController,
    execute: () => Promise<void>,
    onDrop: () => void,
  ): void {
    if (abortController.signal.aborted) {
      onDrop();
      return;
    }

    const entry: QueueEntry = { key, execute, onDrop };

    abortController.signal.addEventListener('abort', () => {
      const idx = this.queue.indexOf(entry);
      if (idx !== -1) {
        this.queue.splice(idx, 1);
        entry.onDrop();
      }
    }, { once: true });

    this.queue.push(entry);
    this.drain();
  }

  private drain(): void {
    while (this.inflight < this.maxConcurrency) {
      const entry = this.queue.shift();
      if (!entry) break;
      this.inflight++;
      entry.execute().finally(() => {
        this.inflight--;
        this.drain();
      });
    }
  }

  clear(): void {
    for (const entry of this.queue) entry.onDrop();
    this.queue.length = 0;
  }
}
