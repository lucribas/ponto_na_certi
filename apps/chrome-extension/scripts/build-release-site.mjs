import { createHash } from 'node:crypto';
import console from 'node:console';
import {
  appendFile,
  copyFile,
  cp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import process from 'node:process';

const projectRoot = resolve(import.meta.dirname, '..');
const packageMetadata = JSON.parse(
  await readFile(resolve(projectRoot, 'package.json'), 'utf8'),
);
const packageLock = JSON.parse(
  await readFile(resolve(projectRoot, 'package-lock.json'), 'utf8'),
);
const manifest = JSON.parse(
  await readFile(resolve(projectRoot, 'manifest.json'), 'utf8'),
);
const version = String(packageMetadata.version ?? '');
if (!/^\d+(?:\.\d+){1,3}$/.test(version)) {
  throw new Error(
    `Versão ${JSON.stringify(version)} incompatível com releases e com o manifesto Chrome.`,
  );
}
if (manifest.version !== version) {
  throw new Error(
    `Versões diferentes: package.json=${version}, manifest.json=${String(manifest.version)}.`,
  );
}
if (
  packageLock.version !== version ||
  packageLock.packages?.['']?.version !== version
) {
  throw new Error(
    `package-lock.json não acompanha a versão ${version}. Use npm version ${version} --no-git-tag-version.`,
  );
}

const repository = process.env.RELEASE_REPOSITORY ?? 'lucribas/ponto_na_certi';
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
  throw new Error(`Repositório inválido: ${repository}.`);
}

const tag = `v${version}`;
const artifactName = `${packageMetadata.name}-${version}.zip`;
const artifactPath = resolve(projectRoot, 'artifacts', artifactName);
const artifact = await readFile(artifactPath);
const sha256 = createHash('sha256').update(artifact).digest('hex');
const siteSource = resolve(projectRoot, 'site');
const siteOutput = resolve(projectRoot, 'release-site');
const versionedDownload = `ponto-na-certi-${version}.zip`;
const latestDownload = 'ponto-na-certi-latest.zip';
const releaseUrl = `https://github.com/${repository}/releases/tag/${tag}`;

await rm(siteOutput, { recursive: true, force: true });
await cp(siteSource, siteOutput, { recursive: true });
await mkdir(resolve(siteOutput, 'download'), { recursive: true });
await Promise.all([
  copyFile(artifactPath, resolve(siteOutput, 'download', versionedDownload)),
  copyFile(artifactPath, resolve(siteOutput, 'download', latestDownload)),
]);

const templatePath = resolve(siteOutput, 'index.html');
const replacements = new Map([
  ['{{VERSION}}', escapeHtml(version)],
  ['{{TAG}}', escapeHtml(tag)],
  ['{{REPOSITORY}}', escapeHtml(repository)],
  ['{{REPOSITORY_URL}}', `https://github.com/${repository}`],
  ['{{RELEASE_URL}}', releaseUrl],
  ['{{ZIP_FILE}}', versionedDownload],
  ['{{LATEST_ZIP_FILE}}', latestDownload],
  ['{{SHA256}}', sha256],
]);
let index = await readFile(templatePath, 'utf8');
for (const [placeholder, value] of replacements) {
  index = index.replaceAll(placeholder, value);
}
if (/\{\{[A-Z0-9_]+\}\}/.test(index)) {
  throw new Error('A página de release contém placeholders não resolvidos.');
}
await writeFile(templatePath, index);

const releaseMetadata = {
  name: manifest.name,
  version,
  tag,
  repository,
  releaseUrl,
  download: `download/${latestDownload}`,
  versionedDownload: `download/${versionedDownload}`,
  sha256,
};
await writeFile(
  resolve(siteOutput, 'release.json'),
  `${JSON.stringify(releaseMetadata, null, 2)}\n`,
);
await writeFile(
  resolve(siteOutput, 'SHA256SUMS.txt'),
  `${sha256}  download/${versionedDownload}\n${sha256}  download/${latestDownload}\n`,
);
await writeFile(
  resolve(projectRoot, 'artifacts', 'SHA256SUMS.txt'),
  `${sha256}  ${basename(artifactPath)}\n`,
);

if (process.env.GITHUB_OUTPUT) {
  await appendFile(
    process.env.GITHUB_OUTPUT,
    `version=${version}\ntag=${tag}\nartifact_path=artifacts/${artifactName}\nartifact_name=${artifactName}\n`,
  );
}

console.info(
  JSON.stringify({
    status: 'ok',
    version,
    tag,
    artifact: `artifacts/${artifactName}`,
    site: 'release-site',
    sha256,
  }),
);

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
