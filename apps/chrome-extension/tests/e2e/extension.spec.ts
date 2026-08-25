import {
  expect,
  test,
  chromium,
  type BrowserContext,
  type Page,
  type Worker,
} from '@playwright/test';
import { Buffer } from 'node:buffer';
import { resolve } from 'node:path';

interface ExtensionHarness {
  readonly context: BrowserContext;
  readonly serviceWorker: Worker;
  readonly panel: Page;
  readonly source: Page;
  readonly target: Page;
}

async function launchExtension(): Promise<ExtensionHarness> {
  const extensionPath = resolve(import.meta.dirname, '../../dist');
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
  let [serviceWorker] = context.serviceWorkers();
  serviceWorker ??= await context.waitForEvent('serviceworker');
  const extensionId = new URL(serviceWorker.url()).host;
  const source = await context.newPage();
  await source.goto('http://127.0.0.1:4174/tests/fixtures/e2e/ahgora.html');
  const target = await context.newPage();
  await target.goto('http://127.0.0.1:4174/tests/fixtures/e2e/channel.html');
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/src/ui/side-panel.html`);
  await expect(panel.locator('#operation-status')).toHaveText(
    'Registre as duas abas e configure a operação.',
  );
  return { context, serviceWorker, panel, source, target };
}

async function openRulesCard(panel: Page): Promise<void> {
  const card = panel.locator('#rules-card');
  if ((await card.getAttribute('open')) === null) {
    await card.locator(':scope > summary').click();
  }
  await expect(card).toHaveAttribute('open', '');
}

test('bloqueia etapas dependentes da conexão e abre as etapas disponíveis pelos links', async () => {
  const harness = await launchExtension();
  try {
    await harness.panel.setViewportSize({ width: 460, height: 900 });
    const openCards = harness.panel.locator('details.workflow-card[open]');
    await expect(openCards).toHaveCount(1);
    await expect(harness.panel.locator('#login-card')).toHaveAttribute(
      'open',
      '',
    );
    for (const [flowId, cardId] of [
      ['flow-login', 'login-card'],
      ['flow-rules', 'rules-card'],
    ] as const) {
      const link = harness.panel.locator(`#${flowId} a`);
      const card = harness.panel.locator(`#${cardId}`);
      await link.click();
      await expect(card).toHaveAttribute('open', '');
      await expect(link).toHaveAttribute('aria-expanded', 'true');
      await expect(card.locator(':scope > summary')).toBeFocused();
      await expect(openCards).toHaveCount(1);
    }
    for (const [flowId, cardId] of [
      ['flow-capture', 'capture-card'],
      ['flow-review', 'review-card'],
      ['flow-send', 'send-card'],
    ] as const) {
      const link = harness.panel.locator(`#${flowId} a`);
      const card = harness.panel.locator(`#${cardId}`);
      await expect(link).toHaveAttribute('aria-disabled', 'true');
      await expect(link).toHaveAttribute('tabindex', '-1');
      await expect(card).toHaveAttribute('inert', '');
      await expect(card).toHaveAttribute('aria-disabled', 'true');
      await link.dispatchEvent('click');
      await expect(card).not.toHaveAttribute('open', '');
      await card
        .locator(':scope > summary')
        .evaluate((summary: HTMLElement) => {
          summary.click();
        });
      await expect(card).not.toHaveAttribute('open', '');
      await expect(harness.panel.locator('#rules-card')).toHaveAttribute(
        'open',
        '',
      );
    }
  } finally {
    await harness.context.close();
  }
});

