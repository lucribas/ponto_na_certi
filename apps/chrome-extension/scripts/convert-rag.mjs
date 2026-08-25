import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../..');
const inputs = [
  {
    id: 'reunioes-por-area',
    name: 'Reuniões por área',
    description: 'Orientações agrupadas por área e contexto de reunião.',
    file: 'Apontamento  Channel - Reuniões - Página1.csv',
  },
  {
    id: 'reunioes-rag',
    name: 'Reuniões — RAG',
    description: 'Orientações consolidadas por tipo de apontamento.',
    file: 'Apontamento  Channel - Reuniões - RAG.csv',
  },
];
const sourceDirectory = resolve(root, 'docs/rag');
const outputDirectory = resolve(root, 'apps/chrome-extension/assets/rag');

await mkdir(outputDirectory, { recursive: true });
for (const input of inputs) {
  const rows = parseCsv(
    await readFile(resolve(sourceDirectory, input.file), 'utf8'),
  );
  const catalog = convert(input, rows);
  await writeFile(
    resolve(outputDirectory, `${input.id}.json`),
    `${JSON.stringify(catalog, null, 2)}\n`,
  );
}

function convert(input, rows) {
  let group = 'Geral';
  let header = undefined;
  const items = [];
  rows.forEach((rawRow, index) => {
    const row = rawRow.map(clean);
    const populated = row.filter(Boolean);
    if (populated.length === 0) return;
    if (populated.length === 1) {
      group = populated[0];
      header = undefined;
      return;
    }
    if (normalize(row[0]) === 'evento') {
      header = row;
      return;
    }
    if (!header) return;
    const destination = normalize(row[1]);
    const kind = destination.includes('nao apontar')
      ? 'SKIP'
      : destination.includes('avulso')
        ? 'AD_HOC'
        : 'PROJECT';
    const id = `${input.id}:${String(index + 1).padStart(3, '0')}:${slug(row[0])}`;
    const common = {
      id,
      sourceLine: index + 1,
      group,
      event: row[0],
      kind,
      durationHint: row[5] || null,
      comment: row[6] || null,
      raw: {
        destination: row[1] || null,
        target: row[2] || null,
        field4: row[3] || null,
        field5: row[4] || null,
      },
    };
    if (kind === 'SKIP') {
      items.push({
        ...common,
        channel: null,
        warnings: ['Este evento não deve gerar apontamento no Channel.'],
      });
      return;
    }
    if (kind === 'AD_HOC') {
      items.push({
        ...common,
        channel: {
          client: row[2],
          operationNature: row[3],
          activityType: normalizeNone(row[4]),
        },
        warnings: row[3]
          ? []
          : ['A natureza da operação não foi informada na fonte.'],
      });
      return;
    }
    const contextualActivity = isContext(row[4]);
    const contextualDestination = destination.includes('respectivo projeto');
    // Algumas linhas do RAG usam "CERTI" como marcador de contexto na coluna
    // Projeto e deixam a atividade dinâmica. "CERTI" é cliente, não projeto.
    const contextualProject =
      contextualDestination ||
      isContext(row[2]) ||
      (contextualActivity && normalize(row[2]) === 'certi');
    items.push({
      ...common,
      channel: {
        project: contextualProject ? null : row[2],
        activityType: normalizeNone(row[3]),
        activity: contextualActivity ? null : row[4],
        task: 'Nenhum',
        projectSource: contextualProject ? 'TAG' : 'FIXED',
        activitySource: contextualActivity ? 'TAG' : 'FIXED',
      },
      warnings: [
        ...(contextualProject
          ? [
              'O projeto não é fixo. Ao usar este item, escolha uma TAG salva; o projeto dessa TAG será usado no apontamento do Channel.',
            ]
          : []),
        ...(contextualActivity
          ? [
              'A atividade não é fixa. Ao usar este item, escolha uma TAG salva; a atividade dessa TAG será usada no apontamento do Channel.',
            ]
          : []),
      ],
    });
  });
  return {
    version: 1,
    id: input.id,
    name: input.name,
    description: input.description,
    sourceFile: basename(input.file),
    itemCount: items.length,
    items,
  };
}

function parseCsv(source) {
  const rows = [];
  let row = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (character === '"') {
      if (quoted && source[index + 1] === '"') {
        value += '"';
        index++;
      } else quoted = !quoted;
    } else if (character === ',' && !quoted) {
      row.push(value);
      value = '';
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && source[index + 1] === '\n') index++;
      row.push(value);
      rows.push(row);
      row = [];
      value = '';
    } else value += character;
  }
  if (value || row.length > 0) {
    row.push(value);
    rows.push(row);
  }
  return rows;
}

function clean(value) {
  return (value ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function normalize(value) {
  return clean(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR');
}

function normalizeNone(value) {
  const normalized = normalize(value);
  return !normalized ||
    normalized === '-' ||
    normalized.includes('nao preencher')
    ? 'Nenhum'
    : normalized.startsWith('nenhum')
      ? 'Nenhum'
      : clean(value);
}

function isContext(value) {
  const normalized = normalize(value);
  return (
    normalized.includes('respectivo projeto') ||
    normalized.startsWith('atividade corrente') ||
    normalized.startsWith('atividade relacionada') ||
    normalized.startsWith('atividade do projeto')
  );
}

function slug(value) {
  return (
    normalize(value)
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'item'
  );
}
