import areaCatalogJson from '../../assets/rag/reunioes-por-area.json';
import areaCatalogUrl from '../../assets/rag/reunioes-por-area.json?url';
import ragCatalogJson from '../../assets/rag/reunioes-rag.json';
import ragCatalogUrl from '../../assets/rag/reunioes-rag.json?url';

export type RagItemKind = 'PROJECT' | 'AD_HOC' | 'SKIP';
export type RagItemState = 'original' | 'modified' | 'created';
export type RagImportMode = 'merge' | 'replace';

export interface RagProjectTarget {
  readonly project: string | null;
  readonly activityType: string;
  readonly activity: string | null;
  readonly task: string;
  readonly projectSource: 'FIXED' | 'TAG';
  readonly activitySource: 'FIXED' | 'TAG';
}

export interface RagAdHocTarget {
  readonly client: string;
  readonly operationNature: string;
  readonly activityType: string;
}

interface RagItemBase {
  readonly id: string;
  readonly sourceLine: number;
  readonly group: string;
  readonly event: string;
  readonly durationHint: string | null;
  readonly comment: string | null;
  readonly warnings: readonly string[];
}

export type RagItem =
  | (RagItemBase & {
      readonly kind: 'PROJECT';
      readonly channel: RagProjectTarget;
    })
  | (RagItemBase & {
      readonly kind: 'AD_HOC';
      readonly channel: RagAdHocTarget;
    })
  | (RagItemBase & { readonly kind: 'SKIP'; readonly channel: null });

type RagItemEditableBase = Pick<
  RagItemBase,
  'group' | 'event' | 'durationHint' | 'comment'
>;

/** ID, linha de origem e avisos são controlados pelo serviço. */
export type RagItemInput =
  | (RagItemEditableBase & {
      readonly kind: 'PROJECT';
      readonly channel: RagProjectTarget;
    })
  | (RagItemEditableBase & {
      readonly kind: 'AD_HOC';
      readonly channel: RagAdHocTarget;
    })
  | (RagItemEditableBase & { readonly kind: 'SKIP'; readonly channel: null });

export interface RagCatalog {
  readonly version: 1;
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly sourceFile: string;
  readonly itemCount: number;
  readonly items: readonly RagItem[];
  readonly assetUrl: string;
}

export type RagCatalogSnapshot = Omit<RagCatalog, 'assetUrl'>;

export interface RagImportIssue {
  readonly row: number;
  readonly message: string;
  readonly id?: string;
}

export interface RagImportPreview {
  readonly catalogId: string;
  readonly mode: RagImportMode;
  readonly format: 'canonical' | 'legacy';
  readonly newItems: readonly RagItem[];
  readonly updatedItems: readonly RagItem[];
  readonly unchangedItems: readonly RagItem[];
  readonly removedItems: readonly RagItem[];
  readonly errors: readonly RagImportIssue[];
  readonly duplicates: readonly RagImportIssue[];
  readonly counts: {
    readonly new: number;
    readonly updated: number;
    readonly unchanged: number;
    readonly removed: number;
    readonly errors: number;
    readonly duplicates: number;
  };
  readonly canApply: boolean;
  readonly catalog: RagCatalogSnapshot;
}

const CANONICAL_HEADERS = [
  'catalogId',
  'id',
  'sourceLine',
  'group',
  'event',
  'kind',
  'durationHint',
  'comment',
  'project',
  'activityType',
  'activity',
  'task',
  'projectSource',
  'activitySource',
  'client',
  'operationNature',
] as const;

const loadCatalog = (value: unknown, assetUrl: string): RagCatalog => {
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    !Array.isArray(record.items) ||
    record.itemCount !== record.items.length
  )
    throw new Error('Catálogo RAG empacotado é inválido.');
  const catalog = value as Omit<RagCatalog, 'assetUrl'>;
  if (
    catalog.id === 'reunioes-rag' &&
    deduplicateEvents(catalog.items).items.length !== catalog.items.length
  )
    throw new Error('Catálogo RAG empacotado contém eventos duplicados.');
  return { ...catalog, assetUrl };
};

const bundledRagCatalogs: readonly RagCatalog[] = [
  loadCatalog(areaCatalogJson, areaCatalogUrl),
  loadCatalog(ragCatalogJson, ragCatalogUrl),
];

interface ParsedImport {
  readonly format: 'canonical' | 'legacy';
  readonly items: readonly RagItem[];
  readonly errors: readonly RagImportIssue[];
  readonly duplicates: readonly RagImportIssue[];
}

