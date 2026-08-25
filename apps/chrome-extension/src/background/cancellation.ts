import type { IncomingMessage } from '../messaging/messages';

export class CancellationRegistry {
  private readonly operationIds = new Set<string>();

  request(operationId: string): void {
    this.operationIds.add(operationId);
  }

  isRequested(operationId: string): boolean {
    return this.operationIds.has(operationId);
  }

  clear(operationId: string): void {
    this.operationIds.delete(operationId);
  }

  resetAfterOperationStarted(): void {
    this.operationIds.clear();
  }
}

export function createCancellationAwareHandler<TSender, TResponse>(
  registry: CancellationRegistry,
  authorize: (sender: TSender) => void,
  process: (message: IncomingMessage, sender: TSender) => Promise<TResponse>,
): (message: IncomingMessage, sender: TSender) => Promise<TResponse> {
  return (message, sender) => {
    authorize(sender);
    if (
      message.type === 'CANCEL_OPERATION' ||
      message.type === 'STOP_CURRENT_ACTION'
    ) {
      registry.request(message.operationId);
    }
    return process(message, sender);
  };
}
