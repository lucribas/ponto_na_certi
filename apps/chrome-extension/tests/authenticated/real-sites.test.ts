import { chromium, type Frame, type Page } from '@playwright/test';
import { describe, expect, it } from 'vitest';

import type { OperationConfig } from '../../src/application/types';
import {
  calculatePunchDays,
  civilDate,
  compareAhgoraWithChannel,
  defaultPeriod,
  formatDurationMinutes,
  formatBrazilianDate,
  rangePeriod,
  resolvePeriod,
  type ComparableWorkRecord,
  type PunchOverride,
} from '../../src/domain';
import {
  captureAhgora,
  captureAhgoraByApi,
  captureAhgoraMonthInDocument,
  probeAhgoraDocument,
  type AhgoraProbeDto,
  type FrameExecution,
  type InjectedMonthCaptureDto,
  type MonthCaptureInput,
  type SourceScriptRunner,
} from '../../src/sites/source';
import {
  runInjectedChannelApiRead,
  runInjectedChannelApiDelete,
  runInjectedChannelApiWrite,
  runInjectedChannelCatalog,
  runInjectedChannelFill,
  runInjectedChannelRead,
  type InjectedChannelFillInput,
} from '../../src/sites/target';

const runAuthenticated = process.env.RUN_AUTHENTICATED_SMOKE === '1';