/** Serviço de aplicação que concentra o ciclo de vida dos itens RAG. */
export class RagCatalogService {
  readonly #originals: readonly RagCatalog[];
  readonly #active: RagCatalog[];
  readonly #newId: () => string;

  constructor(
    definitions: readonly RagCatalog[] = bundledRagCatalogs,
    newId: () => string = defaultNewId,
  ) {
    this.#originals = definitions.map(cloneCatalog);
    this.#active = definitions.map(cloneCatalog);
    this.#newId = newId;
  }

  get catalogs(): readonly RagCatalog[] {
    return this.#active;
  }

  setOverrides(overrides: readonly RagCatalogSnapshot[]): void {
    if (new Set(overrides.map(({ id }) => id)).size !== overrides.length)
      throw new Error(
        'Uma fonte RAG não pode possuir mais de uma customização.',
      );
    const byId = new Map(overrides.map((catalog) => [catalog.id, catalog]));
    for (const override of overrides) {
      if (!this.#originals.some(({ id }) => id === override.id))
        throw new Error('Fonte RAG desconhecida.');
      if (!isCatalogSnapshotForDefinitions(override, this.#originals))
        throw new Error('Catálogo RAG customizado é inválido.');
    }
    this.#active.splice(
      0,
      this.#active.length,
      ...this.#originals.map((original) => {
        const override = byId.get(original.id);
        return override
          ? cloneCatalog({
              ...original,
              itemCount: override.itemCount,
              items: override.items,
            })
          : cloneCatalog(original);
      }),
    );
  }

  getOverrides(): readonly RagCatalogSnapshot[] {
    return this.#active
      .filter(
        (catalog) =>
          !sameItemList(catalog.items, this.#original(catalog.id).items),
      )
      .map(toSnapshot);
  }

  getOriginal(catalogId: string): RagCatalogSnapshot {
    return toSnapshot(this.#original(catalogId));
  }

  getOriginals(): readonly RagCatalogSnapshot[] {
    return this.#originals.map(toSnapshot);
  }

  findItem(
    catalogId: string | undefined,
    itemId: string | undefined,
  ): RagItem | undefined {
    if (!catalogId || !itemId) return undefined;
    return this.#active
      .find((catalog) => catalog.id === catalogId)
      ?.items.find((item) => item.id === itemId);
  }

  getItemState(catalogId: string, itemId: string): RagItemState | undefined {
    const current = this.findItem(catalogId, itemId);
    if (!current) return undefined;
    const original = this.#original(catalogId).items.find(
      (item) => item.id === itemId,
    );
    if (!original) return 'created';
    return sameItem(current, original) ? 'original' : 'modified';
  }

  createItem(catalogId: string, input: RagItemInput): RagCatalogSnapshot {
    validateItemInput(input);
    const catalog = this.#catalog(catalogId);
    let id: string;
    do id = `${catalogId}:custom:${this.#newId()}`;
    while (catalog.items.some((item) => item.id === id));
    const sourceLine =
      Math.max(0, ...catalog.items.map((item) => item.sourceLine)) + 1;
    this.#replaceCatalog(catalogId, [
      ...catalog.items,
      makeItem(id, sourceLine, input),
    ]);
    return toSnapshot(this.#catalog(catalogId));
  }

  updateItem(
    catalogId: string,
    itemId: string,
    input: RagItemInput,
  ): RagCatalogSnapshot {
    validateItemInput(input);
    const catalog = this.#catalog(catalogId);
    const current = catalog.items.find((item) => item.id === itemId);
    if (!current) throw new Error('Item RAG não encontrado.');
    const replacement = makeItem(current.id, current.sourceLine, input);
    this.#replaceCatalog(
      catalogId,
      catalog.items.map((item) => (item.id === itemId ? replacement : item)),
    );
    return toSnapshot(this.#catalog(catalogId));
  }

  deleteItem(catalogId: string, itemId: string): RagCatalogSnapshot {
    const catalog = this.#catalog(catalogId);
    if (!catalog.items.some((item) => item.id === itemId))
      throw new Error('Item RAG não encontrado.');
    this.#replaceCatalog(
      catalogId,
      catalog.items.filter((item) => item.id !== itemId),
    );
    return toSnapshot(this.#catalog(catalogId));
  }

