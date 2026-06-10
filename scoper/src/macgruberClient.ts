/**
 * Scoper-side MacGruber fire-and-forget client.
 *
 * Per FEAT.MACGRUBER.8 (D8, D9): on Mode B (gaps_hold) and Mode C (structural_block)
 * failure exits, Scoper pushes a structured failure payload to MacGruber's `/intake`
 * so it can investigate. The push must NOT block Scoper's own exit flow, and
 * network errors must not propagate.
 */

export interface MacGruberPushPayload {
  failure_class: string;
  error_message: string;
  step_attempted: string;
  repo: string;
  branch: string;
  sha: string;
  clause_id: string;
  prior_attempts: number;
  dispatch_event_id: string;
  agent_id: string;
  timestamp: string;
  stack_trace?: string;
  reported_by: 'scoper';
}

export interface NotifyOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  logger?: (msg: string) => void;
}

const DEFAULT_TIMEOUT_MS = 5_000;

export async function notifyMacGruber(
  payload: Omit<MacGruberPushPayload, 'reported_by'>,
  opts: NotifyOptions = {},
): Promise<{ delivered: boolean; reason?: string }> {
  const url = process.env.MACGRUBER_INTAKE_URL;
  const log = opts.logger ?? ((m) => process.stderr.write(`${m}\n`));

  if (!url) {
    return { delivered: false, reason: 'MACGRUBER_INTAKE_URL not configured' };
  }
  if (!payload.dispatch_event_id) {
    log('notifyMacGruber: missing dispatch_event_id, skipping push');
    return { delivered: false, reason: 'missing dispatch_event_id' };
  }

  const body: MacGruberPushPayload = { ...payload, reported_by: 'scoper' };
  const fetchFn = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      log(`notifyMacGruber: non-2xx ${res.status} from ${url}`);
      return { delivered: false, reason: `http_${res.status}` };
    }
    return { delivered: true };
  } catch (err) {
    log(`notifyMacGruber: network error: ${(err as Error).message}`);
    return { delivered: false, reason: 'network_error' };
  } finally {
    clearTimeout(timer);
  }
}