describe.runIf(runAuthenticated)('sites autenticados, sem submissão', () => {
  it('recupera o contexto do Channel pelo Extrato quando a página registrada não o expõe', async () => {
    const config = authenticatedConfig();
    const browser = await chromium.launch({
      channel: 'chrome',
      headless: true,
    });
    const context = await browser.newContext();
    const channel = await context.newPage();
    try {
      await loginChannel(channel, config);
      await safeNavigate(
        channel,
        config.channelExtractUrl,
        'CHANNEL_EXTRACT_NAVIGATION_FAILED',
      );
      await channel
        .locator('#totalItensPagina')
        .waitFor({ state: 'visible', timeout: 30_000 });
      let extractGets = 0;
      let dwrReads = 0;
      channel.on('request', (request) => {
        const url = new URL(request.url());
        if (
          request.method() === 'GET' &&
          url.pathname === '/channel/apontamento.do' &&
          url.searchParams.get('action') === 'listarDatas'
        )
          extractGets++;
        if (
          request.method() === 'POST' &&
          url.pathname.endsWith('/ApontamentoAjax.listarApontamentoPorData.dwr')
        )
          dwrReads++;
      });
      await channel.evaluate(() => {
        document.querySelector('#participanteSelecionado')?.remove();
        (
          globalThis as typeof globalThis & {
            ID_EMPRESA?: string | number;
          }
        ).ID_EMPRESA = '';
      });
      const period = authenticatedPeriod(config, localToday());
      const result = await channel.evaluate(runInjectedChannelApiRead, {
        startDate: formatBrazilianDate(period.start),
        endDate: formatBrazilianDate(period.end),
        timeoutMs: 30_000,
      });

      if (!result.ok) throw new Error(`CHANNEL_CONTEXT_${result.code}`);
      expect(extractGets).toBeGreaterThanOrEqual(1);
      expect(dwrReads).toBeGreaterThanOrEqual(1);
    } finally {
      await context.close();
      await browser.close();
    }
  });

  it('usa as APIs reais do Ahgora e Channel sem navegar por controles nem gravar no smoke', async () => {
    const config = authenticatedConfig();
    const browser = await chromium.launch({
      channel: 'chrome',
      headless: true,
    });
    const context = await browser.newContext();
    const ahgora = await context.newPage();
    const channel = await context.newPage();
    try {
      await loginAhgora(ahgora, config);
      const period = authenticatedPeriod(config, localToday());
      const source = await ahgora.evaluate(captureAhgoraByApi, {
        months: period.mirrorMonths,
        timeoutMs: 30_000,
      });
      if (!source.ok) throw new Error(`AHGORA_API_${source.code}`);
      expect(source.months.length).toBe(period.mirrorMonths.length);

      await loginChannel(channel, config);
      await safeNavigate(
        channel,
        config.channelExtractUrl,
        'CHANNEL_EXTRACT_NAVIGATION_FAILED',
      );
      await channel
        .locator('#totalItensPagina')
        .waitFor({ state: 'visible', timeout: 30_000 });
      const catalog = await channel.evaluate(runInjectedChannelCatalog, {
        timeoutMs: 30_000,
      });
      if (!catalog.ok) throw new Error(`CHANNEL_CATALOG_${catalog.code}`);
      const configuredProject = catalog.projects.find((project) =>
        project.label.startsWith(config.project),
      );
      expect(configuredProject).toBeDefined();
      expect(
        configuredProject?.activities.some((activity) =>
          activity.label.startsWith(config.activity),
        ),
      ).toBe(true);

      const target = await channel.evaluate(runInjectedChannelApiRead, {
        startDate: formatBrazilianDate(period.start),
        endDate: formatBrazilianDate(period.end),
        timeoutMs: 30_000,
      });
      if (!target.ok) throw new Error(`CHANNEL_API_READ_${target.code}`);

      const knownRows = await channel.evaluate(runInjectedChannelApiRead, {
        startDate: '20/08/2026',
        endDate: '21/08/2026',
        timeoutMs: 30_000,
      });
      if (!knownRows.ok)
        throw new Error(`CHANNEL_DETAIL_READ_${knownRows.code}`);
      expect(knownRows.rows).toHaveLength(2);
      expect(
        knownRows.rows.every(
          (row) => Boolean(row.project) && Boolean(row.activity),
        ),
      ).toBe(true);
      expect(
        knownRows.rows.every((row) => (row.markings?.length ?? 0) > 0),
      ).toBe(true);

      let channelWrites = 0;
      channel.on('request', (request) => {
        const url = new URL(request.url());
        if (
          request.method() === 'POST' &&
          url.pathname === '/channel/apontamento.do'
        )
          channelWrites++;
      });
      const prepared = await channel.evaluate(runInjectedChannelApiWrite, {
        kind: 'PROJETOS',
        project: config.project,
        activityType: config.activityType,
        activity: config.activity,
        task: config.task,
        date: localToday(),
        duration: '00:01',
        durationMinutes: 1,
        timeoutMs: 30_000,
        commit: false,
      } satisfies InjectedChannelFillInput & { readonly commit: false });
      if (prepared.status !== 'filled')
        throw new Error(
          `CHANNEL_API_WRITE_PREP_${prepared.status}_${prepared.code ?? 'NO_CODE'}`,
        );
      expect(channelWrites).toBe(0);
    } finally {
      await context.close();
      await browser.close();
    }
  });

  it('captura, compara e prepara no máximo um item sem persistir no Channel', async () => {
    const config = authenticatedConfig();
    const browser = await chromium.launch({
      channel: 'chrome',
      headless: true,
    });
    const context = await browser.newContext();
    const ahgora = await context.newPage();
    const channel = await context.newPage();

    try {
      await loginAhgora(ahgora, config);
      await openAhgoraMirror(ahgora, config.ahgoraMirrorUrl);
      const today = localToday();
      const period = authenticatedPeriod(config, today);
      const captured = await captureAhgora(new PlaywrightSourceRunner(ahgora), {
        tabId: 1,
        today,
        period,
      });
      if (!captured.ok)
        throw new Error(
          `AHGORA_${captured.error.stage}_${captured.error.code}`,
        );
      if (captured.days.length === 0) throw new Error('AHGORA_NO_DAYS');

      const calculation = calculatePunchDays(captured.days, config.overrides);
      if (calculation.records.length === 0)
        throw new Error('AHGORA_NO_EFFECTIVE_RECORDS');

      await loginChannel(channel, config);
      await safeNavigate(
        channel,
        config.channelExtractUrl,
        'CHANNEL_EXTRACT_NAVIGATION_FAILED',
      );
      await channel
        .locator('#totalItensPagina')
        .waitFor({ state: 'visible', timeout: 30_000 })
        .catch(() => {
          throw new Error('CHANNEL_EXTRACT_NOT_READY');
        });
      const read = await channel
        .evaluate(runInjectedChannelRead, {
          startDate: formatBrazilianDate(period.start),
          endDate: formatBrazilianDate(period.end),
        })
        .catch(() => ({ ok: false as const, code: 'execution-failed' }));
      if (!read.ok) throw new Error(`CHANNEL_READ_${read.code}`);

      const sourceRows: readonly ComparableWorkRecord[] =
        calculation.records.map(({ date, duration, durationMinutes }) => ({
          date,
          duration,
          durationMinutes,
        }));
      const targetRows: readonly ComparableWorkRecord[] = read.rows.map(
        ({ date, duration, durationMinutes }) => ({
          date: civilDate(date),
          duration,
          durationMinutes,
        }),
      );
      const comparisons = compareAhgoraWithChannel(sourceRows, targetRows);
      expect(comparisons.length).toBeGreaterThan(0);
      const candidate = comparisons.find(
        (item) => item.status === 'missing' && item.ahgoraMinutes > 0,
      );

      const include = channel.locator('#incluirNovoApontamento');
      await include.waitFor({ state: 'visible', timeout: 30_000 });
      await include.click();
      await channel
        .locator('#apontamento_diario')
        .waitFor({ state: 'visible', timeout: 30_000 });
      await installSubmitBarrier(channel);
      const formSupport = await waitForProjectForm(channel);
      const missing = Object.entries(formSupport)
        .filter(([, supported]) => !supported)
        .map(([field]) => field);
      if (missing.length > 0) {
        const controls = await projectControlSignature(channel);
        throw new Error(
          `CHANNEL_FORM_MISSING_${missing.join('_')}__CONTROLS_${controls}`,
        );
      }

      if (!candidate) {
        expect(await submitCount(channel)).toBe(0);
        return;
      }
      const record = calculation.records.find(
        ({ date }) => date === candidate.date,
      );
      if (!record) throw new Error('CHANNEL_CANDIDATE_RECORD_MISSING');

      const assignment: InjectedChannelFillInput = {
        kind: 'PROJETOS',
        project: config.project,
        activityType: config.activityType,
        activity: config.activity,
        task: config.task,
        date: record.date,
        duration: record.duration,
        durationMinutes: record.durationMinutes,
        timeoutMs: 30_000,
      };
      const fill = await channel.evaluate(runInjectedChannelFill, assignment);
      expect(['filled', 'already-correct']).toContain(fill.status);
      expect(await submitCount(channel)).toBe(0);
    } finally {
      await context.close();
      await browser.close();
    }
  });

  it('valida extrato e formulário PROJETOS do Channel sem submeter', async () => {
    const config = authenticatedConfig();
    const browser = await chromium.launch({
      channel: 'chrome',
      headless: true,
    });
    const context = await browser.newContext();
    const channel = await context.newPage();

    try {
      await loginChannel(channel, config);
      await safeNavigate(
        channel,
        config.channelExtractUrl,
        'CHANNEL_EXTRACT_NAVIGATION_FAILED',
      );
      await channel
        .locator('#totalItensPagina')
        .waitFor({ state: 'visible', timeout: 30_000 })
        .catch(() => {
          throw new Error('CHANNEL_EXTRACT_NOT_READY');
        });

      const period = authenticatedPeriod(config, localToday());
      const read = await channel
        .evaluate(runInjectedChannelRead, {
          startDate: formatBrazilianDate(period.start),
          endDate: formatBrazilianDate(period.end),
        })
        .catch(() => ({ ok: false as const, code: 'execution-failed' }));
      if (!read.ok) throw new Error(`CHANNEL_READ_${read.code}`);

      const include = channel.locator('#incluirNovoApontamento');
      await include.waitFor({ state: 'visible', timeout: 30_000 });
      await include.click();
      await channel
        .locator('#apontamento_diario')
        .waitFor({ state: 'visible', timeout: 30_000 });
      await installSubmitBarrier(channel);

      const formSupport = await waitForProjectForm(channel);
      const missing = Object.entries(formSupport)
        .filter(([, supported]) => !supported)
        .map(([field]) => field);
      if (missing.length > 0) {
        const controls = await projectControlSignature(channel);
        throw new Error(
          `CHANNEL_FORM_MISSING_${missing.join('_')}__CONTROLS_${controls}`,
        );
      }

      const date = localToday();
      const fill = await channel.evaluate(runInjectedChannelFill, {
        kind: 'PROJETOS',
        project: config.project,
        activityType: config.activityType,
        activity: config.activity,
        task: config.task,
        date,
        duration: '00:01',
        durationMinutes: 1,
        timeoutMs: 30_000,
      } satisfies InjectedChannelFillInput);
      if (!['filled', 'already-correct'].includes(fill.status)) {
        const optionSupport = await optionMatchSupport(
          channel,
          '[id="apontamento.projetosSelecionado"]',
          config.project,
        );
        throw new Error(
          `CHANNEL_FILL_${fill.status}_${fill.code ?? 'NO_CODE'}_${optionSupport}`,
        );
      }
      expect(await submitCount(channel)).toBe(0);
    } finally {
      await context.close();
      await browser.close();
    }
  });
});

