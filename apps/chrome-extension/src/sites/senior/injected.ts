/** These functions run in MAIN and must not close over module values. */
export function probeSeniorDocument(): { ready: boolean; subjectKey?: string } {
  const match =
    /^\/gestaoponto-frontend\/time-adjustment\/employee\/([^/]+)\/(?:all|pending|total)(?:\/|$)/.exec(
      location.pathname,
    );
  const angular = (
    globalThis as unknown as {
      angular?: {
        element(node: HTMLElement): {
          injector(): { get(name: string): unknown } | undefined;
        };
      };
    }
  ).angular;
  const login = document.querySelector<HTMLElement>('#index-vm-username');
  const loginVisible = login !== null && login.getClientRects().length > 0;
  const ready =
    location.origin === 'https://gestaodoponto.certi.org.br' &&
    !loginVisible &&
    Boolean(match?.[1]) &&
    Boolean(angular?.element(document.body).injector()?.get('$http'));
  return { ready, ...(ready && match?.[1] ? { subjectKey: match[1] } : {}) };
}

export interface SeniorQuery {
  readonly subjectKey: string;
  readonly kind: 'period' | 'count' | 'days';
  readonly competence?: string;
  readonly calculationCode?: number;
  readonly resolvedSubject?: string;
  readonly start?: string;
  readonly end?: string;
  readonly timeoutMs?: number;
}
export type SeniorQueryResult =
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false; readonly code: string };

export async function querySeniorDocument(
  input: SeniorQuery,
): Promise<SeniorQueryResult> {
  if (location.origin !== 'https://gestaodoponto.certi.org.br')
    return { ok: false, code: 'ORIGIN_CHANGED' };
  const match =
    /^\/gestaoponto-frontend\/time-adjustment\/employee\/([^/]+)\/(?:all|pending|total)(?:\/|$)/.exec(
      location.pathname,
    );
  if (!match) return { ok: false, code: 'LOGIN_REQUIRED' };
  if (match[1] !== input.subjectKey)
    return { ok: false, code: 'SUBJECT_CHANGED' };
  type Http = {
    get(
      url: string,
      config: { params: Record<string, string | number>; timeout: number },
    ): Promise<{ data: unknown }>;
  };
  const angular = (
    globalThis as unknown as {
      angular?: {
        element(node: HTMLElement): {
          injector(): { get(name: string): Http } | undefined;
        };
      };
    }
  ).angular;
  const http = angular?.element(document.body).injector()?.get('$http');
  if (!http) return { ok: false, code: 'CLIENT_UNAVAILABLE' };
  const base = '/gestaoponto-backend/api/';
  const path =
    input.kind === 'period'
      ? 'codigos-calculo/buscar-codigo-calculo-competencia'
      : `acertoPontoColaboradorPeriodo/colaborador/${encodeURIComponent(input.resolvedSubject ?? input.subjectKey)}${input.kind === 'count' ? '/count' : ''}`;
  const params: Record<string, string | number> = { isTelaColaborador: 'S' };
  if (input.kind === 'period') {
    if (!input.competence) return { ok: false, code: 'SOURCE_DATA_INVALID' };
    params.colaborador = input.subjectKey;
    params.competencia = input.competence;
  } else {
    if (input.calculationCode === undefined || !input.start || !input.end)
      return { ok: false, code: 'SOURCE_DATA_INVALID' };
    params.codigoCalculo = input.calculationCode;
    params.dataInicial = input.start;
    params.dataFinal = input.end;
    if (input.kind === 'days') params.orderby = '-dataApuracao';
    else params.filtraPendencias = 'COLABORADOR';
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await http.get(base + path, {
        params,
        timeout: input.timeoutMs ?? 30_000,
      });
      if (
        location.pathname.split('/employee/')[1]?.split('/')[0] !==
        input.subjectKey
      )
        return { ok: false, code: 'SUBJECT_CHANGED' };
      const isRecord = (value: unknown): value is Record<string, unknown> =>
        typeof value === 'object' && value !== null && !Array.isArray(value);
      const data = response.data;
      if (!isRecord(data)) return { ok: false, code: 'SOURCE_DATA_INVALID' };
      if (input.kind === 'count') {
        if (!isRecord(data.result))
          return { ok: false, code: 'SOURCE_DATA_INVALID' };
        return { ok: true, data: { result: { total: data.result.total } } };
      }
      if (input.kind === 'period') {
        if (!isRecord(data.result))
          return { ok: false, code: 'SOURCE_DATA_INVALID' };
        const c = data.result.codigoCalculo;
        if (c === null)
          return { ok: true, data: { result: { codigoCalculo: null } } };
        if (!isRecord(c) || !isRecord(data.result.colaborador))
          return { ok: false, code: 'SOURCE_DATA_INVALID' };
        return {
          ok: true,
          data: {
            result: {
              codigoCalculo: {
                codigoCalculo: c.codigoCalculo,
                inicioApuracao: c.inicioApuracao,
                fimApuracao: c.fimApuracao,
              },
              colaborador: { id: data.result.colaborador.id },
            },
          },
        };
      }
      if (!Array.isArray(data.apuracao) || !isRecord(data.colaborador))
        return { ok: false, code: 'SOURCE_DATA_INVALID' };
      return {
        ok: true,
        data: {
          colaborador: { id: data.colaborador.id },
          apuracao: data.apuracao.map((day: unknown) => {
            if (!isRecord(day) || !Array.isArray(day.marcacoes)) return null;
            return {
              dataApuracao: day.dataApuracao,
              status: isRecord(day.status)
                ? { codigo: day.status.codigo }
                : undefined,
              incidentes: Array.isArray(day.incidentes)
                ? day.incidentes.map(() => ({}))
                : [],
              marcacoes: day.marcacoes.map((punch: unknown) => {
                if (!isRecord(punch)) return null;
                return {
                  dataAcesso: punch.dataAcesso,
                  dataApuracao: punch.dataApuracao,
                  horaAcesso: punch.horaAcesso,
                  origem: punch.origem,
                  uso: punch.uso,
                };
              }),
            };
          }),
        },
      };
    } catch (error: unknown) {
      const status =
        typeof error === 'object' && error !== null && 'status' in error
          ? Number(error.status)
          : 0;
      if (attempt === 0 && (status <= 0 || status === 429 || status >= 500))
        continue;
      return {
        ok: false,
        code:
          status === 401
            ? 'LOGIN_REQUIRED'
            : status === 403
              ? 'ACCESS_DENIED'
              : status === -1
                ? 'TIMEOUT'
                : status >= 400 && status < 500
                  ? 'PERIOD_NOT_AVAILABLE'
                  : 'NETWORK_ERROR',
      };
    }
  }
  return { ok: false, code: 'NETWORK_ERROR' };
}