  restoreItem(catalogId: string, itemId: string): RagCatalogSnapshot {
    const catalog = this.#catalog(catalogId);
    const originalCatalog = this.#original(catalogId);
    const original = originalCatalog.items.find((item) => item.id === itemId);
    const current = catalog.items.find((item) => item.id === itemId);
    if (!original && !current) throw new Error('Item RAG não encontrado.');
    if (!original) {
      this.#replaceCatalog(
        catalogId,
        catalog.items.filter((item) => item.id !== itemId),
      );
    } else if (current) {
      this.#replaceCatalog(
        catalogId,
        catalog.items.map((item) => (item.id === itemId ? original : item)),
      );
    } else {
      this.#replaceCatalog(
        catalogId,
        [...catalog.items, original].sort((left, right) =>
          compareOriginalOrder(left, right, originalCatalog.items),
        ),
      );
    }
    return toSnapshot(this.#catalog(catalogId));
  }

  restoreCatalog(catalogId: string): RagCatalogSnapshot {
    this.#replaceCatalog(catalogId, this.#original(catalogId).items);
    return toSnapshot(this.#catalog(catalogId));
  }

  restoreAll(): readonly RagCatalogSnapshot[] {
    this.setOverrides([]);
    return this.#active.map(toSnapshot);
  }

  exportCsv(catalogId: string): string {
    const catalog = this.#catalog(catalogId);
    return `\uFEFF${[
      [...CANONICAL_HEADERS],
      ...catalog.items.map((item) => canonicalRow(catalog.id, item)),
    ]
      .map(csvRow)
      .join('\r\n')}\r\n`;
  }

  previewImport(
    catalogId: string,
    source: string,
    mode: RagImportMode,
  ): RagImportPreview {
    const current = this.#catalog(catalogId);
    let parsed: ParsedImport;
    try {
      const rows = parseCsv(source);
      parsed = isCanonicalCsv(rows)
        ? parseCanonical(catalogId, rows)
        : parseLegacy(catalogId, rows, current.items);
    } catch (error) {
      parsed = {
        format: 'canonical',
        items: [],
        errors: [
          {
            row: 0,
            message:
              error instanceof Error
                ? error.message
                : 'Não foi possível ler o CSV.',
          },
        ],
        duplicates: [],
      };
    }
    const currentById = new Map(current.items.map((item) => [item.id, item]));
    const incomingById = new Map(parsed.items.map((item) => [item.id, item]));
    const newItems = parsed.items.filter((item) => !currentById.has(item.id));
    const updatedItems = parsed.items.filter((item) => {
      const previous = currentById.get(item.id);
      return previous !== undefined && !sameItem(previous, item);
    });
    const unchangedItems = parsed.items.filter((item) => {
      const previous = currentById.get(item.id);
      return previous !== undefined && sameItem(previous, item);
    });
    const removedItems =
      mode === 'replace'
        ? current.items.filter((item) => !incomingById.has(item.id))
        : [];
    const proposedItems =
      mode === 'replace'
        ? [...parsed.items]
        : [
            ...current.items.map((item) => incomingById.get(item.id) ?? item),
            ...newItems,
          ];
    const duplicates = [
      ...parsed.duplicates,
      ...(catalogId === 'reunioes-rag'
        ? duplicateEventIssues(proposedItems)
        : []),
    ];
    const counts = {
      new: newItems.length,
      updated: updatedItems.length,
      unchanged: unchangedItems.length,
      removed: removedItems.length,
      errors: parsed.errors.length,
      duplicates: duplicates.length,
    };
    return {
      catalogId,
      mode,
      format: parsed.format,
      newItems,
      updatedItems,
      unchangedItems,
      removedItems,
      errors: parsed.errors,
      duplicates,
      counts,
      canApply: counts.errors === 0 && counts.duplicates === 0,
      catalog: snapshotWithItems(current, proposedItems),
    };
  }

  applyImport(preview: RagImportPreview): RagCatalogSnapshot {
    if (!preview.canApply)
      throw new Error('A importação RAG possui erros ou itens duplicados.');
    this.#catalog(preview.catalogId);
    if (preview.catalog.id !== preview.catalogId)
      throw new Error('A prévia pertence a outra fonte RAG.');
    if (!isCatalogSnapshotForDefinitions(preview.catalog, this.#originals))
      throw new Error('Prévia de importação RAG inválida.');
    this.#replaceCatalog(preview.catalogId, preview.catalog.items);
    return toSnapshot(this.#catalog(preview.catalogId));
  }

  importCsv(
    catalogId: string,
    source: string,
    mode: RagImportMode,
  ): RagCatalogSnapshot {
    return this.applyImport(this.previewImport(catalogId, source, mode));
  }

  /** Mantém o importador anterior tolerante a duplicados da planilha legada. */
  convertLegacyCompatible(
    catalogId: string,
    source: string,
  ): RagCatalogSnapshot {
    const preview = this.previewImport(catalogId, source, 'replace');
    if (preview.errors.length > 0)
      throw new Error(preview.errors[0]?.message ?? 'CSV RAG inválido.');
    return preview.catalog;
  }

  #catalog(catalogId: string): RagCatalog {
    const catalog = this.#active.find((entry) => entry.id === catalogId);
    if (!catalog) throw new Error('Fonte RAG desconhecida.');
    return catalog;
  }

  #original(catalogId: string): RagCatalog {
    const catalog = this.#originals.find((entry) => entry.id === catalogId);
    if (!catalog) throw new Error('Fonte RAG desconhecida.');
    return catalog;
  }

  #replaceCatalog(catalogId: string, items: readonly RagItem[]): void {
    const index = this.#active.findIndex((entry) => entry.id === catalogId);
    if (index < 0) throw new Error('Fonte RAG desconhecida.');
    if (new Set(items.map(({ id }) => id)).size !== items.length)
      throw new Error('O catálogo RAG contém IDs duplicados.');
    if (
      catalogId === 'reunioes-rag' &&
      deduplicateEvents(items).items.length !== items.length
    )
      throw new Error('O catálogo RAG contém eventos duplicados.');
    const previous = this.#active[index] as RagCatalog;
    this.#active[index] = {
      ...previous,
      itemCount: items.length,
      items: [...items],
    };
  }
}