const runAuthenticatedRagWrite =
  process.env.RUN_AUTHENTICATED_RAG_WRITE === '1';

describe.runIf(runAuthenticatedRagWrite)(
  'Channel real: modelos RAG em 21/08/2026',
  () => {
    it('apaga, grava e confirma PROJETOS e AVULSO e restaura o total do Ahgora', async () => {
      const config = authenticatedConfig();
      const testDate = civilDate('2026-08-21');
      const brazilianDate = formatBrazilianDate(testDate);
      const browser = await chromium.launch({
        channel: 'chrome',
        headless: true,
      });
      const context = await browser.newContext();
      const ahgora = await context.newPage();
      const channel = await context.newPage();
      let cleared = false;
      let ahgoraMinutes = 0;

      const readDay = async () => {
        const result = await channel.evaluate(runInjectedChannelApiRead, {
          startDate: brazilianDate,
          endDate: brazilianDate,
          timeoutMs: 30_000,
        });
        if (!result.ok) throw new Error(`CHANNEL_RAG_READ_${result.code}`);
        return result.rows.find((row) => row.date === testDate);
      };
      const clearDay = async (): Promise<void> => {
        const row = await readDay();
        for (const marking of row?.markings ?? []) {
          if (!marking.canDelete)
            throw new Error(`CHANNEL_RAG_DELETE_NOT_PERMITTED_${marking.id}`);
          const result = await channel.evaluate(runInjectedChannelApiDelete, {
            id: marking.id,
            date: testDate,
            timeoutMs: 30_000,
          });
          if (!result.ok)
            throw new Error(`CHANNEL_RAG_DELETE_${result.code}_${marking.id}`);
        }
        const remaining = await readDay();
        if ((remaining?.markings?.length ?? 0) !== 0)
          throw new Error('CHANNEL_RAG_DELETE_NOT_CONFIRMED');
      };
      const restoreDefault = async (): Promise<void> => {
        await clearDay();
        if (ahgoraMinutes <= 0) return;
        const restored = await channel.evaluate(runInjectedChannelApiWrite, {
          kind: 'PROJETOS',
          project: config.project,
          activityType: config.activityType,
          activity: config.activity,
          task: config.task,
          comments: 'Restaurado após validação automatizada dos modelos RAG.',
          date: testDate,
          duration: formatDurationMinutes(ahgoraMinutes),
          durationMinutes: ahgoraMinutes,
          expectedExistingMinutes: 0,
          timeoutMs: 30_000,
        } satisfies InjectedChannelFillInput);
        if (!['filled', 'already-correct'].includes(restored.status))
          throw new Error(
            `CHANNEL_RAG_RESTORE_${restored.status}_${restored.code ?? 'NO_CODE'}`,
          );
      };

      try {
        await loginAhgora(ahgora, config);
        const source = await ahgora.evaluate(captureAhgoraByApi, {
          months: ['2026-08' as const],
          timeoutMs: 30_000,
        });
        if (!source.ok) throw new Error(`AHGORA_RAG_${source.code}`);
        const record = calculatePunchDays(
          source.months.flatMap(({ days }) => days),
          config.overrides,
        ).records.find(({ date }) => date === testDate);
        if (!record || record.durationMinutes <= 2)
          throw new Error('AHGORA_RAG_DAY_DURATION_UNAVAILABLE');
        ahgoraMinutes = record.durationMinutes;

        await loginChannel(channel, config);
        await safeNavigate(
          channel,
          config.channelExtractUrl,
          'CHANNEL_EXTRACT_NAVIGATION_FAILED',
        );
        await channel
          .locator('#totalItensPagina')
          .waitFor({ state: 'visible', timeout: 30_000 });
        const before = await readDay();
        console.info('CHANNEL_RAG_REAL_BEFORE', {
          date: testDate,
          total: before?.duration ?? '00:00',
          markingCount: before?.markings?.length ?? 0,
        });

        await clearDay();
        cleared = true;
        const project = await channel.evaluate(runInjectedChannelApiWrite, {
          kind: 'PROJETOS',
          project: config.project,
          activityType: config.activityType,
          activity: config.activity,
          task: config.task,
          comments: 'Teste automatizado RAG — modelo Projeto.',
          date: testDate,
          duration: '00:01',
          durationMinutes: 1,
          expectedExistingMinutes: 0,
          timeoutMs: 30_000,
        } satisfies InjectedChannelFillInput);
        expect(project).toMatchObject({
          status: 'filled',
          resultingMinutes: 1,
        });

        const adHoc = await channel.evaluate(runInjectedChannelApiWrite, {
          kind: 'AVULSO',
          client: 'CERTI',
          operationNature: '13. Formação/Capacitação',
          activityType: '99601 - Lightning Talk',
          comments: 'Teste automatizado RAG — modelo Avulso.',
          date: testDate,
          duration: '00:01',
          durationMinutes: 1,
          expectedExistingMinutes: 1,
          timeoutMs: 30_000,
        } satisfies InjectedChannelFillInput);
        expect(adHoc).toMatchObject({ status: 'filled', resultingMinutes: 2 });

        const verified = await readDay();
        expect(verified).toMatchObject({ durationMinutes: 2 });
        expect(verified?.markings).toHaveLength(2);
        expect(
          verified?.markings?.some((marking) =>
            marking.project?.includes(config.project.replace(/^\S+\s+/, '')),
          ),
        ).toBe(true);
        console.info('CHANNEL_RAG_REAL_MODELS_CONFIRMED', {
          date: testDate,
          total: verified?.duration,
          markingCount: verified?.markings?.length,
          models: ['PROJETOS', 'AVULSO'],
        });
      } finally {
        if (cleared) {
          await restoreDefault();
          const restored = await readDay();
          expect(restored).toMatchObject({ durationMinutes: ahgoraMinutes });
          expect(restored?.markings).toHaveLength(1);
          expect(restored?.markings?.[0]?.project).toContain(
            config.project.replace(/^\S+\s+/, ''),
          );
          console.info('CHANNEL_RAG_REAL_RESTORED', {
            date: testDate,
            total: restored?.duration,
            markingCount: restored?.markings?.length,
          });
        }
        await context.close();
        await browser.close();
      }
    });
  },
);

