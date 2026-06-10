/**
 * Dispatch-side executors: cancel a queue row, or re-trigger a tree run.
 * Mirror of githubReads in shape: never throw, always return ActionResult.
 */

import { DispatchClient, DispatchClientError } from '../clients/dispatchClient.js';
import type {
  ActionResult,
  CancelDispatchAction,
  CancelDispatchResult,
  RetriggerTreeAction,
  RetriggerTreeResult,
} from './types.js';

export async function cancelDispatch(
  client: DispatchClient,
  action: CancelDispatchAction,
): Promise<ActionResult<CancelDispatchResult>> {
  try {
    const res = await client.cancelDispatch({
      dispatch_id: action.dispatch_id,
      reason: action.reason,
    });
    return {
      success: true,
      data: { dispatch_id: res.dispatch_id, cancelled: res.cancelled },
    };
  } catch (err) {
    return toFailure(err);
  }
}

export async function retriggerTree(
  client: DispatchClient,
  action: RetriggerTreeAction,
): Promise<ActionResult<RetriggerTreeResult>> {
  try {
    const res = await client.retriggerTree({
      tree_run_id: action.tree_run_id,
      reason: action.reason,
    });
    return {
      success: true,
      data: { tree_run_id: res.tree_run_id, accepted: res.accepted },
    };
  } catch (err) {
    return toFailure(err);
  }
}

function toFailure(err: unknown): ActionResult<never> {
  if (err instanceof DispatchClientError) {
    return {
      success: false,
      error_class: err.category,
      status: err.status,
      message: err.message,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    success: false,
    error_class: 'unknown',
    message,
  };
}
