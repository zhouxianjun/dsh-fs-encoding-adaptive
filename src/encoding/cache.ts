import type { FsVersion } from '@deepseek-ai/dsh-fs';
import type { EolStyle, NonUtf8Encoding } from './codecs.js';

export interface EncodingRecord {
  readonly encoding: NonUtf8Encoding;
  readonly hasBom: boolean;
  readonly eol: EolStyle;
  readonly confident: boolean;
  readonly source: 'override' | 'bom' | 'chardet';
  readonly version: FsVersion;
}

export class EncodingStateCache {
  private readonly maxEntries = 1000;
  private readonly records = new Map<string, EncodingRecord>();

  getIfFresh(targetKey: string, version: FsVersion): EncodingRecord | undefined {
    const rec = this.records.get(targetKey);
    if (!rec) {
      return undefined;
    }
    if (rec.version !== version) {
      this.records.delete(targetKey);
      return undefined;
    }
    return rec;
  }

  getLatest(targetKey: string): EncodingRecord | undefined {
    return this.records.get(targetKey);
  }

  set(targetKey: string, record: EncodingRecord): void {
    if (this.records.has(targetKey)) {
      this.records.delete(targetKey);
    } else if (this.records.size >= this.maxEntries) {
      const oldest = this.records.keys().next().value;
      if (oldest !== undefined) {
        this.records.delete(oldest);
      }
    }
    this.records.set(targetKey, record);
  }

  delete(targetKey: string): void {
    this.records.delete(targetKey);
  }

  clear(): void {
    this.records.clear();
  }
}
