import { formatBrazilianDate } from '../../domain/civil-date';
import type { ProjectAssignment } from '../../domain/expert';
import {
  requiredElement,
  requiredInput,
  requiredSelect,
  selectOptionByPrefix,
  setInputValue,
} from './dom';
import { detectChannelPage } from './detection';
import { CHANNEL_SELECTORS } from './selectors';
import {
  ChannelAdapterError,
  waitForCondition,
  type WaitOptions,
} from './wait';

export type ChannelFillStatus =
  'filled' | 'already-correct' | 'not-found' | 'validation-error' | 'failed';

export interface ChannelFillResult {
  readonly date: ProjectAssignment['date'];
  readonly requestedMinutes: number;
  readonly resultingMinutes?: number;
  readonly status: ChannelFillStatus;
  readonly code?: string;
}

export async function fillChannelProject(
  document: Document,
  assignment: ProjectAssignment,
  options: WaitOptions = {},
): Promise<ChannelFillResult> {
  try {
    assertWritablePage(document);
    const form = await openEntryForm(document, options);
    const fields = resolveProjectFields(document, form);
    const requestedDate = formatBrazilianDate(assignment.date);

    if (fields.duration.value !== '') {
      return existingFormResult(fields, assignment, requestedDate);
    }

    const selections = [
      [CHANNEL_SELECTORS.project, assignment.project],
      [CHANNEL_SELECTORS.activityType, assignment.activityType],
      [CHANNEL_SELECTORS.activity, assignment.activity],
      [CHANNEL_SELECTORS.task, assignment.task],
    ] as const;
    fields.projectType.click();
    for (const [selector, prefix] of selections) {
      const select = await waitForCondition(
        () => {
          const current = document.querySelector<HTMLSelectElement>(selector);
          return current && hasOptionPrefix(current, prefix)
            ? current
            : undefined;
        },
        'opção configurada do apontamento',
        options,
      ).catch(() => undefined);
      if (!select)
        return result(assignment, 'not-found', 'option-prefix-not-found');
      selectOptionByPrefix(select, prefix);
    }
    const currentForm = await openEntryForm(document, options);
    const currentFields = resolveProjectFields(document, currentForm);
    setInputValue(currentFields.date, requestedDate);
    setInputValue(currentFields.duration, assignment.duration);

    await waitForCondition(
      () =>
        currentFields.date.value === requestedDate &&
        currentFields.duration.value === assignment.duration
          ? true
          : undefined,
      'reconhecimento dos valores do apontamento',
      options,
    );

    return {
      ...result(assignment, 'filled'),
      resultingMinutes: assignment.durationMinutes,
    };
  } catch (error: unknown) {
    if (error instanceof ChannelAdapterError) {
      const status: ChannelFillStatus =
        error.code === 'not-found' ? 'not-found' : 'failed';
      return result(assignment, status, error.code);
    }
    return result(assignment, 'validation-error', 'unrecognized-dom-error');
  }
}

interface ProjectFields {
  readonly projectType: HTMLElement;
  readonly project: HTMLSelectElement;
  readonly activityType: HTMLSelectElement;
  readonly activity: HTMLSelectElement;
  readonly task: HTMLSelectElement;
  readonly date: HTMLInputElement;
  readonly duration: HTMLInputElement;
}

async function openEntryForm(
  document: Document,
  options: WaitOptions,
): Promise<HTMLElement> {
  const existing = document.querySelector<HTMLElement>(
    CHANNEL_SELECTORS.entryForm,
  );
  if (existing) return existing;

  const includeEntry = requiredElement(
    document,
    CHANNEL_SELECTORS.includeEntry,
    'Ação Incluir Novo Apontamento',
  );
  includeEntry.click();
  return waitForCondition(
    () =>
      document.querySelector<HTMLElement>(CHANNEL_SELECTORS.entryForm) ??
      undefined,
    'formulário de apontamento diário',
    options,
  );
}

function resolveProjectFields(
  document: Document,
  form: HTMLElement,
): ProjectFields {
  return {
    projectType: requiredElement(
      document,
      CHANNEL_SELECTORS.projectType,
      'Tipo PROJETOS',
    ),
    project: requiredSelect(document, CHANNEL_SELECTORS.project, 'Projeto'),
    activityType: requiredSelect(
      document,
      CHANNEL_SELECTORS.activityType,
      'Tipo de atividade',
    ),
    activity: requiredSelect(document, CHANNEL_SELECTORS.activity, 'Atividade'),
    task: requiredSelect(document, CHANNEL_SELECTORS.task, 'Tarefa'),
    date: requiredInput(form, CHANNEL_SELECTORS.date, 'Data'),
    duration: requiredInput(form, CHANNEL_SELECTORS.duration, 'Duração'),
  };
}

function existingFormResult(
  fields: ProjectFields,
  assignment: ProjectAssignment,
  requestedDate: string,
): ChannelFillResult {
  const allSelectionsMatch =
    selectedText(fields.project).startsWith(assignment.project) &&
    selectedText(fields.activityType).startsWith(assignment.activityType) &&
    selectedText(fields.activity).startsWith(assignment.activity) &&
    selectedText(fields.task).startsWith(assignment.task);
  if (
    fields.date.value === requestedDate &&
    fields.duration.value === assignment.duration &&
    allSelectionsMatch
  ) {
    return {
      ...result(assignment, 'already-correct'),
      resultingMinutes: assignment.durationMinutes,
    };
  }
  return result(assignment, 'failed', 'entry-form-occupied');
}

function hasOptionPrefix(select: HTMLSelectElement, prefix: string): boolean {
  return [...select.options].some((option) =>
    option.text.trim().startsWith(prefix),
  );
}

function selectedText(select: HTMLSelectElement): string {
  return select.selectedOptions[0]?.text.trim() ?? '';
}

function assertWritablePage(document: Document): void {
  const state = detectChannelPage(document);
  if (state === 'login') {
    throw new ChannelAdapterError(
      'login-required',
      'Autentique-se na aba do Channel.',
    );
  }
  if (state === 'unknown') {
    throw new ChannelAdapterError(
      'not-channel-page',
      'Página do Channel não reconhecida.',
    );
  }
}

function result(
  assignment: ProjectAssignment,
  status: ChannelFillStatus,
  code?: string,
): ChannelFillResult {
  const base = {
    date: assignment.date,
    requestedMinutes: assignment.durationMinutes,
    status,
  };
  return code === undefined ? base : { ...base, code };
}
