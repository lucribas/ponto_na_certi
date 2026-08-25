import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  convertRagCatalogCsv,
  ragCatalogs,
  setRagCatalogOverrides,
} from '../../src/application/rag';
import type { OperationData } from '../../src/application/types';
import {
  fillCurrentQueueItem,
  type CoordinatorAdapters,
} from '../../src/background/coordinator';
import { civilDate, type ChannelAssignment } from '../../src/domain';

afterEach(() => setRagCatalogOverrides([]));

const date = civilDate('2026-08-21');
const tag = {
  id: 'default',
  name: 'Projeto atual',
  projectId: '11',
  project: 'D15C0401.0 PETROBRAS_SUSTENTAÇÃO CERTIFICARE',
  activityId: '22',
  activity: '1.3 ME04_Medição de agosto.26',
  activityType: 'Nenhum',
  task: 'Nenhum',
};

function operation(catalogId: string, ragItemId: string): OperationData {
  return {
    version: 1,
    revision: 1,
    operationId: 'rag-operation',
    phase: 'preview',
    targetTab: { id: 2, origin: 'https://channel.invalid' },
    config: {
      project: tag.project,
      activity: tag.activity,
      activityType: 'Nenhum',
      task: 'Nenhum',
      period: { kind: 'month', month: '2026-08' },
      overrides: [],
      tags: [tag],
      defaultTagId: tag.id,
    },
    resolvedPeriod: {
      mode: 'month',
      start: civilDate('2026-08-01'),
      end: civilDate('2026-08-31'),
      mirrorMonths: ['2026-08'],
    },
    sourceRows: [{ date, duration: '00:30', durationMinutes: 30 }],
    targetRows: [],
    items: [
      {
        id: date,
        date,
        ahgoraDuration: '00:30',
        status: 'missing',
        decision: 'selected',
        allocations: [
          {
            id: date,
            mode: 'percentage',
            value: '100',
            duration: '00:30',
            durationMinutes: 30,
            tagId: tag.id,
            ragCatalogId: catalogId,
            ragItemId,
            isRemainder: true,
          },
        ],
      },
    ],
    queue: [date],
    queueIndex: 0,
  };
}

function adapters(writeTarget: CoordinatorAdapters['writeTarget']) {
  return {
    today: date,
    captureSource: vi.fn(),
    readTarget: vi.fn(),
    writeTarget,
  } as unknown as CoordinatorAdapters;
}

describe('coordenação de destinos RAG', () => {
  it('usa o destino atualizado importado do CSV durante a escrita', async () => {
    const previous = ragCatalogs[0]?.items.find(
      (candidate) => candidate.event === 'CERTI Informa',
    );
    if (!previous) throw new Error('fixture RAG ausente');
    const updated = convertRagCatalogCsv(
      'reunioes-por-area',
      [
        previous.group,
        'Evento,Destino,Projeto,Tipo,Atividade,Duração,Comentário',
        'CERTI Informa,Projeto,F99 PROJETO NOVO,Nenhum,9.9 ATIVIDADE NOVA,00:30,Comentário atualizado',
      ].join('\n'),
    );
    setRagCatalogOverrides([updated]);
    let written: ChannelAssignment | undefined;
    const writeTarget = vi.fn((_state, assignment: ChannelAssignment) => {
      written = assignment;
      return Promise.resolve({
        date,
        requestedMinutes: 30,
        resultingMinutes: 30,
        status: 'filled' as const,
      });
    });

    await fillCurrentQueueItem(
      operation(updated.id, previous.id),
      adapters(writeTarget),
    );

    expect(written).toMatchObject({
      kind: 'PROJETOS',
      project: 'F99 PROJETO NOVO',
      activity: '9.9 ATIVIDADE NOVA',
      comments: 'Comentário atualizado',
    });
  });

  it('gera PROJETOS fixo com comentário da fonte', async () => {
    const catalog = ragCatalogs[0];
    const item = catalog?.items.find(
      (candidate) => candidate.event === 'CERTI Informa',
    );
    if (!catalog || !item) throw new Error('fixture RAG ausente');
    let written: ChannelAssignment | undefined;
    const writeTarget = vi.fn((_state, assignment: ChannelAssignment) => {
      written = assignment;
      return Promise.resolve({
        date,
        requestedMinutes: 30,
        resultingMinutes: 30,
        status: 'filled' as const,
      });
    });

    await fillCurrentQueueItem(
      operation(catalog.id, item.id),
      adapters(writeTarget),
    );

    expect(written).toMatchObject({
      kind: 'PROJETOS',
      project: 'F01C0078.0 Parada de Aprendizagem',
      activity: '1.2 CERTI informa',
      comments: 'CERTI Informa',
    });
  });

  it('gera AVULSO com cliente, natureza e tipo próprios', async () => {
    const catalog = ragCatalogs[0];
    const item = catalog?.items.find(
      (candidate) => candidate.event === 'Lightning Talk',
    );
    if (!catalog || !item) throw new Error('fixture RAG ausente');
    let written: ChannelAssignment | undefined;
    const writeTarget = vi.fn((_state, assignment: ChannelAssignment) => {
      written = assignment;
      return Promise.resolve({
        date,
        requestedMinutes: 30,
        resultingMinutes: 30,
        status: 'filled' as const,
      });
    });

    await fillCurrentQueueItem(
      operation(catalog.id, item.id),
      adapters(writeTarget),
    );

    expect(written).toMatchObject({
      kind: 'AVULSO',
      client: 'CERTI',
      operationNature: '13. Formação/Capacitação',
      activityType: '99601 - Lightning Talk',
      comments: 'Lightning Talk',
    });
  });
});