test('carrega duas páginas sintéticas/iframe e mantém a prévia inicialmente vazia', async () => {
  const harness = await launchExtension();
  try {
    const now = new Date();
    const currentMonth = `${String(now.getFullYear())}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    await expect(harness.panel.locator('#period-kind')).toHaveValue('month');
    expect(
      await harness.panel.locator('#period-kind option').allTextContents(),
    ).toEqual(['Mês atual', 'Mês anterior', 'Intervalo inclusivo']);
    await expect(harness.panel.locator('#month')).toHaveValue(currentMonth);
    await expect(
      harness.panel.getByRole('button', {
        name: 'Detectar abas ou abrir logins',
      }),
    ).toBeVisible();
    await expect(harness.panel.locator('#login-calendar-state')).toHaveText(
      'Não conectado',
    );
    await expect(harness.panel.locator('#login-calendar-status')).toHaveCount(
      0,
    );
    await expect(harness.panel.locator('#capture-card')).toHaveAttribute(
      'inert',
      '',
    );
    await harness.panel
      .locator('#capture-card > summary')
      .evaluate((summary: HTMLElement) => {
        summary.click();
      });
    await expect(harness.panel.locator('#calendar-progress-state')).toHaveText(
      'Configuração pendente',
    );
    await expect(harness.panel.locator('#calendar-progress-detail')).toHaveText(
      'Google Calendar ativado, mas ainda não conectado.',
    );
    await expect(harness.panel.locator('#capture')).toBeDisabled();
    const overrides = harness.panel.locator('.operation-overrides');
    await expect(overrides).not.toHaveAttribute('open', '');
    await expect(harness.panel.locator('#overrides')).toBeHidden();
    await expect(harness.panel.locator('#capture-card')).not.toHaveAttribute(
      'open',
      '',
    );
    await expect(harness.panel.locator('#login-card')).toHaveAttribute(
      'open',
      '',
    );
    await expect(harness.panel.locator('#month-field')).toBeHidden();
    await openRulesCard(harness.panel);
    await expect(harness.panel.locator('#capture-card')).not.toHaveAttribute(
      'open',
      '',
    );
    await harness.serviceWorker.evaluate(() => {
      const scope = globalThis as typeof globalThis & {
        catalogRefreshRequests?: number;
      };
      scope.catalogRefreshRequests = 0;
      chrome.runtime.onMessage.addListener((message: unknown) => {
        if (
          typeof message === 'object' &&
          message !== null &&
          'type' in message &&
          message.type === 'FETCH_CHANNEL_CATALOG'
        )
          scope.catalogRefreshRequests =
            (scope.catalogRefreshRequests ?? 0) + 1;
      });
    });
    const openConfig = harness.panel.locator('#open-config-dialog');
    await openConfig.click();
    await expect(harness.panel.locator('#config-dialog')).toBeVisible();
    await expect(harness.panel.locator('#config-dialog-title')).toBeFocused();
    await expect
      .poll(() =>
        harness.serviceWorker.evaluate(
          () =>
            (
              globalThis as typeof globalThis & {
                catalogRefreshRequests?: number;
              }
            ).catalogRefreshRequests ?? 0,
        ),
      )
      .toBe(1);
    await harness.panel.keyboard.press('Escape');
    await expect(harness.panel.locator('#config-dialog')).toBeHidden();
    await expect(openConfig).toBeFocused();
    await harness.panel.locator('#login-card > summary').click();
    await expect(harness.source.locator('#mirror')).toBeVisible();
    await expect(
      harness.source.frameLocator('#mirror').getByText('Horas Trabalhadas'),
    ).toBeVisible();
    await expect(
      harness.target.getByRole('heading', { name: 'Channel sintético' }),
    ).toBeVisible();
    await seedPreview(harness.serviceWorker);
    await harness.panel.reload();
    await expect(harness.panel.locator('#font-scale')).toHaveText('130%');

    await expect(
      harness.panel.getByRole('heading', { name: 'Ponto na Certi' }),
    ).toBeVisible();
    await expect(harness.panel.locator('.hero-logo')).toBeVisible();
    await expect(
      harness.panel.getByRole('heading', {
        name: '1. Abrir, autenticar e conectar',
      }),
    ).toBeVisible();
    await expect(
      harness.panel.getByRole('heading', {
        name: '2. Regras',
      }),
    ).toBeVisible();
    await expect(
      harness.panel.getByRole('heading', {
        name: '3. Capturar e comparar',
      }),
    ).toBeVisible();
    await expect(
      harness.panel.getByRole('heading', {
        name: '4. Revisar apontamentos',
      }),
    ).toBeVisible();
    await expect(
      harness.panel.getByRole('heading', { name: '5. Enviar ao Channel' }),
    ).toBeVisible();
    await expect(harness.panel.locator('#login-card')).not.toHaveAttribute(
      'open',
      '',
    );
    await expect(harness.panel.locator('#login-summary')).toHaveText(
      'Concluído',
    );
    for (const cardId of ['capture-card', 'review-card', 'send-card']) {
      await expect(harness.panel.locator(`#${cardId}`)).not.toHaveAttribute(
        'inert',
        '',
      );
      await expect(
        harness.panel.locator(`.flow-overview a[aria-controls="${cardId}"]`),
      ).not.toHaveAttribute('aria-disabled', 'true');
    }
    await expect(harness.panel.locator('#flow-login')).toHaveClass(/done/);
    await expect(harness.panel.locator('#flow-review')).toHaveClass(/current/);
    await harness.panel.locator('#login-card > summary').click();
    await expect(harness.panel.locator('#login-card')).toHaveAttribute(
      'open',
      '',
    );
    await expect(harness.panel.locator('#manual-registration')).toBeHidden();
    await expect(harness.panel.locator('#ahgora-progress')).toHaveAttribute(
      'value',
      '0',
    );
    await expect(harness.panel.locator('#channel-progress')).toHaveAttribute(
      'value',
      '0',
    );
    await expect(harness.panel.locator('#comparison-progress')).toHaveAttribute(
      'value',
      '0',
    );
    await expect(
      harness.panel.locator('#login-source-progress'),
    ).toHaveAttribute('value', '0');
    await expect(
      harness.panel.locator('#login-target-progress'),
    ).toHaveAttribute('value', '0');
    await expect(harness.panel.locator('#write-progress')).toHaveAttribute(
      'value',
      '0',
    );
    await expect(harness.panel.locator('#month-field')).toBeHidden();
    await expect(harness.panel.locator('#start-field')).toBeHidden();
    await expect(harness.panel.locator('#end-field')).toBeHidden();
    await harness.panel.locator('#capture-card > summary').click();
    await overrides
      .getByText('Overrides desta operação', { exact: true })
      .click();
    await expect(harness.panel.locator('#overrides')).toBeVisible();
    await harness.panel.locator('#period-kind').selectOption('month');
    await expect(harness.panel.locator('#month-field')).toBeVisible();
    await expect(harness.panel.locator('#start-field')).toBeHidden();
    await expect(harness.panel.locator('#end-field')).toBeHidden();
    await harness.panel.locator('#period-kind').selectOption('range');
    await expect(harness.panel.locator('#month-field')).toBeHidden();
    await expect(harness.panel.locator('#start-field')).toBeVisible();
    await expect(harness.panel.locator('#end-field')).toBeVisible();
    await harness.panel.locator('#period-kind').selectOption('default');
    await harness.panel.locator('#review-card > summary').click();
    await expect(
      harness.panel.getByRole('heading', { name: '5. Enviar ao Channel' }),
    ).toBeVisible();
    await expect(
      harness.panel.getByRole('checkbox', { name: /2026-07-26/ }),
    ).not.toBeChecked();
    const updatableRow = harness.panel
      .getByRole('listitem')
      .filter({ hasText: '26/07/2026' });
    await expect(updatableRow).toHaveClass(/status-updatable/);
    const equalRow = harness.panel
      .getByRole('listitem')
      .filter({ hasText: 'Já igual' });
    await expect(equalRow).toBeVisible();
    await expect(equalRow.locator('input[type="checkbox"]')).toHaveCount(0);
    await expect(equalRow).not.toContainText('Channel · Projeto:');
    await expect(equalRow).toContainText('Marcação 1 · 05:00');
    await expect(equalRow).toContainText(
      'Projeto: PROJETO PADRÃO · Atividade: ATIVIDADE PADRÃO',
    );
    await expect(equalRow).toContainText('Marcação 2 · 03:00');
    await expect(equalRow).toContainText(
      'Projeto: PROJETO SECUNDÁRIO · Atividade: ATIVIDADE SECUNDÁRIA',
    );
    const deleteEqual = equalRow.getByRole('button', {
      name: /Excluir marcação 05:00/,
    });
    const deleteSecondary = equalRow.getByRole('button', {
      name: /Excluir marcação 03:00/,
    });
    await expect(deleteEqual).toBeVisible();
    await expect(deleteSecondary).toBeVisible();
    const divergentRow = harness.panel
      .getByRole('listitem')
      .filter({ hasText: 'Divergente' });
    await expect(divergentRow).toHaveClass(/status-divergent/);
    await expect(
      divergentRow.getByRole('button', { name: /Excluir marcação 07:30/ }),
    ).toBeVisible();
    await expect(
      divergentRow.getByRole('button', { name: /Editar saldo restante/ }),
    ).toBeVisible();
    await expect(
      harness.panel.getByRole('listitem').filter({ hasText: 'Bloqueado' }),
    ).toHaveClass(/status-error/);
    await expect(
      harness.panel.getByRole('listitem').filter({ hasText: 'Bloqueado' }),
    ).toContainText(
      'Bloqueado · Dia omitido; revise as batidas: 08:00, 12:00, 13:00.',
    );
    await expect(
      harness.panel.getByRole('button', { name: 'Enviar selecionados' }),
    ).toBeHidden();
    await expect(harness.panel.locator('#total-captured')).toHaveText(
      '08:00 · 1 registro',
    );
    await expect(harness.panel.locator('#total-review')).toHaveText(
      '08:00 · 1 item',
    );
    await expect(harness.panel.locator('#total-selected')).toHaveText(
      '00:00 · 0 itens',
    );

    const itemCheckbox = harness.panel.getByRole('checkbox', {
      name: /2026-07-26/,
    });
    const itemTag = harness.panel.getByRole('combobox', {
      name: /TAG da marcação 1 para 2026-07-26/,
    });
    const firstMarking = updatableRow.getByRole('group', {
      name: /Marcação 1/,
    });
    const editorActions = updatableRow.locator('.item-editor-actions');
    await expect(editorActions.getByRole('button')).toHaveText([
      'Enviar este dia',
      'Salvar como template…',
    ]);
    await expect(itemTag).toHaveValue('tag-default');
    await expect(itemTag.locator('option').first()).toContainText('Padrão');
    const sourceSelect = harness.panel.getByRole('combobox', {
      name: /Origem da marcação 1 para 2026-07-26/,
    });
    await expect(sourceSelect).toHaveValue('tags');
    await sourceSelect.selectOption('reunioes-por-area');
    const ragCombobox = firstMarking.getByRole('combobox', {
      name: 'Marcação',
      exact: true,
    });
    await expect(ragCombobox).toBeVisible();
    await expect(
      firstMarking.getByRole('searchbox', { name: 'Filtrar opções' }),
    ).toHaveCount(0);
    await ragCombobox.fill('Lightning Talk');
    const ragListbox = firstMarking.getByRole('listbox', {
      name: 'Marcação',
    });
    await expect(ragListbox).toBeVisible();
    await expect(
      ragListbox.getByRole('option', { name: 'Lightning Talk — Avulso' }),
    ).toBeVisible();
    await expect(
      ragListbox.getByRole('option', { name: /CERTI Informa/ }),
    ).toHaveCount(0);
    await ragCombobox.press('ArrowDown');
    await ragCombobox.press('Enter');
    await expect(firstMarking).toContainText(
      'Destino: Avulso · CERTI · 13. Formação/Capacitação',
    );
    await expect(
      firstMarking.getByText('TAG que fornece projeto/atividade'),
    ).toHaveCount(0);
    await sourceSelect.selectOption('tags');
    await expect(itemTag).toBeVisible();
    await itemTag.selectOption('tag-secondary');
    await expect(itemTag).toHaveValue('tag-secondary');

    await expect(
      firstMarking.getByRole('radiogroup', { name: 'Dividir por' }),
    ).toBeVisible();
    await expect(
      firstMarking.getByRole('radio', { name: 'Percentual' }),
    ).toBeChecked();
    const firstPercentageSlider = firstMarking.getByRole('slider', {
      name: /Ajustar percentual da marcação 1/,
    });
    await expect(firstPercentageSlider).toHaveAttribute('min', '0');
    await expect(firstPercentageSlider).toHaveAttribute('max', '100');
    await expect(firstPercentageSlider).toHaveValue('100');
    await expect(firstMarking.locator('.allocation-slider-labels')).toHaveText(
      '0%25%50%75%100%',
    );
    await firstMarking.getByRole('radio', { name: 'Duração' }).check();
    await expect(firstPercentageSlider).toHaveCount(0);
    const firstDurationInput = firstMarking.getByRole('textbox', {
      name: /Duração.*marcação 1/,
    });
    const firstDurationSlider = firstMarking.getByRole('slider', {
      name: /Ajustar duração da marcação 1/,
    });
    await expect(firstDurationSlider).toHaveAttribute('min', '0');
    await expect(firstDurationSlider).toHaveAttribute('max', '480');
    await expect(firstDurationSlider).toHaveValue('480');
    await expect(firstMarking.locator('.allocation-duration-scale')).toHaveText(
      '00:0001:0002:0003:0004:0005:0006:0007:0008:00',
    );
    await firstDurationSlider.evaluate((slider: HTMLInputElement) => {
      slider.value = '210';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect(firstDurationInput).toHaveValue('03:30');
    await firstDurationInput.fill('03:00');
    await expect(firstDurationSlider).toHaveValue('180');
    await firstDurationInput.press('Tab');
    await expect(updatableRow.getByRole('group')).toHaveCount(2);
    await expect(updatableRow.getByText('Saldo restante')).toBeVisible();
    await expect(updatableRow).toContainText('05:00 · 62.5% do dia');
    await expect(
      updatableRow.getByRole('textbox', { name: /Duração.*marcação 2/ }),
    ).toHaveValue('05:00');
    await expect(
      updatableRow.getByRole('combobox', {
        name: /TAG da marcação 2 para 2026-07-26/,
      }),
    ).toHaveValue('tag-default');

    const secondMarking = updatableRow.getByRole('group', {
      name: /Marcação 2/,
    });
    await expect(
      secondMarking.locator('.allocation-duration-scale'),
    ).toHaveText('00:0000:3001:0001:3002:0002:3003:0003:3004:0004:3005:00');
    await secondMarking.getByRole('radio', { name: 'Percentual' }).check();
    const secondPercentageInput = secondMarking.getByRole('textbox', {
      name: /Percentual.*marcação 2/,
    });
    const secondPercentageSlider = secondMarking.getByRole('slider', {
      name: /Ajustar percentual da marcação 2/,
    });
    await secondPercentageSlider.evaluate((slider: HTMLInputElement) => {
      slider.value = '30';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect(secondPercentageInput).toHaveValue('30');
    await secondPercentageInput.fill('25');
    await expect(secondPercentageSlider).toHaveValue('25');
    await secondPercentageInput.press('Tab');
    await expect(updatableRow.getByRole('group')).toHaveCount(3);
    await expect(updatableRow).toContainText('03:00 · 37.5% do dia');
    await expect(
      updatableRow.getByRole('textbox', { name: /Percentual.*marcação 3/ }),
    ).toHaveValue('37.5');
    await expect(updatableRow).toContainText(
      '3 marcações · Total 08:00 · Distribuído 08:00 · Falta 00:00',
    );
    await expect(
      harness.panel.getByRole('button', { name: 'Selecionar restantes' }),
    ).toBeVisible();
    await expect(harness.panel.locator('#review-actions')).toBeVisible();
    await itemCheckbox.check();
    await expect(harness.panel.locator('#flow-review')).toHaveClass(/done/);
    await expect(harness.panel.locator('#flow-send')).toHaveClass(/current/);
    await expect(harness.panel.locator('#total-selected')).toHaveText(
      '08:00 · 1 item',
    );
    await expect(
      harness.panel.getByRole('button', { name: 'Selecionar restantes' }),
    ).toBeHidden();
    await expect(harness.panel.locator('#review-actions')).toBeHidden();
    await expect(
      harness.panel.locator('#review-actions #select-remaining'),
    ).toBeHidden();
    await expect(
      harness.panel.getByRole('button', { name: /Recusar|Recusado/ }),
    ).toHaveCount(0);
    await harness.panel.locator('#send-card > summary').click();
    await expect(
      harness.panel.getByRole('button', { name: 'Enviar selecionados' }),
    ).toBeEnabled();
    await expect(harness.panel.locator('#send-actions')).toBeVisible();
    await expect(harness.panel.locator('#send-actions #apply')).toBeVisible();
    await expect(harness.panel.locator('#review-card')).not.toHaveAttribute(
      'open',
      '',
    );
    await harness.panel.locator('#review-card > summary').click();
    await itemCheckbox.uncheck();
    await expect(harness.panel.locator('#total-selected')).toHaveText(
      '00:00 · 0 itens',
    );
    await expect(itemCheckbox).not.toBeChecked();
    await expect(
      harness.panel.getByRole('button', { name: 'Enviar selecionados' }),
    ).toBeHidden();

    await harness.serviceWorker.evaluate(async () => {
      const stored = await chrome.storage.session.get('operationData');
      const operation = stored.operationData as {
        items: Array<Record<string, unknown>>;
      };
      await chrome.storage.session.set({
        operationData: {
          ...operation,
          phase: 'completed',
          queue: ['2026-07-26'],
          queueIndex: 1,
          items: operation.items.map((item) =>
            item.id === '2026-07-26'
              ? {
                  ...item,
                  decision: 'selected',
                  result: 'filled',
                  channelDuration: '08:00',
                }
              : item,
          ),
          writeProgress: {
            status: 'done',
            completedItems: 1,
            totalItems: 1,
            detail: '1 de 1 apontamento enviado e confirmado pelo Channel.',
          },
        },
      });
    });
    await harness.panel.reload();
    await harness.panel.locator('#review-card > summary').click();
    const confirmedRow = harness.panel
      .getByRole('listitem')
      .filter({ hasText: '26/07/2026' });
    await expect(confirmedRow).toHaveClass(/status-success/);
    await expect(confirmedRow).toContainText('Já igual');
    await expect(confirmedRow).toContainText('Enviado e confirmado');
    await expect(harness.panel.locator('#preview-status')).toHaveClass(
      /success/,
    );
    await expect(harness.panel.locator('#preview-status')).toContainText(
      'Envio concluído com sucesso',
    );
    for (const buttonName of [
      'Selecionar restantes',
      'Enviar selecionados',
      'Cancelar operação',
    ])
      await expect(
        harness.panel.getByRole('button', { name: buttonName }),
      ).toBeHidden();
    await expect(harness.panel.locator('button[type="submit"]')).toHaveCount(0);
  } finally {
    await harness.context.close();
  }
});

test('exclui uma marcação diária sem abrir diálogo de confirmação', async () => {
  const harness = await launchExtension();
  try {
    await seedPreview(harness.serviceWorker);
    await harness.panel.reload();
    await harness.panel.locator('#review-card > summary').click();
    const remove = harness.panel.getByRole('button', {
      name: /Excluir marcação 05:00/,
    });
    let dialogMessage: string | undefined;
    harness.panel.on('dialog', async (dialog) => {
      dialogMessage = dialog.message();
      await dialog.dismiss();
    });

    await remove.click();
    await harness.panel.evaluate(() => Promise.resolve());

    expect(dialogMessage).toBeUndefined();
  } finally {
    await harness.context.close();
  }
});

test('expande a revisão automaticamente ao concluir a captura', async () => {
  const harness = await launchExtension();
  try {
    await seedPreview(harness.serviceWorker);
    await harness.panel.reload();
    await harness.panel.locator('#capture-card > summary').click();
    await expect(harness.panel.locator('#capture-card')).toHaveAttribute(
      'open',
      '',
    );
    await expect(harness.panel.locator('#review-card')).not.toHaveAttribute(
      'open',
      '',
    );
    await harness.panel.evaluate(async () => {
      const runtime = chrome.runtime as unknown as {
        sendMessage: (
          message: Record<string, unknown>,
        ) => Promise<Record<string, unknown>>;
      };
      const original = runtime.sendMessage.bind(runtime);
      const current = await original({ type: 'GET_STATE' });
      runtime.sendMessage = async (message) =>
        message.type === 'CAPTURE_AND_COMPARE' ? current : original(message);
    });

    await harness.panel
      .getByRole('button', { name: 'Capturar e comparar' })
      .click();

    await expect(harness.panel.locator('#review-card')).toHaveAttribute(
      'open',
      '',
    );
    await expect(harness.panel.locator('#capture-card')).not.toHaveAttribute(
      'open',
      '',
    );
  } finally {
    await harness.context.close();
  }
});

test('entra no modo de edição de um dia divergente usando somente o saldo restante', async () => {
  const harness = await launchExtension();
  try {
    await seedPreview(harness.serviceWorker);
    await harness.serviceWorker.evaluate(async () => {
      const stored = await chrome.storage.session.get('operationData');
      const operation = stored.operationData as {
        sourceRows: Array<Record<string, unknown>>;
      };
      await chrome.storage.session.set({
        operationData: {
          ...operation,
          sourceRows: [
            ...operation.sourceRows,
            {
              date: '2026-07-28',
              duration: '08:00',
              durationMinutes: 480,
            },
          ],
        },
      });
    });
    await harness.panel.reload();
    await harness.panel.locator('#review-card > summary').click();
    const row = harness.panel
      .getByRole('listitem')
      .filter({ hasText: '28/07/2026' });

    await row.getByRole('button', { name: /Editar saldo restante/ }).click();

    await expect(row).toHaveClass(/status-updatable/);
    await expect(row).toContainText(
      'Editando saldo restante de 00:30 · Channel 07:30',
    );
    await expect(row.getByRole('group', { name: /Marcação 1/ })).toContainText(
      '00:30 · 100% do saldo',
    );
    await expect(
      row.getByRole('combobox', {
        name: /TAG da marcação 1 para 2026-07-28/,
      }),
    ).toHaveValue('tag-default');
    await expect(row).toContainText(
      '1 marcação · Saldo 00:30 · Distribuído 00:30 · Falta 00:00',
    );
    const remainingMarking = row.getByRole('group', { name: /Marcação 1/ });
    await remainingMarking.getByRole('radio', { name: 'Duração' }).check();
    await expect(
      remainingMarking.locator('.allocation-duration-scale'),
    ).toHaveText('00:0000:1000:2000:30');
    await expect(
      row.getByRole('button', {
        name: 'Enviar marcações de 2026-07-28 ao Channel',
      }),
    ).toBeVisible();
    await harness.panel.locator('#send-card > summary').click();
    await expect(
      harness.panel.getByRole('button', { name: 'Enviar selecionados' }),
    ).toBeVisible();
    await expect(harness.panel.locator('#total-selected')).toHaveText(
      '00:30 · 1 item',
    );
  } finally {
    await harness.context.close();
  }
});

test('persiste o tema e oferece tutorial, versão e convite de contribuição acessíveis', async () => {
  const harness = await launchExtension();
  try {
    const manifestVersion = await harness.panel.evaluate(
      () => chrome.runtime.getManifest().version,
    );
    await expect(harness.panel.locator('#extension-version')).toHaveText(
      `v${manifestVersion}`,
    );

    const theme = harness.panel.getByRole('button', {
      name: 'Ativar tema escuro',
    });
    const themeControl = harness.panel.locator('#theme-toggle');
    await expect(theme).toHaveAttribute('aria-pressed', 'false');
    await expect(themeControl.locator('.theme-moon-icon')).toBeVisible();
    await expect(themeControl.locator('.theme-sun-icon')).toBeHidden();
    await theme.click();
    await expect(harness.panel.locator('html')).toHaveAttribute(
      'data-theme',
      'dark',
    );
    await expect(
      harness.panel.getByRole('button', { name: 'Ativar tema claro' }),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(themeControl.locator('.theme-moon-icon')).toBeHidden();
    await expect(themeControl.locator('.theme-sun-icon')).toBeVisible();
    await harness.panel.reload();
    await expect(harness.panel.locator('html')).toHaveAttribute(
      'data-theme',
      'dark',
    );

    await harness.panel.getByRole('button', { name: 'Ajuda' }).click();
    const help = harness.panel.getByRole('dialog', { name: 'Como funciona' });
    await expect(help).toBeVisible();
    await expect(help.locator('.tutorial-steps > li')).toHaveCount(6);
    await expect(help.getByText('Capture e compare')).toBeVisible();
    await expect(
      help.getByRole('link', { name: 'Solicitar recurso' }),
    ).toHaveAttribute(
      'href',
      'https://github.com/lucribas/ponto_na_certi/issues/new',
    );
    await expect(
      help.getByRole('link', { name: 'Ver projeto no GitHub' }),
    ).toHaveAttribute('href', 'https://github.com/lucribas/ponto_na_certi');
    await expect(help.locator('.contribution-card img')).toHaveJSProperty(
      'naturalWidth',
      768,
    );
    await help.getByRole('button', { name: 'Fechar ajuda' }).click();
    await expect(help).toBeHidden();

    await harness.panel
      .getByRole('button', {
        name: 'Conheça o projeto e ajude no desenvolvimento',
      })
      .click();
    const support = harness.panel.getByRole('dialog', {
      name: 'Ajude no desenvolvimento',
    });
    await expect(support).toBeVisible();
    await expect(
      support.getByRole('link', { name: 'Quero contribuir' }),
    ).toHaveAttribute('href', 'https://github.com/lucribas/ponto_na_certi');
    await expect(
      support.getByRole('link', { name: 'Sugerir uma melhoria' }),
    ).toHaveAttribute(
      'href',
      'https://github.com/lucribas/ponto_na_certi/issues/new',
    );
  } finally {
    await harness.context.close();
  }
});

test('monitoramento do almoço nasce desligado e reflete a preferência persistida', async () => {
  const harness = await launchExtension();
  try {
    const checkbox = harness.panel.getByRole('switch', {
      name: 'Monitorar almoço',
    });
    await expect(checkbox).not.toBeChecked();
    await expect(
      harness.panel.locator('#lunch-monitor-description'),
    ).toHaveText('Desativado · alertas às 12:30, 13:00, 13:30 e 14:00.');

    await harness.panel.evaluate(async () => {
      const stored = await chrome.storage.local.get('extensionSettings');
      await chrome.storage.local.set({
        extensionSettings: {
          ...(stored.extensionSettings ?? {
            version: 1,
            tags: [],
            fontScale: 1.3,
          }),
          punchAlerts: { enabled: true },
        },
      });
    });
    await expect(checkbox).toBeChecked();
    await expect(
      harness.panel.locator('#lunch-monitor-description'),
    ).toHaveText('Ativo · verificações às 12:30, 13:00, 13:30 e 14:00.');

    await harness.panel.reload();
    await expect(
      harness.panel.getByRole('switch', { name: 'Monitorar almoço' }),
    ).toBeChecked();
    await harness.panel.setViewportSize({ width: 360, height: 900 });
    expect(
      await harness.panel.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
  } finally {
    await harness.context.close();
  }
});

test('nova operação preserva conexões concluídas e limpa somente o trabalho anterior', async () => {
  const harness = await launchExtension();
  try {
    await seedPreview(harness.serviceWorker);
    await harness.serviceWorker.evaluate(async () => {
      const stored = await chrome.storage.session.get('operationData');
      const operation = stored.operationData as Record<string, unknown>;
      await chrome.storage.session.set({
        operationData: {
          ...operation,
          phase: 'completed',
          loginPreparation: {
            ahgora: 'ready',
            channel: 'ready',
            ahgoraDetail: 'Ahgora conectado.',
            channelDetail: 'Channel conectado.',
            autoSubmit: true,
            sourceTabId: 1,
            targetTabId: 2,
          },
        },
      });
    });
    await harness.panel.reload();
    await expect(harness.panel.locator('#login-summary')).toHaveText(
      'Concluído',
    );

    await harness.panel.getByRole('button', { name: 'Nova operação' }).click();

    await expect(harness.panel.locator('#login-summary')).toHaveText(
      'Concluído',
    );
    await expect(harness.panel.locator('#login-card')).not.toHaveAttribute(
      'open',
      '',
    );
    await expect(harness.panel.locator('#operation-status')).toContainText(
      'conexões Ahgora e Channel preservadas',
    );
    await expect(harness.panel.locator('#preview')).toBeEmpty();
    const persisted = await harness.serviceWorker.evaluate(async () => {
      const stored = await chrome.storage.session.get('operationData');
      return stored.operationData as {
        operationId: string;
        phase: string;
        sourceTab: { id: number; origin: string };
        targetTab: { id: number; origin: string };
        items: unknown[];
        queue: unknown[];
        queueIndex: number;
      };
    });
    expect(persisted).toMatchObject({
      phase: 'setup',
      sourceTab: { id: 1, origin: 'http://127.0.0.1:4174' },
      targetTab: { id: 2, origin: 'http://127.0.0.1:4174' },
      items: [],
      queue: [],
      queueIndex: 0,
    });
    expect(persisted.operationId).not.toBe('e2e-operation');
  } finally {
    await harness.context.close();
  }
});

test('avisa e bloqueia operações quando as abas registradas são fechadas', async () => {
  const harness = await launchExtension();
  try {
    await harness.source.bringToFront();
    const sourceTabId = await harness.serviceWorker.evaluate(
      async () => (await chrome.tabs.query({ active: true }))[0]?.id,
    );
    await harness.target.bringToFront();
    const targetTabId = await harness.serviceWorker.evaluate(
      async () => (await chrome.tabs.query({ active: true }))[0]?.id,
    );
    await harness.panel.bringToFront();
    await harness.serviceWorker.evaluate(
      async (tabIds) => {
        const stored = await chrome.storage.session.get('operationData');
        const operation = stored.operationData as Record<string, unknown>;
        if (tabIds.source === undefined || tabIds.target === undefined)
          throw new Error('Abas sintéticas não encontradas.');
        await chrome.storage.session.set({
          operationData: {
            ...operation,
            revision: 1,
            sourceTab: {
              id: tabIds.source,
              origin: 'http://127.0.0.1:4174',
            },
            targetTab: {
              id: tabIds.target,
              origin: 'http://127.0.0.1:4174',
            },
            loginPreparation: {
              ahgora: 'ready',
              channel: 'ready',
              ahgoraDetail: 'Ahgora conectado.',
              channelDetail: 'Channel conectado.',
              autoSubmit: true,
              sourceTabId: tabIds.source,
              targetTabId: tabIds.target,
            },
          },
        });
      },
      { source: sourceTabId, target: targetTabId },
    );
    await harness.panel.reload();
    await expect(harness.panel.locator('#login-summary')).toHaveText(
      'Pendente',
    );
    await expect(harness.panel.locator('#connection-alert')).toBeHidden();

    await harness.source.close();

    const alert = harness.panel.locator('#connection-alert');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('A aba do Ahgora foi fechada');
    await expect(
      alert.getByRole('button', { name: 'Reconectar agora' }),
    ).toBeVisible();
    await expect(harness.panel.locator('#login-card')).toHaveAttribute(
      'open',
      '',
    );
    await expect(harness.panel.locator('#login-summary')).toHaveText(
      'Pendente',
    );
    await expect(harness.panel.locator('#login-source-state')).toHaveText(
      'Reconexão necessária',
    );
    await expect(harness.panel.locator('#login-source-detail')).toContainText(
      'foi fechada',
    );
    await expect(harness.panel.locator('#capture')).toBeDisabled();

    const afterSourceClosed = await harness.serviceWorker.evaluate(async () => {
      const stored = await chrome.storage.session.get('operationData');
      return stored.operationData as Record<string, unknown>;
    });
    expect(afterSourceClosed).not.toHaveProperty('sourceTab');
    expect(afterSourceClosed).toHaveProperty('targetTab');
    expect(afterSourceClosed.tabConnectionIssues).toEqual([
      { role: 'source', reason: 'closed' },
    ]);

    await harness.target.close();

    await expect(alert).toContainText(
      'As abas do Ahgora e do Channel não estão mais conectadas',
    );
    const afterBothClosed = await harness.serviceWorker.evaluate(async () => {
      const stored = await chrome.storage.session.get('operationData');
      return stored.operationData as Record<string, unknown>;
    });
    expect(afterBothClosed).not.toHaveProperty('sourceTab');
    expect(afterBothClosed).not.toHaveProperty('targetTab');
    expect(afterBothClosed.tabConnectionIssues).toEqual([
      { role: 'source', reason: 'closed' },
      { role: 'target', reason: 'closed' },
    ]);
  } finally {
    await harness.context.close();
  }
});

test('explica a permissão recusada e oferece nova tentativa', async () => {
  const harness = await launchExtension();
  try {
    await harness.serviceWorker.evaluate(async () => {
      const stored = await chrome.storage.session.get('operationData');
      const operation = stored.operationData as Record<string, unknown>;
      await chrome.storage.session.set({
        operationData: {
          ...operation,
          revision: 1,
          loginPreparation: {
            ahgora: 'awaiting-user',
            channel: 'awaiting-user',
            ahgoraDetail:
              'Permissão recusada. Faça login manualmente ou tente concedê-la novamente.',
            channelDetail:
              'Permissão recusada. Faça login manualmente ou tente concedê-la novamente.',
            autoSubmit: false,
            permissionDenied: true,
          },
        },
      });
    });
    await harness.panel.reload();

    await expect(
      harness.panel.getByRole('button', {
        name: 'Permitir acesso e tentar novamente',
      }),
    ).toBeVisible();
    await expect(harness.panel.locator('#login-permission-hint')).toContainText(
      'é necessária',
    );
    await expect(harness.panel.locator('#login-summary')).toHaveText(
      'Pendente',
    );
    await expect(
      harness.panel.locator('#login-source-progress'),
    ).toHaveAttribute('value', '50');
    await expect(
      harness.panel.locator('#login-target-progress'),
    ).toHaveAttribute('value', '50');

    await harness.serviceWorker.evaluate(async () => {
      const stored = await chrome.storage.session.get('operationData');
      const operation = stored.operationData as {
        loginPreparation: Record<string, unknown>;
      };
      await chrome.storage.session.set({
        operationData: {
          ...operation,
          loginPreparation: {
            ...operation.loginPreparation,
            autoSubmit: true,
            permissionDenied: false,
          },
        },
      });
    });
    await harness.panel.reload();
    await expect(
      harness.panel.getByRole('button', {
        name: 'Verificar logins novamente',
      }),
    ).toBeVisible();
  } finally {
    await harness.context.close();
  }
});

test('permite parar login, captura e envio somente enquanto estão em execução', async () => {
  const harness = await launchExtension();
  try {
    await seedPreview(harness.serviceWorker);
    await harness.serviceWorker.evaluate(async () => {
      const stored = await chrome.storage.session.get('operationData');
      const operation = stored.operationData as Record<string, unknown>;
      await chrome.storage.session.set({
        operationData: {
          ...operation,
          revision: Number(operation.revision) + 1,
          phase: 'capturing',
          inFlight: 'capture',
          captureProgress: {
            ahgora: { status: 'running', detail: 'Consultando Ahgora…' },
            channel: { status: 'waiting', detail: 'Aguardando Ahgora.' },
            comparison: { status: 'waiting', detail: 'Aguardando fontes.' },
          },
        },
      });
    });
    await harness.panel.reload();
    await harness.panel.locator('#capture-card > summary').click();
    await expect(
      harness.panel.getByRole('button', { name: 'Parar captura' }),
    ).toBeVisible();
    await harness.panel.getByRole('button', { name: 'Parar captura' }).click();
    await expect(harness.panel.locator('#ahgora-progress-state')).toHaveText(
      'Interrompido',
    );
    await expect(
      harness.panel.locator('#comparison-progress-state'),
    ).toHaveText('Interrompido');
    await expect(
      harness.panel.getByRole('button', { name: 'Parar captura' }),
    ).toBeHidden();

    await harness.serviceWorker.evaluate(async () => {
      const stored = await chrome.storage.session.get('operationData');
      const operation = stored.operationData as Record<string, unknown>;
      await chrome.storage.session.set({
        operationData: {
          ...operation,
          revision: Number(operation.revision) + 1,
          phase: 'preview',
          inFlight: 'apply',
          writeProgress: {
            status: 'running',
            completedItems: 1,
            totalItems: 3,
            detail: 'Enviando a segunda marcação…',
          },
        },
      });
    });
    await harness.panel.reload();
    await harness.panel.locator('#send-card > summary').click();
    await expect(
      harness.panel.getByRole('button', { name: 'Parar envio' }),
    ).toBeVisible();
    await harness.panel.getByRole('button', { name: 'Parar envio' }).click();
    await expect(harness.panel.locator('#write-progress-state')).toContainText(
      'Parado · 1 de 3',
    );
    await expect(
      harness.panel.getByRole('button', { name: 'Parar envio' }),
    ).toBeHidden();

    await harness.serviceWorker.evaluate(async () => {
      const stored = await chrome.storage.session.get('operationData');
      const operation = stored.operationData as Record<string, unknown>;
      await chrome.storage.session.set({
        operationData: {
          ...operation,
          revision: Number(operation.revision) + 1,
          phase: 'setup',
          inFlight: undefined,
          loginPreparation: {
            ahgora: 'opening',
            channel: 'submitted',
            ahgoraDetail: 'Abrindo Ahgora…',
            channelDetail: 'Confirmando Channel…',
            autoSubmit: true,
          },
        },
      });
    });
    await harness.panel.reload();
    await harness.panel.locator('#login-card > summary').click();
    await expect(
      harness.panel.getByRole('button', { name: 'Parar login' }),
    ).toBeVisible();
    await harness.panel.getByRole('button', { name: 'Parar login' }).click();
    await expect(harness.panel.locator('#login-source-state')).toHaveText(
      'Interrompido',
    );
    await expect(harness.panel.locator('#login-target-state')).toHaveText(
      'Interrompido',
    );
    await expect(
      harness.panel.getByRole('button', { name: 'Parar login' }),
    ).toBeHidden();
  } finally {
    await harness.context.close();
  }
});

test('atualiza um catálogo RAG por CSV, persiste e permite restaurar o original', async () => {
  const harness = await launchExtension();
  try {
    await harness.panel.setViewportSize({ width: 460, height: 900 });
    await openRulesCard(harness.panel);
    const openRagCatalogManager = harness.panel.locator(
      '#open-rag-catalog-manager-dialog',
    );
    await openRagCatalogManager.click();
    await expect(
      harness.panel.locator('#rag-catalog-manager-dialog'),
    ).toBeVisible();
    await expect(
      harness.panel.locator('#rag-catalog-manager-dialog-title'),
    ).toBeFocused();
    await expect(harness.panel.locator('#config-dialog')).toBeHidden();
    await expect(harness.panel.locator('#rag-catalog-status')).toContainText(
      '52 apontamento(s) · dados originais',
    );

    const downloadPromise = harness.panel.waitForEvent('download');
    await harness.panel.locator('#export-rag-catalog').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('reunioes-por-area.csv');
    await expect(harness.panel.locator('#rag-update-status')).toContainText(
      'exportado em CSV',
    );

    await harness.panel.locator('#rag-item-search').fill('CERTI Informa');
    await expect(harness.panel.locator('#rag-item-count')).toContainText(
      '1 de 27 item(ns)',
    );
    const editOriginal = harness.panel.getByRole('button', {
      name: 'Editar item RAG CERTI Informa',
    });
    await editOriginal.click();
    await expect(harness.panel.locator('#rag-item-group')).toBeFocused();
    await harness.panel.locator('#rag-item-kind').selectOption('AD_HOC');
    await expect(harness.panel.locator('#rag-project-fields')).toBeHidden();
    await expect(harness.panel.locator('#rag-ad-hoc-fields')).toBeVisible();
    await expect(
      harness.panel.locator('#rag-item-destination-preview'),
    ).toContainText('Destino: Avulso');
    await harness.panel.locator('#rag-item-kind').selectOption('SKIP');
    await expect(harness.panel.locator('#rag-project-fields')).toBeHidden();
    await expect(harness.panel.locator('#rag-ad-hoc-fields')).toBeHidden();
    await expect(
      harness.panel.locator('#rag-item-destination-preview'),
    ).toHaveText('Destino: não apontar no Channel.');

    const keepDraftDialog = harness.panel.waitForEvent('dialog');
    const firstCancel = harness.panel.locator('#cancel-rag-item-edit').click();
    const keepDraft = await keepDraftDialog;
    expect(keepDraft.message()).toContain('Descartar as alterações não salvas');
    await keepDraft.dismiss();
    await firstCancel;
    await expect(harness.panel.locator('#rag-item-editor')).toBeVisible();

    const discardDraftDialog = harness.panel.waitForEvent('dialog');
    const secondCancel = harness.panel.locator('#cancel-rag-item-edit').click();
    await (await discardDraftDialog).accept();
    await secondCancel;
    await expect(harness.panel.locator('#rag-item-editor')).toBeHidden();
    await expect(editOriginal).toBeFocused();
    await harness.panel.locator('#rag-item-search').fill('');

    const importPanel = harness.panel.locator('#rag-import-panel');
    await importPanel.locator('summary').click();
    await expect(importPanel).toHaveAttribute('open', '');
    await harness.panel
      .locator('#rag-update-source')
      .selectOption('reunioes-por-area');
    await harness.panel.locator('#rag-update-file').setInputFiles({
      name: 'reunioes-atualizadas.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(
        [
          'Novidades',
          'Evento,Destino,Projeto,Tipo,Atividade,Duração,Comentário',
          'Reunião importada,Projeto,P99 PROJETO IMPORTADO,Nenhum,9.9 ATIVIDADE IMPORTADA,00:45,Catálogo atualizado pelo usuário',
        ].join('\n'),
      ),
    });
    await harness.panel.locator('#update-rag-catalog').click();

    await expect(harness.panel.locator('#rag-update-status')).toContainText(
      'Prévia pronta',
    );
    await expect(harness.panel.locator('#rag-import-counts')).toContainText(
      '1 novo(s) · 0 alterado(s) · 0 inalterado(s) · 0 removido(s)',
    );
    await expect(harness.panel.locator('#rag-import-result')).toHaveText(
      'Resultado: 28 item(ns). Itens ausentes no arquivo serão mantidos.',
    );
    await expect(harness.panel.locator('#rag-catalog-status')).toContainText(
      '52 apontamento(s) · dados originais',
    );

    await harness.panel.locator('#rag-import-mode').selectOption('replace');
    await expect(harness.panel.locator('#rag-import-preview')).toBeHidden();
    await harness.panel.locator('#update-rag-catalog').click();
    await expect(harness.panel.locator('#rag-import-counts')).toContainText(
      '1 novo(s) · 0 alterado(s) · 0 inalterado(s) · 27 removido(s)',
    );
    await expect(harness.panel.locator('#rag-import-result')).toHaveText(
      'Resultado: 1 item(ns). A fonte atual será substituída por esta prévia.',
    );
    const replaceConfirmation = harness.panel.waitForEvent('dialog');
    const applyReplace = harness.panel.locator('#apply-rag-import').click();
    expect((await replaceConfirmation).message()).toContain(
      '27 item(ns) desaparecer',
    );
    await (await replaceConfirmation).accept();
    await applyReplace;
    await expect(harness.panel.locator('#rag-update-status')).toContainText(
      '1 apontamento(s) importados',
    );
    await expect(harness.panel.locator('#rag-catalog-status')).toContainText(
      '26 apontamento(s) · atualizado',
    );

    await harness.panel.setViewportSize({ width: 360, height: 900 });
    expect(
      await harness.panel.evaluate(() => {
        const dialog = document.querySelector('#rag-catalog-manager-dialog');
        return (
          document.documentElement.scrollWidth <=
            document.documentElement.clientWidth &&
          dialog !== null &&
          dialog.scrollWidth <= dialog.clientWidth
        );
      }),
    ).toBe(true);
    await harness.panel.reload();
    await openRulesCard(harness.panel);
    await harness.panel.locator('#open-config-dialog').click();
    await harness.panel.locator('#toggle-tag-rag-copy').click();
    await expect(
      harness.panel.locator('#tag-rag-copy-item option'),
    ).toContainText(['Reunião importada — Projeto compatível']);
    await harness.panel
      .getByRole('button', { name: 'Fechar definição de marcações' })
      .click();
    await openRagCatalogManager.click();

    const dialogPromise = harness.panel.waitForEvent('dialog');
    const restoreClick = harness.panel.locator('#restore-rag-catalogs').click();
    const dialog = await dialogPromise;
    expect(dialog.message()).toContain('Restaurar todos os catálogos RAG');
    await dialog.accept();
    await restoreClick;
    await expect(harness.panel.locator('#rag-update-status')).toHaveText(
      'Catálogos RAG originais restaurados.',
    );
    await expect(harness.panel.locator('#rag-catalog-status')).toContainText(
      '52 apontamento(s) · dados originais',
    );
  } finally {
    await harness.context.close();
  }
});

test('faz rollback do catálogo e das regras na UI quando storage.local.set falha', async () => {
  const harness = await launchExtension();
  try {
    await harness.panel.setViewportSize({ width: 460, height: 900 });
    await openRulesCard(harness.panel);
    await harness.panel.locator('#open-rag-catalog-manager-dialog').click();
    await harness.panel
      .locator('#rag-update-source')
      .selectOption('reunioes-rag');
    await harness.panel.locator('#rag-item-search').fill('CERTI Informa');
    await harness.panel
      .getByRole('button', { name: 'Editar item RAG CERTI Informa' })
      .click();
    await harness.panel
      .locator('#rag-item-event')
      .fill('CERTI Informa com falha');

    await harness.panel.evaluate(() => {
      chrome.storage.local.set = () =>
        Promise.reject(new Error('Falha de persistência simulada.'));
    });
    await harness.panel.locator('#save-rag-item').click();

    await expect(harness.panel.locator('#rag-item-editor-status')).toHaveText(
      'Falha de persistência simulada.',
    );
    await expect(harness.panel.locator('#rag-item-editor')).toBeVisible();

    const discardDialog = harness.panel.waitForEvent('dialog');
    const cancelEdit = harness.panel.locator('#cancel-rag-item-edit').click();
    await (await discardDialog).accept();
    await cancelEdit;
    await harness.panel.locator('#rag-item-search').fill('com falha');
    await expect(harness.panel.locator('#rag-item-count')).toContainText(
      '0 de 25 item(ns)',
    );
    await harness.panel.locator('#rag-item-search').fill('CERTI Informa');
    await expect(harness.panel.locator('#rag-item-count')).toContainText(
      '1 de 25 item(ns)',
    );

    await harness.panel
      .getByRole('button', {
        name: 'Fechar catálogos de apontamentos RAG',
      })
      .click();
    await harness.panel
      .getByRole('button', {
        name: 'Gerenciar regras automáticas do Google Calendar',
      })
      .click();
    await expect(
      harness.panel
        .locator('#calendar-rule-list')
        .getByRole('listitem')
        .filter({ hasText: 'RAG · CERTI Informa' }),
    ).toBeVisible();
    await expect(
      harness.panel
        .locator('#calendar-rule-list')
        .getByRole('listitem')
        .filter({ hasText: 'RAG · CERTI Informa com falha' }),
    ).toHaveCount(0);
  } finally {
    await harness.context.close();
  }
});

test('exclui TAG inferida sem manter vínculo automático do Calendar', async () => {
  const harness = await launchExtension();
  try {
    await harness.serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({
        extensionSettings: {
          version: 1,
          tags: [
            {
              id: 'inferred-default',
              name: 'Parada de Aprendizagem — CERTI Reflete',
              projectId: '78',
              project: 'Parada de Aprendizagem',
              activityId: '904',
              activity: 'CERTI Reflete',
              activityType: 'Nenhum',
              task: 'Nenhum',
            },
          ],
          defaultTagId: 'inferred-default',
          fontScale: 1.3,
          fontScaleCustomized: true,
          theme: 'light',
          ragCatalogOverrides: [],
          markingTemplates: [],
          templateRules: [],
          googleCalendar: {
            enabled: false,
            accessMode: 'oauth',
            connected: false,
            calendars: [],
            selectedCalendarIds: [],
            ragRuleImportVersion: 2,
            rules: [
              {
                id: 'calendar-rag:reunioes-rag:010:design-review',
                name: 'RAG · Design Review',
                enabled: true,
                calendarIds: [],
                fields: ['title', 'description'],
                matchMode: 'all',
                phrases: ['Design Review'],
                excludedPhrases: [],
                ragCatalogId: 'reunioes-rag',
                ragItemId: 'reunioes-rag:010:design-review',
                tagId: 'inferred-default',
                ignoreCancelled: true,
                ignoreDeclined: true,
                ignoreAllDay: true,
                busyOnly: false,
              },
            ],
          },
          punchAlerts: { enabled: false },
        },
      });
    });
    await harness.panel.reload();
    await openRulesCard(harness.panel);
    await harness.panel.locator('#open-config-dialog').click();

    await harness.panel
      .getByRole('button', {
        name: 'Excluir TAG Parada de Aprendizagem — CERTI Reflete',
      })
      .click();

    await expect(harness.panel.locator('#tag-editor-status')).toContainText(
      'TAG excluída. 1 regra(s) contextual(is)',
    );
    await expect(harness.panel.locator('#tag-list')).toContainText(
      'Nenhuma TAG salva',
    );
    await expect
      .poll(() =>
        harness.serviceWorker.evaluate(async () => {
          const stored = await chrome.storage.local.get('extensionSettings');
          const extensionSettings = stored.extensionSettings as {
            tags: unknown[];
            defaultTagId?: string;
            googleCalendar: { rules: Array<{ tagId?: string }> };
          };
          return {
            tagCount: extensionSettings.tags.length,
            defaultTagId: extensionSettings.defaultTagId ?? null,
            calendarTagId:
              extensionSettings.googleCalendar.rules[0]?.tagId ?? null,
          };
        }),
      )
      .toEqual({ tagCount: 0, defaultTagId: null, calendarTagId: null });
  } finally {
    await harness.context.close();
  }
});

test('gerencia TAGs dependentes, padrão e tamanho persistente das letras', async () => {
  const harness = await launchExtension();
  try {
    await harness.serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({
        extensionSettings: {
          version: 1,
          tags: [],
          fontScale: 1,
          catalog: {
            fetchedAt: '2026-08-23T12:00:00.000Z',
            projects: [
              {
                id: '11',
                label: 'P11 PROJETO TESTE',
                activities: [
                  { id: '111', label: '1.1 ATIVIDADE A' },
                  { id: '112', label: '1.2 ATIVIDADE B' },
                ],
              },
              {
                id: '22',
                label: 'P22 OUTRO PROJETO',
                activities: [{ id: '221', label: '2.1 ATIVIDADE C' }],
              },
            ],
          },
        },
      });
    });
    await harness.panel.reload();
    await openRulesCard(harness.panel);
    await harness.panel.locator('#open-config-dialog').click();

    const projectSelect = harness.panel.locator('#tag-project');
    await projectSelect.selectOption('11');
    await expect(harness.panel.locator('#tag-activity')).toBeEnabled();
    await expect(harness.panel.locator('#tag-activity option')).toHaveText([
      'Escolha uma atividade',
      '1.1 ATIVIDADE A',
      '1.2 ATIVIDADE B',
    ]);
    await projectSelect.selectOption('22');
    await expect(harness.panel.locator('#tag-activity option')).toHaveText([
      'Escolha uma atividade',
      '2.1 ATIVIDADE C',
    ]);
    await projectSelect.selectOption('11');
    await expect(harness.panel.locator('#tag-activity option')).toHaveText([
      'Escolha uma atividade',
      '1.1 ATIVIDADE A',
      '1.2 ATIVIDADE B',
    ]);

    const tagName = 'P11 PROJETO TESTE — 1.2 ATIVIDADE B';
    await expect(harness.panel.locator('#tag-name')).toBeEmpty();
    await expect(harness.panel.locator('#tag-name')).toHaveAttribute(
      'readonly',
      '',
    );
    await harness.panel.locator('#tag-activity').selectOption('112');
    await expect(harness.panel.locator('#tag-name')).toHaveValue(tagName);
    await harness.panel
      .getByText('Opções avançadas desta TAG', { exact: true })
      .click();
    await harness.panel.locator('#activity-type').fill('Consultoria');
    await harness.panel.locator('#task').fill('Desenvolvimento');
    await harness.panel
      .locator('#tag-comments')
      .fill('Atividades realizadas para a entrega semanal.');
    await harness.panel.locator('#save-tag').click();

    const tagCard = harness.panel
      .getByRole('listitem')
      .filter({ hasText: tagName });
    await expect(tagCard).toContainText('P11 PROJETO TESTE');
    await expect(tagCard).toContainText('1.2 ATIVIDADE B');
    await expect(tagCard).toContainText('Tipo: Consultoria');
    await expect(tagCard).toContainText('Tarefa: Desenvolvimento');
    await expect(tagCard).toContainText(
      'Observações: Atividades realizadas para a entrega semanal.',
    );
    await expect(tagCard.getByRole('radio', { name: 'Padrão' })).toBeChecked();

    const savedTagId = await harness.serviceWorker.evaluate(async () => {
      const stored = await chrome.storage.local.get('extensionSettings');
      return (
        stored.extensionSettings as {
          tags: Array<{ id: string }>;
        }
      ).tags[0]?.id;
    });
    await tagCard
      .getByRole('button', { name: `Editar TAG ${tagName}` })
      .click();
    await expect(harness.panel.locator('#tag-editor-title')).toHaveText(
      'Editar TAG',
    );
    await expect(harness.panel.locator('#save-tag')).toHaveText(
      'Salvar alterações',
    );
    await expect(harness.panel.locator('#cancel-tag-edit')).toBeVisible();
    await expect(harness.panel.locator('#tag-project')).toHaveValue('11');
    await expect(harness.panel.locator('#tag-activity')).toHaveValue('112');
    await expect(harness.panel.locator('#activity-type')).toHaveValue(
      'Consultoria',
    );
    await harness.panel
      .locator('#activity-type')
      .fill('Consultoria atualizada');
    await harness.panel
      .locator('#tag-comments')
      .fill('Observações atualizadas pela edição.');
    await harness.panel.locator('#save-tag').click();
    await expect(harness.panel.locator('#tag-editor-status')).toHaveText(
      `TAG ${tagName} atualizada.`,
    );
    await expect(
      harness.panel.locator('#tag-list').getByRole('listitem'),
    ).toHaveCount(1);
    await expect(tagCard).toContainText('Tipo: Consultoria atualizada');
    await expect(tagCard).toContainText(
      'Observações: Observações atualizadas pela edição.',
    );
    await expect
      .poll(async () =>
        harness.serviceWorker.evaluate(async () => {
          const stored = await chrome.storage.local.get('extensionSettings');
          return (
            stored.extensionSettings as {
              tags: Array<{ id: string }>;
            }
          ).tags.map(({ id }) => id);
        }),
      )
      .toEqual([savedTagId]);

    await tagCard
      .getByRole('button', { name: `Editar TAG ${tagName}` })
      .click();
    await harness.panel.locator('#cancel-tag-edit').click();
    await expect(harness.panel.locator('#tag-editor-title')).toHaveText(
      'Criar nova TAG',
    );
    await expect(harness.panel.locator('#tag-project')).toHaveValue('');

    await harness.panel
      .getByRole('button', { name: 'Fechar definição de marcações' })
      .click();
    await harness.panel
      .getByRole('button', { name: 'Aumentar letras' })
      .click();
    await expect(harness.panel.locator('#font-scale')).toHaveText('140%');
    await harness.panel.reload();
    await openRulesCard(harness.panel);
    await harness.panel.locator('#open-config-dialog').click();
    await expect(harness.panel.locator('#font-scale')).toHaveText('140%');
    await expect(
      harness.panel.getByRole('listitem').filter({ hasText: tagName }),
    ).toBeVisible();
    await expect(
      harness.panel.getByRole('listitem').filter({ hasText: tagName }),
    ).toContainText('Tipo: Consultoria atualizada · Tarefa: Desenvolvimento');
    await expect(
      harness.panel.getByRole('listitem').filter({ hasText: tagName }),
    ).toContainText('Observações: Observações atualizadas pela edição.');
  } finally {
    await harness.context.close();
  }
});