interface AuthenticatedConfig extends OperationConfig {
  readonly ahgoraLoginUrl: string;
  readonly ahgoraMirrorUrl: string;
  readonly ahgoraRegistration: string;
  readonly ahgoraPassword: string;
  readonly channelLoginUrl: string;
  readonly channelExtractUrl: string;
  readonly channelUsername: string;
  readonly channelPassword: string;
}

function authenticatedConfig(): AuthenticatedConfig {
  return {
    ahgoraLoginUrl: requiredEnvironment('AHGORA_LOGIN_URL'),
    ahgoraMirrorUrl: requiredEnvironment('AHGORA_MIRROR_URL'),
    ahgoraRegistration: requiredEnvironment('AHGORA_MATRICULA'),
    ahgoraPassword: requiredEnvironment('AHGORA_PASSWORD'),
    channelLoginUrl: requiredEnvironment('CHANNEL_LOGIN_URL'),
    channelExtractUrl: requiredEnvironment('CHANNEL_EXTRATO_URL'),
    channelUsername: requiredEnvironment('CHANNEL_USERNAME'),
    channelPassword: requiredEnvironment('CHANNEL_PASSWORD'),
    project: requiredEnvironment('CHANNEL_DEFAULT_PROJECT'),
    activity: requiredEnvironment('CHANNEL_DEFAULT_ACTIVITY'),
    activityType: process.env.CHANNEL_DEFAULT_ACTIVITY_TYPE || 'Nenhum',
    task: process.env.CHANNEL_DEFAULT_TASK || 'Nenhum',
    period: defaultPeriod(),
    overrides: parseOverrides(process.env.AHGORA_PUNCH_OVERRIDES),
  };
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`CONFIG_MISSING_${name}`);
  return value;
}

