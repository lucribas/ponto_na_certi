/* global chrome */

import { chromium } from '@playwright/test';
import console from 'node:console';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import process from 'node:process';
import { URL } from 'node:url';

const enabled = process.env.RUN_AUTHENTICATED_HEADLESS_FLOW === '1';
if (!enabled) {
  throw new Error('Defina RUN_AUTHENTICATED_HEADLESS_FLOW=1 para executar.');
}

const start = required('CHANNEL_FLOW_START');
const end = required('CHANNEL_FLOW_END');
const commit = process.env.CHANNEL_FLOW_COMMIT === '1';
const browserChannel = process.env.HEADLESS_BROWSER_CHANNEL || 'chromium';
const config = {
  ahgoraLoginUrl: required('AHGORA_LOGIN_URL'),
  ahgoraMirrorUrl: required('AHGORA_MIRROR_URL'),
  ahgoraRegistration: required('AHGORA_MATRICULA'),
  ahgoraPassword: required('AHGORA_PASSWORD'),
  channelLoginUrl: required('CHANNEL_LOGIN_URL'),
  channelExtractUrl: required('CHANNEL_EXTRATO_URL'),
  channelUsername: required('CHANNEL_USERNAME'),
  channelPassword: required('CHANNEL_PASSWORD'),
  project: required('CHANNEL_DEFAULT_PROJECT'),
  activity: required('CHANNEL_DEFAULT_ACTIVITY'),
  activityType: process.env.CHANNEL_DEFAULT_ACTIVITY_TYPE || 'Nenhum',
  task: process.env.CHANNEL_DEFAULT_TASK || 'Nenhum',
  period: { kind: 'range', start, end },
  overrides: parseOverrides(process.env.AHGORA_PUNCH_OVERRIDES),
};