test('copia item RAG compatível para o formulário e exige revisão antes de salvar a TAG', async () => {
  const harness = await launchExtension();
  try {
    await harness.serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({
        extensionSettings: {
          version: 1,
          tags: [],
          fontScale: 1.3,
          catalog: {
            fetchedAt: '2026-08-24T12:00:00.000Z',
            projects: [
              {
                id: 'project-learning',
                label: 'F01C0078.0 Parada de Aprendizagem',
                activities: [
                  { id: 'activity-informa', label: '1.2 CERTI informa' },
                ],
              },
            ],
          },
        },
      });
    });
    await harness.panel.reload();
    await openRulesCard(harness.panel);
    await harness.panel.locator('#open-config-dialog').click();
    const toggle = harness.panel.locator('#toggle-tag-rag-copy');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const panel = harness.panel.locator('#tag-rag-copy-panel');
    await expect(panel).toBeVisible();

    await panel.getByLabel('Filtrar opções').fill('Lightning Talk');
    await expect(
      panel.locator('option').filter({ hasText: 'Lightning Talk' }),
    ).toBeDisabled();
    await panel.getByLabel('Filtrar opções').fill('CERTI Informa');
    await panel
      .getByLabel('Marcação')
      .selectOption({ label: 'CERTI Informa — Projeto compatível' });
    await expect(panel.locator('#tag-rag-copy-preview')).toContainText(
      'Projeto: F01C0078.0 Parada de Aprendizagem',
    );
    await expect(panel.locator('#tag-rag-copy-preview')).toContainText(
      'Atividade: 1.2 CERTI informa',
    );
    await panel
      .getByRole('button', { name: 'Copiar campos para a TAG' })
      .click();

    await expect(panel).toBeHidden();
    await expect(harness.panel.locator('#tag-project')).toHaveValue(
      'project-learning',
    );
    await expect(harness.panel.locator('#tag-activity')).toHaveValue(
      'activity-informa',
    );
    await expect(harness.panel.locator('#tag-name')).toHaveValue(
      'F01C0078.0 Parada de Aprendizagem — 1.2 CERTI informa',
    );
    await expect(
      harness.panel.locator('#tag-advanced-options'),
    ).toHaveAttribute('open', '');
    await expect(harness.panel.locator('#activity-type')).toHaveValue('Nenhum');
    await expect(harness.panel.locator('#task')).toHaveValue('Nenhum');
    await expect(harness.panel.locator('#tag-comments')).toHaveValue(
      'CERTI Informa',
    );
    await expect(harness.panel.locator('#tag-editor-status')).toHaveText(
      'Campos copiados de “CERTI Informa”. Revise antes de salvar.',
    );
    await expect(harness.panel.locator('#tag-list')).toContainText(
      'Nenhuma TAG salva',
    );

    await harness.panel.locator('#save-tag').click();
    const savedTag = harness.panel
      .locator('#tag-list')
      .getByRole('listitem')
      .filter({ hasText: 'F01C0078.0 Parada de Aprendizagem' });
    await expect(savedTag).toContainText('1.2 CERTI informa');
    await expect(savedTag).toContainText('Observações: CERTI Informa');
  } finally {
    await harness.context.close();
  }
});

