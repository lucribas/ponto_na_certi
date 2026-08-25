import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { defaultExtensionSettings } from '../../src/application/settings';

const projectRoot = resolve(import.meta.dirname, '../..');

describe('MV3 foundation', () => {
  it('uses activeTab for operations and only exact optional hosts for login assistance', async () => {
    const manifest = JSON.parse(
      await readFile(resolve(projectRoot, 'manifest.json'), 'utf8'),
    ) as Record<string, unknown>;

    expect(manifest.manifest_version).toBe(3);
    expect(manifest.minimum_chrome_version).toBe('116');
    expect(manifest.permissions).toEqual([
      'activeTab',
      'alarms',
      'identity',
      'offscreen',
      'scripting',
      'storage',
      'sidePanel',
    ]);
    expect(manifest.optional_permissions).toEqual(['notifications']);
    expect(manifest).not.toHaveProperty('host_permissions');
    expect(manifest.optional_host_permissions).toEqual([
      'https://www.ahgora.com.br/*',
      'https://app.ahgora.com.br/*',
      'https://channel.certi.org.br/*',
      'https://calendar.google.com/*',
      'https://www.googleapis.com/*',
    ]);
    expect(JSON.stringify(manifest)).not.toContain('<all_urls>');
    expect(JSON.stringify(manifest)).not.toContain('cookies');
    expect(manifest.icons).toEqual({
      16: 'assets/ponto_na_certi_icon_16.png',
      32: 'assets/ponto_na_certi_icon_32.png',
      48: 'assets/ponto_na_certi_icon_48.png',
      128: 'assets/ponto_na_certi_icon_128.png',
    });
    expect(manifest.action).toMatchObject({
      default_icon: {
        16: 'assets/ponto_na_certi_icon_16.png',
        32: 'assets/ponto_na_certi_icon_32.png',
      },
    });
  });

  it('provides the approved pt-BR side panel without any submit control', async () => {
    const html = await readFile(
      resolve(projectRoot, 'src/ui/side-panel.html'),
      'utf8',
    );
    const parsed = new DOMParser().parseFromString(html, 'text/html');

    expect(parsed.documentElement.lang).toBe('pt-BR');
    expect(
      parsed.querySelector('main[aria-labelledby="title"]'),
    ).not.toBeNull();
    expect(parsed.querySelector('[aria-live="polite"]')).not.toBeNull();
    expect(parsed.body.textContent).toContain('Capturar e comparar');
    expect(parsed.body.textContent).toContain('Selecionar restantes');
    expect(parsed.body.textContent).not.toContain('Executar dry-run');
    expect(parsed.body.textContent).toContain('Enviar selecionados');
    expect(
      parsed.querySelector(
        'details#rules-card.workflow-card.collapsible-card[name="workflow-step"] > summary #rules-card-title[role="heading"][aria-level="2"]',
      )?.textContent,
    ).toBe('2. Regras');
    expect(parsed.querySelector('#config-card')).toBeNull();
    expect(parsed.querySelector('#template-manager-card')).toBeNull();
    expect(parsed.querySelectorAll('.workflow-launcher')).toHaveLength(1);
    expect(parsed.body.textContent).toContain('3. Capturar e comparar');
    expect(parsed.body.textContent).toContain('4. Revisar apontamentos');
    expect(parsed.body.textContent).toContain('5. Enviar ao Channel');
    expect(parsed.body.textContent).toContain(
      'Um clique envia todos os itens selecionados',
    );
    expect(parsed.body.textContent).toContain(
      'Definição de marcações de ponto no Channel',
    );
    expect(parsed.querySelector('#fetch-catalog')).not.toBeNull();
    expect(parsed.querySelector('details#login-card[open]')).not.toBeNull();
    expect(
      parsed.querySelectorAll('details.workflow-card.collapsible-card'),
    ).toHaveLength(5);
    expect(
      parsed.querySelectorAll(
        'details.workflow-card.collapsible-card[name="workflow-step"]',
      ),
    ).toHaveLength(5);
    expect(
      [...parsed.querySelectorAll<HTMLAnchorElement>('.flow-overview a')].map(
        (link) => [
          link.querySelector('.flow-step-number')?.textContent,
          link.querySelector('.flow-step-label')?.textContent,
          link.getAttribute('href'),
          link.getAttribute('aria-controls'),
          link.getAttribute('aria-label'),
        ],
      ),
    ).toEqual([
      ['1', 'Conectar', '#login-card', 'login-card', 'Abrir etapa 1: Conectar'],
      ['2', 'Regras', '#rules-card', 'rules-card', 'Abrir etapa 2: Regras'],
      [
        '3',
        'Capturar',
        '#capture-card',
        'capture-card',
        'Abrir etapa 3: Capturar',
      ],
      ['4', 'Revisar', '#review-card', 'review-card', 'Abrir etapa 4: Revisar'],
      ['5', 'Enviar', '#send-card', 'send-card', 'Abrir etapa 5: Enviar'],
    ]);
    expect(parsed.querySelectorAll('details.workflow-card[open]')).toHaveLength(
      1,
    );
    expect(
      parsed.querySelectorAll(
        '#config-dialog, #template-manager-dialog, #calendar-manager-dialog, #rag-catalog-manager-dialog',
      ),
    ).toHaveLength(4);
    expect(
      parsed.querySelector(
        '#open-config-dialog[aria-haspopup="dialog"][aria-controls="config-dialog"]',
      ),
    ).not.toBeNull();
    expect(
      parsed.querySelector(
        '#open-template-manager-dialog[aria-haspopup="dialog"][aria-controls="template-manager-dialog"]',
      ),
    ).not.toBeNull();
    expect(
      parsed.querySelector(
        '#open-calendar-manager-dialog[aria-haspopup="dialog"][aria-controls="calendar-manager-dialog"]',
      ),
    ).not.toBeNull();
    expect(
      parsed.querySelector(
        '#open-rag-catalog-manager-dialog[aria-haspopup="dialog"][aria-controls="rag-catalog-manager-dialog"]',
      ),
    ).not.toBeNull();
    expect(
      parsed.querySelector('.workflow-launcher-actions > :last-child')?.id,
    ).toBe('open-rag-catalog-manager-dialog');
    expect(parsed.querySelector('#punch-alert-dialog')).toBeNull();
    expect(
      parsed.querySelector(
        '.lunch-monitor-toggle #punch-alert-enabled[role="switch"][aria-describedby="lunch-monitor-description"]:not(:checked)',
      ),
    ).not.toBeNull();
    expect(
      parsed.querySelector('#lunch-monitor-description')?.textContent,
    ).toContain('12:30, 13:00, 13:30 e 14:00');
    expect(parsed.querySelectorAll('.hero-toolbar svg[viewBox]')).toHaveLength(
      5,
    );
    expect(
      parsed.querySelector(
        '#font-scale[aria-live="polite"][aria-label="Tamanho atual das letras"]',
      ),
    ).not.toBeNull();
    expect(
      parsed.querySelector('#config-dialog[aria-labelledby][aria-describedby]'),
    ).not.toBeNull();
    expect(
      parsed.querySelector(
        '#template-manager-dialog[aria-labelledby][aria-describedby]',
      ),
    ).not.toBeNull();
    expect(
      parsed.querySelector(
        '#calendar-manager-dialog[aria-labelledby][aria-describedby]',
      ),
    ).not.toBeNull();
    expect(
      parsed.querySelector(
        '#rag-catalog-manager-dialog[aria-labelledby][aria-describedby]',
      ),
    ).not.toBeNull();
    expect(
      parsed.querySelectorAll('#config-dialog [data-close-dialog]'),
    ).toHaveLength(2);
    expect(
      parsed.querySelectorAll('#template-manager-dialog [data-close-dialog]'),
    ).toHaveLength(2);
    expect(
      parsed.querySelectorAll('#calendar-manager-dialog [data-close-dialog]'),
    ).toHaveLength(2);
    expect(
      parsed.querySelectorAll(
        '#rag-catalog-manager-dialog [data-close-dialog]',
      ),
    ).toHaveLength(2);
    expect(parsed.querySelector('#config-dialog #rag-update-title')).toBeNull();
    expect(
      parsed.querySelector('#rag-catalog-manager-dialog #rag-update-title'),
    ).not.toBeNull();
    expect(
      parsed.querySelector(
        '#rag-catalog-manager-dialog #rag-item-search[type="search"][aria-controls="rag-item-list"]',
      ),
    ).not.toBeNull();
    expect(
      parsed.querySelectorAll(
        '#rag-catalog-manager-dialog #rag-item-kind-filter option',
      ),
    ).toHaveLength(4);
    expect(
      parsed.querySelectorAll(
        '#rag-catalog-manager-dialog #rag-item-state-filter option',
      ),
    ).toHaveLength(4);
    expect(
      parsed.querySelector(
        '#rag-catalog-manager-dialog #rag-item-list[role="list"]',
      ),
    ).not.toBeNull();
    expect(
      parsed.querySelector(
        '#rag-catalog-manager-dialog #rag-item-count[role="status"][aria-live="polite"]',
      ),
    ).not.toBeNull();
    expect(
      parsed.querySelector(
        '#rag-catalog-manager-dialog #rag-item-editor[aria-labelledby="rag-item-editor-title"] #rag-project-fields',
      ),
    ).not.toBeNull();
    expect(
      parsed.querySelector(
        '#rag-catalog-manager-dialog #rag-item-editor #rag-ad-hoc-fields[hidden]',
      ),
    ).not.toBeNull();
    expect(
      parsed.querySelector(
        '#rag-catalog-manager-dialog #rag-import-mode option[value="merge"]',
      ),
    ).not.toBeNull();
    expect(
      parsed.querySelector(
        '#rag-catalog-manager-dialog #rag-import-mode option[value="replace"]',
      ),
    ).not.toBeNull();
    expect(
      parsed.querySelector(
        '#rag-catalog-manager-dialog #rag-import-preview #apply-rag-import',
      ),
    ).not.toBeNull();
    expect(
      parsed.querySelector(
        '#rag-catalog-manager-dialog #rag-import-preview #rag-import-result',
      ),
    ).not.toBeNull();
    expect(
      parsed.querySelector(
        '#rag-catalog-manager-dialog #rag-item-destination-preview[role="status"][aria-live="polite"]',
      ),
    ).not.toBeNull();
    expect(
      parsed.querySelector('#rag-catalog-manager-dialog #export-rag-catalog'),
    ).not.toBeNull();
    expect(
      parsed.querySelector(
        '#rag-catalog-manager-dialog #rag-create-calendar-rule[type="checkbox"]',
      ),
    ).not.toBeNull();
    expect(
      parsed.querySelector(
        '#rag-catalog-manager-dialog #rag-delete-panel #rag-delete-replacement',
      ),
    ).not.toBeNull();
    expect(
      parsed.querySelector('#template-manager-dialog #calendar-title'),
    ).toBeNull();
    expect(
      parsed.querySelector('#calendar-manager-dialog #calendar-title'),
    ).not.toBeNull();
    expect(parsed.querySelector('#review-actions')).not.toBeNull();
    expect(parsed.querySelector('#send-actions')).not.toBeNull();
    expect(parsed.querySelector('#stop-login')).not.toBeNull();
    expect(parsed.querySelector('#stop-capture')).not.toBeNull();
    expect(parsed.querySelector('#stop-write')).not.toBeNull();
    expect(
      parsed.querySelector(
        '#connection-alert[role="alert"][aria-labelledby="connection-alert-title"][hidden]',
      ),
    ).not.toBeNull();
    expect(parsed.querySelector('#connection-alert-message')).not.toBeNull();
    expect(parsed.querySelector('#reconnect-tabs')).not.toBeNull();
    expect(
      parsed.querySelector('#review-actions #select-remaining'),
    ).not.toBeNull();
    expect(parsed.querySelector('#send-actions #apply')).not.toBeNull();
    expect(
      parsed.querySelector<HTMLSelectElement>('select#tag-project'),
    ).not.toBeNull();
    expect(parsed.querySelector('#tag-activity')).not.toBeNull();
    expect(parsed.querySelector('#cancel-tag-edit[hidden]')).not.toBeNull();
    expect(
      parsed.querySelector(
        '#toggle-tag-rag-copy[aria-controls="tag-rag-copy-panel"]',
      ),
    ).not.toBeNull();
    expect(parsed.querySelector('#tag-rag-copy-source')).not.toBeNull();
    expect(parsed.querySelector('#tag-rag-copy-item')).not.toBeNull();
    expect(parsed.querySelector('#apply-tag-rag-copy')).not.toBeNull();
    expect(parsed.querySelector('#font-decrease')).not.toBeNull();
    expect(parsed.querySelector('#font-increase')).not.toBeNull();
    expect(
      parsed.querySelector(
        '#theme-toggle[aria-pressed][aria-label][type="button"]',
      ),
    ).not.toBeNull();
    expect(
      parsed.querySelector(
        '#open-help-dialog[aria-haspopup="dialog"][aria-controls="help-dialog"]',
      ),
    ).not.toBeNull();
    expect(
      parsed.querySelector(
        '#open-support-dialog[aria-haspopup="dialog"][aria-controls="support-dialog"]',
      ),
    ).not.toBeNull();
    expect(
      parsed.querySelector('#help-dialog[aria-labelledby][aria-describedby]'),
    ).not.toBeNull();
    expect(
      parsed.querySelector(
        '#support-dialog[aria-labelledby][aria-describedby]',
      ),
    ).not.toBeNull();
    expect(
      parsed.querySelectorAll('#help-dialog .tutorial-steps > li'),
    ).toHaveLength(6);
    expect(
      parsed.querySelectorAll(
        'a[href^="https://github.com/lucribas/ponto_na_certi"][target="_blank"][rel="noopener noreferrer"]',
      ),
    ).toHaveLength(4);
    expect(
      parsed.querySelectorAll(
        'img[src="../../assets/development-support.png"][alt]',
      ),
    ).toHaveLength(2);
    expect(parsed.querySelector('small#extension-version')).not.toBeNull();
    expect(
      parsed.querySelector(
        '.weekday-picker input[value="2"][aria-label="Terça-feira"]',
      ),
    ).not.toBeNull();
    expect(
      parsed.querySelector(
        '.weekday-picker input[value="4"][aria-label="Quinta-feira"]',
      ),
    ).not.toBeNull();
    expect(
      parsed.querySelector('.weekday-picker')?.textContent.replace(/\s+/g, ' '),
    ).toContain('Segunda Terça Quarta Quinta Sexta Sábado Domingo');
    expect(parsed.querySelector('#create-template')).not.toBeNull();
    expect(parsed.querySelector('#save-template')).not.toBeNull();
    expect(
      parsed.querySelector('#cancel-calendar-rule-edit[hidden]'),
    ).not.toBeNull();
    expect(
      parsed.querySelector<HTMLOptionElement>(
        '#period-kind option[value="month"]',
      )?.selected,
    ).toBe(true);
    expect(
      [...parsed.querySelectorAll('#period-kind option')].map(
        (option) => option.textContent,
      ),
    ).toEqual(['Mês atual', 'Mês anterior', 'Intervalo inclusivo']);
    expect(parsed.querySelector('#login-calendar-connect')).toBeNull();
    expect(parsed.querySelector('#calendar-enabled')).toBeNull();
    expect(
      parsed.querySelector(
        '#login-calendar-access-tab[type="radio"][name="calendar-access-mode"][value="tab"][checked]',
      ),
    ).not.toBeNull();
    expect(
      [
        ...parsed.querySelectorAll<HTMLInputElement>(
          'input[type="radio"][name="calendar-access-mode"]',
        ),
      ].map((input) => input.value),
    ).toEqual(['tab', 'oauth']);
    expect(parsed.querySelector('#calendar-integration-card')).not.toBeNull();
    expect(
      parsed.querySelector(
        '#login-card .system-progress > #calendar-integration-card #login-calendar-detail',
      ),
    ).not.toBeNull();
    expect(
      parsed.querySelector('#calendar-integration-card .calendar-mode-control'),
    ).toBeNull();
    expect(
      parsed.querySelector(
        '#settings-dialog .calendar-mode-control #login-calendar-access-oauth',
      ),
    ).not.toBeNull();
    expect(
      parsed.querySelector('#calendar-api-access-note[hidden]'),
    ).not.toBeNull();
    expect(
      parsed.querySelector(
        '#open-settings-dialog[aria-haspopup="dialog"][aria-controls="settings-dialog"]',
      ),
    ).not.toBeNull();
    const accessRequest = parsed.querySelector<HTMLAnchorElement>(
      '#request-calendar-api-access',
    );
    const accessRequestUrl = new URL(accessRequest?.href ?? 'about:blank');
    expect(accessRequestUrl.origin).toBe('https://mail.google.com');
    expect(accessRequestUrl.pathname).toBe('/mail/');
    expect(accessRequestUrl.searchParams.get('view')).toBe('cm');
    expect(accessRequestUrl.searchParams.get('fs')).toBe('1');
    expect(accessRequestUrl.searchParams.get('to')).toBe('lus@certi.org.br');
    expect(accessRequestUrl.searchParams.get('su')).toContain(
      'Solicitação de convite para acesso à Google API do Ponto na Certi',
    );
    expect(accessRequestUrl.searchParams.get('body')).toContain(
      'Gostaria de solicitar a inclusão do meu e-mail na lista de usuários de teste',
    );
    expect(accessRequest?.target).toBe('_blank');
    expect(accessRequest?.rel).toContain('noopener');
    expect(parsed.querySelector('#calendar-use-tab')).toBeNull();
    expect(parsed.querySelector('#calendar-mode-description')).toBeNull();
    expect(parsed.querySelector('#login-calendar-status')).toBeNull();
    for (const redundantMessage of [
      'Usar uma aba autenticada',
      'Faz o GET pela sessão aberta do Google Calendar.',
      'Google Calendar conectado · aba autenticada ativo.',
      'Acesso opcional concedido:',
    ])
      expect(html).not.toContain(redundantMessage);
    expect(defaultExtensionSettings().googleCalendar.connected).toBe(false);
    expect(defaultExtensionSettings().googleCalendar.enabled).toBe(true);
    expect(defaultExtensionSettings().googleCalendar.accessMode).toBe('tab');
    expect(parsed.querySelector('#month-field[hidden]')).toBeNull();
    expect(
      parsed.querySelector<HTMLImageElement>(
        'img.hero-logo[src="../../assets/ponto_na_certi_logo.png"]',
      ),
    ).not.toBeNull();
    expect(parsed.querySelector('.hero-copy > #new-operation')).not.toBeNull();
    expect(defaultExtensionSettings().tags).toEqual([]);
    expect(defaultExtensionSettings().defaultTagId).toBeUndefined();
    expect(defaultExtensionSettings().fontScale).toBe(1.3);
    expect(defaultExtensionSettings().theme).toBe('light');
    expect(defaultExtensionSettings().markingTemplates).toEqual([]);
    expect(defaultExtensionSettings().templateRules).toEqual([]);
    expect(
      parsed.querySelector<HTMLInputElement>('#activity-type')?.value,
    ).toBe('Nenhum');
    expect(parsed.querySelector<HTMLInputElement>('#task')?.value).toBe(
      'Nenhum',
    );
    expect(parsed.querySelector('form')).toBeNull();
    expect(parsed.querySelector('button[type="submit"]')).toBeNull();
  });
});
