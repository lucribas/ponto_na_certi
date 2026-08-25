import type {
  InjectedChannelFillInput,
  InjectedChannelFillResult,
  InjectedChannelCatalogResult,
  InjectedChannelDeleteInput,
  InjectedChannelDeleteResult,
  InjectedChannelReadInput,
  InjectedChannelReadResult,
} from './injected';

interface DwrApi {
  readonly [method: string]: (...args: unknown[]) => unknown;
}

type ChannelRuntime = typeof globalThis & {
  readonly ApontamentoAjax?: DwrApi;
  readonly ProjetoAjax?: DwrApi;
  readonly ClienteAjax?: DwrApi;
  readonly TipoAtividadeAjax?: DwrApi;
  readonly ID_EMPRESA?: string | number;
  readonly ID_AREA_USUARIO_LOGADO?: string | number;
  readonly idAreaUsuario?: string | number;
  readonly idUsuarioSelecionado?: string | number;
  readonly checkBoxApontamento?: string;
  readonly dwr?: {
    readonly engine?: {
      _execute(
        path: string,
        owner: string,
        method: string,
        args: ArrayLike<unknown>,
      ): unknown;
    };
  };
};

interface ChannelApiRow {
  readonly dataFormatada?: unknown;
  readonly totalDuracao?: unknown;
}

interface ChannelDetailRow {
  readonly id?: unknown;
  readonly duracao?: unknown;
  readonly duracaoDouble?: unknown;
  readonly permissaoRemover?: unknown;
  readonly projeto?: unknown;
  readonly notificacao?: unknown;
  readonly nomeApontamento?: unknown;
  readonly nomeAtividadeTicket?: unknown;
}