test('usa Calendar via aba por padrão e mostra o aviso somente no modo API', async () => {
  const harness = await launchExtension();
  try {
    const tabAccessMode = harness.panel.locator('#login-calendar-access-tab');
    const apiAccessMode = harness.panel.locator('#login-calendar-access-oauth');
    const apiAccessNote = harness.panel.locator('#calendar-api-access-note');
    await expect(harness.panel.locator('#calendar-enabled')).toHaveCount(0);
    await expect(
      harness.panel.locator('#calendar-integration-card'),
    ).toBeVisible();
    await harness.panel
      .getByRole('button', { name: 'Abrir configurações' })
      .click();
    await expect(harness.panel.locator('#settings-dialog')).toBeVisible();
    await expect(harness.panel.locator('#settings-dialog-title')).toBeFocused();
    await expect(tabAccessMode).toBeEnabled();
    await expect(apiAccessMode).toBeEnabled();
    await expect(tabAccessMode).toBeChecked();
    await expect(apiAccessMode).not.toBeChecked();
    await expect(apiAccessNote).toBeHidden();
    await apiAccessMode.check();
    await expect(tabAccessMode).not.toBeChecked();
    await expect(apiAccessNote).toBeVisible();
    await tabAccessMode.check();
    await expect(apiAccessMode).not.toBeChecked();
    await expect(apiAccessNote).toBeHidden();
    await harness.panel
      .locator('[data-close-dialog="settings-dialog"]')
      .last()
      .click();
    await expect(harness.panel.locator('#login-calendar-connect')).toHaveCount(
      0,
    );
    await expect(
      harness.panel.locator('#calendar-mode-description'),
    ).toHaveCount(0);
    const calendarSettings = await harness.serviceWorker.evaluate(async () => {
      const stored = await chrome.storage.local.get('extensionSettings');
      return (
        stored.extensionSettings as {
          googleCalendar: { enabled?: boolean; accessMode?: string };
        }
      ).googleCalendar;
    });
    expect(calendarSettings).toMatchObject({
      enabled: true,
      accessMode: 'tab',
    });

    await expect(harness.panel.locator('#login-calendar-state')).toHaveText(
      'Não conectado',
    );
  } finally {
    await harness.context.close();
  }
});

