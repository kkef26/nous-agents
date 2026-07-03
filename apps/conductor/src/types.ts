/**
 * NOUS.CONDUCTOR.MERGE_GATES.1 — shared merge-status literals and
 * MergeResult discriminated union. Every terminal state of the merge
 * flow surfaces through this type so callers can pattern-match on
 * result.status rather than sniffing loose flags.
 *
 * A shipped verdict may only be written for status === 'merged'
 * (constraint #4).
 */

export type MergeStatus =
  | 'merged'
  | 'merge_conflict'
  | 'fetch_failed'
  | 'aborted';

export interface MergeSuccess {
  status: 'merged';
  merged_sha: string;
  base_sha: string;
  head_sha: string;
}

export interface MergeConflict {
  status: 'merge_conflict';
  base_sha: string;
  head_sha: string;
  message: string;
}

export interface MergeFetchFailed {
  status: 'fetch_failed';
  head_sha: string;
  error: string;
}

export interface MergeAborted {
  status: 'aborted';
  reason: string;
}

export type MergeResult =
  | MergeSuccess
  | MergeConflict
  | MergeFetchFailed
  | MergeAborted;
