/* global chrome */
import { chromium } from '@playwright/test';
import { build } from 'vite';
import { cp, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import console from 'node:console';

if (process.env.RUN_SENIOR_AUTHENTICATED_SMOKE !== '1')
  throw new Error(
    'Defina RUN_SENIOR_AUTHENTICATED_SMOKE=1 para executar a leitura real.',
  );
const start = process.env.SENIOR_SMOKE_START;
const end = process.env.SENIOR_SMOKE_END;
if (
  !/^\d{4}-\d{2}-\d{2}$/.test(start ?? '') ||
  !/^\d{4}-\d{2}-\d{2}$/.test(end ?? '') ||
  start > end ||
  start < '2026-09-21'
)
  throw new Error(
    'Defina SENIOR_SMOKE_START e SENIOR_SMOKE_END válidos desde 2026-09-21.',
  );
const root = await mkdtemp(resolve(tmpdir(), 'senior-smoke-'));
let context;
try {
  const extension = resolve(root, 'extension');
  await cp(resolve(import.meta.dirname, '../dist'), extension, {
    recursive: true,
  });
  const manifestPath = resolve(extension, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.host_permissions = ['https://gestaodoponto.certi.org.br/*'];
  await writeFile(manifestPath, JSON.stringify(manifest));
  await build({
    configFile: false,
    logLevel: 'error',
    build: {
      outDir: resolve(root, 'adapter'),
      emptyOutDir: true,
      minify: false,
      lib: {
        entry: resolve(import.meta.dirname, '../src/sites/senior/index.ts'),
        formats: ['es'],
        fileName: () => 'adapter.mjs',
      },
    },
  });
  const { captureSenior, probeSeniorDocument, querySeniorDocument } =
    await import(pathToFileURL(resolve(root, 'adapter/adapter.mjs')).href);
  context = await chromium.launchPersistentContext(resolve(root, 'profile'), {
    channel: 'chromium',
    headless: false,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
  });
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent('serviceworker'));
  const page = await context.newPage();
  await page.goto('https://gestaodoponto.certi.org.br/gestaoponto-frontend/', {
    waitUntil: 'domcontentloaded',
  });
  console.log(
    'Faça login na janela de teste e abra Meus acertos de ponto. Prazo: 5 minutos.',
  );
  await page.waitForURL(
    /\/time-adjustment\/employee\/[^/]+\/(all|pending|total)/,
    { timeout: 300_000 },
  );
  const tabId = await worker.evaluate(async () => {
    const tabs = await chrome.tabs.query({
      url: 'https://gestaodoponto.certi.org.br/*',
    });
    return tabs.find((tab) => tab.url.includes('/employee/'))?.id;
  });
  if (tabId === undefined) throw new Error('SENIOR_TAB_NOT_FOUND');
  const invoke = async (func, args = []) => {
    // All executable code comes from our compiled module, never page content.
    const result = await worker.evaluate(
      `(async()=>await chrome.scripting.executeScript({target:{tabId:${tabId}},world:'MAIN',func:(${func.toString()}),args:${JSON.stringify(args)}}))()`,
    );
    if (!result[0]?.result) throw new Error('INJECTION_FAILED');
    return result[0].result;
  };
  const result = await captureSenior(
    {
      probe: () => invoke(probeSeniorDocument),
      query: (input) => invoke(querySeniorDocument, [input]),
    },
    { start, end },
  );
  if (!result.ok) throw new Error(result.error.code);
  const rows = await page.locator('tbody tr').allTextContents();
  const sampledDays = result.days.filter((day) => day.times.length > 0);
  const datesVisible = sampledDays.filter((day) =>
    rows.some((row) =>
      row.includes(`${day.date.slice(8, 10)}/${day.date.slice(5, 7)}`),
    ),
  );
  const matched = datesVisible.filter((day) =>
    rows.some(
      (row) =>
        row.includes(`${day.date.slice(8, 10)}/${day.date.slice(5, 7)}`) &&
        day.times.every((time) => row.includes(time)),
    ),
  );
  if (matched.length !== datesVisible.length)
    throw new Error('VISIBLE_PUNCH_MISMATCH');
  console.log(
    JSON.stringify({
      ok: true,
      period: { start, end },
      dayCount: result.days.length,
      issueCount: result.issues.length,
      visibleDaysCompared: matched.length,
      writes: 0,
    }),
  );
  if (!matched.length)
    console.log(
      'Nenhum dia do intervalo estava visível na competência aberta. Conferência visual desse intervalo ainda necessária.',
    );
} finally {
  await context?.close();
  await rm(root, { recursive: true, force: true });
}