test('conecta Calendar, Ahgora e Channel pelo mesmo botão principal', async () => {
  const harness = await launchExtension();
  try {
    await harness.panel.evaluate(() => {
      const scope = globalThis as typeof globalThis & {
        connectionFlow?: unknown[];
      };
      scope.connectionFlow = [];
      const originalSendMessage = chrome.runtime.sendMessage.bind(
        chrome.runtime,
      );
      chrome.permissions.request = (permissions) => {
        scope.connectionFlow?.push({ kind: 'request', permissions });
        return Promise.resolve(true);
      };
      chrome.permissions.contains = (permissions) => {
        scope.connectionFlow?.push({ kind: 'contains', permissions });
        return Promise.resolve(true);
      };
      chrome.runtime.sendMessage = async (message: unknown) => {
        if (
          typeof message === 'object' &&
          message !== null &&
          'type' in message &&
          (message.type === 'CONNECT_GOOGLE_CALENDAR' ||
            message.type === 'OPEN_LOGIN_PAGES')
        ) {
          scope.connectionFlow?.push({ kind: 'message', message });
          return originalSendMessage({ type: 'GET_STATE' });
        }
        return originalSendMessage(message);
      };
    });

    await harness.panel.locator('#open-logins').click();

    await expect
      .poll(() =>
        harness.panel.evaluate(
          () =>
            (
              globalThis as typeof globalThis & {
                connectionFlow?: unknown[];
              }
            ).connectionFlow ?? [],
        ),
      )
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'request',
            permissions: {
              origins: expect.arrayContaining([
                'https://www.ahgora.com.br/*',
                'https://app.ahgora.com.br/*',
                'https://channel.certi.org.br/*',
                'https://calendar.google.com/*',
              ]),
            },
          }),
          {
            kind: 'message',
            message: expect.objectContaining({
              type: 'CONNECT_GOOGLE_CALENDAR',
            }),
          },
          {
            kind: 'message',
            message: expect.objectContaining({
              type: 'OPEN_LOGIN_PAGES',
              autoSubmit: true,
            }),
          },
        ]),
      );
  } finally {
    await harness.context.close();
  }
});