/** Obtém projetos e, para cada projeto, as atividades permitidas ao usuário. */
export async function runInjectedChannelCatalog(
  input: { readonly timeoutMs?: number } = {},
): Promise<InjectedChannelCatalogResult> {
  const runtime = globalThis as ChannelRuntime;
  const apontamento = runtime.ApontamentoAjax;
  const projetos = runtime.ProjetoAjax;
  const timeoutMs = input.timeoutMs ?? 30_000;
  const failure = (code: string): InjectedChannelCatalogResult => {
    console.warn('[PontoNaCerti][ChannelCatalog]', {
      status: 'failed',
      code,
      origin: location.origin,
    });
    return { ok: false, code };
  };
  if (!apontamento || !projetos) return failure('channel-api-unavailable');
  const call = (
    owner: DwrApi,
    method: string,
    args: readonly unknown[],
  ): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const action = owner[method];
      if (!action) {
        reject(new Error(`${method}-not-found`));
        return;
      }
      const timer = globalThis.setTimeout(
        () => reject(new Error(`${method}-timeout`)),
        timeoutMs,
      );
      action(...args, (value: unknown) => {
        globalThis.clearTimeout(timer);
        resolve(value);
      });
    });
  const recordOf = (value: unknown): Record<string, unknown> | undefined =>
    typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>)
      : undefined;
  const idOf = (record: Record<string, unknown>): string | undefined =>
    typeof record.id === 'string' || typeof record.id === 'number'
      ? String(record.id)
      : undefined;
  const labelOf = (record: Record<string, unknown>): string | undefined => {
    const code =
      typeof record.codigo === 'string' || typeof record.codigo === 'number'
        ? String(record.codigo).trim()
        : '';
    const nameCandidates = [
      record.nome,
      record.descricao,
      record.nomeAtividade,
      record.nomeNotificacao,
    ];
    const name = nameCandidates.find(
      (value): value is string =>
        typeof value === 'string' && value.trim().length > 0,
    );
    const normalizedName = name?.trim() ?? '';
    const label =
      code &&
      normalizedName.toLocaleLowerCase().startsWith(code.toLocaleLowerCase())
        ? normalizedName
        : `${code} ${normalizedName}`.trim();
    return label || undefined;
  };
  try {
    const formResponse = await fetch('/channel/apontamento.do?action=novo', {
      credentials: 'include',
      headers: { Accept: 'text/html' },
    });
    const formHtml = await formResponse.text();
    const parsed = new DOMParser().parseFromString(formHtml, 'text/html');
    if (parsed.querySelector('#loginForm')) return failure('login-required');
    let participant =
      parsed.querySelector<HTMLInputElement>('[name="participanteSelecionado"]')
        ?.value ||
      document.querySelector<HTMLInputElement>('#participanteSelecionado')
        ?.value ||
      String(runtime.idUsuarioSelecionado ?? '');
    if (!participant) {
      const extractResponse = await fetch(
        '/channel/apontamento.do?action=listarDatas&retorno=painel',
        { credentials: 'include', headers: { Accept: 'text/html' } },
      );
      const extract = new DOMParser().parseFromString(
        await extractResponse.text(),
        'text/html',
      );
      participant =
        extract.querySelector<HTMLInputElement>('#participanteSelecionado')
          ?.value ?? '';
    }
    if (!participant) return failure('channel-participant-unavailable');
    const isStaff = Boolean(await call(apontamento, 'isStaff', [participant]));
    const rawProjects = await call(
      projetos,
      isStaff
        ? 'listarPorUsuarioObjetoFalso'
        : 'listarPorUsuarioAreaApontamento',
      isStaff ? [participant] : [-1, true, false],
    );
    if (!Array.isArray(rawProjects))
      return failure('channel-project-contract-invalid');
    const projectRows = rawProjects.flatMap((candidate) => {
      const record = recordOf(candidate);
      if (!record) return [];
      const id = idOf(record);
      const label = labelOf(record);
      return id && label ? [{ id, label }] : [];
    });
    const output: Array<{
      id: string;
      label: string;
      activities: Array<{ id: string; label: string }>;
    }> = [];
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < projectRows.length) {
        const index = cursor++;
        const project = projectRows[index];
        if (!project) continue;
        const rawActivities = await call(
          apontamento,
          'getAtividadesByProjeto',
          [project.id, participant, null],
        );
        const activities = Array.isArray(rawActivities)
          ? rawActivities.flatMap((candidate) => {
              const record = recordOf(candidate);
              if (!record) return [];
              const id = idOf(record);
              const label = labelOf(record);
              return id && label ? [{ id, label }] : [];
            })
          : [];
        output[index] = {
          ...project,
          activities: activities.sort((left, right) =>
            left.label.localeCompare(right.label, 'pt-BR'),
          ),
        };
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(4, Math.max(1, projectRows.length)) }, () =>
        worker(),
      ),
    );
    const result = output
      .filter(Boolean)
      .sort((left, right) => left.label.localeCompare(right.label, 'pt-BR'));
    console.info('[PontoNaCerti][ChannelCatalog]', {
      status: 'ok',
      origin: location.origin,
      projectCount: result.length,
      activityCount: result.reduce(
        (total, project) => total + project.activities.length,
        0,
      ),
    });
    return { ok: true, projects: result };
  } catch (error: unknown) {
    return failure(
      error instanceof Error ? error.message : 'channel-catalog-failed',
    );
  }
}

interface ChannelApiResult {
  readonly lista?: unknown;
}

