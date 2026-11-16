import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Reentrant per-targetKey async mutex backed by `AsyncLocalStorage`.
 * Lock ordering relative to parent `LocalFileSystem` is strictly
 * outer (`fileLocks`) -> inner (`super`'s internal lock), preventing deadlocks
 * without touching any `private` parent fields.
 */
export class TargetLockManager {
  private readonly fileLocks = new Map<string, Promise<void>>();
  private readonly heldLocks = new AsyncLocalStorage<Set<string>>();

  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const held = this.heldLocks.getStore();
    if (held?.has(key)) {
      return await fn();
    }

    const previous = this.fileLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => {}).then(() => gate);
    this.fileLocks.set(key, tail);

    await previous.catch(() => {});
    const nextHeld = new Set(held);
    nextHeld.add(key);

    try {
      return await this.heldLocks.run(nextHeld, fn);
    } finally {
      release();
      if (this.fileLocks.get(key) === tail) {
        this.fileLocks.delete(key);
      }
    }
  }

  async withLocks<T>(keys: readonly string[], fn: () => Promise<T>): Promise<T> {
    const ordered = [...new Set(keys)].sort();
    const acquire = (idx: number): Promise<T> => {
      if (idx >= ordered.length) {
        return fn();
      }
      return this.withLock(ordered[idx]!, () => acquire(idx + 1));
    };
    return acquire(0);
  }
}