const defaultRagCatalogService = new RagCatalogService();

/** Referência estável mantida para os consumidores existentes. */
export const ragCatalogs: readonly RagCatalog[] =
  defaultRagCatalogService.catalogs;

export function setRagCatalogOverrides(
  overrides: readonly RagCatalogSnapshot[],
): void {
  defaultRagCatalogService.setOverrides(overrides);
}

export function getRagCatalogOverrides(): readonly RagCatalogSnapshot[] {
  return defaultRagCatalogService.getOverrides();
}

export function getOriginalRagCatalog(catalogId: string): RagCatalogSnapshot {
  return defaultRagCatalogService.getOriginal(catalogId);
}

export function getOriginalRagCatalogs(): readonly RagCatalogSnapshot[] {
  return defaultRagCatalogService.getOriginals();
}

export function isRagCatalogSnapshot(
  value: unknown,
): value is RagCatalogSnapshot {
  return isCatalogSnapshotForDefinitions(value, bundledRagCatalogs);
}

export function convertRagCatalogCsv(
  catalogId: string,
  source: string,
): RagCatalogSnapshot {
  return defaultRagCatalogService.convertLegacyCompatible(catalogId, source);
}

export function exportRagCatalogCsv(catalogId: string): string {
  return defaultRagCatalogService.exportCsv(catalogId);
}

export function previewRagCatalogCsvImport(
  catalogId: string,
  source: string,
  mode: RagImportMode,
): RagImportPreview {
  return defaultRagCatalogService.previewImport(catalogId, source, mode);
}

export function applyRagCatalogCsvImport(
  preview: RagImportPreview,
): RagCatalogSnapshot {
  return defaultRagCatalogService.applyImport(preview);
}

export function createRagItem(
  catalogId: string,
  input: RagItemInput,
): RagCatalogSnapshot {
  return defaultRagCatalogService.createItem(catalogId, input);
}

export function editRagItem(
  catalogId: string,
  itemId: string,
  input: RagItemInput,
): RagCatalogSnapshot {
  return defaultRagCatalogService.updateItem(catalogId, itemId, input);
}

export function deleteRagItem(
  catalogId: string,
  itemId: string,
): RagCatalogSnapshot {
  return defaultRagCatalogService.deleteItem(catalogId, itemId);
}

export function restoreRagItem(
  catalogId: string,
  itemId: string,
): RagCatalogSnapshot {
  return defaultRagCatalogService.restoreItem(catalogId, itemId);
}

export function restoreRagCatalog(catalogId: string): RagCatalogSnapshot {
  return defaultRagCatalogService.restoreCatalog(catalogId);
}

export function restoreAllRagCatalogs(): readonly RagCatalogSnapshot[] {
  return defaultRagCatalogService.restoreAll();
}

export function getRagItemState(
  catalogId: string,
  itemId: string,
): RagItemState | undefined {
  return defaultRagCatalogService.getItemState(catalogId, itemId);
}

