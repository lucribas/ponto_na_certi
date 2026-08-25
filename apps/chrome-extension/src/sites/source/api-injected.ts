import type { ClosingMonth, PunchDay } from '../../domain';

export interface AhgoraApiCaptureInput {
  readonly months: readonly ClosingMonth[];
  readonly timeoutMs?: number;
}

export type AhgoraApiCaptureResult =
  | {
      readonly ok: true;
      readonly months: readonly {
        readonly month: ClosingMonth;
        readonly days: readonly PunchDay[];
      }[];
    }
  | { readonly ok: false; readonly code: string };

/** Executada no MAIN world para reutilizar cookie ou bearer da sessão Ahgora. */
export async function captureAhgoraByApi(
  input: AhgoraApiCaptureInput,
): Promise<AhgoraApiCaptureResult> {
  const timeoutMs = input.timeoutMs ?? 30_000;
  const bearer = globalThis.sessionStorage.getItem('bearer');
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  const request = async (path: string): Promise<unknown> => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const controller = new AbortController();
      const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(path, {
          credentials: 'include',
          headers,
          signal: controller.signal,
        });
        if (response.status === 401 || response.status === 403)
          throw new Error('login-required');
        if (!response.ok) {
          const code = `http-${String(response.status)}`;
          if (response.status === 429 || response.status >= 500)
            throw new Error(`retryable-${code}`);
          throw new Error(code);
        }
        if (!(response.headers.get('content-type') ?? '').includes('json'))
          throw new Error('unexpected-content-type');
        return await response.json();
      } catch (error: unknown) {
        const code = error instanceof Error ? error.message : 'network-error';
        if (
          code === 'login-required' ||
          code === 'unexpected-content-type' ||
          (/^http-4\d\d$/.test(code) && code !== 'http-429')
        )
          throw error;
        lastError = error;
        if (attempt < 3) {
          console.warn('[PontoNaCerti][AhgoraApi]', {
            status: 'retrying',
            request: path === '/api-espelho/apuracao/' ? 'index' : 'month',
            attempt,
            code: code.replace(/^retryable-/, ''),
          });
          await new Promise((resolve) =>
            globalThis.setTimeout(resolve, attempt * 250),
          );
        }
      } finally {
        globalThis.clearTimeout(timer);
      }
    }
    const code =
      lastError instanceof Error ? lastError.message : 'api-request-failed';
    throw new Error(code.replace(/^retryable-/, ''));
  };
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

  try {
    const index = await request('/api-espelho/apuracao/');
    if (!isRecord(index) || !isRecord(index.meses))
      return { ok: false, code: 'api-contract-invalid' };
    const months = [];
    for (const month of input.months) {
      const descriptor = index.meses[month];
      if (!isRecord(descriptor) || typeof descriptor.referencia !== 'string')
        return { ok: false, code: 'month-not-available' };
      const raw = await request(
        `/api-espelho/apuracao/${encodeURIComponent(descriptor.referencia)}`,
      );
      if (!isRecord(raw) || !isRecord(raw.dias))
        return { ok: false, code: 'api-contract-invalid' };
      const days: PunchDay[] = [];
      for (const [date, value] of Object.entries(raw.dias)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !isRecord(value)) continue;
        const punches = Array.isArray(value.batidas) ? value.batidas : [];
        const times: string[] = [];
        for (const punch of punches) {
          if (!isRecord(punch)) continue;
          const type =
            typeof punch.tipo === 'string'
              ? punch.tipo.trim().toUpperCase()
              : '';
          // PREVISTA representa somente a escala esperada. A API pode devolvê-la
          // com hora vazia ou preenchida, mas ela nunca é uma batida realizada.
          if (type === 'PREVISTA') continue;
          if (typeof punch.hora !== 'string')
            return { ok: false, code: 'punch-time-invalid' };
          const time = punch.hora.trim();
          if (!/^\d{2}:\d{2}$/.test(time))
            return { ok: false, code: 'punch-time-invalid' };
          times.push(time);
        }
        days.push({ date: date as PunchDay['date'], times });
      }
      months.push({ month, days });
    }
    console.info('[PontoNaCerti][AhgoraApi]', {
      status: 'ok',
      authentication: bearer ? 'bearer' : 'session-cookie',
      monthCount: months.length,
      dayCounts: months.map(({ days }) => days.length),
    });
    return { ok: true, months };
  } catch (error: unknown) {
    const code = error instanceof Error ? error.message : 'api-request-failed';
    console.warn('[PontoNaCerti][AhgoraApi]', { status: 'failed', code });
    return { ok: false, code };
  }
}