test('configura calendários e cria regra com a mesma origem RAG da edição diária', async () => {
  const harness = await launchExtension();
  try {
    await harness.serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({
        extensionSettings: {
          version: 1,
          tags: [
            {
              id: 'tag-default',
              name: 'Padrão',
              projectId: '11',
              project: 'PROJETO PADRÃO',
              activityId: '111',
              activity: 'ATIVIDADE PADRÃO',
            },
          ],
          defaultTagId: 'tag-default',
          fontScale: 1.3,
          fontScaleCustomized: false,
          theme: 'light',
          markingTemplates: [],
          templateRules: [],
          googleCalendar: {
            connected: true,
            accountEmail: 'usuario@example.com',
            calendars: [
              { id: 'primary', name: 'Agenda principal', primary: true },
              { id: 'team', name: 'Equipe' },
              { id: 'holidays', name: 'Feriados' },
            ],
            selectedCalendarIds: ['primary'],
            rules: [],
          },
        },
      });
    });
    await harness.panel.reload();
    await expect(harness.panel.locator('#calendar-progress-detail')).toHaveText(
      'A captura ainda não começou.',
    );
    await expect(harness.panel.locator('#calendar-progress-state')).toHaveText(
      'Aguardando',
    );
    await openRulesCard(harness.panel);
    const openCalendarManager = harness.panel.getByRole('button', {
      name: 'Gerenciar regras automáticas do Google Calendar',
    });
    await expect(openCalendarManager).toBeVisible();
    await openCalendarManager.click();
    await expect(
      harness.panel.locator('#calendar-manager-dialog'),
    ).toBeVisible();
    await expect(
      harness.panel.locator('#template-manager-dialog'),
    ).toBeHidden();

    const list = harness.panel.getByRole('list', {
      name: 'Calendários usados nas capturas',
    });
    await expect(list.getByRole('listitem')).toHaveCount(3);
    const primary = list.getByRole('checkbox', {
      name: 'Agenda principal · principal',
    });
    const team = list.getByRole('checkbox', { name: 'Equipe' });
    const holidays = list.getByRole('checkbox', { name: 'Feriados' });
    await expect(primary).toBeChecked();
    await expect(team).not.toBeChecked();
    await expect(holidays).not.toBeChecked();

    const searchedFields = harness.panel.getByRole('list', {
      name: 'Campos do evento pesquisados',
    });
    await expect(searchedFields.getByRole('listitem')).toHaveCount(3);
    const title = searchedFields.getByRole('checkbox', { name: 'Título' });
    const description = searchedFields.getByRole('checkbox', {
      name: 'Descrição',
    });
    const location = searchedFields.getByRole('checkbox', { name: 'Local' });
    await expect(title).toBeChecked();
    await expect(description).toBeChecked();
    await expect(location).not.toBeChecked();
    await location.check();
    await expect(title).toBeChecked();
    await expect(description).toBeChecked();
    await expect(location).toBeChecked();

    await team.check();
    await expect(primary).toBeChecked();
    await expect(team).toBeChecked();
    await expect
      .poll(async () =>
        harness.serviceWorker.evaluate(async () => {
          const stored = await chrome.storage.local.get('extensionSettings');
          return (
            stored.extensionSettings as {
              googleCalendar: { selectedCalendarIds: string[] };
            }
          ).googleCalendar.selectedCalendarIds;
        }),
      )
      .toEqual(['primary', 'team']);

    const markingSource = harness.panel.getByRole('combobox', {
      name: 'Origem da marcação',
    });
    await expect(markingSource).toHaveValue('tags');
    await expect(harness.panel.locator('#calendar-rule-tag')).toHaveValue(
      'tag-default',
    );
    await markingSource.selectOption('reunioes-por-area');
    await harness.panel
      .locator('#calendar-rule-rag-filter')
      .fill('Lightning Talk');
    const ragItem = harness.panel.locator('#calendar-rule-rag-item');
    await ragItem.selectOption({ label: 'Lightning Talk — Avulso' });
    const ragItemId = await ragItem.inputValue();
    await expect(
      harness.panel.locator('#calendar-rule-destination'),
    ).toContainText('Destino: Avulso · CERTI · 13. Formação/Capacitação');
    await harness.panel.locator('#calendar-rule-name').fill('Lightning Talks');
    await harness.panel
      .locator('#calendar-rule-phrases')
      .fill('lightning talk');
    await harness.panel
      .getByRole('button', { name: 'Salvar regra do Calendar' })
      .click();
    await expect(harness.panel.locator('#calendar-manager-status')).toHaveText(
      'Regra Lightning Talks salva.',
    );
    await expect(
      harness.panel
        .locator('#calendar-rule-list')
        .getByRole('listitem')
        .filter({ hasText: 'Lightning Talks' }),
    ).toContainText('Lightning Talk');
    const savedRule = await harness.serviceWorker.evaluate(async () => {
      const stored = await chrome.storage.local.get('extensionSettings');
      return (
        stored.extensionSettings as {
          googleCalendar: {
            rules: Array<Record<string, unknown>>;
          };
        }
      ).googleCalendar.rules.find((rule) => rule.name === 'Lightning Talks');
    });
    expect(savedRule).toMatchObject({
      ragCatalogId: 'reunioes-por-area',
      ragItemId,
    });
    expect(savedRule).not.toHaveProperty('tagId');

    const savedRuleId = String(savedRule?.id);
    const manualRule = harness.panel
      .locator('#calendar-rule-list')
      .getByRole('listitem')
      .filter({ hasText: 'Lightning Talks' });
    await manualRule
      .getByRole('button', { name: 'Editar regra Lightning Talks' })
      .click();
    await expect(harness.panel.locator('#save-calendar-rule')).toHaveText(
      'Salvar alterações',
    );
    await expect(
      harness.panel.locator('#cancel-calendar-rule-edit'),
    ).toBeVisible();
    await harness.panel
      .locator('#calendar-rule-name')
      .fill('Lightning Talks editada');
    await harness.panel
      .locator('#calendar-rule-phrases')
      .fill('lightning talk\ncompartilhamento');
    await harness.panel.locator('#save-calendar-rule').click();
    await expect(harness.panel.locator('#calendar-manager-status')).toHaveText(
      'Regra Lightning Talks editada atualizada.',
    );
    await expect(
      harness.panel
        .locator('#calendar-rule-list')
        .getByRole('listitem')
        .filter({ hasText: 'Lightning Talks editada' }),
    ).toBeVisible();
    const editedManualRule = await harness.serviceWorker.evaluate(
      async (ruleId) => {
        const stored = await chrome.storage.local.get('extensionSettings');
        return (
          stored.extensionSettings as {
            googleCalendar: { rules: Array<Record<string, unknown>> };
          }
        ).googleCalendar.rules.filter((rule) => rule.id === ruleId);
      },
      savedRuleId,
    );
    expect(editedManualRule).toEqual([
      expect.objectContaining({
        id: savedRuleId,
        name: 'Lightning Talks editada',
        phrases: ['lightning talk', 'compartilhamento'],
      }),
    ]);

    const importedRagRule = harness.panel
      .locator('#calendar-rule-list')
      .getByRole('listitem')
      .filter({ hasText: 'RAG · CERTI Informa' });
    await importedRagRule
      .getByRole('button', { name: 'Editar regra RAG · CERTI Informa' })
      .click();
    await harness.panel.locator('#calendar-rule-name').fill('RAG alterada');
    await harness.panel
      .locator('#calendar-rule-phrases')
      .fill('texto alterado');
    await harness.panel.locator('#calendar-rule-enabled').uncheck();
    await harness.panel.locator('#save-calendar-rule').click();
    const restoreDialog = harness.panel.waitForEvent('dialog');
    const restoreClick = harness.panel
      .getByRole('button', { name: 'Restaurar regra RAG RAG alterada' })
      .click();
    await (await restoreDialog).accept();
    await restoreClick;
    await expect(harness.panel.locator('#calendar-manager-status')).toHaveText(
      'Regra RAG RAG · CERTI Informa restaurada.',
    );
    const restoredRagRule = await harness.serviceWorker.evaluate(async () => {
      const stored = await chrome.storage.local.get('extensionSettings');
      return (
        stored.extensionSettings as {
          googleCalendar: { rules: Array<Record<string, unknown>> };
        }
      ).googleCalendar.rules.find(
        (rule) => rule.id === 'calendar-rag:reunioes-rag:005:certi-informa',
      );
    });
    expect(restoredRagRule).toMatchObject({
      name: 'RAG · CERTI Informa',
      enabled: true,
      fields: ['title', 'description'],
      phrases: ['CERTI Informa'],
      calendarIds: [],
      busyOnly: false,
    });

    await harness.panel.reload();
    await openRulesCard(harness.panel);
    await harness.panel
      .getByRole('button', {
        name: 'Gerenciar regras automáticas do Google Calendar',
      })
      .click();
    const restored = harness.panel.getByRole('list', {
      name: 'Calendários usados nas capturas',
    });
    await expect(
      restored.getByRole('checkbox', { name: 'Agenda principal · principal' }),
    ).toBeChecked();
    await expect(
      restored.getByRole('checkbox', { name: 'Equipe' }),
    ).toBeChecked();
  } finally {
    await harness.context.close();
  }
});