export function findRagItem(
  catalogId: string | undefined,
  itemId: string | undefined,
): RagItem | undefined {
  return defaultRagCatalogService.findItem(catalogId, itemId);
}

function parseCanonical(
  catalogId: string,
  rows: readonly string[][],
): ParsedImport {
  const header = rows[0]?.map(clean) ?? [];
  const indexes = new Map(header.map((name, index) => [name, index]));
  const errors: RagImportIssue[] = [];
  const duplicates: RagImportIssue[] = [];
  const items: RagItem[] = [];
  const seenIds = new Set<string>();
  const seenEvents = new Set<string>();
  for (let index = 1; index < rows.length; index++) {
    const row = rows[index] ?? [];
    if (row.every((value) => clean(value) === '')) continue;
    const get = (column: (typeof CANONICAL_HEADERS)[number]): string =>
      clean(row[indexes.get(column) ?? -1] ?? '');
    const rowNumber = index + 1;
    const rowCatalogId = get('catalogId');
    const id = get('id');
    if (rowCatalogId !== catalogId) {
      errors.push({
        row: rowNumber,
        id,
        message: 'O item pertence a outra fonte RAG.',
      });
      continue;
    }
    if (!id) {
      errors.push({ row: rowNumber, message: 'O ID do item é obrigatório.' });
      continue;
    }
    if (seenIds.has(id)) {
      duplicates.push({
        row: rowNumber,
        id,
        message: 'ID de item duplicado no CSV.',
      });
      continue;
    }
    seenIds.add(id);
    const sourceLine = Number(get('sourceLine'));
    if (!Number.isInteger(sourceLine) || sourceLine < 1) {
      errors.push({
        row: rowNumber,
        id,
        message: 'A linha de origem deve ser um inteiro positivo.',
      });
      continue;
    }
    const kind = get('kind') as RagItemKind;
    const base = {
      group: get('group'),
      event: get('event'),
      durationHint: get('durationHint') || null,
      comment: get('comment') || null,
    };
    let input: RagItemInput | undefined;
    if (kind === 'SKIP') input = { ...base, kind, channel: null };
    if (kind === 'AD_HOC') {
      input = {
        ...base,
        kind,
        channel: {
          client: get('client'),
          operationNature: get('operationNature'),
          activityType: get('activityType'),
        },
      };
    }
    if (kind === 'PROJECT') {
      const projectSource = get('projectSource');
      const activitySource = get('activitySource');
      if (
        (projectSource !== 'FIXED' && projectSource !== 'TAG') ||
        (activitySource !== 'FIXED' && activitySource !== 'TAG')
      ) {
        errors.push({
          row: rowNumber,
          id,
          message: 'A origem de projeto/atividade é inválida.',
        });
        continue;
      }
      input = {
        ...base,
        kind,
        channel: {
          project: projectSource === 'TAG' ? null : get('project'),
          activityType: get('activityType'),
          activity: activitySource === 'TAG' ? null : get('activity'),
          task: get('task'),
          projectSource,
          activitySource,
        },
      };
    }
    if (!input) {
      errors.push({
        row: rowNumber,
        id,
        message: 'O tipo do item deve ser PROJECT, AD_HOC ou SKIP.',
      });
      continue;
    }
    try {
      validateItemInput(input);
    } catch (error) {
      errors.push({
        row: rowNumber,
        id,
        message: error instanceof Error ? error.message : 'Item inválido.',
      });
      continue;
    }
    const eventKey = normalizedEvent(input.event);
    if (catalogId === 'reunioes-rag' && seenEvents.has(eventKey)) {
      duplicates.push({
        row: rowNumber,
        id,
        message: 'Evento duplicado no CSV.',
      });
      continue;
    }
    seenEvents.add(eventKey);
    items.push(makeItem(id, sourceLine, input));
  }
  if (items.length === 0 && errors.length === 0 && duplicates.length === 0)
    errors.push({
      row: 0,
      message: 'O CSV não contém apontamentos RAG reconhecíveis.',
    });
  return { format: 'canonical', items, errors, duplicates };
}

