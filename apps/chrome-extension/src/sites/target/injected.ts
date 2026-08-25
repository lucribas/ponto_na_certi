export interface InjectedChannelReadInput {
  readonly startDate: string;
  readonly endDate: string;
  readonly timeoutMs?: number;
}

export interface InjectedChannelReadRow {
  readonly rowIndex: number;
  readonly date: string;
  readonly duration: string;
  readonly durationMinutes: number;
  readonly project?: string;
  readonly activity?: string;
  readonly markings?: readonly InjectedChannelMarking[];
}

export interface InjectedChannelMarking {
  readonly id: string;
  readonly date: string;
  readonly duration: string;
  readonly durationMinutes: number;
  readonly project?: string;
  readonly activity?: string;
  readonly canDelete: boolean;
}

export interface InjectedChannelDeleteInput {
  readonly id: string;
  readonly date: string;
  readonly timeoutMs?: number;
}

export type InjectedChannelDeleteResult =
  | { readonly ok: true; readonly id: string; readonly date: string }
  | { readonly ok: false; readonly code: string };

export interface InjectedChannelCatalogProject {
  readonly id: string;
  readonly label: string;
  readonly activities: readonly {
    readonly id: string;
    readonly label: string;
  }[];
}

export type InjectedChannelCatalogResult =
  | {
      readonly ok: true;
      readonly projects: readonly InjectedChannelCatalogProject[];
    }
  | { readonly ok: false; readonly code: string };

export type InjectedChannelReadResult =
  | {
      readonly ok: true;
      readonly rows: readonly InjectedChannelReadRow[];
      readonly errors: readonly {
        readonly rowIndex: number;
        readonly code: 'invalid-row';
      }[];
    }
  | { readonly ok: false; readonly code: string };

interface InjectedChannelFillBase {
  readonly date: string;
  readonly duration: string;
  readonly durationMinutes: number;
  readonly comments?: string;
  readonly expectedExistingMinutes?: number;
  readonly timeoutMs?: number;
}

export interface InjectedChannelProjectFillInput extends InjectedChannelFillBase {
  readonly kind: 'PROJETOS';
  readonly project: string;
  readonly activityType: string;
  readonly activity: string;
  readonly task: string;
}

export interface InjectedChannelAdHocFillInput extends InjectedChannelFillBase {
  readonly kind: 'AVULSO';
  readonly client: string;
  readonly operationNature: string;
  readonly activityType: string;
}

export type InjectedChannelFillInput =
  InjectedChannelProjectFillInput | InjectedChannelAdHocFillInput;

export interface InjectedChannelFillResult {
  readonly date: string;
  readonly requestedMinutes: number;
  readonly resultingMinutes?: number;
  readonly status:
    'filled' | 'already-correct' | 'not-found' | 'validation-error' | 'failed';
  readonly code?: string;
}

/**
 * Função autocontida para chrome.scripting.executeScript. Não adicionar referências
 * a imports ou variáveis do módulo: o Chrome serializa somente este corpo.
 */