test('salva templates, ajusta estouro e cria regra semanal com múltiplos templates', async () => {
  const harness = await launchExtension();
  try {
    await seedPreview(harness.serviceWorker);
    await harness.serviceWorker.evaluate(async () => {
      const stored = await chrome.storage.local.get('extensionSettings');
      await chrome.storage.local.set({
        extensionSettings: {
          ...(stored.extensionSettings as Record<string, unknown>),
          version: 1,
          tags: [
            {
              id: 'tag-default',
              name: 'Padrão',
              projectId: '11',
              project: 'PROJETO PADRÃO',
              activityId: '111',
              activity: 'ATIVIDADE PADRÃO',
            },
            {
              id: 'tag-secondary',
              name: 'Secundária',
              projectId: '22',
              project: 'PROJETO SECUNDÁRIO',
              activityId: '222',
              activity: 'ATIVIDADE SECUNDÁRIA',
            },
          ],
          defaultTagId: 'tag-default',
          fontScale: 1.3,
          fontScaleCustomized: false,
          markingTemplates: [
            {
              id: 'nine-hours',
              name: 'Dia original de nove horas',
              sourceDurationMinutes: 540,
              createdAt: '2026-08-24T12:00:00.000Z',
              entries: [
                {
                  id: 'nine-hours::1',
                  tagId: 'tag-default',
                  percentage: 66.6667,
                  durationMinutes: 360,
                },
                {
                  id: 'nine-hours::2',
                  tagId: 'tag-secondary',
                  percentage: 33.3333,
                  durationMinutes: 180,
                },
              ],
            },
          ],
          templateRules: [],
        },
      });
    });
    await harness.panel.reload();
    await harness.panel.locator('#review-card > summary').click();
    const newDay = harness.panel
      .getByRole('listitem')
      .filter({ hasText: '26/07/2026' });
    const templateBasis = newDay.getByRole('combobox', {
      name: 'Aplicar usando',
    });
    await expect(templateBasis).toBeEnabled();
    await templateBasis.selectOption('duration');
    await expect(newDay.locator('.template-overflow')).toContainText(
      'excedem o dia em 01:00',
    );
    await newDay.getByRole('button', { name: 'Ajustar e aplicar' }).click();
    await expect(newDay.locator('.allocation-effective')).toHaveText([
      '05:20 · 66.67% do dia',
      '02:40 · 33.33% do dia',
    ]);

    await newDay
      .getByRole('button', { name: /Salvar marcações.*como template/ })
      .click();
    await newDay.locator('.template-save input').fill('Domingo ajustado');
    await newDay.getByRole('button', { name: 'Salvar template' }).click();

    await openRulesCard(harness.panel);
    await harness.panel.locator('#open-template-manager-dialog').click();
    await expect(
      harness.panel.locator('#template-list').getByText('Domingo ajustado'),
    ).toBeVisible();
    await expect(harness.panel.locator('#template-list')).toContainText(
      '66.67% (05:20)',
    );
    await expect(harness.panel.locator('#template-list')).toContainText(
      '33.33% (02:40)',
    );
    await expect(harness.panel.locator('.weekday-picker')).toContainText(
      'Segunda',
    );
    await expect(harness.panel.locator('.weekday-picker')).toContainText(
      'Terça',
    );
    await expect(harness.panel.locator('.weekday-picker')).toContainText(
      'Quarta',
    );
    await expect(harness.panel.locator('.weekday-picker')).toContainText(
      'Quinta',
    );
    await expect(harness.panel.locator('.weekday-picker')).toContainText(
      'Sexta',
    );
    await expect(harness.panel.locator('.weekday-picker')).toContainText(
      'Sábado',
    );
    await expect(harness.panel.locator('.weekday-picker')).toContainText(
      'Domingo',
    );

    await harness.panel.getByRole('button', { name: 'Criar template' }).click();
    await expect(harness.panel.locator('#template-editor-title')).toHaveText(
      'Criar template',
    );
    await harness.panel.locator('#template-name').fill('Criado no gerenciador');
    await harness.panel.locator('#template-source-duration').fill('08:00');
    const createdEntry = harness.panel.locator('.template-entry-row');
    await createdEntry
      .locator('.template-entry-destination')
      .selectOption({ label: 'Padrão' });
    await createdEntry.locator('.template-entry-duration').fill('08:00');
    await expect(harness.panel.locator('#template-entry-total')).toHaveText(
      'Total: 08:00 de 08:00',
    );
    await harness.panel.locator('#save-template').click();
    const createdTemplateId = await harness.serviceWorker.evaluate(async () => {
      const stored = await chrome.storage.local.get('extensionSettings');
      return String(
        (
          stored.extensionSettings as {
            markingTemplates: Array<Record<string, unknown>>;
          }
        ).markingTemplates.find(
          (template) => template.name === 'Criado no gerenciador',
        )?.id,
      );
    });
    const createdTemplate = harness.panel
      .locator('#template-list')
      .getByRole('listitem')
      .filter({ hasText: 'Criado no gerenciador' });
    await createdTemplate
      .getByRole('button', { name: 'Editar template Criado no gerenciador' })
      .click();
    await expect(harness.panel.locator('#template-editor-title')).toHaveText(
      'Editar template',
    );
    await harness.panel.locator('#template-name').fill('Gerenciador editado');
    await harness.panel
      .locator('.template-entry-row .template-entry-duration')
      .fill('06:00');
    await harness.panel.locator('#add-template-entry').click();
    const editedEntries = harness.panel.locator('.template-entry-row');
    await editedEntries
      .nth(1)
      .locator('.template-entry-destination')
      .selectOption({ label: 'Secundária' });
    await editedEntries
      .nth(1)
      .locator('.template-entry-duration')
      .fill('02:00');
    await harness.panel.locator('#save-template').click();
    await expect(harness.panel.locator('#template-manager-status')).toHaveText(
      'Template Gerenciador editado atualizado.',
    );
    const editedTemplate = await harness.serviceWorker.evaluate(
      async (templateId) => {
        const stored = await chrome.storage.local.get('extensionSettings');
        return (
          stored.extensionSettings as {
            markingTemplates: Array<Record<string, unknown>>;
          }
        ).markingTemplates.filter((template) => template.id === templateId);
      },
      createdTemplateId,
    );
    expect(editedTemplate).toEqual([
      expect.objectContaining({
        id: createdTemplateId,
        name: 'Gerenciador editado',
        sourceDurationMinutes: 480,
        entries: [
          expect.objectContaining({
            tagId: 'tag-default',
            durationMinutes: 360,
          }),
          expect.objectContaining({
            tagId: 'tag-secondary',
            durationMinutes: 120,
          }),
        ],
      }),
    ]);

    await harness.panel.locator('#rule-name').fill('Segundas alternadas');
    await harness.panel.locator('#rule-every').fill('2');
    await harness.panel
      .locator('#template-manager-dialog .weekday-picker input[value="1"]')
      .check();
    await harness.panel.locator('#rule-start').fill('2026-08-24');
    await harness.panel
      .locator('input[name="rule-end"][value="after"]')
      .check();
    await expect(harness.panel.locator('#rule-end-count')).toBeEnabled();
    await harness.panel.locator('#rule-end-count').fill('4');
    await harness.panel
      .getByRole('button', { name: 'Adicionar template' })
      .click();
    const shares = harness.panel.locator('.rule-template-share');
    await expect(shares).toHaveCount(2);
    await shares.nth(0).locator('input[type="number"]').fill('40');
    await shares
      .nth(1)
      .locator('select')
      .selectOption({ label: 'Domingo ajustado' });
    await shares.nth(1).locator('input[type="number"]').fill('60');
    await expect(harness.panel.locator('#rule-share-total')).toHaveText(
      'Total: 100%',
    );
    await harness.panel
      .getByRole('button', { name: 'Salvar regra', exact: true })
      .click();

    const rule = harness.panel
      .locator('#rule-list')
      .getByRole('listitem')
      .filter({ hasText: 'Segundas alternadas' });
    await expect(rule).toContainText(
      'A cada 2 semanas, em seg., a partir de 24/08/2026, por 4 ocorrência(s).',
    );
    await expect(rule).toContainText('40%');
    await expect(rule).toContainText('Domingo ajustado 60%');

    const stored = await harness.serviceWorker.evaluate(async () =>
      chrome.storage.local.get('extensionSettings'),
    );
    const saved = stored.extensionSettings as {
      markingTemplates: {
        name: string;
        entries: { percentage: number; durationMinutes: number }[];
      }[];
      templateRules: { name: string; templates: unknown[] }[];
    };
    expect(saved.markingTemplates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'Domingo ajustado',
          entries: [
            expect.objectContaining({
              percentage: 66.6667,
              durationMinutes: 320,
            }),
            expect.objectContaining({
              percentage: 33.3333,
              durationMinutes: 160,
            }),
          ],
        }),
      ]),
    );
    expect(saved.templateRules).toEqual([
      expect.objectContaining({
        name: 'Segundas alternadas',
        templates: expect.arrayContaining([
          expect.objectContaining({ percentage: 40 }),
          expect.objectContaining({ percentage: 60 }),
        ]),
      }),
    ]);
  } finally {
    await harness.context.close();
  }
});