/** Chama o cliente DWR já autenticado sem navegar, preencher ou clicar no DOM. */
export async function runInjectedChannelApiRead(
  input: InjectedChannelReadInput,
): Promise<InjectedChannelReadResult> {
  const runtime = globalThis as ChannelRuntime;
  const api = runtime.ApontamentoAjax;
  const timeoutMs = input.timeoutMs ?? 30_000;
  const call = (
    owner: DwrApi,
    method: string,
    args: readonly unknown[],
  ): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const action = owner[method];
      if (!action) {
        reject(new Error(`${method}-not-found`));
        return;
      }
      const timer = globalThis.setTimeout(
        () => reject(new Error(`${method}-timeout`)),
        timeoutMs,
      );
      action(...args, (value: unknown) => {
        globalThis.clearTimeout(timer);
        resolve(value);
      });
    });
  const toIso = (value: string): string | undefined => {
    const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
    if (!match) return undefined;
    const [, day, month, year] = match;
    return day && month && year ? `${year}-${month}-${day}` : undefined;
  };
  const toDuration = (minutes: number): string => {
    const sign = minutes < 0 ? '-' : '';
    const absolute = Math.abs(minutes);
    return `${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`;
  };
  const failed = (code: string): InjectedChannelReadResult => {
    console.warn('[PontoNaCerti][ChannelApiRead]', {
      status: 'failed',
      code,
      origin: location.origin,
      dwrAvailable: api?.listarApontamentoPorData !== undefined,
    });
    return { ok: false, code };
  };
  if (!api?.listarApontamentoPorData) return failed('channel-api-unavailable');
  let participant =
    document.querySelector<HTMLInputElement>('#participanteSelecionado')
      ?.value ?? '';
  const noPagination = [
    ...document.querySelectorAll<HTMLOptionElement>('#totalItensPagina option'),
  ].find((option) => option.text.trim() === 'Não paginar');
  let company = String(runtime.ID_EMPRESA ?? '');
  const participantFromPage = Boolean(participant);
  const companyFromPage = Boolean(company);

  try {
    if (!participant || !company) {
      const contextResponse = await fetch(
        '/channel/apontamento.do?action=listarDatas&retorno=painel',
        { credentials: 'include', headers: { Accept: 'text/html' } },
      );
      const contextHtml = await contextResponse.text();
      const contextDocument = new DOMParser().parseFromString(
        contextHtml,
        'text/html',
      );
      if (contextDocument.querySelector('#loginForm'))
        return failed('login-required');
      if (!contextResponse.ok)
        return failed(`channel-context-http-${String(contextResponse.status)}`);
      participant ||=
        contextDocument.querySelector<HTMLInputElement>(
          '#participanteSelecionado',
        )?.value ?? '';
      const scripts = [...contextDocument.scripts]
        .map((script) => script.textContent)
        .join('\n');
      company ||=
        /(?:var\s+)?ID_EMPRESA\s*=\s*["']?([A-Za-z0-9_-]+)/.exec(
          scripts,
        )?.[1] ?? '';
    }
    console.info('[PontoNaCerti][ChannelContext]', {
      status: participant && company ? 'ok' : 'failed',
      participantSource: participantFromPage
        ? 'page'
        : participant
          ? 'extract-fetch'
          : 'missing',
      companySource: companyFromPage
        ? 'page'
        : company
          ? 'extract-fetch'
          : 'missing',
    });
    if (!participant) return failed('channel-participant-unavailable');
    if (!company) return failed('channel-company-unavailable');
    const raw = (await call(api, 'listarApontamentoPorData', [
      {
        start: 0,
        limit: noPagination?.value || '999999',
        dataInicial: input.startDate,
        dataFinal: input.endDate,
        usuario: participant,
        checkBoxApontamento: '',
        empresa: company,
        filtroStatusApontamento: '',
      },
    ])) as ChannelApiResult;
    if (!Array.isArray(raw.lista))
      return failed('channel-api-contract-invalid');
    const rawList = raw.lista;
    let rows = rawList.flatMap((candidate, rowIndex) => {
      const row = candidate as ChannelApiRow;
      if (
        typeof row.dataFormatada !== 'string' ||
        typeof row.totalDuracao !== 'number'
      )
        return [];
      const date = toIso(row.dataFormatada);
      if (!date) return [];
      const durationMinutes = Math.round(row.totalDuracao * 60);
      return [
        {
          rowIndex,
          date,
          duration: toDuration(durationMinutes),
          durationMinutes,
        },
      ];
    });
    const invalidRowCount = rawList.length - rows.length;
    let detailFailureCount = 0;
    if (api.listarApontamentoPorDataIndividualmente) {
      const filterType =
        document.querySelector<HTMLInputElement>('#FILTRO_TIPO_APONTAMENTO')
          ?.value ?? '0';
      rows = await Promise.all(
        rows.map(async (row) => {
          try {
            const details = await call(
              api,
              'listarApontamentoPorDataIndividualmente',
              [
                (rawList[row.rowIndex] as ChannelApiRow).dataFormatada,
                participant,
                filterType,
                runtime.checkBoxApontamento ?? '',
              ],
            );
            if (!Array.isArray(details)) return row;
            const detailRows = details as ChannelDetailRow[];
            const markings = detailRows.flatMap((detail) => {
              if (
                typeof detail.id !== 'string' &&
                typeof detail.id !== 'number'
              )
                return [];
              const rawDuration =
                typeof detail.duracao === 'string' ? detail.duracao.trim() : '';
              const durationMatch = /^(\d+):([0-5]\d)$/.exec(rawDuration);
              const durationMinutes = durationMatch
                ? Number(durationMatch[1]) * 60 + Number(durationMatch[2])
                : typeof detail.duracaoDouble === 'number' &&
                    Number.isFinite(detail.duracaoDouble)
                  ? Math.round(detail.duracaoDouble * 60)
                  : undefined;
              if (durationMinutes === undefined || durationMinutes < 0)
                return [];
              const permission = detail.permissaoRemover;
              const canDelete = !(
                permission === false ||
                permission === 0 ||
                permission === '0' ||
                (typeof permission === 'string' &&
                  permission.toLocaleLowerCase() === 'false')
              );
              return [
                {
                  id: String(detail.id),
                  date: row.date,
                  duration: toDuration(durationMinutes),
                  durationMinutes,
                  ...(typeof detail.nomeApontamento === 'string' &&
                  detail.nomeApontamento.trim()
                    ? { project: detail.nomeApontamento.trim() }
                    : {}),
                  ...(typeof detail.nomeAtividadeTicket === 'string' &&
                  detail.nomeAtividadeTicket.trim()
                    ? { activity: detail.nomeAtividadeTicket.trim() }
                    : {}),
                  canDelete,
                },
              ];
            });
            const projects = [
              ...new Set(
                detailRows.flatMap((detail) =>
                  typeof detail.nomeApontamento === 'string' &&
                  detail.nomeApontamento.trim()
                    ? [detail.nomeApontamento.trim()]
                    : [],
                ),
              ),
            ];
            const activities = [
              ...new Set(
                detailRows.flatMap((detail) =>
                  typeof detail.nomeAtividadeTicket === 'string' &&
                  detail.nomeAtividadeTicket.trim()
                    ? [detail.nomeAtividadeTicket.trim()]
                    : [],
                ),
              ),
            ];
            return {
              ...row,
              ...(markings.length === 0 ? {} : { markings }),
              ...(projects.length === 0
                ? {}
                : { project: projects.join(' + ') }),
              ...(activities.length === 0
                ? {}
                : { activity: activities.join(' + ') }),
            };
          } catch {
            detailFailureCount++;
            return row;
          }
        }),
      );
    }
    console.info('[PontoNaCerti][ChannelApiRead]', {
      status: 'ok',
      origin: location.origin,
      rowCount: rows.length,
      invalidRowCount,
      detailFailureCount,
    });
    return {
      ok: true,
      rows,
      errors: Array.from({ length: invalidRowCount }, (_, rowIndex) => ({
        rowIndex,
        code: 'invalid-row' as const,
      })),
    };
  } catch (error: unknown) {
    return failed(error instanceof Error ? error.message : 'api-read-failed');
  }
}