export async function runInjectedChannelRead(
  input: InjectedChannelReadInput,
  runtimeDocument: Document = document,
): Promise<InjectedChannelReadResult> {
  const selectors = {
    loginForm: '#loginForm',
    password: '[name="password"]',
    entryForm: '#apontamento_diario',
    pageSize: '#totalItensPagina',
    content: '#conteudo',
    startDate: '[name="dataInicial"]',
    endDate: '[name="dataFinal"]',
    filter: '[value*="Filtrar"]',
    extractRows: '#tblListagem',
  } as const;
  const timeoutMs = input.timeoutMs ?? 1_000;

  const dispatchValueEvents = (
    element: HTMLInputElement | HTMLSelectElement,
  ): void => {
    const EventConstructor = element.ownerDocument.defaultView?.Event ?? Event;
    element.dispatchEvent(new EventConstructor('input', { bubbles: true }));
    element.dispatchEvent(new EventConstructor('change', { bubbles: true }));
  };
  const waitFor = async <T>(condition: () => T | undefined): Promise<T> => {
    const startedAt = Date.now();
    while (Date.now() - startedAt <= timeoutMs) {
      const value = condition();
      if (value !== undefined) return value;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('report-not-refreshed');
  };
  const structuralDiagnostic = (): Record<string, unknown> => ({
    origin: runtimeDocument.defaultView?.location.origin ?? 'detached-document',
    readyState: runtimeDocument.readyState,
    topFrame: runtimeDocument.defaultView?.top === runtimeDocument.defaultView,
    loginForm: runtimeDocument.querySelector(selectors.loginForm) !== null,
    entryForm: runtimeDocument.querySelector(selectors.entryForm) !== null,
    pageSize: runtimeDocument.querySelector(selectors.pageSize) !== null,
    content: runtimeDocument.querySelector(selectors.content) !== null,
    startDate: runtimeDocument.querySelector(selectors.startDate) !== null,
    endDate: runtimeDocument.querySelector(selectors.endDate) !== null,
    filter: runtimeDocument.querySelector(selectors.filter) !== null,
    extractRows: runtimeDocument.querySelector(selectors.extractRows) !== null,
  });
  const failed = (code: string): InjectedChannelReadResult => {
    console.warn('[PontoNaCerti][ChannelRead]', {
      status: 'failed',
      code,
      ...structuralDiagnostic(),
    });
    return { ok: false, code };
  };

  try {
    const login = runtimeDocument.querySelector(selectors.loginForm);
    if (login?.querySelector(selectors.password)) {
      return failed('login-required');
    }
    if (runtimeDocument.querySelector(selectors.entryForm)) {
      return failed('entry-form-open');
    }
    const pageSize = runtimeDocument.querySelector<HTMLSelectElement>(
      selectors.pageSize,
    );
    const content = runtimeDocument.querySelector<HTMLElement>(
      selectors.content,
    );
    const filter = runtimeDocument.querySelector<HTMLElement>(selectors.filter);
    if (!pageSize || !content || !filter) return failed('not-channel-page');

    const noPagination = [...pageSize.options].find(
      (option) => option.text.trim() === 'Não paginar',
    );
    if (!noPagination) return failed('no-pagination-option-not-found');
    pageSize.selectedIndex = noPagination.index;
    noPagination.selected = true;
    noPagination.click();
    dispatchValueEvents(pageSize);

    const startDate = content.querySelector<HTMLInputElement>(
      selectors.startDate,
    );
    const endDate = content.querySelector<HTMLInputElement>(selectors.endDate);
    if (!startDate || !endDate) return failed('period-fields-not-found');

    const previousReport = runtimeDocument.querySelector<HTMLElement>(
      selectors.extractRows,
    );
    const previousText = previousReport?.textContent.trim() ?? '';
    startDate.value = input.startDate;
    endDate.value = input.endDate;
    dispatchValueEvents(startDate);
    dispatchValueEvents(endDate);
    filter.click();

    const report = await waitFor(() => {
      const current = runtimeDocument.querySelector<HTMLElement>(
        selectors.extractRows,
      );
      if (!current) return undefined;
      if (
        !previousReport ||
        current !== previousReport ||
        current.textContent.trim() !== previousText
      ) {
        return current;
      }
      return undefined;
    });

    const rows: InjectedChannelReadRow[] = [];
    const errors: { rowIndex: number; code: 'invalid-row' }[] = [];
    const lines = report.textContent
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    lines.forEach((line, rowIndex) => {
      const [rawDate, duration] = line.split(/\s+/);
      if (!rawDate || !duration) {
        errors.push({ rowIndex, code: 'invalid-row' });
        return;
      }
      const dateMatch = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(rawDate);
      const durationMatch = /^(-?)(\d+):(\d{2})$/.exec(duration);
      if (!dateMatch || !durationMatch) {
        errors.push({ rowIndex, code: 'invalid-row' });
        return;
      }
      const day = Number(dateMatch[1]);
      const month = Number(dateMatch[2]);
      const year = Number(dateMatch[3]);
      const parsedDate = new Date(Date.UTC(year, month - 1, day));
      if (
        parsedDate.getUTCFullYear() !== year ||
        parsedDate.getUTCMonth() !== month - 1 ||
        parsedDate.getUTCDate() !== day
      ) {
        errors.push({ rowIndex, code: 'invalid-row' });
        return;
      }
      const sign = durationMatch[1] === '-' ? -1 : 1;
      rows.push({
        rowIndex,
        date: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(
          day,
        ).padStart(2, '0')}`,
        duration,
        durationMinutes:
          sign * (Number(durationMatch[2]) * 60 + Number(durationMatch[3])),
      });
    });
    console.info('[PontoNaCerti][ChannelRead]', {
      status: 'ok',
      rowCount: rows.length,
      invalidRowCount: errors.length,
      ...structuralDiagnostic(),
    });
    return { ok: true, rows, errors };
  } catch (error: unknown) {
    return failed(error instanceof Error ? error.message : 'read-failed');
  }
}

/** Autocontida, um item PROJETOS por chamada e sem qualquer caminho de envio. */
export async function runInjectedChannelFill(
  input: InjectedChannelProjectFillInput,
  runtimeDocument: Document = document,
): Promise<InjectedChannelFillResult> {
  const selectors = {
    loginForm: '#loginForm',
    password: '[name="password"]',
    includeEntry: '#incluirNovoApontamento',
    entryForm: '#apontamento_diario',
    projectType: '#tpApontamentoProjeto',
    project: '[id="apontamento.projetosSelecionado"]',
    activityType: '[id="apontamento.idTipoAtividadeProjeto"]',
    activity: '[id="apontamento.notificacaoSelecionada"]',
    task: '[id="apontamento.idTarefa"]',
    date: '#data',
    duration: '[id="apontamento.duracao"]',
  } as const;
  const timeoutMs = input.timeoutMs ?? 1_000;
  const base = { date: input.date, requestedMinutes: input.durationMinutes };
  const structuralDiagnostic = (): Record<string, unknown> => {
    const optionCount = (selector: string): number | undefined =>
      runtimeDocument.querySelector<HTMLSelectElement>(selector)?.options
        .length;
    return {
      origin:
        runtimeDocument.defaultView?.location.origin ?? 'detached-document',
      readyState: runtimeDocument.readyState,
      topFrame:
        runtimeDocument.defaultView?.top === runtimeDocument.defaultView,
      loginForm: runtimeDocument.querySelector(selectors.loginForm) !== null,
      includeEntry:
        runtimeDocument.querySelector(selectors.includeEntry) !== null,
      entryForm: runtimeDocument.querySelector(selectors.entryForm) !== null,
      projectType:
        runtimeDocument.querySelector(selectors.projectType) !== null,
      project: runtimeDocument.querySelector(selectors.project) !== null,
      projectOptionCount: optionCount(selectors.project),
      activityType:
        runtimeDocument.querySelector(selectors.activityType) !== null,
      activityTypeOptionCount: optionCount(selectors.activityType),
      activity: runtimeDocument.querySelector(selectors.activity) !== null,
      activityOptionCount: optionCount(selectors.activity),
      task: runtimeDocument.querySelector(selectors.task) !== null,
      taskOptionCount: optionCount(selectors.task),
      date: runtimeDocument.querySelector(selectors.date) !== null,
      duration: runtimeDocument.querySelector(selectors.duration) !== null,
    };
  };
  const failure = (
    status: InjectedChannelFillResult['status'],
    code: string,
  ): InjectedChannelFillResult => {
    console.warn('[PontoNaCerti][ChannelFill]', {
      status,
      code,
      ...structuralDiagnostic(),
    });
    return { ...base, status, code };
  };
  const success = (
    status: 'filled' | 'already-correct',
  ): InjectedChannelFillResult => {
    console.info('[PontoNaCerti][ChannelFill]', {
      status,
      ...structuralDiagnostic(),
    });
    return {
      ...base,
      status,
      resultingMinutes: input.durationMinutes,
    };
  };
  const dispatchValueEvents = (
    element: HTMLInputElement | HTMLSelectElement,
  ): void => {
    const EventConstructor = element.ownerDocument.defaultView?.Event ?? Event;
    element.dispatchEvent(new EventConstructor('input', { bubbles: true }));
    element.dispatchEvent(new EventConstructor('change', { bubbles: true }));
  };
  const waitFor = async <T>(condition: () => T | undefined): Promise<T> => {
    const startedAt = Date.now();
    while (Date.now() - startedAt <= timeoutMs) {
      const value = condition();
      if (value !== undefined) return value;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('timeout');
  };

  try {
    const login = runtimeDocument.querySelector(selectors.loginForm);
    if (login?.querySelector(selectors.password))
      return failure('failed', 'login-required');

    let form = runtimeDocument.querySelector<HTMLElement>(selectors.entryForm);
    if (!form) {
      const includeEntry = runtimeDocument.querySelector<HTMLElement>(
        selectors.includeEntry,
      );
      if (!includeEntry) return failure('not-found', 'include-entry-not-found');
      includeEntry.click();
      form = await waitFor(
        () =>
          runtimeDocument.querySelector<HTMLElement>(selectors.entryForm) ??
          undefined,
      );
    }

    const projectType = runtimeDocument.querySelector<HTMLElement>(
      selectors.projectType,
    );
    const date = form.querySelector<HTMLInputElement>(selectors.date);
    const duration = form.querySelector<HTMLInputElement>(selectors.duration);
    if (!projectType || !date || !duration) {
      return failure('not-found', 'project-fields-not-found');
    }

    const dateParts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.date);
    if (!dateParts) return failure('validation-error', 'invalid-date');
    const year = dateParts[1];
    const month = dateParts[2];
    const day = dateParts[3];
    if (!year || !month || !day)
      return failure('validation-error', 'invalid-date');
    const requestedDate = `${day}/${month}/${year}`;
    const selectedText = (select: HTMLSelectElement): string =>
      select.selectedOptions[0]?.text.trim() ?? '';
    if (duration.value !== '') {
      const project = runtimeDocument.querySelector<HTMLSelectElement>(
        selectors.project,
      );
      const activityType = runtimeDocument.querySelector<HTMLSelectElement>(
        selectors.activityType,
      );
      const activity = runtimeDocument.querySelector<HTMLSelectElement>(
        selectors.activity,
      );
      const task = runtimeDocument.querySelector<HTMLSelectElement>(
        selectors.task,
      );
      if (!project || !activityType || !activity || !task)
        return failure('not-found', 'project-fields-not-found');
      const matches =
        date.value === requestedDate &&
        duration.value === input.duration &&
        selectedText(project).startsWith(input.project) &&
        selectedText(activityType).startsWith(input.activityType) &&
        selectedText(activity).startsWith(input.activity) &&
        selectedText(task).startsWith(input.task);
      return matches
        ? success('already-correct')
        : failure('failed', 'entry-form-occupied');
    }

    const selections = [
      ['project', selectors.project, input.project],
      ['activity-type', selectors.activityType, input.activityType],
      ['activity', selectors.activity, input.activity],
      ['task', selectors.task, input.task],
    ] as const;
    projectType.click();
    for (const [field, selector, prefix] of selections) {
      const match = await waitFor(() => {
        const select =
          runtimeDocument.querySelector<HTMLSelectElement>(selector);
        if (!select) return undefined;
        const option = [...select.options].find((candidate) =>
          candidate.text.trim().startsWith(prefix),
        );
        return option ? { select, option } : undefined;
      }).catch(() => undefined);
      if (!match)
        return failure('not-found', `${field}-option-prefix-not-found`);
      const { select, option } = match;
      select.selectedIndex = option.index;
      option.selected = true;
      option.click();
      dispatchValueEvents(select);
    }
    const writable = await waitFor(() => {
      const currentForm = runtimeDocument.querySelector<HTMLElement>(
        selectors.entryForm,
      );
      const currentDate = currentForm?.querySelector<HTMLInputElement>(
        selectors.date,
      );
      const currentDuration = currentForm?.querySelector<HTMLInputElement>(
        selectors.duration,
      );
      return currentDate && currentDuration
        ? { date: currentDate, duration: currentDuration }
        : undefined;
    }).catch(() => undefined);
    if (!writable) return failure('not-found', 'entry-fields-not-found');
    writable.date.value = requestedDate;
    writable.duration.value = input.duration;
    dispatchValueEvents(writable.date);
    dispatchValueEvents(writable.duration);
    await waitFor(() => {
      const currentForm = runtimeDocument.querySelector<HTMLElement>(
        selectors.entryForm,
      );
      const currentDate = currentForm?.querySelector<HTMLInputElement>(
        selectors.date,
      );
      const currentDuration = currentForm?.querySelector<HTMLInputElement>(
        selectors.duration,
      );
      return currentDate?.value === requestedDate &&
        currentDuration?.value === input.duration
        ? true
        : undefined;
    });

    return success('filled');
  } catch (error: unknown) {
    return failure(
      'failed',
      error instanceof Error ? error.message : 'fill-failed',
    );
  }
}