function parseLegacy(
  catalogId: string,
  rows: readonly string[][],
  currentItems: readonly RagItem[],
): ParsedImport {
  const previousIds = reusableIds(currentItems);
  let group = 'Geral';
  let headerFound = false;
  const items: RagItem[] = [];
  const duplicates: RagImportIssue[] = [];
  const seenEvents = new Set<string>();
  rows.forEach((rawRow, index) => {
    const row = rawRow.map(clean);
    const populated = row.filter(Boolean);
    if (populated.length === 0) return;
    if (populated.length === 1) {
      group = populated[0] ?? 'Geral';
      headerFound = false;
      return;
    }
    if (normalize(row[0] ?? '') === 'evento') {
      headerFound = true;
      return;
    }
    if (!headerFound || !row[0]) return;
    const destination = normalize(row[1] ?? '');
    const kind: RagItemKind = destination.includes('nao apontar')
      ? 'SKIP'
      : destination.includes('avulso')
        ? 'AD_HOC'
        : 'PROJECT';
    const key = itemIdentity(group, row[0]);
    const id =
      previousIds.get(key)?.shift() ??
      uniqueLegacyId(catalogId, index + 1, row[0], items);
    const base = {
      group,
      event: row[0],
      durationHint: row[5] || null,
      comment: row[6] || null,
    };
    let input: RagItemInput;
    if (kind === 'SKIP') input = { ...base, kind, channel: null };
    else if (kind === 'AD_HOC') {
      input = {
        ...base,
        kind,
        channel: {
          client: row[2] ?? '',
          operationNature: row[3] ?? '',
          activityType: normalizeNone(row[4] ?? ''),
        },
      };
    } else {
      const contextualActivity = isContext(row[4] ?? '');
      const contextualDestination = destination.includes('respectivo projeto');
      const contextualProject =
        contextualDestination ||
        isContext(row[2] ?? '') ||
        (contextualActivity && normalize(row[2] ?? '') === 'certi');
      input = {
        ...base,
        kind,
        channel: {
          project: contextualProject ? null : (row[2] ?? ''),
          activityType: normalizeNone(row[3] ?? ''),
          activity: contextualActivity ? null : (row[4] ?? ''),
          task: 'Nenhum',
          projectSource: contextualProject ? 'TAG' : 'FIXED',
          activitySource: contextualActivity ? 'TAG' : 'FIXED',
        },
      };
    }
    const eventKey = normalizedEvent(input.event);
    if (catalogId === 'reunioes-rag' && seenEvents.has(eventKey)) {
      duplicates.push({
        row: index + 1,
        id,
        message: 'Evento duplicado no CSV.',
      });
      return;
    }
    seenEvents.add(eventKey);
    items.push(makeItem(id, index + 1, input));
  });
  const errors: RagImportIssue[] = [];
  if (items.length === 0)
    errors.push({
      row: 0,
      message: 'O CSV não contém apontamentos RAG reconhecíveis.',
    });
  return { format: 'legacy', items, errors, duplicates };
}

function canonicalRow(catalogId: string, item: RagItem): string[] {
  const common = [
    catalogId,
    item.id,
    String(item.sourceLine),
    item.group,
    item.event,
    item.kind,
    item.durationHint ?? '',
    item.comment ?? '',
  ];
  if (item.kind === 'PROJECT')
    return [
      ...common,
      item.channel.project ?? '',
      item.channel.activityType,
      item.channel.activity ?? '',
      item.channel.task,
      item.channel.projectSource,
      item.channel.activitySource,
      '',
      '',
    ];
  if (item.kind === 'AD_HOC')
    return [
      ...common,
      '',
      item.channel.activityType,
      '',
      '',
      '',
      '',
      item.channel.client,
      item.channel.operationNature,
    ];
  return [...common, '', '', '', '', '', '', '', ''];
}

function makeItem(
  id: string,
  sourceLine: number,
  input: RagItemInput,
): RagItem {
  const common: RagItemBase = {
    id,
    sourceLine,
    group: clean(input.group),
    event: clean(input.event),
    durationHint: nullableClean(input.durationHint),
    comment: nullableClean(input.comment),
    warnings: warningsFor(input),
  };
  if (input.kind === 'SKIP')
    return { ...common, kind: input.kind, channel: null };
  if (input.kind === 'AD_HOC')
    return {
      ...common,
      kind: input.kind,
      channel: {
        client: clean(input.channel.client),
        operationNature: clean(input.channel.operationNature),
        activityType: clean(input.channel.activityType),
      },
    };
  return {
    ...common,
    kind: input.kind,
    channel: {
      project:
        input.channel.projectSource === 'TAG'
          ? null
          : clean(input.channel.project ?? ''),
      activityType: clean(input.channel.activityType),
      activity:
        input.channel.activitySource === 'TAG'
          ? null
          : clean(input.channel.activity ?? ''),
      task: clean(input.channel.task),
      projectSource: input.channel.projectSource,
      activitySource: input.channel.activitySource,
    },
  };
}