/** Exclui somente o apontamento identificado e confirma que ele saiu do dia esperado. */
export async function runInjectedChannelApiDelete(
  input: InjectedChannelDeleteInput,
): Promise<InjectedChannelDeleteResult> {
  const runtime = globalThis as ChannelRuntime;
  const api = runtime.ApontamentoAjax;
  const timeoutMs = input.timeoutMs ?? 30_000;
  const failed = (code: string): InjectedChannelDeleteResult => {
    console.warn('[PontoNaCerti][ChannelApiDelete]', {
      status: 'failed',
      code,
      origin: location.origin,
      date: input.date,
    });
    return { ok: false, code };
  };
  if (!api?.listarApontamentoPorDataIndividualmente || !api.remover)
    return failed('channel-delete-api-unavailable');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || !input.id.trim())
    return failed('invalid-delete-target');
  const call = (
    owner: DwrApi,
    method: string,
    args: readonly unknown[],
  ): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const action = owner[method];
      if (!action) {
        reject(new Error(`${method}-not-found`));
        return;
      }
      const timer = globalThis.setTimeout(
        () => reject(new Error(`${method}-timeout`)),
        timeoutMs,
      );
      action(...args, (value: unknown) => {
        globalThis.clearTimeout(timer);
        resolve(value);
      });
    });
  const brazilianDate = (() => {
    const [year, month, day] = input.date.split('-');
    return year && month && day ? `${day}/${month}/${year}` : '';
  })();
  try {
    let participant =
      document.querySelector<HTMLInputElement>('#participanteSelecionado')
        ?.value ?? '';
    if (!participant) {
      const response = await fetch(
        '/channel/apontamento.do?action=listarDatas&retorno=painel',
        { credentials: 'include', headers: { Accept: 'text/html' } },
      );
      const context = new DOMParser().parseFromString(
        await response.text(),
        'text/html',
      );
      if (context.querySelector('#loginForm')) return failed('login-required');
      participant =
        context.querySelector<HTMLInputElement>('#participanteSelecionado')
          ?.value ?? '';
    }
    if (!participant) return failed('channel-participant-unavailable');
    const filterType =
      document.querySelector<HTMLInputElement>('#FILTRO_TIPO_APONTAMENTO')
        ?.value ?? '0';
    const detailArgs = [
      brazilianDate,
      participant,
      filterType,
      runtime.checkBoxApontamento ?? '',
    ] as const;
    const before = await call(
      api,
      'listarApontamentoPorDataIndividualmente',
      detailArgs,
    );
    if (!Array.isArray(before))
      return failed('channel-detail-contract-invalid');
    const target = before.find((candidate) => {
      if (typeof candidate !== 'object' || candidate === null) return false;
      const id = (candidate as { id?: unknown }).id;
      return (
        (typeof id === 'string' || typeof id === 'number') &&
        String(id) === input.id
      );
    }) as ChannelDetailRow | undefined;
    if (!target) return failed('marking-not-found');
    const permission = target.permissaoRemover;
    if (
      permission === false ||
      permission === 0 ||
      permission === '0' ||
      (typeof permission === 'string' &&
        permission.toLocaleLowerCase() === 'false')
    )
      return failed('marking-delete-not-permitted');
    const numericId = Number(input.id);
    await call(api, 'remover', [
      Number.isSafeInteger(numericId) && String(numericId) === input.id
        ? numericId
        : input.id,
    ]);
    const after = await call(
      api,
      'listarApontamentoPorDataIndividualmente',
      detailArgs,
    );
    if (!Array.isArray(after)) return failed('delete-confirmation-invalid');
    const stillPresent = after.some((candidate) => {
      if (typeof candidate !== 'object' || candidate === null) return false;
      const id = (candidate as { id?: unknown }).id;
      return (
        (typeof id === 'string' || typeof id === 'number') &&
        String(id) === input.id
      );
    });
    if (stillPresent) return failed('delete-not-confirmed');
    console.info('[PontoNaCerti][ChannelApiDelete]', {
      status: 'ok',
      origin: location.origin,
      date: input.date,
    });
    return { ok: true, id: input.id, date: input.date };
  } catch (error: unknown) {
    return failed(
      error instanceof Error ? error.message : 'channel-delete-failed',
    );
  }
}

