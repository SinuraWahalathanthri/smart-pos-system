/**
 * Deterministic store for tests and for the browser demo. It enforces the same uniqueness rules as
 * the durable adapter, so a bug that the tests cannot see is a bug the database will not forgive.
 */

import { IntegrityError, type LedgerEvent, type LedgerStore, type Snapshot } from "./types";

export class MemoryLedgerStore implements LedgerStore {
  private readonly streams = new Map<string, LedgerEvent[]>();
  private readonly byCommand = new Map<string, LedgerEvent>();
  private readonly hashes = new Set<string>();
  private readonly snapshots = new Map<string, Snapshot>();

  async head(stream: string): Promise<LedgerEvent | null> {
    const list = this.streams.get(stream);
    return list && list.length ? list[list.length - 1] : null;
  }

  async append(event: LedgerEvent): Promise<void> {
    if (this.hashes.has(event.hash)) {
      throw new IntegrityError(`event hash ${event.hash} already exists (replay or collision)`);
    }
    const list = this.streams.get(event.stream) ?? [];
    const last = list.length ? list[list.length - 1] : null;
    const expected = (last?.seq ?? 0) + 1;
    if (event.seq !== expected) {
      throw new IntegrityError(`seq ${event.seq} cannot follow ${last?.seq ?? 0} in "${event.stream}"`);
    }
    this.hashes.add(event.hash);
    this.byCommand.set(event.commandId, event);
    list.push(event);
    this.streams.set(event.stream, list);
  }

  async readStream(stream: string, opts: { fromSeq?: number } = {}): Promise<LedgerEvent[]> {
    const list = this.streams.get(stream) ?? [];
    const from = opts.fromSeq ?? 1;
    return list.filter((e) => e.seq >= from);
  }

  async findByCommandId(commandId: string): Promise<LedgerEvent | null> {
    return this.byCommand.get(commandId) ?? null;
  }

  async count(stream: string): Promise<number> {
    return (this.streams.get(stream) ?? []).length;
  }

  async getSnapshot(key: string): Promise<Snapshot | null> {
    return this.snapshots.get(key) ?? null;
  }

  async putSnapshot(key: string, snap: Snapshot): Promise<void> {
    this.snapshots.set(key, snap);
  }

  async clear(): Promise<void> {
    this.streams.clear();
    this.byCommand.clear();
    this.hashes.clear();
    this.snapshots.clear();
  }
}