function parseOverrides(value: string | undefined): readonly PunchOverride[] {
  if (!value) return [];
  return value.split(';').map((entry) => {
    const [rawDate, rawTimes] = entry.split('=', 2);
    const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(rawDate?.trim() ?? '');
    if (!match || !rawTimes) throw new Error('CONFIG_INVALID_OVERRIDE');
    const day = match[1];
    const month = match[2];
    const year = match[3];
    if (!day || !month || !year) throw new Error('CONFIG_INVALID_OVERRIDE');
    return {
      date: civilDate(`${year}-${month}-${day}`),
      times: rawTimes.split(',').map((time) => time.trim()),
    };
  });
}

function navigationOptions(): {
  readonly waitUntil: 'commit';
  readonly timeout: number;
} {
  return { waitUntil: 'commit', timeout: 60_000 };
}

async function loginAhgora(
  page: Page,
  config: AuthenticatedConfig,
): Promise<void> {
  const form = page.locator('#boxLogin');
  for (let attempt = 0; attempt < 3; attempt++) {
    const ready = await safeNavigate(
      page,
      config.ahgoraLoginUrl,
      'AHGORA_LOGIN_NAVIGATION_FAILED',
    )
      .then(() =>
        form
          .waitFor({ state: 'visible', timeout: 20_000 })
          .then(() => true)
          .catch(() => false),
      )
      .catch(() => false);
    if (!ready) continue;
    await form.locator('[name="matricula"]').fill(config.ahgoraRegistration);
    await form.locator('[name="senha"]').fill(config.ahgoraPassword);
    await form.locator('[name="senha"]').press('Enter');
    const confirmed = await form
      .waitFor({ state: 'hidden', timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    if (confirmed) return;
  }
  throw new Error('AHGORA_LOGIN_NOT_CONFIRMED');
}

async function loginChannel(
  page: Page,
  config: AuthenticatedConfig,
): Promise<void> {
  const form = page.locator('#loginForm');
  for (let attempt = 0; attempt < 3; attempt++) {
    const ready = await safeNavigate(
      page,
      config.channelLoginUrl,
      'CHANNEL_LOGIN_NAVIGATION_FAILED',
    )
      .then(() =>
        form
          .waitFor({ state: 'visible', timeout: 20_000 })
          .then(() => true)
          .catch(() => false),
      )
      .catch(() => false);
    if (!ready) continue;
    await form.locator('[name="username"]').fill(config.channelUsername);
    await form.locator('[name="password"]').fill(config.channelPassword);
    await form.locator('[name="password"]').press('Enter');
    const confirmed = await form
      .waitFor({ state: 'hidden', timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    if (confirmed) return;
  }
  throw new Error('CHANNEL_LOGIN_NOT_CONFIRMED');
}

async function safeNavigate(
  page: Page,
  url: string,
  failureCode: string,
): Promise<void> {
  await page.goto(url, navigationOptions()).catch(() => {
    throw new Error(failureCode);
  });
}

async function openAhgoraMirror(page: Page, url: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const ready = await safeNavigate(
      page,
      url,
      'AHGORA_MIRROR_NAVIGATION_FAILED',
    )
      .then(() =>
        waitForMirrorFrame(page)
          .then(() => true)
          .catch(() => false),
      )
      .catch(() => false);
    if (ready) return;
  }
  throw new Error('AHGORA_MIRROR_LOAD_TIMEOUT');
}

async function waitForMirrorFrame(page: Page): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const visible = await Promise.all(
      page.frames().map((frame) =>
        frame
          .locator('body')
          .innerText({ timeout: 1_000 })
          .then((text) => text.includes('MONTHLY SUMMARY'))
          .catch(() => false),
      ),
    );
    if (visible.some(Boolean)) return;
    await page.waitForTimeout(100);
  }
  throw new Error('AHGORA_MIRROR_LOAD_TIMEOUT');
}

class PlaywrightSourceRunner implements SourceScriptRunner {
  private readonly frames = new Map<number, Frame>();

  constructor(private readonly page: Page) {}

  async probe(): Promise<readonly FrameExecution<AhgoraProbeDto>[]> {
    this.frames.clear();
    return Promise.all(
      this.page.frames().map(async (frame, frameId) => {
        this.frames.set(frameId, frame);
        return frame
          .evaluate(probeAhgoraDocument)
          .then((result) => ({ frameId, result }))
          .catch(() => ({ frameId }));
      }),
    );
  }

  async captureMonth(
    _tabId: number,
    frameId: number,
    input: MonthCaptureInput,
  ): Promise<FrameExecution<InjectedMonthCaptureDto>> {
    const frame = this.frames.get(frameId);
    if (!frame) return { frameId };
    return {
      frameId,
      result: await frame.evaluate(captureAhgoraMonthInDocument, input),
    };
  }
}

async function installSubmitBarrier(page: Page): Promise<void> {
  await page.evaluate(() => {
    const runtime = globalThis as typeof globalThis & {
      __authenticatedSubmitCount?: number;
    };
    runtime.__authenticatedSubmitCount = 0;
    const form = document.querySelector<HTMLFormElement>('#apontamento_diario');
    if (!form) return;
    const blockSubmit = (): void => {
      runtime.__authenticatedSubmitCount =
        (runtime.__authenticatedSubmitCount ?? 0) + 1;
    };
    form.addEventListener(
      'submit',
      (event) => {
        event.preventDefault();
        blockSubmit();
      },
      true,
    );
    Object.defineProperty(form, 'submit', {
      configurable: true,
      value: blockSubmit,
    });
    Object.defineProperty(form, 'requestSubmit', {
      configurable: true,
      value: blockSubmit,
    });
  });
}

function submitCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (
        globalThis as typeof globalThis & {
          __authenticatedSubmitCount?: number;
        }
      ).__authenticatedSubmitCount ?? 0,
  );
}

