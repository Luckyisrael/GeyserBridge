export class RingBuffer<T> {
  private buffer: (T | undefined)[];
  private head: number = 0;
  private size: number = 0;
  private readonly capacity: number;
  private readonly keyFn: (item: T) => number;

  constructor(capacity: number, keyFn: (item: T) => number) {
    this.capacity = capacity;
    this.keyFn = keyFn;
    this.buffer = new Array(capacity);
  }

  push(item: T): void {
    this.buffer[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) {
      this.size++;
    }
  }

  getByKey(key: number): T | undefined {
    for (let i = 0; i < this.size; i++) {
      const idx = (this.head - 1 - i + this.capacity) % this.capacity;
      const item = this.buffer[idx];
      if (item !== undefined && this.keyFn(item) === key) {
        return item;
      }
    }
    return undefined;
  }

  getRange(fromKey: number, toKey: number): T[] {
    const result: T[] = [];
    for (let i = 0; i < this.size; i++) {
      const idx = (this.head - 1 - i + this.capacity) % this.capacity;
      const item = this.buffer[idx];
      if (item !== undefined) {
        const k = this.keyFn(item);
        if (k >= fromKey && k <= toKey) {
          result.unshift(item);
        }
      }
    }
    return result;
  }

  oldestKey(): number | undefined {
    if (this.size === 0) return undefined;
    const idx = (this.head - this.size + this.capacity) % this.capacity;
    const item = this.buffer[idx];
    return item ? this.keyFn(item) : undefined;
  }

  get length(): number {
    return this.size;
  }
}
