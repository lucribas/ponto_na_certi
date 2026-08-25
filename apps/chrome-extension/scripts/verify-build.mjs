import { access, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';

const buildDirectory = join(import.meta.dirname, '..', 'dist');
const manifest = JSON.parse(
  await readFile(join(buildDirectory, 'manifest.json'), 'utf8'),
);
const serviceWorkerPath = join(
  buildDirectory,
  manifest.background?.service_worker ?? '',
);
const sidePanelPath = join(
  buildDirectory,
  manifest.side_panel?.default_path ?? '',
);
const offscreenAudioPath = join(buildDirectory, 'src/offscreen/audio.html');

if (
  manifest.oauth2 &&
  !manifest.optional_host_permissions?.includes('https://www.googleapis.com/*')
) {
  throw new Error(
    'A build OAuth não declara acesso opcional à API do Google Calendar.',
  );
}

if (
  !manifest.optional_host_permissions?.includes('https://calendar.google.com/*')
) {
  throw new Error(
    'A build não declara o host opcional da aba do Google Calendar.',
  );
}

if (
  process.env.CHROME_EXTENSION_PUBLIC_KEY?.trim() &&
  manifest.key !== process.env.CHROME_EXTENSION_PUBLIC_KEY.trim()
) {
  throw new Error('A build não preservou a chave pública da extensão.');
}

await Promise.all([
  access(serviceWorkerPath),
  access(sidePanelPath),
  access(offscreenAudioPath),
]);

const serviceWorkerLoader = await readFile(serviceWorkerPath, 'utf8');
if (
  /from\s+['"]https?:\/\/|import\s+['"]https?:\/\//u.test(serviceWorkerLoader)
) {
  throw new Error('A build contém importação remota no service worker.');
}

for (const match of serviceWorkerLoader.matchAll(
  /import\s+['"](\.\.?\/[^'"]+)['"]/gu,
)) {
  const importedPath = resolve(dirname(serviceWorkerPath), match[1]);
  await access(importedPath);
}
