/**
 * Ledger-Driven Development (LDD) — core types.
 *
 * A ledger is an append-only, hash-chained sequence of immutable events. Current state is never
 * stored: it is a pure fold (`project`) over the events. Corrections are new events, never edits.
 */

/** Integer thousandths of a unit, so 1.5 kg is 1500. Avoids binary float drift in quantities. */
export type Milli = number;

/** Money in integer minor units (cents). Never a float. */
export type Cents = number;

/** ISO-8601 instant, always UTC with milliseconds. */
export type Iso = string;

export interface LedgerEvent<T = unknown> {
  /** Contiguous within a stream, starting at 1. Gaps are corruption. */
  readonly seq: number;
  readonly id: string;
  readonly type: string;
  readonly version: number;
  /** Ordering scope: one stream per store (`store:<uuid>`). */
  readonly stream: string;
  /** When the business fact happened. Differs from `recordedAt` when a till was offline. */
  readonly at: Iso;
  /** When the ledger accepted it. */
  readonly recordedAt: Iso;
  readonly actor: string;
  /** Idempotency key of the command that produced this event. */
  readonly commandId: string;
  readonly payload: T;
  readonly prevHash: string;
  readonly hash: string;
}

export interface Command<T = unknown> {
  readonly type: string;
  readonly commandId: string;
  readonly stream: string;
  readonly actor: string;
  /** Business time; defaults to the clock at append. Set it when replaying an offline queue. */
  readonly at?: Iso;
  readonly payload: T;
}

export interface EventDef<T = unknown> {
  readonly type: string;
  readonly version: number;
  /** Validated before the event is accepted, so a malformed event can never enter the ledger. */
  readonly schema: {
    safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: unknown };
  };
}

export type Clock = () => Date;
export type IdGen = () => string;

export interface Snapshot<S = unknown> {
  readonly seq: number;
  readonly state: S;
}

export interface LedgerStore {
  head(stream: string): Promise<LedgerEvent | null>;
  /** Must reject a duplicate (stream, seq) and a duplicate hash. */
  append(event: LedgerEvent): Promise<void>;
  readStream(stream: string, opts?: { fromSeq?: number }): Promise<LedgerEvent[]>;
  findByCommandId(commandId: string): Promise<LedgerEvent | null>;
  count(stream: string): Promise<number>;
  getSnapshot?(key: string): Promise<Snapshot | null>;
  putSnapshot?(key: string, snap: Snapshot): Promise<void>;
  clear?(): Promise<void>;
}

export interface VerifyProblem {
  seq: number;
  reason: string;
}

export interface VerifyReport {
  ok: boolean;
  checked: number;
  headHash: string;
  problems: VerifyProblem[];
}

/* ------------------------------------------------------------------ errors */

export type LddErrorCode =
  | "VALIDATION"
  | "UNKNOWN_EVENT"
  | "CONFLICT"
  | "INTEGRITY"
  | "INVARIANT"
  | "DUPLICATE_SEQ";

export class LddError extends Error {
  readonly code: LddErrorCode;

  constructor(code: LddErrorCode, message: string) {
    super(message);
    this.name = "LddError";
    this.code = code;
  }
}

export class ValidationError extends LddError {
  readonly issues: unknown;

  constructor(type: string, issues: unknown) {
    super("VALIDATION", `Invalid payload for "${type}"`);
    this.name = "ValidationError";
    this.issues = issues;
  }
}

export class UnknownEventError extends LddError {
  constructor(type: string) {
    super("UNKNOWN_EVENT", `No event definition registered for "${type}"`);
    this.name = "UnknownEventError";
  }
}

export class ConflictError extends LddError {
  constructor(stream: string, expected: number, actual: number) {
    super("CONFLICT", `Stream "${stream}" is at seq ${actual}, expected ${expected}`);
    this.name = "ConflictError";
  }
}

export class IntegrityError extends LddError {
  constructor(message: string) {
    super("INTEGRITY", message);
    this.name = "IntegrityError";
  }
}

export class InvariantError extends LddError {
  readonly violations: string[];

  constructor(violations: string[]) {
    super("INVARIANT", `Ledger invariants broken:\n  - ${violations.join("\n  - ")}`);
    this.name = "InvariantError";
    this.violations = violations;
  }
}