const temporaryRoot = await mkdtemp(resolve(tmpdir(), 'ponto-na-certi-flow-'));
const extensionPath = resolve(temporaryRoot, 'extension');
const profilePath = resolve(temporaryRoot, 'profile');
let context;
try {
  await prepareExtension(extensionPath, [
    originPattern(config.ahgoraLoginUrl),
    originPattern(config.ahgoraMirrorUrl),
    originPattern(config.channelExtractUrl),
  ]);
  context = await chromium.launchPersistentContext(profilePath, {
    channel: browserChannel,
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
  let [worker] = context.serviceWorkers();
  worker ??= await context.waitForEvent('serviceworker', { timeout: 30_000 });
  worker.on('console', (message) => {
    if (!message.text().includes('[PontoNaCerti]')) return;
    console.warn(
      JSON.stringify({
        stage: 'extension-log',
        type: message.type(),
        message: message.text(),
      }),
    );
  });
  const extensionId = new URL(worker.url()).host;

  const ahgora = await context.newPage();
  await loginAhgora(ahgora, config);
  await navigateWithRetries(
    ahgora,
    config.ahgoraMirrorUrl,
    'ahgora-mirror-navigation',
  );

  const channel = await context.newPage();
  await loginChannel(channel, config);
  await navigateWithRetries(
    channel,
    config.channelExtractUrl,
    'channel-extract-navigation',
  );
  await channel
    .locator('#totalItensPagina')
    .waitFor({ state: 'visible', timeout: 30_000 });

  const bindings = await worker.evaluate(
    async ({ sourceOrigin, targetOrigin }) => {
      const tabs = await chrome.tabs.query({});
      const source = tabs.find((tab) => tab.url?.startsWith(sourceOrigin));
      const target = tabs.find((tab) => tab.url?.startsWith(targetOrigin));
      if (source?.id === undefined || target?.id === undefined)
        throw new Error('authenticated-tabs-not-found');
      return {
        source: { id: source.id, origin: sourceOrigin },
        target: { id: target.id, origin: targetOrigin },
      };
    },
    {
      sourceOrigin: new URL(config.ahgoraMirrorUrl).origin,
      targetOrigin: new URL(config.channelExtractUrl).origin,
    },
  );

  const operationId = `authenticated-headless-${Date.now()}`;
  await worker.evaluate(
    async ({ operationId: id, bindings: registered }) => {
      await chrome.storage.session.set({
        operationData: {
          version: 1,
          revision: 0,
          operationId: id,
          phase: 'setup',
          sourceTab: registered.source,
          targetTab: registered.target,
          loginPreparation: {
            ahgora: 'awaiting-user',
            channel: 'awaiting-user',
            ahgoraDetail: 'Aguardando detecção passiva do teste.',
            channelDetail: 'Aguardando detecção passiva do teste.',
            autoSubmit: true,
            permissionDenied: false,
            sourceTabId: registered.source.id,
            targetTabId: registered.target.id,
          },
          items: [],
          queue: [],
          queueIndex: 0,
          message: 'Abas registradas pelo teste autenticado headless.',
        },
      });
    },
    { operationId, bindings },
  );

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/src/ui/side-panel.html`);
  const monitoredLogins = await waitForLoginMonitor(panel, operationId);
  if (
    monitoredLogins.state.loginPreparation?.ahgora !== 'ready' ||
    monitoredLogins.state.loginPreparation?.channel !== 'ready'
  ) {
    console.warn(
      JSON.stringify({
        stage: 'login-monitor-not-ready',
        ahgora: monitoredLogins.state.loginPreparation?.ahgora,
        channel: monitoredLogins.state.loginPreparation?.channel,
        ahgoraDetail: monitoredLogins.state.loginPreparation?.ahgoraDetail,
        channelDetail: monitoredLogins.state.loginPreparation?.channelDetail,
      }),
    );
    throw new Error('existing-login-session-not-detected');
  }
  await panel
    .locator('#login-card:not([open])')
    .waitFor({ state: 'attached', timeout: 5_000 });
  const loginCardCollapsed = true;
  console.log(
    JSON.stringify({
      stage: 'login-monitor',
      ahgora: monitoredLogins.state.loginPreparation.ahgora,
      channel: monitoredLogins.state.loginPreparation.channel,
      detectedWithoutSubmit: true,
      loginCardCollapsed,
    }),
  );
  await worker.evaluate(() => {
    globalThis.__authenticatedCaptureProgress = [];
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'session') return;
      const progress = changes.operationData?.newValue?.captureProgress;
      if (!progress) return;
      globalThis.__authenticatedCaptureProgress.push({
        ahgora: progress.ahgora.status,
        channel: progress.channel.status,
      });
    });
  });
  const catalogResponse = await send(panel, {
    type: 'FETCH_CHANNEL_CATALOG',
    operationId,
  });
  assertSuccess(catalogResponse, 'fetch-channel-catalog');
  const catalogProject = catalogResponse.catalog?.projects.find((project) =>
    project.label.startsWith(config.project),
  );
  const catalogActivity = catalogProject?.activities.find((activity) =>
    activity.label.startsWith(config.activity),
  );
  if (!catalogProject || !catalogActivity)
    throw new Error('configured-tag-options-not-found-in-catalog');
  const defaultTag = {
    id: 'authenticated-default',
    name: 'Padrão autenticado',
    projectId: catalogProject.id,
    project: catalogProject.label,
    activityId: catalogActivity.id,
    activity: catalogActivity.label,
  };
  const operationConfig = {
    project: defaultTag.project,
    activity: defaultTag.activity,
    activityType: config.activityType,
    task: config.task,
    period: config.period,
    overrides: config.overrides,
    tags: [defaultTag],
    defaultTagId: defaultTag.id,
  };
  console.log(
    JSON.stringify({
      stage: 'catalog',
      projectCount: catalogResponse.catalog.projects.length,
      activityCount: catalogResponse.catalog.projects.reduce(
        (total, project) => total + project.activities.length,
        0,
      ),
      configuredTagFound: true,
    }),
  );
  const preview = await send(panel, {
    type: 'CAPTURE_AND_COMPARE',
    operationId,
    config: operationConfig,
  });
  assertSuccess(preview, 'capture-and-compare');
  const progressHistory = await worker.evaluate(
    () => globalThis.__authenticatedCaptureProgress,
  );
  const expectedProgress = [
    { ahgora: 'running', channel: 'waiting' },
    { ahgora: 'done', channel: 'running' },
    { ahgora: 'done', channel: 'done' },
  ];
  for (const expected of expectedProgress) {
    if (
      !progressHistory.some(
        (progress) =>
          progress.ahgora === expected.ahgora &&
          progress.channel === expected.channel,
      )
    )
      throw new Error(
        `capture-progress-missing:${expected.ahgora}:${expected.channel}`,
      );
  }
  const expectedDates = datesBetween(start, end);
  const items = preview.state.items.filter((item) =>
    expectedDates.includes(item.date),
  );
  if (items.length !== expectedDates.length)
    throw new Error('preview-dates-incomplete');
  if (items.some((item) => item.ahgoraDuration === '—'))
    throw new Error('preview-ahgora-duration-unavailable');
  if (
    items.some(
      (item) =>
        item.status !== 'missing' &&
        (!item.channelProject || !item.channelActivity),
    )
  )
    throw new Error('preview-channel-assignment-unavailable');

  console.log(
    JSON.stringify({
      stage: 'preview',
      browser: `${browserChannel}-headless`,
      period: { start, end },
      progress: expectedProgress,
      items: items.map((item) => ({
        date: item.date,
        ahgoraDuration: item.ahgoraDuration,
        channelDuration: item.channelDuration,
        channelProject: item.channelProject,
        channelActivity: item.channelActivity,
        tagId: item.tagId,
        status: item.status,
        warning: item.warning,
      })),
    }),
  );

  if (!commit) process.exitCode = 0;
  else {
    if (items.some((item) => item.status !== 'missing'))
      throw new Error('commit-requires-all-dates-missing');
    if (items.some((item) => item.warning !== undefined))
      throw new Error('commit-blocked-by-source-warning');
    for (const item of items) {
      const selected = await send(panel, {
        type: 'SET_ITEM_DECISION',
        operationId,
        itemId: item.id,
        decision: 'selected',
      });
      assertSuccess(selected, `select-${item.date}`);
    }
    const applied = await send(panel, {
      type: 'APPLY_SELECTED',
      operationId,
    });
    assertSuccess(applied, 'apply-selected');
    if (applied.state.phase !== 'completed')
      throw new Error(`flow-not-completed:${applied.state.phase}`);
    const finalItems = applied.state.items.filter((item) =>
      expectedDates.includes(item.date),
    );
    if (finalItems.some((item) => item.result !== 'filled'))
      throw new Error('flow-write-not-confirmed');

    const verificationId = `${operationId}-verification`;
    await worker.evaluate(
      async ({ operationId: id, bindings: registered }) => {
        await chrome.storage.session.set({
          operationData: {
            version: 1,
            revision: 0,
            operationId: id,
            phase: 'setup',
            sourceTab: registered.source,
            targetTab: registered.target,
            items: [],
            queue: [],
            queueIndex: 0,
          },
        });
      },
      { operationId: verificationId, bindings },
    );
    const verified = await send(panel, {
      type: 'CAPTURE_AND_COMPARE',
      operationId: verificationId,
      config: operationConfig,
    });
    assertSuccess(verified, 'post-write-verification');
    const verifiedItems = verified.state.items.filter((item) =>
      expectedDates.includes(item.date),
    );
    if (
      verifiedItems.length !== expectedDates.length ||
      verifiedItems.some((item) => item.status !== 'equal')
    )
      throw new Error('post-write-channel-values-not-equal');
    console.log(
      JSON.stringify({
        stage: 'completed',
        period: { start, end },
        items: verifiedItems.map((item) => ({
          date: item.date,
          ahgoraDuration: item.ahgoraDuration,
          channelDuration: item.channelDuration,
          channelProject: item.channelProject,
          channelActivity: item.channelActivity,
          status: item.status,
        })),
      }),
    );
  }
} finally {
  await context?.close();
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function prepareExtension(destination, hostPermissions) {
  const source = resolve(import.meta.dirname, '../dist');
  await cp(source, destination, { recursive: true });
  const manifestPath = resolve(destination, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.host_permissions = [...new Set(hostPermissions)];
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function loginAhgora(page, values) {
  const form = page.locator('#boxLogin');
  for (let attempt = 1; attempt <= 3; attempt++) {
    const navigated = await page
      .goto(values.ahgoraLoginUrl, navigationOptions())
      .then(() => true)
      .catch(() => false);
    if (!navigated) {
      console.warn(
        JSON.stringify({ stage: 'ahgora-login-navigation-retry', attempt }),
      );
      continue;
    }
    const ready = await form
      .waitFor({ state: 'visible', timeout: 20_000 })
      .then(() => true)
      .catch(() => false);
    if (!ready) continue;
    await form.locator('[name="matricula"]').fill(values.ahgoraRegistration);
    await form.locator('[name="senha"]').fill(values.ahgoraPassword);
    await form.locator('[name="senha"]').press('Enter');
    const authenticated = await form
      .waitFor({ state: 'hidden', timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    if (authenticated) return;
    console.warn(JSON.stringify({ stage: 'ahgora-login-retry', attempt }));
  }
  throw new Error('AHGORA_LOGIN_NOT_CONFIRMED');
}

async function loginChannel(page, values) {
  const form = page.locator('#loginForm');
  for (let attempt = 1; attempt <= 3; attempt++) {
    const navigated = await page
      .goto(values.channelLoginUrl, navigationOptions())
      .then(() => true)
      .catch(() => false);
    if (!navigated) {
      console.warn(
        JSON.stringify({ stage: 'channel-login-navigation-retry', attempt }),
      );
      continue;
    }
    const ready = await form
      .waitFor({ state: 'visible', timeout: 20_000 })
      .then(() => true)
      .catch(() => false);
    if (!ready) continue;
    await form.locator('[name="username"]').fill(values.channelUsername);
    await form.locator('[name="password"]').fill(values.channelPassword);
    await form.locator('[name="password"]').press('Enter');
    const authenticated = await form
      .waitFor({ state: 'hidden', timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    if (authenticated) return;
    console.warn(JSON.stringify({ stage: 'channel-login-retry', attempt }));
  }
  throw new Error('CHANNEL_LOGIN_NOT_CONFIRMED');
}

function send(page, message) {
  return page.evaluate(
    (candidate) => chrome.runtime.sendMessage(candidate),
    message,
  );
}

async function waitForLoginMonitor(page, operationId) {
  const deadline = Date.now() + 30_000;
  let lastResponse;
  while (Date.now() <= deadline) {
    lastResponse = await send(page, { type: 'GET_STATE' });
    assertSuccess(lastResponse, 'monitor-existing-logins');
    if (
      lastResponse.state.operationId === operationId &&
      lastResponse.state.loginPreparation?.ahgora === 'ready' &&
      lastResponse.state.loginPreparation?.channel === 'ready'
    )
      return lastResponse;
    await new Promise((resolve) => globalThis.setTimeout(resolve, 250));
  }
  return lastResponse;
}

function assertSuccess(response, stage) {
  if (!response?.ok)
    throw new Error(
      `${stage}:${response?.code ?? 'no-response'}:${response?.message ?? 'no-message'}`,
    );
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`CONFIG_MISSING_${name}`);
  return value;
}

function parseOverrides(value) {
  if (!value) return [];
  return value.split(';').map((entry) => {
    const [rawDate, rawTimes] = entry.split('=', 2);
    const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(rawDate?.trim() ?? '');
    if (!match || !rawTimes) throw new Error('CONFIG_INVALID_OVERRIDE');
    return {
      date: `${match[3]}-${match[2]}-${match[1]}`,
      times: rawTimes.split(',').map((time) => time.trim()),
    };
  });
}

function originPattern(url) {
  return `${new URL(url).origin}/*`;
}

function navigationOptions() {
  return { waitUntil: 'commit', timeout: 45_000 };
}

async function navigateWithRetries(page, url, stage) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const navigated = await page
      .goto(url, navigationOptions())
      .then(() => true)
      .catch(() => false);
    if (navigated) return;
    console.warn(JSON.stringify({ stage: `${stage}-retry`, attempt }));
  }
  throw new Error(`${stage}-failed`);
}

function datesBetween(first, last) {
  const values = [];
  const current = new Date(`${first}T00:00:00Z`);
  const endDate = new Date(`${last}T00:00:00Z`);
  while (current <= endDate) {
    values.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return values;
}
