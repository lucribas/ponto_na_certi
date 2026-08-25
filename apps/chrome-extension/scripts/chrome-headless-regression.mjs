/* global chrome, document */

import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import console from 'node:console';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { access, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import process from 'node:process';
import { URL } from 'node:url';

const temporaryRoot = await mkdtemp(
  resolve(tmpdir(), 'ponto-na-certi-chrome-headless-'),
);
const extensionPath = resolve(temporaryRoot, 'extension');
const profilePath = resolve(temporaryRoot, 'profile');
const requests = new Map();
const monitorFixture = currentMonitorFixture();
let context;
let server;

try {
  const executablePath = await findHeadlessChrome();
  const publicKey = createTestPublicKey();
  const extensionId = extensionIdFromPublicKey(publicKey);
  server = createFixtureServer(requests, monitorFixture);
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server-port');
  const origin = `http://127.0.0.1:${String(address.port)}`;

  await prepareExtension(extensionPath, `${origin}/*`, publicKey);
  context = await chromium.launchPersistentContext(profilePath, {
    executablePath,
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });

  const extensionLogs = [];
  context.on('serviceworker', (worker) => {
    worker.on('console', (message) => {
      if (message.text().includes('[PontoNaCerti]'))
        extensionLogs.push(message.text());
    });
  });

  const source = await context.newPage();
  const target = await context.newPage();
  await Promise.all([
    source.goto(`${origin}/source`),
    target.goto(`${origin}/target`),
  ]);
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/src/ui/side-panel.html`);
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent('serviceworker', { timeout: 15_000 }));
  worker.on('console', (message) => {
    if (message.text().includes('[PontoNaCerti]'))
      extensionLogs.push(message.text());
  });

  const bindings = await panel.evaluate(async (fixtureOrigin) => {
    const tabs = await chrome.tabs.query({});
    const sourceTab = tabs.find((tab) => tab.url === `${fixtureOrigin}/source`);
    const targetTab = tabs.find((tab) => tab.url === `${fixtureOrigin}/target`);
    if (sourceTab?.id === undefined || targetTab?.id === undefined)
      throw new Error('fixture-tabs-not-found');
    return {
      source: { id: sourceTab.id, origin: fixtureOrigin },
      target: { id: targetTab.id, origin: fixtureOrigin },
    };
  }, origin);

  const successId = 'chrome-headless-prevista-success';
  await seedOperation(panel, successId, bindings);
  const success = await send(panel, {
    type: 'CAPTURE_AND_COMPARE',
    operationId: successId,
    config: operationConfig('2026-08'),
  });
  assert.equal(success.ok, true, JSON.stringify(success));
  assert.equal(success.state.phase, 'preview');
  assert.deepEqual(success.state.captureProgress, {
    ahgora: {
      status: 'done',
      detail: '1 dia(s) recebido(s); 1 com duração calculada.',
    },
    channel: {
      status: 'done',
      detail: '1 linha(s) recebida(s) do Extrato.',
    },
    calendar: {
      status: 'done',
      detail: 'Conexão Google Calendar desabilitada.',
    },
    comparison: {
      status: 'done',
      detail: '1 dia(s) preparado(s) para revisão.',
    },
  });
  assert.deepEqual(success.state.sourceRows, [
    { date: '2026-08-20', duration: '08:00', durationMinutes: 480 },
  ]);
  assert.equal(success.state.items[0]?.ahgoraDuration, '08:00');
  const inferredTag = success.state.config.tags.find(
    (tag) => tag.id === success.state.config.defaultTagId,
  );
  assert.deepEqual(
    {
      name: inferredTag?.name,
      project: inferredTag?.project,
      activity: inferredTag?.activity,
    },
    {
      name: 'PROJETO REFERÊNCIA — ATIVIDADE REFERÊNCIA',
      project: 'PROJETO REFERÊNCIA',
      activity: 'ATIVIDADE REFERÊNCIA',
    },
  );
  assert.equal(success.state.items[0]?.allocations[0]?.tagId, inferredTag?.id);
  const persistedDefault = await panel.evaluate(async () => {
    const stored = await chrome.storage.local.get('extensionSettings');
    const settings = stored.extensionSettings;
    return settings.tags.find((tag) => tag.id === settings.defaultTagId);
  });
  assert.equal(persistedDefault?.project, 'PROJETO REFERÊNCIA');
  assert.equal(persistedDefault?.activity, 'ATIVIDADE REFERÊNCIA');
  assert.equal(requests.get('/api-espelho/apuracao/'), 1);
  assert.equal(requests.get('/api-espelho/apuracao/2026-08'), 1);

  const failureId = 'chrome-headless-invalid-punch-failure';
  const started = await send(panel, {
    type: 'START_OPERATION',
    operationId: failureId,
  });
  assert.equal(started.ok, true, JSON.stringify(started));
  const failure = await send(panel, {
    type: 'CAPTURE_AND_COMPARE',
    operationId: failureId,
    config: operationConfig('2026-09'),
  });
  assert.equal(failure.ok, false, JSON.stringify(failure));
  assert.match(failure.message ?? '', /formato não suportado/);
  const failedState = await send(panel, { type: 'GET_STATE' });
  assert.equal(failedState.ok, true, JSON.stringify(failedState));
  assert.equal(failedState.state.phase, 'failed');
  assert.equal(failedState.state.inFlight, undefined);
  assert.equal(failedState.state.captureProgress.ahgora.status, 'failed');
  assert.equal(failedState.state.captureProgress.channel.status, 'done');
  assert.equal(failedState.state.captureProgress.comparison.status, 'failed');
  assert.notEqual(failedState.state.captureProgress.ahgora.status, 'running');
  assert.equal(requests.get('/api-espelho/apuracao/2026-09'), 1);

  const notificationTest = await send(panel, {
    type: 'TEST_PUNCH_ALERT',
    operationId: failureId,
  });
  assert.equal(notificationTest.ok, true, JSON.stringify(notificationTest));
  const nativeNotifications = await panel.evaluate(() =>
    chrome.notifications.getAll(),
  );
  assert.equal(
    Object.hasOwn(nativeNotifications, 'ahgora-punch-alert'),
    true,
    JSON.stringify(nativeNotifications),
  );
  const offscreenContexts = await panel.evaluate(() =>
    chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL('src/offscreen/audio.html')],
    }),
  );
  assert.equal(offscreenContexts.length, 1);

  await panel.evaluate(async () => {
    await chrome.notifications.clear('ahgora-punch-alert');
    await chrome.storage.local.remove('punchAlertRuntimeState');
  });
  monitorFixture.times = ['08:00'];
  await panel.locator('#punch-alert-enabled').check();
  await panel.waitForFunction(
    () =>
      document
        .querySelector('#punch-alert-enabled')
        ?.getAttribute('aria-checked') === 'true',
  );
  const monitorEnabled = await panel.evaluate(async () => {
    const stored = await chrome.storage.local.get('extensionSettings');
    return stored.extensionSettings?.punchAlerts?.enabled;
  });
  assert.equal(monitorEnabled, true);
  const monitorCheckAt = new Date();
  monitorCheckAt.setHours(14, 0, 0, 0);
  const monitorAlarm = await panel.evaluate(() =>
    chrome.alarms.get('ahgora-punch-alert-check'),
  );
  assert.equal(monitorAlarm?.periodInMinutes, 30);
  const firstMonitorCheck = await send(panel, {
    type: 'TEST_PUNCH_ALERT',
    operationId: failureId,
    checkAt: monitorCheckAt.toISOString(),
  });
  assert.equal(firstMonitorCheck.ok, true, JSON.stringify(firstMonitorCheck));
  const firstSignature = await panel.evaluate(async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const [notifications, runtime] = await Promise.all([
        chrome.notifications.getAll(),
        chrome.storage.local.get('punchAlertRuntimeState'),
      ]);
      const signature =
        runtime.punchAlertRuntimeState?.lastNotificationSignature;
      if (
        Object.hasOwn(notifications, 'ahgora-punch-alert') &&
        typeof signature === 'string'
      )
        return signature;
      await new Promise((resolveWait) =>
        globalThis.setTimeout(resolveWait, 100),
      );
    }
    throw new Error('punch-alert-not-created');
  });
  assert.match(
    firstSignature,
    new RegExp(`^${monitorFixture.date}\\|14:00\\|lunch-exit\\|`),
  );
  const duplicateMonitorCheck = await send(panel, {
    type: 'TEST_PUNCH_ALERT',
    operationId: failureId,
    checkAt: monitorCheckAt.toISOString(),
  });
  assert.equal(
    duplicateMonitorCheck.ok,
    true,
    JSON.stringify(duplicateMonitorCheck),
  );
  await panel.waitForTimeout(500);
  const deduplicatedSignature = await panel.evaluate(async () => {
    const runtime = await chrome.storage.local.get('punchAlertRuntimeState');
    return runtime.punchAlertRuntimeState?.lastNotificationSignature;
  });
  assert.equal(deduplicatedSignature, firstSignature);

  monitorFixture.times = ['08:00', '12:00', '13:00'];
  const correctedMonitorCheck = await send(panel, {
    type: 'TEST_PUNCH_ALERT',
    operationId: failureId,
    checkAt: monitorCheckAt.toISOString(),
  });
  assert.equal(
    correctedMonitorCheck.ok,
    true,
    JSON.stringify(correctedMonitorCheck),
  );
  await panel.evaluate(async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const [notifications, runtime] = await Promise.all([
        chrome.notifications.getAll(),
        chrome.storage.local.get('punchAlertRuntimeState'),
      ]);
      if (
        !Object.hasOwn(notifications, 'ahgora-punch-alert') &&
        runtime.punchAlertRuntimeState === undefined
      )
        return;
      await new Promise((resolveWait) =>
        globalThis.setTimeout(resolveWait, 100),
      );
    }
    throw new Error('punch-alert-not-cleared');
  });

  console.log(
    JSON.stringify({
      status: 'ok',
      browser: execFileSync(executablePath, ['--version'], {
        encoding: 'utf8',
      }).trim(),
      mode: 'headless',
      scenarios: [
        'PREVISTA vazia e preenchida ignoradas; duração 08:00 calculada',
        'primeira captura cria e persiste a TAG padrão pela última marcação válida do Channel',
        'batida realizada inválida encerra progresso como failed',
        'notificação nativa e documento offscreen de áudio criados',
        'checkbox ativa consultas de 30 minutos e o alerta limpa após correção',
      ],
      requests: Object.fromEntries(requests),
      extensionLogCount: extensionLogs.length,
    }),
  );
} finally {
  await context?.close();
  if (server)
    await new Promise((resolveClose, reject) =>
      server.close((error) => (error ? reject(error) : resolveClose())),
    );
  await rm(temporaryRoot, { recursive: true, force: true });
}

function createFixtureServer(requestCounts, punchMonitor) {
  return createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://fixture.local').pathname;
    requestCounts.set(path, (requestCounts.get(path) ?? 0) + 1);
    if (path === '/source') {
      sendHtml(response, '<title>Ahgora</title><main>Espelho</main>');
      return;
    }
    if (path === '/target') {
      sendHtml(
        response,
        `<input id="participanteSelecionado" value="123">
         <select id="totalItensPagina"><option value="999999">Não paginar</option></select>
         <script>
           globalThis.ID_EMPRESA = '7';
           globalThis.ApontamentoAjax = {
             listarApontamentoPorData(_input, callback) {
               callback({
                 lista: [{ dataFormatada: '19/08/2026', totalDuracao: 8 }]
               });
             },
             listarApontamentoPorDataIndividualmente(
               _date,
               _participant,
               _filter,
               _checkbox,
               callback
             ) {
               callback([{
                 id: 'reference-marking',
                 duracao: '08:00',
                 nomeApontamento: 'PROJETO REFERÊNCIA',
                 nomeAtividadeTicket: 'ATIVIDADE REFERÊNCIA',
                 permissaoRemover: true
               }]);
             }
           };
         </script>`,
      );
      return;
    }
    if (path === '/api-espelho/apuracao/') {
      sendJson(response, {
        meses: {
          '2026-08': { referencia: '2026-08' },
          '2026-09': { referencia: '2026-09' },
          [punchMonitor.month]: { referencia: punchMonitor.month },
        },
      });
      return;
    }
    if (path === '/api-espelho/apuracao/2026-08') {
      sendJson(response, {
        dias: {
          '2026-08-20': {
            batidas: [
              { tipo: 'ONLINE', hora: '08:00' },
              { tipo: 'PREVISTA', hora: '' },
              { tipo: 'PREVISTA', hora: '09:00' },
              { tipo: 'MANUAL', hora: '12:00' },
              { tipo: 'ORIGINAL', hora: '13:00' },
              { tipo: 'ONLINE', hora: '17:00' },
            ],
          },
          ...(punchMonitor.month === '2026-08' && punchMonitor.times
            ? {
                [punchMonitor.date]: {
                  batidas: punchMonitor.times.map((hora) => ({
                    tipo: 'ONLINE',
                    hora,
                  })),
                },
              }
            : {}),
        },
      });
      return;
    }
    if (path === '/api-espelho/apuracao/2026-09') {
      sendJson(response, {
        dias: {
          '2026-09-20': {
            batidas: [{ tipo: 'ONLINE', hora: '' }],
          },
        },
      });
      return;
    }
    if (path === `/api-espelho/apuracao/${punchMonitor.month}`) {
      sendJson(response, {
        dias: punchMonitor.times
          ? {
              [punchMonitor.date]: {
                batidas: punchMonitor.times.map((hora) => ({
                  tipo: 'ONLINE',
                  hora,
                })),
              },
            }
          : {},
      });
      return;
    }
    response.writeHead(404).end('not found');
  });
}

function currentMonitorFixture(now = new Date()) {
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const date = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const closing = new Date(year, month - 1 + (now.getDate() >= 26 ? 1 : 0), 1);
  return {
    date,
    month: `${String(closing.getFullYear()).padStart(4, '0')}-${String(closing.getMonth() + 1).padStart(2, '0')}`,
    times: undefined,
  };
}

function sendHtml(response, body) {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(`<!doctype html><html><body>${body}</body></html>`);
}

function sendJson(response, body) {
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

function operationConfig(month) {
  return {
    project: '',
    activity: '',
    activityType: 'Nenhum',
    task: 'Nenhum',
    period: { kind: 'month', month },
    overrides: [],
    tags: [],
  };
}

async function seedOperation(page, operationId, bindings) {
  await page.evaluate(
    async ({ id, registered }) => {
      const stored = await chrome.storage.local.get('extensionSettings');
      const settings = stored.extensionSettings ?? {
        version: 1,
        tags: [],
        fontScale: 1.3,
      };
      await chrome.storage.local.set({
        extensionSettings: {
          ...settings,
          googleCalendar: {
            enabled: true,
            accessMode: 'oauth',
            connected: true,
            calendars: [],
            selectedCalendarIds: [],
            rules: [],
          },
        },
      });
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
          message: 'Estado criado pelo teste Google Chrome headless.',
        },
      });
    },
    { id: operationId, registered: bindings },
  );
}

function send(page, message) {
  return page.evaluate(
    (candidate) => chrome.runtime.sendMessage(candidate),
    message,
  );
}

async function prepareExtension(destination, hostPermission, publicKey) {
  await cp(resolve(import.meta.dirname, '../dist'), destination, {
    recursive: true,
  });
  const manifestPath = resolve(destination, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.key = publicKey;
  manifest.host_permissions = [hostPermission];
  manifest.permissions = [...manifest.permissions, 'notifications'];
  manifest.optional_permissions = manifest.optional_permissions.filter(
    (permission) => permission !== 'notifications',
  );
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function createTestPublicKey() {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
}

function extensionIdFromPublicKey(publicKey) {
  const digest = createHash('sha256')
    .update(Buffer.from(publicKey, 'base64'))
    .digest()
    .subarray(0, 16);
  return [...digest]
    .flatMap((byte) => [byte >> 4, byte & 15])
    .map((nibble) => String.fromCharCode('a'.charCodeAt(0) + nibble))
    .join('');
}

async function findHeadlessChrome() {
  const candidates = [
    process.env.HEADLESS_CHROME_EXECUTABLE,
    chromium.executablePath(),
    '/opt/google/chrome/chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continua procurando o Google Chrome instalado no sistema.
    }
  }
  throw new Error('Google Chrome for Testing não encontrado para o headless.');
}
