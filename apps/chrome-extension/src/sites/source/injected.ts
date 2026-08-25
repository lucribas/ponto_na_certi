import type {
  AhgoraProbeDto,
  InjectedMonthCaptureDto,
  MonthCaptureInput,
} from './contracts';

/**
 * Serialized by chrome.scripting.executeScript. Keep this function entirely
 * self-contained: module constants and imports do not exist in the page frame.
 */
export function probeAhgoraDocument(): AhgoraProbeDto {
  const login = document.getElementById('boxLogin');
  let loginForm: AhgoraProbeDto['loginForm'] = 'absent';
  if (login) {
    const style = globalThis.getComputedStyle(login);
    const hidden =
      login.hasAttribute('hidden') ||
      style.display === 'none' ||
      style.visibility === 'hidden';
    loginForm = hidden ? 'hidden' : 'visible';
  }

  const bodyText = document.body.innerText || document.body.textContent || '';
  return {
    titleMatches: document.title.toLowerCase().includes('ahgora'),
    loginForm,
    mirrorElement: document.getElementById('mirror') !== null,
    monthlySummary: bodyText.includes('MONTHLY SUMMARY'),
  };
}

/**
 * Serialized by chrome.scripting.executeScript. Its helpers deliberately live
 * inside the function so no runtime closure or imported value is required.
 */
export async function captureAhgoraMonthInDocument(
  input: MonthCaptureInput,
): Promise<InjectedMonthCaptureDto> {
  const monthNames = [
    'JANUARY',
    'FEBRUARY',
    'MARCH',
    'APRIL',
    'MAY',
    'JUNE',
    'JULY',
    'AUGUST',
    'SEPTEMBER',
    'OCTOBER',
    'NOVEMBER',
    'DECEMBER',
  ];
  const monthAbbreviations = [
    'JAN',
    'FEB',
    'MAR',
    'APR',
    'MAY',
    'JUN',
    'JUL',
    'AUG',
    'SEP',
    'OCT',
    'NOV',
    'DEC',
  ];
  const match = /^(\d{4})-(\d{2})$/.exec(input.month);
  const targetYear = match ? Number(match[1]) : Number.NaN;
  const targetMonth = match ? Number(match[2]) : Number.NaN;
  const targetName = monthNames[targetMonth - 1];
  const abbreviation = monthAbbreviations[targetMonth - 1];
  if (!targetName || !abbreviation || !Number.isInteger(targetYear)) {
    return { ok: false, code: 'MONTH_BUTTON_NOT_FOUND' };
  }

  const textOf = (element: Element): string =>
    ((element as HTMLElement).innerText || element.textContent || '').trim();
  const bodyText = (): string =>
    document.body.innerText || document.body.textContent || '';
  const buttons = (): HTMLButtonElement[] =>
    Array.from(document.querySelectorAll('button'));
  const waitForButton = (
    predicate: (button: HTMLButtonElement) => boolean,
  ): Promise<HTMLButtonElement | undefined> =>
    new Promise((resolve) => {
      const existing = buttons().find(predicate);
      if (existing) {
        resolve(existing);
        return;
      }

      let settled = false;
      const finish = (value: HTMLButtonElement | undefined): void => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        globalThis.clearTimeout(timer);
        resolve(value);
      };
      const observer = new MutationObserver(() => {
        const value = buttons().find(predicate);
        if (value) finish(value);
      });
      observer.observe(document.body, { childList: true, subtree: true });
      const timer = globalThis.setTimeout(
        () => finish(undefined),
        input.timeoutMs,
      );
    });
  const waitForBodyText = (expected: string): Promise<boolean> =>
    new Promise((resolve) => {
      if (bodyText().includes(expected)) {
        resolve(true);
        return;
      }

      let settled = false;
      const finish = (value: boolean): void => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        globalThis.clearTimeout(timer);
        resolve(value);
      };
      const observer = new MutationObserver(() => {
        if (bodyText().includes(expected)) finish(true);
      });
      observer.observe(document.body, {
        childList: true,
        characterData: true,
        subtree: true,
      });
      const timer = globalThis.setTimeout(() => finish(false), input.timeoutMs);
    });

  const targetLabel = `${targetName}/${String(targetYear)}`;
  const alreadySelected = bodyText().includes(targetLabel);
  if (!alreadySelected) {
    const selector = buttons().find((button) =>
      /^[A-Z]+\/\d{4}/.test(textOf(button)),
    );
    if (!selector) return { ok: false, code: 'MONTH_SELECTOR_NOT_FOUND' };
    selector.click();

    let currentYear = input.navigationYear;
    while (currentYear !== targetYear) {
      const direction =
        currentYear > targetYear ? 'chevron_left' : 'chevron_right';
      const control = await waitForButton(
        (button) => textOf(button) === direction,
      );
      if (!control) return { ok: false, code: 'YEAR_CONTROL_NOT_FOUND' };
      control.click();
      currentYear += currentYear > targetYear ? -1 : 1;
    }

    const monthButton = await waitForButton(
      (button) => textOf(button).toUpperCase() === abbreviation,
    );
    if (!monthButton) return { ok: false, code: 'MONTH_BUTTON_NOT_FOUND' };
    monthButton.click();
    if (!(await waitForBodyText(targetLabel))) {
      return { ok: false, code: 'MONTH_CHANGE_TIMEOUT' };
    }
  }

  const summaryButton = buttons().find((button) =>
    textOf(button).includes('MONTHLY SUMMARY'),
  );
  summaryButton?.click();
  if (!(await waitForBodyText('Horas Trabalhadas'))) {
    return { ok: false, code: 'CALENDAR_LOAD_TIMEOUT' };
  }

  return {
    ok: true,
    selection: alreadySelected ? 'already-selected' : 'changed',
    bodyText: bodyText(),
  };
}
