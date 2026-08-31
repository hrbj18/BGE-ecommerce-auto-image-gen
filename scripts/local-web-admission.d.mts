export interface SubmissionLease { token: string; jobId: string; idempotencyKey: string; phase: string; acquiredAt: string; updatedAt: string }
export class SubmissionGate {
  constructor(options?: { now?: () => number; tokenFactory?: () => string; maxIdempotencyEntries?: number });
  begin(input: { jobId: string; idempotencyKey?: string; phase?: string }): { kind: "acquired"; lease: SubmissionLease } | { kind: "duplicate"; jobId: string; idempotencyKey: string } | { kind: "busy"; active: SubmissionLease | null };
  remember(key: string, jobId: string): void;
  forget(key: string): void;
  transition(token: string, phase: string): boolean;
  release(token: string): boolean;
  snapshot(): SubmissionLease | null;
}
export function normalizeIdempotencyKey(value: unknown): string;
