import archiver from 'archiver';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDirectory = join(projectRoot, 'dist');
const artifactDirectory = join(projectRoot, 'artifacts');
const packageMetadata = JSON.parse(
  await readFile(join(projectRoot, 'package.json'), 'utf8'),
);
const artifactPath = join(
  artifactDirectory,
  `${packageMetadata.name}-${packageMetadata.version}.zip`,
);
const fixedTimestamp = new Date('1980-01-01T00:00:00.000Z');

async function filesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? filesBelow(path) : [path];
    }),
  );
  return nested.flat().sort();
}

await mkdir(artifactDirectory, { recursive: true });
await rm(artifactPath, { force: true });

const output = createWriteStream(artifactPath);
const archive = archiver('zip', { zlib: { level: 9 } });
const completed = new Promise((resolvePromise, rejectPromise) => {
  output.on('close', resolvePromise);
  output.on('error', rejectPromise);
  archive.on('error', rejectPromise);
});

archive.pipe(output);
for (const path of await filesBelow(sourceDirectory)) {
  const name = relative(sourceDirectory, path).split(sep).join('/');
  archive.append(await readFile(path), {
    date: fixedTimestamp,
    mode: 0o644,
    name,
  });
}
await archive.finalize();
await completed;
