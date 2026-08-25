export interface WaitOptions {
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly signal?: AbortSignal;
}

export class ChannelAdapterError extends Error {
  override readonly name = 'ChannelAdapterError';

  constructor(
    readonly code:
      | 'cancelled'
      | 'entry-form-open'
      | 'login-required'
      | 'not-channel-page'
      | 'not-found'
      | 'report-not-refreshed'
      | 'timeout',
    message: string,
  ) {
    super(message);
  }
}

export async function waitForCondition<T>(
  condition: () => T | undefined,
  description: string,
  options: WaitOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 1_000;
  const pollIntervalMs = options.pollIntervalMs ?? 10;
  const startedAt = Date.now();

  while (Date.now() - startedAt <= timeoutMs) {
    if (options.signal?.aborted === true) {
      throw new ChannelAdapterError(
        'cancelled',
        `Operação cancelada ao aguardar ${description}.`,
      );
    }

    const result = condition();
    if (result !== undefined) return result;
    await delay(pollIntervalMs);
  }

  throw new ChannelAdapterError(
    'timeout',
    `Tempo esgotado ao aguardar ${description}.`,
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