async function seedPreview(worker: Worker): Promise<void> {
  await worker.evaluate(async () => {
    const tags = [
      {
        id: 'tag-default',
        name: 'Padrão',
        projectId: '11',
        project: 'PROJETO PADRÃO',
        activityId: '111',
        activity: 'ATIVIDADE PADRÃO',
      },
      {
        id: 'tag-secondary',
        name: 'Secundária',
        projectId: '22',
        project: 'PROJETO SECUNDÁRIO',
        activityId: '222',
        activity: 'ATIVIDADE SECUNDÁRIA',
      },
    ];
    await chrome.storage.local.set({
      extensionSettings: {
        version: 1,
        tags,
        defaultTagId: 'tag-default',
        fontScale: 1.3,
        fontScaleCustomized: false,
        theme: 'light',
        ragCatalogOverrides: [],
        markingTemplates: [],
        templateRules: [],
        googleCalendar: {
          enabled: true,
          accessMode: 'oauth',
          connected: true,
          calendars: [],
          selectedCalendarIds: [],
          rules: [],
          ragRuleImportVersion: 2,
        },
        punchAlerts: { enabled: false },
      },
    });
    await chrome.storage.session.set({
      operationData: {
        version: 1,
        revision: 1,
        operationId: 'e2e-operation',
        phase: 'preview',
        sourceTab: { id: 1, origin: 'http://127.0.0.1:4174' },
        targetTab: { id: 2, origin: 'http://127.0.0.1:4174' },
        config: {
          project: 'PROJETO PADRÃO',
          activity: 'ATIVIDADE PADRÃO',
          activityType: 'Nenhum',
          task: 'Nenhum',
          period: { kind: 'default' },
          overrides: [],
          tags,
          defaultTagId: 'tag-default',
        },
        resolvedPeriod: {
          mode: 'month',
          start: '2026-06-26',
          end: '2026-07-25',
          mirrorMonths: ['2026-07'],
        },
        sourceRows: [
          { date: '2026-07-26', duration: '08:00', durationMinutes: 480 },
        ],
        targetRows: [],
        items: [
          {
            id: '2026-07-26',
            date: '2026-07-26',
            ahgoraDuration: '08:00',
            status: 'missing',
            decision: 'pending',
            tagId: 'tag-default',
            allocations: [
              {
                id: '2026-07-26',
                mode: 'percentage',
                value: '100',
                durationMinutes: 480,
                duration: '08:00',
                tagId: 'tag-default',
                isRemainder: true,
              },
            ],
          },
          {
            id: '2026-07-27',
            date: '2026-07-27',
            ahgoraDuration: '08:00',
            channelDuration: '08:00',
            channelMarkings: [
              {
                id: 'channel-27',
                duration: '05:00',
                durationMinutes: 300,
                project: 'PROJETO PADRÃO',
                activity: 'ATIVIDADE PADRÃO',
                canDelete: true,
              },
              {
                id: 'channel-27-secondary',
                duration: '03:00',
                durationMinutes: 180,
                project: 'PROJETO SECUNDÁRIO',
                activity: 'ATIVIDADE SECUNDÁRIA',
                canDelete: true,
              },
            ],
            channelProject: 'Múltiplas TAGs',
            channelActivity: '2 marcações',
            status: 'equal',
            decision: 'pending',
          },
          {
            id: '2026-07-28',
            date: '2026-07-28',
            ahgoraDuration: '08:00',
            channelDuration: '07:30',
            channelMarkings: [
              {
                id: 'channel-28',
                duration: '07:30',
                durationMinutes: 450,
                project: 'PROJETO SECUNDÁRIO',
                activity: 'ATIVIDADE SECUNDÁRIA',
                canDelete: true,
              },
            ],
            status: 'divergent',
            decision: 'pending',
          },
          {
            id: '2026-07-29',
            date: '2026-07-29',
            ahgoraDuration: '—',
            status: 'blocked',
            decision: 'pending',
            warning: 'Dia omitido; revise as batidas: 08:00, 12:00, 13:00.',
          },
        ],
        queue: [],
        queueIndex: 0,
        message: 'Prévia pronta. Nenhum item foi selecionado automaticamente.',
      },
    });
  });
}
