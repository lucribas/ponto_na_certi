import {
  captureAhgoraByApi,
  type AhgoraApiCaptureInput,
  type AhgoraApiCaptureResult,
} from './api-injected';
import type { SourceScriptRunner } from './contracts';

export class ChromeSourceScriptRunner implements SourceScriptRunner {
  async capturePeriod(
    tabId: number,
    input: AhgoraApiCaptureInput,
  ): Promise<AhgoraApiCaptureResult> {
    const [execution] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: captureAhgoraByApi,
      args: [input],
    });
    const result = execution?.result ?? {
      ok: false as const,
      code: 'missing-execution-result',
    };
    console.info('[PontoNaCerti][AhgoraApiRunner]', {
      status: result.ok ? 'ok' : 'failed',
      tabId,
      code: result.ok ? undefined : result.code,
      monthCount: result.ok ? result.months.length : undefined,
    });
    return result;
  }
}
