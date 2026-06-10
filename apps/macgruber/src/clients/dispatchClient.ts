/**
 * Typed HTTP wrapper for internal dispatch APIs.
 *
 * Two endpoints: POST /dispatch/tree to (re)trigger a tree run, and
 * POST /dispatch/cancel to mark a queue row cancelled. No retries — the
 * agent loop chooses whether to retry an action based on the recorded result.
 */

export class DispatchClientError extends Error {
  readonly status?: number;
  readonly category: 'network' | 'http' | 'validation';

  constructor(message: string, category: 'network' | 'http' | 'validation', status?: number) {
    super(message);
    this.name = 'DispatchClientError';
    this.category = category;
    this.status = status;
  }
}

export interface DispatchClientOptions {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

export interface RetriggerTreePayload {
  tree_run_id: string;
  reason: string;
}

export interface RetriggerTreeResponse {
  accepted: boolean;
  tree_run_id: string;
}

export interface CancelDispatchPayload {
  dispatch_id: string;
  reason: string;
}

export interface CancelDispatchResponse {
  cancelled: boolean;
  dispatch_id: string;
}

export class DispatchClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: DispatchClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async retriggerTree(payload: RetriggerTreePayload): Promise<RetriggerTreeResponse> {
    const json = await this.postJson('/dispatch/tree', payload);
    if (!isObject(json) || typeof json.tree_run_id !== 'string') {
      throw new DispatchClientError('retrigger response missing tree_run_id', 'validation');
    }
    return {
      tree_run_id: json.tree_run_id,
      accepted: json.accepted === true,
    };
  }

  async cancelDispatch(payload: CancelDispatchPayload): Promise<CancelDispatchResponse> {
    const json = await this.postJson('/dispatch/cancel', payload);
    if (!isObject(json) || typeof json.dispatch_id !== 'string') {
      throw new DispatchClientError('cancel response missing dispatch_id', 'validation');
    }
    return {
      dispatch_id: json.dispatch_id,
      cancelled: json.cancelled === true,
    };
  }

  private async postJson(path: string, body: unknown): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (cause) {
      throw new DispatchClientError(
        `network error posting ${path}: ${(cause as Error).message ?? String(cause)}`,
        'network',
      );
    }
    if (!res.ok) {
      const text = await safeText(res);
      throw new DispatchClientError(
        `dispatch ${path} failed: ${res.status} ${text}`,
        'http',
        res.status,
      );
    }
    try {
      return (await res.json()) as unknown;
    } catch (cause) {
      throw new DispatchClientError(
        `dispatch ${path} returned non-JSON: ${(cause as Error).message ?? String(cause)}`,
        'validation',
      );
    }
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '<unreadable body>';
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