export async function runInjectedChannelApiWrite(
  input: InjectedChannelFillInput & { readonly commit?: boolean },
): Promise<InjectedChannelFillResult> {
  const runtime = globalThis as ChannelRuntime;
  const apontamento = runtime.ApontamentoAjax;
  const projetos = runtime.ProjetoAjax;
  const timeoutMs = input.timeoutMs ?? 30_000;
  const call = (
    owner: DwrApi,
    method: string,
    args: readonly unknown[],
  ): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const action = owner[method];
      if (!action) {
        reject(new Error(`${method}-not-found`));
        return;
      }
      const timer = globalThis.setTimeout(
        () => reject(new Error(`${method}-timeout`)),
        timeoutMs,
      );
      action(...args, (value: unknown) => {
        globalThis.clearTimeout(timer);
        resolve(value);
      });
    });
  const find = (
    items: unknown,
    prefix: string,
  ): Record<string, unknown> | undefined => {
    if (!Array.isArray(items)) return undefined;
    const canonical = (value: string): string =>
      value
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9]+/g, ' ')
        .trim()
        .toLocaleLowerCase('pt-BR');
    const requested = canonical(prefix);
    return items.find((item): item is Record<string, unknown> => {
      if (typeof item !== 'object' || item === null) return false;
      const record = item as Record<string, unknown>;
      const values = Object.values(record).filter(
        (value): value is string => typeof value === 'string',
      );
      const code =
        typeof record.codigo === 'string' || typeof record.codigo === 'number'
          ? String(record.codigo)
          : '';
      const name = typeof record.nome === 'string' ? record.nome : '';
      const combined = `${code} ${name}`.trim();
      const requestedCode = /^\s*([^\s-]+)/.exec(prefix)?.[1];
      const labels = [...values, combined].map(canonical).filter(Boolean);
      return (
        values.some((value) => value.trim().startsWith(prefix)) ||
        combined.startsWith(prefix) ||
        labels.some(
          (label) =>
            label === requested ||
            label.endsWith(` ${requested}`) ||
            requested.endsWith(` ${label}`),
        ) ||
        (requestedCode !== undefined && code === requestedCode)
      );
    });
  };
  const idOf = (item: Record<string, unknown>): string => {
    if (typeof item.id !== 'number' && typeof item.id !== 'string')
      throw new Error('option-id-not-found');
    return String(item.id);
  };
  const selectValue = (
    form: HTMLFormElement,
    selector: string,
    prefix: string,
  ): string | undefined => {
    const select = form.querySelector<HTMLSelectElement>(selector);
    return [...(select?.options ?? [])].find((option) =>
      option.text.trim().startsWith(prefix),
    )?.value;
  };
  const normalize = (value: unknown): string =>
    (typeof value === 'string' || typeof value === 'number'
      ? String(value)
      : ''
    )
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLocaleLowerCase('pt-BR');
  const brazilianDate = (value: string): string => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) throw new Error('invalid-date');
    const [, year, month, day] = match;
    if (!year || !month || !day) throw new Error('invalid-date');
    return `${day}/${month}/${year}`;
  };
  const base = { date: input.date, requestedMinutes: input.durationMinutes };
  const failure = (
    status: InjectedChannelFillResult['status'],
    code: string,
  ): InjectedChannelFillResult => {
    console.warn('[PontoNaCerti][ChannelApiWrite]', {
      status,
      code,
      origin: location.origin,
    });
    return { ...base, status, code };
  };
  if (!apontamento || (input.kind === 'PROJETOS' && !projetos))
    return failure('failed', 'channel-api-unavailable');

  try {
    const response = await fetch('/channel/apontamento.do?action=novo', {
      credentials: 'include',
      headers: { Accept: 'text/html' },
    });
    const html = await response.text();
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    if (parsed.querySelector('#loginForm'))
      return failure('failed', 'login-required');
    const form = parsed.querySelector<HTMLFormElement>(
      'form[name="apontamentoForm"]',
    );
    if (!response.ok || !form)
      return failure('failed', 'entry-request-contract-invalid');
    let participant =
      form.querySelector<HTMLInputElement>('[name="participanteSelecionado"]')
        ?.value ||
      document.querySelector<HTMLInputElement>('#participanteSelecionado')
        ?.value ||
      '';
    let company = String(runtime.ID_EMPRESA ?? '');
    if (!participant || !company) {
      const contextResponse = await fetch(
        '/channel/apontamento.do?action=listarDatas&retorno=painel',
        { credentials: 'include', headers: { Accept: 'text/html' } },
      );
      const contextHtml = await contextResponse.text();
      const contextDocument = new DOMParser().parseFromString(
        contextHtml,
        'text/html',
      );
      if (contextDocument.querySelector('#loginForm'))
        return failure('failed', 'login-required');
      if (!contextResponse.ok)
        return failure(
          'failed',
          `channel-context-http-${String(contextResponse.status)}`,
        );
      participant ||=
        contextDocument.querySelector<HTMLInputElement>(
          '#participanteSelecionado',
        )?.value ?? '';
      const scripts = [...contextDocument.scripts]
        .map((script) => script.textContent)
        .join('\n');
      company ||=
        /(?:var\s+)?ID_EMPRESA\s*=\s*["']?([A-Za-z0-9_-]+)/.exec(
          scripts,
        )?.[1] ?? '';
    }
    if (!participant)
      return failure('failed', 'channel-participant-unavailable');
    if (!company) return failure('failed', 'channel-company-unavailable');
    const readExistingMinutes = async (): Promise<number | undefined> => {
      if (!apontamento.listarApontamentoPorData) return undefined;
      const requestedDate = brazilianDate(input.date);
      const result = (await call(apontamento, 'listarApontamentoPorData', [
        {
          start: 0,
          limit: '999999',
          dataInicial: requestedDate,
          dataFinal: requestedDate,
          usuario: participant,
          checkBoxApontamento: '',
          empresa: company,
          filtroStatusApontamento: '',
        },
      ])) as ChannelApiResult;
      if (!Array.isArray(result.lista)) return undefined;
      const row = result.lista.find(
        (candidate) =>
          (candidate as ChannelApiRow).dataFormatada === requestedDate,
      ) as ChannelApiRow | undefined;
      return typeof row?.totalDuracao === 'number'
        ? Math.round(row.totalDuracao * 60)
        : undefined;
    };
    const existingMinutes = (await readExistingMinutes()) ?? 0;
    const expectedExistingMinutes = input.expectedExistingMinutes ?? 0;
    const expectedResultingMinutes =
      expectedExistingMinutes + input.durationMinutes;
    if (existingMinutes === expectedResultingMinutes)
      return {
        ...base,
        status: 'already-correct',
        resultingMinutes: existingMinutes,
      };
    if (existingMinutes !== expectedExistingMinutes)
      return failure('validation-error', 'existing-duration-divergent');
    const body = new URLSearchParams();
    for (const [name, value] of new FormData(form))
      if (typeof value === 'string') body.append(name, value);
    if (input.kind === 'AVULSO') {
      const engine = runtime.dwr?.engine;
      const clients =
        runtime.ClienteAjax ??
        (engine
          ? {
              campoApropriacaoAutocomplete: (...args: unknown[]): unknown => {
                return engine._execute(
                  '/channel/dwr',
                  'ClienteAjax',
                  'campoApropriacaoAutocomplete',
                  args,
                );
              },
            }
          : undefined);
      const activityTypes =
        runtime.TipoAtividadeAjax ??
        (engine
          ? {
              getTipoAtividadePorArea: (...args: unknown[]): unknown => {
                return engine._execute(
                  '/channel/dwr',
                  'TipoAtividadeAjax',
                  'getTipoAtividadePorArea',
                  args,
                );
              },
            }
          : undefined);
      if (!clients) return failure('failed', 'client-api-unavailable');
      const clientItems = (await call(clients, 'campoApropriacaoAutocomplete', [
        input.client,
      ])) as unknown[];
      const client = Array.isArray(clientItems)
        ? (clientItems.find(
            (candidate): candidate is Record<string, unknown> => {
              if (typeof candidate !== 'object' || candidate === null)
                return false;
              const record = candidate as Record<string, unknown>;
              return Object.values(record).some(
                (value) => normalize(value) === normalize(input.client),
              );
            },
          ) ?? find(clientItems, input.client))
        : undefined;
      if (!client) return failure('not-found', 'client-not-found');
      const natureSelect = form.querySelector<HTMLSelectElement>(
        '[id="apontamento.tipoOperacaoSelecionado"]',
      );
      const requestedNature = normalize(input.operationNature);
      const nature = [...(natureSelect?.options ?? [])].find((option) => {
        const label = normalize(option.text);
        const requestedCode = /^\d+/.exec(requestedNature)?.[0];
        const labelCode = /^\d+/.exec(label)?.[0];
        return (
          label.startsWith(requestedNature) ||
          requestedNature.startsWith(label) ||
          (requestedCode !== undefined && requestedCode === labelCode)
        );
      });
      if (!nature)
        return failure('not-found', 'operation-nature-prefix-not-found');
      let activityTypeId = '-1';
      if (normalize(input.activityType) !== 'nenhum') {
        if (!activityTypes)
          return failure('failed', 'ad-hoc-activity-api-unavailable');
        const scripts = [...parsed.scripts]
          .map((script) => script.textContent)
          .join('\n');
        const area = String(
          runtime.idAreaUsuario ??
            runtime.ID_AREA_USUARIO_LOGADO ??
            /(?:var\s+)?(?:idAreaUsuario|ID_AREA_USUARIO_LOGADO)\s*=\s*["']?([A-Za-z0-9_-]+)/.exec(
              scripts,
            )?.[1] ??
            '',
        );
        if (!area) return failure('failed', 'channel-area-unavailable');
        const typeItems = (await call(
          activityTypes,
          'getTipoAtividadePorArea',
          [area, []],
        )) as unknown[];
        const activityType = find(typeItems, input.activityType);
        if (!activityType)
          return failure('not-found', 'ad-hoc-activity-type-prefix-not-found');
        activityTypeId = idOf(activityType);
      }
      body.set(
        'tipoApontamento',
        form.querySelector<HTMLInputElement>('#tpApontamentoAvulso')?.value ??
          '2',
      );
      body.set('apontamento.clienteSelecionadoAvulso', idOf(client));
      body.set('apontamento.tipoOperacaoSelecionado', nature.value);
      body.set('apontamento.idTipoAtividadeAvulso', activityTypeId);
    } else {
      if (!projetos) return failure('failed', 'project-api-unavailable');
      const isStaff = Boolean(
        await call(apontamento, 'isStaff', [participant]),
      );
      const projectItems = (await call(
        projetos,
        isStaff
          ? 'listarPorUsuarioObjetoFalso'
          : 'listarPorUsuarioAreaApontamento',
        isStaff ? [participant] : [-1, true, false],
      )) as unknown[];
      const project = find(projectItems, input.project);
      if (!project) return failure('not-found', 'project-prefix-not-found');
      const projectId = idOf(project);
      const activities = (await call(apontamento, 'getAtividadesByProjeto', [
        projectId,
        participant,
        null,
      ])) as unknown[];
      const activity = find(activities, input.activity);
      if (!activity) return failure('not-found', 'activity-prefix-not-found');
      const activityId = idOf(activity);
      const tasks = (await call(apontamento, 'getTarefasByAtividade', [
        activityId,
      ])) as unknown[];
      const task = find(tasks, input.task);
      const activityType = selectValue(
        form,
        '[id="apontamento.idTipoAtividadeProjeto"]',
        input.activityType,
      );
      const taskId = task
        ? idOf(task)
        : selectValue(form, '[id="apontamento.idTarefa"]', input.task);
      if (activityType === undefined)
        return failure('not-found', 'activity-type-prefix-not-found');
      if (taskId === undefined)
        return failure('not-found', 'task-prefix-not-found');
      body.set(
        'tipoApontamento',
        form.querySelector<HTMLInputElement>('#tpApontamentoProjeto')?.value ??
          '0',
      );
      body.set('apontamento.projetosSelecionado', projectId);
      body.set('apontamento.idTipoAtividadeProjeto', activityType);
      body.set('apontamento.notificacaoSelecionada', activityId);
      body.set('apontamento.idTarefa', taskId);
    }
    body.set('apontamento.comentario', input.comments ?? '');
    body.set('data', brazilianDate(input.date));
    body.set('apontamento.duracao', input.duration);
    body.set('apontamento.horaInicio', '');
    body.set('apontamento.horaFim', '');
    body.set('action', 'salvar');
    body.set('key', '-1');
    body.set('historyBackUrl', '');
    if (input.commit === false) {
      console.info('[PontoNaCerti][ChannelApiWrite]', {
        status: 'prepared',
        origin: location.origin,
        fieldCount: [...body.keys()].length,
      });
      return {
        ...base,
        status: 'filled',
        resultingMinutes: expectedExistingMinutes,
      };
    }
    const saved = await fetch(form.getAttribute('action') ?? form.action, {
      method: 'POST',
      credentials: 'include',
      headers: {
        Accept: 'text/html',
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      },
      body,
    });
    if (!saved.ok)
      return failure('failed', `write-http-${String(saved.status)}`);
    let confirmedMinutes: number | undefined;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      confirmedMinutes = await readExistingMinutes();
      if (confirmedMinutes === expectedResultingMinutes) break;
      await new Promise((resolve) => globalThis.setTimeout(resolve, 250));
    }
    if (confirmedMinutes !== expectedResultingMinutes)
      return failure(
        confirmedMinutes === undefined ? 'failed' : 'validation-error',
        confirmedMinutes === undefined
          ? 'write-not-confirmed'
          : 'written-duration-divergent',
      );
    console.info('[PontoNaCerti][ChannelApiWrite]', {
      status: 'submitted',
      origin: location.origin,
      responseStatus: saved.status,
    });
    return {
      ...base,
      status: 'filled',
      resultingMinutes: confirmedMinutes,
    };
  } catch (error: unknown) {
    return failure(
      error instanceof Error && /not-found$/.test(error.message)
        ? 'not-found'
        : 'failed',
      error instanceof Error ? error.message : 'api-write-failed',
    );
  }
}