interface ProjectFormSupport {
  readonly projectType: boolean;
  readonly project: boolean;
  readonly activityType: boolean;
  readonly activity: boolean;
  readonly task: boolean;
  readonly date: boolean;
  readonly duration: boolean;
}

async function waitForProjectForm(page: Page): Promise<ProjectFormSupport> {
  const deadline = Date.now() + 30_000;
  let support = await projectFormSupport(page);
  while (
    Date.now() < deadline &&
    Object.values(support).some((item) => !item)
  ) {
    await page.waitForTimeout(100);
    support = await projectFormSupport(page);
  }
  return support;
}

function projectFormSupport(page: Page): Promise<ProjectFormSupport> {
  return page.evaluate(() => {
    const form = document.querySelector('#apontamento_diario');
    const projectType = document.querySelector('#tpApontamentoProjeto');
    const selects = [
      document.querySelector<HTMLSelectElement>(
        '[id="apontamento.projetosSelecionado"]',
      ),
      document.querySelector<HTMLSelectElement>(
        '[id="apontamento.idTipoAtividadeProjeto"]',
      ),
      document.querySelector<HTMLSelectElement>(
        '[id="apontamento.notificacaoSelecionada"]',
      ),
      document.querySelector<HTMLSelectElement>('[id="apontamento.idTarefa"]'),
    ] as const;
    const date = form?.querySelector('#data');
    const duration = form?.querySelector('[id="apontamento.duracao"]');
    return {
      projectType: projectType !== null,
      project: selects[0] !== null,
      activityType: selects[1] !== null,
      activity: selects[2] !== null,
      task: selects[3] !== null,
      date: date !== null && date !== undefined,
      duration: duration !== null && duration !== undefined,
    };
  });
}

