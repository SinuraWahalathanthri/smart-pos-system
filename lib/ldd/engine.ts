/**
 * The facade an application actually uses. It wires the ledger, the projection, the command specs
 * and the invariant suite together so a caller cannot append an event that skips any of them.
 *
 * The rule: `execute()` is the only way to change state. There is no update, no delete, no save.
 */

import { Ledger } from "./ledger";
import { checkInvariants, errorsOnly, type Violation } from "./invariants";
import { POS_EVENTS, type SaleCompleted } from "./pos-events";
import { emptyState, reduce, type PosState } from "./pos-reducer";
import { specFor, checkPostconditions, checkPreconditions } from "./statements";
import {
  InvariantError,
  LddError,
  type Clock,
  type Command,
  type EventDef,
  type IdGen,
  type LedgerEvent,
  type LedgerStore,
  type VerifyReport,
} from "./types";
import { auditLedger, type LedgerAudit } from "./invariants";

export interface EngineOptions {
  store: LedgerStore;
  stream: string;
  events?: EventDef<unknown>[];
  clock?: Clock;
  newId?: IdGen;
}

export interface ExecuteResult {
  event: LedgerEvent;
  state: PosState;
  violations: Violation[];
}

export class LedgerEngine {
  readonly ledger: Ledger;
  readonly stream: string;

  constructor(opts: EngineOptions) {
    this.stream = opts.stream;
    this.ledger = new Ledger({
      store: opts.store,
      events: opts.events ?? POS_EVENTS,
      clock: opts.clock,
      newId: opts.newId,
    });
  }

  async state(): Promise<PosState> {
    return this.ledger.project(this.stream, reduce, emptyState());
  }

  /**
   * Append a command, then re-derive state and assert the invariants. A violation does not roll the
   * event back — the ledger is append-only — but it is returned and thrown loudly, because the next
   * thing that happens should be a human reading it, not another sale.
   */
  async execute<T>(cmd: Command<T>, opts: { throwOnViolation?: boolean } = {}): Promise<ExecuteResult> {
    const before = await this.state();
    const spec = specFor(cmd.type);

    if (spec) {
      const failed = checkPreconditions(spec, before, cmd);
      if (failed.length) throw new InvariantError(failed.map((v) => `${cmd.type} precondition: ${v.message}`));
    }

    const event = await this.ledger.append({ ...cmd, stream: this.stream });
    const after = reduce(before, event);

    const violations = spec
      ? checkPostconditions(spec, before, after, cmd, event)
      : errorsOnly(checkInvariants(after));

    if (violations.length && opts.throwOnViolation !== false) {
      throw new InvariantError(violations.map((v) => `${event.type}: ${v.message}`));
    }
    return { event, state: after, violations };
  }

  /** Convenience for the till: completes a sale under a stable commandId derived from the sale id. */
  sell(payload: SaleCompleted, actor: string, at?: string): Promise<ExecuteResult> {
    return this.execute({
      type: "sale.completed",
      commandId: `sale:${payload.saleId}`,
      stream: this.stream,
      actor,
      at,
      payload,
    });
  }

  verify(): Promise<VerifyReport> {
    return this.ledger.verify(this.stream);
  }

  /** The command CI runs. Chain integrity plus every invariant, over every named stream. */
  audit(streams: string[] = [this.stream], project?: (s: string) => Promise<PosState>): Promise<LedgerAudit> {
    return auditLedger(this.ledger, streams, project ?? (() => this.ledger.project(this.stream, reduce, emptyState())));
  }

  history(fromSeq = 1): Promise<LedgerEvent[]> {
    return this.ledger.history(this.stream, fromSeq);
  }
}

/** Build a command id that is stable across retries of the same business act. */
export const stableCommandId = (kind: string, ...parts: (string | number)[]): string =>
  `${kind}:${parts.join(":")}`;

export { LddError };
