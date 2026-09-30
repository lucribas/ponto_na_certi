import {
  probeSeniorDocument,
  querySeniorDocument,
  type SeniorQuery,
} from './injected';
import type { SeniorRunner } from './adapter';
export class ChromeSeniorRunner implements SeniorRunner {
  constructor(
    private readonly tabId: number,
    readonly check?: () => Promise<void>,
  ) {}
  async probe() {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: this.tabId },
      world: 'MAIN',
      func: probeSeniorDocument,
    });
    return result?.result ?? { ready: false };
  }
  async query(input: SeniorQuery) {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: this.tabId },
      world: 'MAIN',
      func: querySeniorDocument,
      args: [input],
    });
    return result?.result ?? { ok: false as const, code: 'CLIENT_UNAVAILABLE' };
  }
}