function projectControlSignature(page: Page): Promise<string> {
  return page.evaluate(() => {
    const controls = [...document.querySelectorAll('input, select')]
      .filter((element) => {
        if (element instanceof HTMLSelectElement) return true;
        return element instanceof HTMLInputElement && element.type === 'radio';
      })
      .map((element) => element.id)
      .filter(Boolean)
      .map((id) => id.replace(/[^A-Za-z0-9_.-]/g, '_'))
      .sort();
    return controls.length > 0 ? controls.join('-') : 'NONE';
  });
}

function optionMatchSupport(
  page: Page,
  selector: string,
  configuredPrefix: string,
): Promise<string> {
  return page.evaluate(
    ({ selector: controlSelector, configuredPrefix: rawPrefix }) => {
      const select = document.querySelector<HTMLSelectElement>(controlSelector);
      if (!select) return 'SELECT_MISSING';
      const prefix = rawPrefix.trim();
      const labels = [...select.options].map((option) => option.text.trim());
      const lowerPrefix = prefix.toLocaleLowerCase();
      return [
        `COUNT_${String(labels.length)}`,
        `TRIM_PREFIX_${String(labels.some((label) => label.startsWith(prefix)))}`,
        `CASE_PREFIX_${String(labels.some((label) => label.toLocaleLowerCase().startsWith(lowerPrefix)))}`,
        `CONTAINS_${String(labels.some((label) => label.includes(prefix)))}`,
        `VALUE_${String([...select.options].some((option) => option.value.trim() === prefix))}`,
      ].join('_');
    },
    { selector, configuredPrefix },
  );
}

function localToday(): ReturnType<typeof civilDate> {
  const now = new Date();
  return civilDate(
    `${String(now.getFullYear()).padStart(4, '0')}-${String(
      now.getMonth() + 1,
    ).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`,
  );
}

function authenticatedPeriod(
  config: AuthenticatedConfig,
  today: ReturnType<typeof civilDate>,
): ReturnType<typeof resolvePeriod> {
  const configuredDates = config.overrides.map(({ date }) => date).sort();
  return resolvePeriod(
    configuredDates.length > 0
      ? rangePeriod(
          configuredDates[0] ?? today,
          configuredDates.at(-1) ?? today,
        )
      : rangePeriod(daysBefore(today, 14), today),
    { today: () => today },
  );
}

function daysBefore(
  date: ReturnType<typeof civilDate>,
  days: number,
): ReturnType<typeof civilDate> {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - days);
  return civilDate(value.toISOString().slice(0, 10));
}
