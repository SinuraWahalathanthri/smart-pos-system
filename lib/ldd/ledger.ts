/**
 * The ledger: validate, hash-chain, append. One stream per store.
 *
 * Guarantees this module enforces:
 *  1. Every event is validated against its registered schema before it can enter the ledger.
 *  2. `seq` is contiguous from 1; a gap or repeat is corruption, not a fact to accept.
 *  3. `hash` chains to `prevHash`, so removing or editing any historical event is detectable.
 *  4. `commandId` is idempotent: replaying a queued command returns the original event.
 */

import { canonicalJson, GENESIS_HASH, hashEvent } from "./hash";
import {
  ConflictError,
  IntegrityError,
  LddError,
  UnknownEventError,
  ValidationError,
  type Clock,
  type Command,
  type EventDef,
  type IdGen,
  type LedgerEvent,
  type LedgerStore,
  type VerifyReport,
} from "./types";

const defaultClock: Clock = () => new Date();
const defaultId: IdGen = () => crypto.randomUUID();

export function toIso(d: Date): string {
  return d.toISOString().replace(/\.(\d{3})\d*Z$/, ".$1Z");
}

export interface LedgerOptions {
  store: LedgerStore;
  events: EventDef<unknown>[];
  clock?: Clock;
  newId?: IdGen;
}

export class Ledger {
  private readonly store: LedgerStore;
  private readonly defs: Map<string, EventDef<unknown>>;
  private readonly clock: Clock;
  private readonly newId: IdGen;

  constructor(opts: LedgerOptions) {
    this.store = opts.store;
    this.clock = opts.clock ?? defaultClock;
    this.newId = opts.newId ?? defaultId;
    this.defs = new Map();
    for (const def of opts.events) this.register(def);
  }

  register(def: EventDef<unknown>): void {
    const key = `${def.type}@${def.version}`;
    if (this.defs.has(key)) throw new LddError("INTEGRITY", `Event "${key}" is already registered`);
    this.defs.set(key, def);
  }

  definition(type: string, version: number): EventDef<unknown> {
    const def = this.defs.get(`${type}@${version}`);
    if (!def) throw new UnknownEventError(`${type}@${version}`);
    return def;
  }

  /**
   * Validate and append one command. Returns the existing event if this command was already applied,
   * which is what makes an offline queue safe to replay.
   */
  async append<T>(cmd: Command<T>): Promise<LedgerEvent> {
    if (!cmd.commandId) throw new LddError("VALIDATION", "commandId is required for idempotency");

    const seen = await this.store.findByCommandId(cmd.commandId);
    if (seen) {
      if (seen.type !== cmd.type) {
        throw new LddError(
          "CONFLICT",
          `commandId "${cmd.commandId}" was already used for "${seen.type}", not "${cmd.type}"`,
        );
      }
      return seen;
    }

    // The version is resolved by trying the highest registered version for the type.
    const def = this.latestDef(cmd.type);
    const parsed = def.schema.safeParse(cmd.payload);
    if (!parsed.success) throw new ValidationError(cmd.type, parsed.error);

    const head = await this.store.head(cmd.stream);
    const seq = (head?.seq ?? 0) + 1;
    const prevHash = head?.hash ?? GENESIS_HASH;
    const now = toIso(this.clock());
    const at = cmd.at ? toIso(new Date(cmd.at)) : now;

    const body = {
      seq,
      type: cmd.type,
      version: def.version,
      stream: cmd.stream,
      at,
      recordedAt: now,
      actor: cmd.actor,
      commandId: cmd.commandId,
      payload: parsed.data,
      prevHash,
    };

    const event: LedgerEvent = { id: this.newId(), ...body, hash: hashEvent(body) };

    try {
      await this.store.append(event);
    } catch (e) {
      // A concurrent writer got there first: surface it as a conflict, not a generic failure.
      const latest = await this.store.head(cmd.stream);
      if (latest && latest.seq >= seq) throw new ConflictError(cmd.stream, seq, latest.seq);
      throw e;
    }
    return event;
  }

  async appendMany<T>(cmds: Command<T>[]): Promise<LedgerEvent[]> {
    const out: LedgerEvent[] = [];
    for (const c of cmds) out.push(await this.append(c));
    return out;
  }

  /** Verify contiguity and the hash chain, re-deriving every hash from the payload. */
  async verify(stream: string): Promise<VerifyReport> {
    const events = await this.store.readStream(stream);
    const problems: VerifyReport["problems"] = [];
    let prevHash = GENESIS_HASH;
    let expectedSeq = 1;

    for (const e of events) {
      if (e.seq !== expectedSeq) {
        problems.push({ seq: e.seq, reason: `expected seq ${expectedSeq}` });
      }
      if (e.prevHash !== prevHash) {
        problems.push({ seq: e.seq, reason: "prevHash does not match the previous event" });
      }
      const rederived = hashEvent(e);
      if (rederived !== e.hash) {
        problems.push({ seq: e.seq, reason: "hash does not match the payload (event was altered)" });
      }
      prevHash = e.hash;
      expectedSeq = e.seq + 1;
    }

    return {
      ok: problems.length === 0,
      checked: events.length,
      headHash: events.length ? events[events.length - 1].hash : GENESIS_HASH,
      problems,
    };
  }

  /**
   * Fold the stream into state. `reducer` must be pure and total: given any event it returns the
   * next state, and an unknown event type must throw rather than be silently skipped — a skipped
   * event is a wrong balance.
   */
  async project<S>(
    stream: string,
    reducer: (state: S, event: LedgerEvent) => S,
    initial: S,
    opts: { upToSeq?: number; fromSeq?: number; state?: S } = {},
  ): Promise<S> {
    const from = opts.fromSeq ?? 1;
    const events = await this.store.readStream(stream, { fromSeq: from });
    let state = opts.state ?? initial;
    for (const e of events) {
      if (opts.upToSeq !== undefined && e.seq > opts.upToSeq) break;
      state = reducer(state, e);
    }
    return state;
  }

  /** Read events for display; the caller must not treat this as state. */
  history(stream: string, fromSeq = 1): Promise<LedgerEvent[]> {
    return this.store.readStream(stream, { fromSeq });
  }

  head(stream: string): Promise<LedgerEvent | null> {
    return this.store.head(stream);
  }

  private latestDef(type: string): EventDef<unknown> {
    let best: EventDef<unknown> | undefined;
    for (const def of this.defs.values()) {
      if (def.type === type && (!best || def.version > best.version)) best = def;
    }
    if (!best) throw new UnknownEventError(type);
    return best;
  }
}

/** Re-hash an event body and compare, for callers that already hold a parsed event. */
export function eventHashMatches(e: LedgerEvent): boolean {
  return hashEvent(e) === e.hash;
}

/** A stable digest of a whole projection, for asserting that two replays agree. */
export function stateDigest(state: unknown): string {
  const canonical = canonicalJson(state);
  return hashEvent({
    seq: 0,
    type: "state",
    version: 1,
    stream: "",
    at: "",
    recordedAt: "",
    actor: "",
    commandId: "",
    payload: canonical,
    prevHash: "",
  });
}

export { IntegrityError };