function warningsFor(input: RagItemInput): readonly string[] {
  if (input.kind === 'SKIP')
    return ['Este evento não deve gerar apontamento no Channel.'];
  if (input.kind === 'AD_HOC')
    return clean(input.channel.operationNature)
      ? []
      : ['A natureza da operação não foi informada na fonte.'];
  return [
    ...(input.channel.projectSource === 'TAG'
      ? [
          'O projeto não é fixo. Ao usar este item, escolha uma TAG salva; o projeto dessa TAG será usado no apontamento do Channel.',
        ]
      : []),
    ...(input.channel.activitySource === 'TAG'
      ? [
          'A atividade não é fixa. Ao usar este item, escolha uma TAG salva; a atividade dessa TAG será usada no apontamento do Channel.',
        ]
      : []),
  ];
}

function validateItemInput(input: RagItemInput): void {
  if (!clean(input.group)) throw new Error('O grupo do item é obrigatório.');
  if (!clean(input.event)) throw new Error('O evento do item é obrigatório.');
  if (input.kind === 'PROJECT') {
    if (
      input.channel.projectSource === 'FIXED' &&
      !clean(input.channel.project ?? '')
    )
      throw new Error('O projeto fixo é obrigatório.');
    if (
      input.channel.activitySource === 'FIXED' &&
      !clean(input.channel.activity ?? '')
    )
      throw new Error('A atividade fixa é obrigatória.');
  }
}

function deduplicateEvents(items: readonly RagItem[]): {
  readonly items: RagItem[];
  readonly duplicates: RagItem[];
} {
  const seen = new Set<string>();
  const unique: RagItem[] = [];
  const duplicates: RagItem[] = [];
  for (const item of items) {
    const key = normalizedEvent(item.event);
    if (seen.has(key)) duplicates.push(item);
    else {
      seen.add(key);
      unique.push(item);
    }
  }
  return { items: unique, duplicates };
}

function duplicateEventIssues(
  items: readonly RagItem[],
): readonly RagImportIssue[] {
  return deduplicateEvents(items).duplicates.map((item) => ({
    row: item.sourceLine,
    id: item.id,
    message: 'Evento duplicado no catálogo resultante.',
  }));
}

function reusableIds(items: readonly RagItem[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const item of items) {
    const key = itemIdentity(item.group, item.event);
    const ids = result.get(key) ?? [];
    ids.push(item.id);
    result.set(key, ids);
  }
  return result;
}

function itemIdentity(group: string, event: string): string {
  return `${normalize(group)}\u0000${normalize(event)}`;
}

function normalizedEvent(event: string): string {
  return normalize(event).replace(/\s+/g, ' ');
}

function parseCsv(source: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < source.length; index++) {
    const character = source[index] ?? '';
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
  if (quoted) throw new Error('O CSV possui aspas não fechadas.');
  if (value || row.length > 0) {
    row.push(value);
    rows.push(row);
  }
  return rows;
}

function isCanonicalCsv(rows: readonly string[][]): boolean {
  const header = rows[0]?.map(clean) ?? [];
  return CANONICAL_HEADERS.every((name) => header.includes(name));
}

