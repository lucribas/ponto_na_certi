import { afterEach, describe, expect, it } from 'vitest';

import {
  applyRagCatalogCsvImport,
  convertRagCatalogCsv,
  createRagItem,
  deleteRagItem,
  editRagItem,
  exportRagCatalogCsv,
  findRagItem,
  getRagItemState,
  previewRagCatalogCsvImport,
  ragCatalogs,
  restoreAllRagCatalogs,
  restoreRagCatalog,
  restoreRagItem,
  setRagCatalogOverrides,
  type RagItem,
  type RagItemInput,
} from '../../../src/application/rag';

afterEach(() => setRagCatalogOverrides([]));

describe('catálogos RAG empacotados', () => {
  it('mantém contagens, identificadores e os três comportamentos da fonte', () => {
    expect(ragCatalogs).toHaveLength(2);
    expect(ragCatalogs.map(({ id, itemCount }) => ({ id, itemCount }))).toEqual(
      [
        { id: 'reunioes-por-area', itemCount: 27 },
        { id: 'reunioes-rag', itemCount: 25 },
      ],
    );
    expect(
      new Set(
        ragCatalogs.flatMap((catalog) =>
          catalog.items.map((item) => item.kind),
        ),
      ),
    ).toEqual(new Set(['PROJECT', 'AD_HOC', 'SKIP']));
    expect(
      ragCatalogs.every((catalog) => catalog.assetUrl.endsWith('.json')),
    ).toBe(true);
  });

  it('interpreta projeto fixo, projeto contextual e avulso com campos distintos', () => {
    const fixed = ragCatalogs[0]?.items.find(
      (item) => item.event === 'CERTI Informa',
    );
    expect(fixed).toMatchObject({
      kind: 'PROJECT',
      channel: {
        project: 'F01C0078.0 Parada de Aprendizagem',
        activity: '1.2 CERTI informa',
        projectSource: 'FIXED',
      },
    });
    const contextual = ragCatalogs[1]?.items.find(
      (item) => item.event === 'Reunião quinzenal UX',
    );
    expect(contextual).toMatchObject({
      kind: 'PROJECT',
      channel: {
        project: null,
        activity: null,
        projectSource: 'TAG',
        activitySource: 'TAG',
      },
    });
    const adHoc = ragCatalogs[0]?.items.find(
      (item) => item.event === 'Lightning Talk',
    );
    expect(adHoc).toMatchObject({
      kind: 'AD_HOC',
      channel: {
        client: 'CERTI',
        operationNature: '13. Formação/Capacitação',
        activityType: '99601 - Lightning Talk',
      },
    });
    expect(findRagItem('reunioes-por-area', adHoc?.id)).toEqual(adHoc);
  });

  it('não contém eventos duplicados no JSON consolidado do RAG', () => {
    const catalog = ragCatalogs.find(({ id }) => id === 'reunioes-rag');
    if (!catalog) throw new Error('Catálogo RAG ausente.');
    const normalizedEvents = catalog.items.map((item) =>
      item.event
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLocaleLowerCase('pt-BR')
        .replace(/\s+/g, ' ')
        .trim(),
    );

    expect(new Set(normalizedEvents).size).toBe(catalog.items.length);
  });

  it('não torna executável uma orientação de não apontar', () => {
    expect(
      ragCatalogs[0]?.items.find((item) => item.kind === 'SKIP'),
    ).toMatchObject({ event: 'Atestados / Ausências', channel: null });
  });

  it('converte uma atualização CSV e preserva o ID de um evento existente', () => {
    const previous = ragCatalogs[0]?.items.find(
      (item) => item.event === 'CERTI Informa',
    );
    const updated = convertRagCatalogCsv(
      'reunioes-por-area',
      [
        previous?.group ?? 'Institucional',
        'Evento,Destino,Projeto,Tipo,Atividade,Duração,Comentário',
        'CERTI Informa,Projeto,F99 PROJETO ATUALIZADO,Nenhum,9.9 ATIVIDADE ATUALIZADA,00:30,Novo comentário',
      ].join('\n'),
    );

    expect(updated.items[0]).toMatchObject({
      id: previous?.id,
      event: 'CERTI Informa',
      comment: 'Novo comentário',
      channel: {
        project: 'F99 PROJETO ATUALIZADO',
        activity: '9.9 ATIVIDADE ATUALIZADA',
      },
    });
    setRagCatalogOverrides([updated]);
    expect(findRagItem(updated.id, previous?.id)).toMatchObject({
      channel: { project: 'F99 PROJETO ATUALIZADO' },
    });
    expect(ragCatalogs[1]?.itemCount).toBe(25);
  });

  it('elimina eventos repetidos ao atualizar o catálogo RAG por CSV', () => {
    const updated = convertRagCatalogCsv(
      'reunioes-rag',
      [
        'PROJETO',
        'Evento,Destino,Projeto,Tipo,Atividade,Duração,Comentário',
        'Design Review,Projetos,Respectivo projeto,-,Atividade relacionada,,Revisão',
        ' design   review ,Projetos,Respectivo projeto,-,Atividade relacionada,,Duplicada',
      ].join('\n'),
    );

    expect(updated.itemCount).toBe(1);
    expect(updated.items).toHaveLength(1);
    expect(updated.items[0]?.event).toBe('Design Review');
  });

  it('recusa CSV sem cabeçalho e apontamentos reconhecíveis', () => {
    expect(() =>
      convertRagCatalogCsv('reunioes-rag', 'conteúdo incompatível'),
    ).toThrow('não contém apontamentos RAG reconhecíveis');
  });

  it('cria, edita e restaura itens sem trocar IDs referenciados', () => {
    const catalogId = 'reunioes-por-area';
    const original = ragCatalogs[0]?.items[0];
    if (!original) throw new Error('fixture RAG ausente');

    editRagItem(catalogId, original.id, {
      ...editable(original),
      event: `${original.event} editado`,
    });
    expect(findRagItem(catalogId, original.id)?.event).toContain('editado');
    expect(getRagItemState(catalogId, original.id)).toBe('modified');

    deleteRagItem(catalogId, original.id);
    expect(findRagItem(catalogId, original.id)).toBeUndefined();
    restoreRagItem(catalogId, original.id);
    expect(findRagItem(catalogId, original.id)).toEqual(original);
    expect(getRagItemState(catalogId, original.id)).toBe('original');

    const created = createRagItem(catalogId, {
      group: 'Customizados',
      event: 'Evento avulso customizado',
      durationHint: '00:30',
      comment: 'Comentário, com vírgula e "aspas"',
      kind: 'AD_HOC',
      channel: {
        client: 'Cliente',
        operationNature: 'Operação',
        activityType: 'Tipo',
      },
    }).items.at(-1);
    expect(created?.id).toMatch(/^reunioes-por-area:custom:/);
    expect(getRagItemState(catalogId, created?.id ?? '')).toBe('created');
    restoreRagItem(catalogId, created?.id ?? '');
    expect(findRagItem(catalogId, created?.id)).toBeUndefined();
  });

  it('faz round-trip do CSV canônico UTF-8 preservando IDs e os três tipos', () => {
    const catalogId = 'reunioes-por-area';
    const before = ragCatalogs[0];
    if (!before) throw new Error('fixture RAG ausente');
    const csv = exportRagCatalogCsv(catalogId);
    expect(csv.startsWith('\uFEFFcatalogId,id,sourceLine')).toBe(true);
    const preview = previewRagCatalogCsvImport(catalogId, csv, 'replace');

    expect(preview).toMatchObject({
      format: 'canonical',
      canApply: true,
      counts: {
        new: 0,
        updated: 0,
        unchanged: before.itemCount,
        removed: 0,
        errors: 0,
        duplicates: 0,
      },
    });
    expect(new Set(preview.catalog.items.map(({ id }) => id))).toEqual(
      new Set(before.items.map(({ id }) => id)),
    );
    expect(new Set(preview.catalog.items.map(({ kind }) => kind))).toEqual(
      new Set(['PROJECT', 'AD_HOC', 'SKIP']),
    );
    applyRagCatalogCsvImport(preview);
  });

  it('distingue merge/substituição, relata duplicados e restaura fonte/todas', () => {
    const catalogId = 'reunioes-rag';
    const csv = exportRagCatalogCsv(catalogId);
    const [header, first] = csv
      .replace(/^\uFEFF/, '')
      .trim()
      .split('\r\n');
    if (!header || !first) throw new Error('CSV canônico ausente');
    const partial = `${header}\r\n${first}\r\n`;

    expect(
      previewRagCatalogCsvImport(catalogId, partial, 'merge').counts,
    ).toMatchObject({
      unchanged: 1,
      removed: 0,
    });
    expect(
      previewRagCatalogCsvImport(catalogId, partial, 'replace').counts,
    ).toMatchObject({ unchanged: 1, removed: 24 });
    const duplicate = previewRagCatalogCsvImport(
      catalogId,
      `${partial}${first}\r\n`,
      'merge',
    );
    expect(duplicate.counts.duplicates).toBe(1);
    expect(duplicate.canApply).toBe(false);

    applyRagCatalogCsvImport(
      previewRagCatalogCsvImport(catalogId, partial, 'replace'),
    );
    expect(ragCatalogs[1]?.itemCount).toBe(1);
    restoreRagCatalog(catalogId);
    expect(ragCatalogs[1]?.itemCount).toBe(25);
    restoreAllRagCatalogs();
    expect(ragCatalogs.map(({ itemCount }) => itemCount)).toEqual([27, 25]);
  });

  it('impede que CRUD introduza eventos duplicados na fonte consolidada', () => {
    const catalogId = 'reunioes-rag';
    const [first, second] = ragCatalogs[1]?.items ?? [];
    if (!first || !second) throw new Error('fixture RAG ausente');

    expect(() =>
      editRagItem(catalogId, second.id, {
        ...editable(second),
        event: `  ${first.event.toLocaleUpperCase('pt-BR')}  `,
      }),
    ).toThrow('eventos duplicados');
    expect(findRagItem(catalogId, second.id)).toEqual(second);

    expect(() =>
      createRagItem(catalogId, {
        ...editable(first),
        event: first.event,
      }),
    ).toThrow('eventos duplicados');
    expect(ragCatalogs[1]?.itemCount).toBe(25);
  });

  it('detecta no merge duplicação contra itens que não vieram no CSV', () => {
    const catalogId = 'reunioes-rag';
    const first = ragCatalogs[1]?.items[0];
    if (!first) throw new Error('fixture RAG ausente');
    const [header, row] = exportRagCatalogCsv(catalogId)
      .replace(/^\uFEFF/, '')
      .split('\r\n');
    if (!header || !row) throw new Error('CSV canônico ausente');
    const duplicatedEventWithNewId = row.replace(
      `,${first.id},`,
      ',reunioes-rag:custom:duplicado,',
    );

    const preview = previewRagCatalogCsvImport(
      catalogId,
      `${header}\r\n${duplicatedEventWithNewId}\r\n`,
      'merge',
    );

    expect(preview.counts).toMatchObject({ new: 1, duplicates: 1 });
    expect(preview.canApply).toBe(false);
    expect(() => applyRagCatalogCsvImport(preview)).toThrow(
      'erros ou itens duplicados',
    );
  });

  it('recusa customizações repetidas e prévia de outra fonte', () => {
    const areaPreview = previewRagCatalogCsvImport(
      'reunioes-por-area',
      exportRagCatalogCsv('reunioes-por-area'),
      'replace',
    );
    const ragPreview = previewRagCatalogCsvImport(
      'reunioes-rag',
      exportRagCatalogCsv('reunioes-rag'),
      'replace',
    );

    expect(() =>
      setRagCatalogOverrides([areaPreview.catalog, areaPreview.catalog]),
    ).toThrow('mais de uma customização');
    expect(() =>
      applyRagCatalogCsvImport({
        ...areaPreview,
        catalog: ragPreview.catalog,
      }),
    ).toThrow('outra fonte RAG');
  });
});

function editable(item: RagItem): RagItemInput {
  if (item.kind === 'SKIP')
    return {
      group: item.group,
      event: item.event,
      durationHint: item.durationHint,
      comment: item.comment,
      kind: item.kind,
      channel: null,
    };
  return {
    group: item.group,
    event: item.event,
    durationHint: item.durationHint,
    comment: item.comment,
    kind: item.kind,
    channel: item.channel,
  } as RagItemInput;
}
