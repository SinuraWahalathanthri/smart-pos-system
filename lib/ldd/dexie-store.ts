/**
 * Durable store for the till. Dexie already exists in this app, so the ledger reuses it rather than
 * adding another storage engine.
 *
 * The `++seq` compound index gives us `head()` and range reads without scanning, and the unique
 * indexes on `hash` and `commandId` make double-apply impossible even across browser tabs.
 */

import Dexie, { type Table } from "dexie";
import { IntegrityError, type LedgerEvent, type LedgerStore, type Snapshot } from "./types";

interface SnapshotRow extends Snapshot {
  key: string;
}

export class LedgerDB extends Dexie {
  events!: Table<LedgerEvent, string>;
  snapshots!: Table<SnapshotRow, string>;

  constructor(name = "pos-ldd") {
    super(name);
    this.version(1).stores({
      events: "&id, &hash, &commandId, [stream+seq], stream, type, at",
      snapshots: "&key",
    });
  }
}

export class DexieLedgerStore implements LedgerStore {
  constructor(private readonly db: LedgerDB) {}

  async head(stream: string): Promise<LedgerEvent | null> {
    const row = await this.db.events.where("[stream+seq]").between([stream, Dexie.minKey], [stream, Dexie.maxKey]).last();
    return row ?? null;
  }

  async append(event: LedgerEvent): Promise<void> {
    const last = await this.head(event.stream);
    const expected = (last?.seq ?? 0) + 1;
    if (event.seq !== expected) {
      throw new IntegrityError(`seq ${event.seq} cannot follow ${last?.seq ?? 0} in "${event.stream}"`);
    }
    try {
      await this.db.events.add(event);
    } catch (e) {
      // A unique-index failure means another tab already appended this event or this seq.
      throw new IntegrityError(
        `could not append seq ${event.seq} to "${event.stream}": ${(e as Error).message}`,
      );
    }
  }

  async readStream(stream: string, opts: { fromSeq?: number } = {}): Promise<LedgerEvent[]> {
    const from = opts.fromSeq ?? 1;
    return this.db.events
      .where("[stream+seq]")
      .between([stream, from], [stream, Dexie.maxKey])
      .toArray();
  }

  async findByCommandId(commandId: string): Promise<LedgerEvent | null> {
    const row = await this.db.events.where("commandId").equals(commandId).first();
    return row ?? null;
  }

  async count(stream: string): Promise<number> {
    return this.db.events.where("stream").equals(stream).count();
  }

  async getSnapshot(key: string): Promise<Snapshot | null> {
    const row = await this.db.snapshots.get(key);
    return row ? { seq: row.seq, state: row.state } : null;
  }

  async putSnapshot(key: string, snap: Snapshot): Promise<void> {
    await this.db.snapshots.put({ key, seq: snap.seq, state: snap.state });
  }

  async clear(): Promise<void> {
    await Promise.all([this.db.events.clear(), this.db.snapshots.clear()]);
  }
}