function csvRow(values: readonly string[]): string {
  return values
    .map((value) => {
      const escaped = value.replace(/"/g, '""');
      return /[",\r\n]/.test(value) ? `"${escaped}"` : escaped;
    })
    .join(',');
}

function clean(value: string): string {
  return value
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function nullableClean(value: string | null): string | null {
  return value === null ? null : clean(value) || null;
}

function normalize(value: string): string {
  return clean(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR');
}

function normalizeNone(value: string): string {
  const normalized = normalize(value);
  return !normalized ||
    normalized === '-' ||
    normalized.includes('nao preencher') ||
    normalized.startsWith('nenhum')
    ? 'Nenhum'
    : clean(value);
}

function isContext(value: string): boolean {
  const normalized = normalize(value);
  return (
    normalized.includes('respectivo projeto') ||
    normalized.startsWith('atividade corrente') ||
    normalized.startsWith('atividade relacionada') ||
    normalized.startsWith('atividade do projeto')
  );
}

function slug(value: string): string {
  return (
    normalize(value)
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'item'
  );
}

function uniqueLegacyId(
  catalogId: string,
  sourceLine: number,
  event: string,
  items: readonly RagItem[],
): string {
  const base = `${catalogId}:${String(sourceLine).padStart(3, '0')}:${slug(event)}`;
  let id = base;
  let suffix = 2;
  while (items.some((item) => item.id === id)) {
    id = `${base}-${String(suffix)}`;
    suffix++;
  }
  return id;
}

function defaultNewId(): string {
  return globalThis.crypto.randomUUID();
}

function sameItem(left: RagItem, right: RagItem): boolean {
  return (
    JSON.stringify(comparableItem(left)) ===
    JSON.stringify(comparableItem(right))
  );
}

function comparableItem(item: RagItem): RagItemInput {
  return {
    group: item.group,
    event: item.event,
    durationHint: item.durationHint,
    comment: item.comment,
    kind: item.kind,
    channel: item.channel,
  } as RagItemInput;
}

function sameItemList(
  left: readonly RagItem[],
  right: readonly RagItem[],
): boolean {
  return (
    left.length === right.length &&
    left.every((item, index) => {
      const other = right[index];
      return (
        other !== undefined && item.id === other.id && sameItem(item, other)
      );
    })
  );
}

function compareOriginalOrder(
  left: RagItem,
  right: RagItem,
  originals: readonly RagItem[],
): number {
  const leftIndex = originals.findIndex((item) => item.id === left.id);
  const rightIndex = originals.findIndex((item) => item.id === right.id);
  if (leftIndex < 0 && rightIndex < 0)
    return left.sourceLine - right.sourceLine;
  if (leftIndex < 0) return 1;
  if (rightIndex < 0) return -1;
  return leftIndex - rightIndex;
}

function snapshotWithItems(
  catalog: RagCatalog,
  items: readonly RagItem[],
): RagCatalogSnapshot {
  return {
    version: 1,
    id: catalog.id,
    name: catalog.name,
    description: catalog.description,
    sourceFile: catalog.sourceFile,
    itemCount: items.length,
    items: [...items],
  };
}

function toSnapshot(catalog: RagCatalog): RagCatalogSnapshot {
  return snapshotWithItems(catalog, catalog.items);
}

function cloneCatalog(catalog: RagCatalog): RagCatalog {
  return { ...catalog, items: [...catalog.items] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCatalogSnapshotForDefinitions(
  value: unknown,
  definitions: readonly RagCatalog[],
): value is RagCatalogSnapshot {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.items))
    return false;
  const definition = definitions.find((catalog) => catalog.id === value.id);
  return (
    definition !== undefined &&
    typeof value.name === 'string' &&
    typeof value.description === 'string' &&
    typeof value.sourceFile === 'string' &&
    value.itemCount === value.items.length &&
    value.items.every(isRagItem) &&
    new Set(value.items.map((item) => item.id)).size === value.items.length &&
    (definition.id !== 'reunioes-rag' ||
      deduplicateEvents(value.items).items.length === value.items.length)
  );
}

function isRagItem(value: unknown): value is RagItem {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    !value.id ||
    !Number.isInteger(value.sourceLine) ||
    (value.sourceLine as number) < 1 ||
    typeof value.group !== 'string' ||
    !value.group.trim() ||
    typeof value.event !== 'string' ||
    !value.event.trim() ||
    (value.durationHint !== null && typeof value.durationHint !== 'string') ||
    (value.comment !== null && typeof value.comment !== 'string') ||
    !Array.isArray(value.warnings) ||
    !value.warnings.every((warning) => typeof warning === 'string')
  )
    return false;
  if (value.kind === 'SKIP') return value.channel === null;
  if (!isRecord(value.channel)) return false;
  if (value.kind === 'AD_HOC')
    return (
      typeof value.channel.client === 'string' &&
      typeof value.channel.operationNature === 'string' &&
      typeof value.channel.activityType === 'string'
    );
  return (
    value.kind === 'PROJECT' &&
    (value.channel.project === null ||
      typeof value.channel.project === 'string') &&
    typeof value.channel.activityType === 'string' &&
    (value.channel.activity === null ||
      typeof value.channel.activity === 'string') &&
    typeof value.channel.task === 'string' &&
    (value.channel.projectSource === 'FIXED' ||
      value.channel.projectSource === 'TAG') &&
    (value.channel.activitySource === 'FIXED' ||
      value.channel.activitySource === 'TAG') &&
    (value.channel.projectSource === 'FIXED'
      ? typeof value.channel.project === 'string' &&
        value.channel.project.trim() !== ''
      : value.channel.project === null) &&
    (value.channel.activitySource === 'FIXED'
      ? typeof value.channel.activity === 'string' &&
        value.channel.activity.trim() !== ''
      : value.channel.activity === null)
  );
}
