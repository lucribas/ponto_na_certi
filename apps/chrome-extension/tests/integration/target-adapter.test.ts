import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { civilDate } from '../../src/domain/civil-date';
import type { ProjectAssignment } from '../../src/domain/expert';
import {
  detectChannelPage,
  fillChannelProject,
  parseChannelExtract,
  readChannelExtract,
  runInjectedChannelFill,
  runInjectedChannelRead,
  runInjectedChannelApiRead,
  runInjectedChannelApiDelete,
  runInjectedChannelApiWrite,
  runInjectedChannelCatalog,
  waitForCondition,
} from '../../src/sites/target';

const projectRoot = resolve(import.meta.dirname, '../..');

async function loadFixture(name: string): Promise<void> {
  const html = await readFile(
    resolve(projectRoot, `tests/fixtures/target/${name}.html`),
    'utf8',
  );
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  document.documentElement.replaceWith(parsed.documentElement);
}

function assignment(
  overrides: Partial<ProjectAssignment> = {},
): ProjectAssignment {
  return {
    kind: 'PROJETOS',
    project: 'PROJETO_SINTETICO',
    activityType: 'Nenhum',
    activity: 'ATIVIDADE_SINTETICA',
    task: 'Nenhum',
    date: civilDate('2026-08-18'),
    durationMinutes: 450,
    duration: '07:30',
    comments: '',
    ...overrides,
  };
}

beforeEach(() => {
  document.documentElement.innerHTML = '<head></head><body></body>';
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('API direta do Channel', () => {
  it('consulta o extrato via DWR sem clicar nem alterar os filtros', async () => {
    document.body.innerHTML = `
      <input id="participanteSelecionado" value="synthetic-user">
      <select id="totalItensPagina"><option value="999999">Não paginar</option></select>
    `;
    const listarApontamentoPorData = vi.fn((...args: unknown[]) =>
      (args.at(-1) as (value: unknown) => void)({
        lista: [
          {
            dataFormatada: '18/08/2026',
            totalDuracao: 8.85,
          },
        ],
      }),
    );
    const listarApontamentoPorDataIndividualmente = vi.fn(
      (...args: unknown[]) =>
        (args.at(-1) as (value: unknown) => void)([
          {
            id: 42,
            duracao: '08:51',
            permissaoRemover: true,
            nomeApontamento: 'PROJETO_SINTETICO',
            nomeAtividadeTicket: 'ATIVIDADE_SINTETICA',
          },
        ]),
    );
    vi.stubGlobal('ID_EMPRESA', 'synthetic-company');
    vi.stubGlobal('ApontamentoAjax', {
      listarApontamentoPorData,
      listarApontamentoPorDataIndividualmente,
    });

    const result = await runInjectedChannelApiRead({
      startDate: '18/08/2026',
      endDate: '18/08/2026',
      timeoutMs: 100,
    });

    expect(result).toEqual({
      ok: true,
      rows: [
        {
          rowIndex: 0,
          date: '2026-08-18',
          duration: '08:51',
          durationMinutes: 531,
          project: 'PROJETO_SINTETICO',
          activity: 'ATIVIDADE_SINTETICA',
          markings: [
            {
              id: '42',
              date: '2026-08-18',
              duration: '08:51',
              durationMinutes: 531,
              project: 'PROJETO_SINTETICO',
              activity: 'ATIVIDADE_SINTETICA',
              canDelete: true,
            },
          ],
        },
      ],
      errors: [],
    });
    expect(listarApontamentoPorData).toHaveBeenCalledTimes(1);
    expect(listarApontamentoPorDataIndividualmente).toHaveBeenCalledWith(
      '18/08/2026',
      'synthetic-user',
      '0',
      '',
      expect.any(Function),
    );
  });

  it('exclui pelo identificador exato e confirma a remoção no mesmo dia', async () => {
    document.body.innerHTML = `
      <input id="participanteSelecionado" value="synthetic-user">
      <input id="FILTRO_TIPO_APONTAMENTO" value="0">
    `;
    let deleted = false;
    const listarApontamentoPorDataIndividualmente = vi.fn(
      (...args: unknown[]) =>
        (args.at(-1) as (value: unknown) => void)(
          deleted
            ? []
            : [
                {
                  id: 42,
                  duracao: '08:51',
                  permissaoRemover: true,
                },
              ],
        ),
    );
    const remover = vi.fn((...args: unknown[]) => {
      deleted = true;
      (args.at(-1) as (value: unknown) => void)({
        mensagem: 'Removido',
        tipoMensagem: 'success',
      });
    });
    vi.stubGlobal('ApontamentoAjax', {
      listarApontamentoPorDataIndividualmente,
      remover,
    });

    await expect(
      runInjectedChannelApiDelete({
        id: '42',
        date: '2026-08-18',
        timeoutMs: 100,
      }),
    ).resolves.toEqual({ ok: true, id: '42', date: '2026-08-18' });
    expect(remover).toHaveBeenCalledWith(42, expect.any(Function));
    expect(listarApontamentoPorDataIndividualmente).toHaveBeenCalledTimes(2);
  });

  it('não exclui uma marcação sem permissão retornada pelo Channel', async () => {
    document.body.innerHTML = `
      <input id="participanteSelecionado" value="synthetic-user">
    `;
    const remover = vi.fn();
    vi.stubGlobal('ApontamentoAjax', {
      listarApontamentoPorDataIndividualmente: (...args: unknown[]) =>
        (args.at(-1) as (value: unknown) => void)([
          { id: 42, duracao: '08:51', permissaoRemover: false },
        ]),
      remover,
    });

    await expect(
      runInjectedChannelApiDelete({
        id: '42',
        date: '2026-08-18',
        timeoutMs: 100,
      }),
    ).resolves.toEqual({
      ok: false,
      code: 'marking-delete-not-permitted',
    });
    expect(remover).not.toHaveBeenCalled();
  });

  it('obtém projetos e atividades permitidas para o cache local', async () => {
    const callback =
      (value: unknown) =>
      (...args: unknown[]): void =>
        (args.at(-1) as (result: unknown) => void)(value);
    vi.stubGlobal('ApontamentoAjax', {
      isStaff: callback(false),
      getAtividadesByProjeto: vi.fn((projectId: string, ...args: unknown[]) =>
        (args.at(-1) as (result: unknown) => void)([
          { id: Number(projectId) * 10, codigo: '1.3', nome: 'ATIVIDADE' },
        ]),
      ),
    });
    vi.stubGlobal('ProjetoAjax', {
      listarPorUsuarioAreaApontamento: callback([
        { id: 11, codigo: 'P11', nome: 'PROJETO ONZE' },
        { id: 12, codigo: 'P12', nome: 'PROJETO DOZE' },
      ]),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(
            '<form name="apontamentoForm"><input name="participanteSelecionado" value="synthetic-user"></form>',
            { status: 200 },
          ),
        ),
      ),
    );

    await expect(
      runInjectedChannelCatalog({ timeoutMs: 100 }),
    ).resolves.toEqual({
      ok: true,
      projects: [
        {
          id: '11',
          label: 'P11 PROJETO ONZE',
          activities: [{ id: '110', label: '1.3 ATIVIDADE' }],
        },
        {
          id: '12',
          label: 'P12 PROJETO DOZE',
          activities: [{ id: '120', label: '1.3 ATIVIDADE' }],
        },
      ],
    });
  });

  it('recupera participante e empresa pelo GET autenticado do Extrato antes do DWR', async () => {
    const listarApontamentoPorData = vi.fn((...args: unknown[]) =>
      (args.at(-1) as (value: unknown) => void)({
        lista: [{ dataFormatada: '18/08/2026', totalDuracao: 7.5 }],
      }),
    );
    vi.stubGlobal('ApontamentoAjax', { listarApontamentoPorData });
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(
          `<!doctype html>
          <input id="participanteSelecionado" value="synthetic-user">
          <script>var ID_EMPRESA = 321;</script>`,
          { status: 200, headers: { 'Content-Type': 'text/html' } },
        ),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await runInjectedChannelApiRead({
      startDate: '18/08/2026',
      endDate: '18/08/2026',
      timeoutMs: 100,
    });

    expect(result).toMatchObject({
      ok: true,
      rows: [{ date: '2026-08-18', duration: '07:30' }],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/channel/apontamento.do?action=listarDatas&retorno=painel',
      expect.objectContaining({ credentials: 'include' }),
    );
    expect(listarApontamentoPorData).toHaveBeenCalledTimes(1);
    expect(listarApontamentoPorData.mock.calls[0]?.[0]).toMatchObject({
      usuario: 'synthetic-user',
      empresa: '321',
    });
  });

  it('aceita rótulos vindos do Extrato e o total acumulado esperado', async () => {
    const html = `<!doctype html><form name="apontamentoForm" action="/channel/apontamento.do" method="post">
      <input type="hidden" name="org.apache.struts.taglib.html.TOKEN" value="synthetic-token">
      <input type="hidden" name="participanteSelecionado" value="synthetic-user">
      <input type="hidden" name="action" value="">
      <input type="hidden" name="key" value="">
      <input id="tpApontamentoProjeto" type="radio" name="tipoApontamento" value="0">
      <select id="apontamento.idTipoAtividadeProjeto" name="apontamento.idTipoAtividadeProjeto"><option value="0">Nenhum</option></select>
      <select id="apontamento.idTarefa" name="apontamento.idTarefa"><option value="-1">Nenhum</option></select>
      <input name="data"><input name="apontamento.duracao">
    </form>`;
    const callback =
      (value: unknown) =>
      (...args: unknown[]): void =>
        (args.at(-1) as (result: unknown) => void)(value);
    vi.stubGlobal('ID_EMPRESA', 'synthetic-company');
    vi.stubGlobal('ApontamentoAjax', {
      listarApontamentoPorData: callback({
        lista: [{ dataFormatada: '18/08/2026', totalDuracao: 3 }],
      }),
      isStaff: callback(false),
      getAtividadesByProjeto: callback([
        { id: 22, codigo: 'ME04', nome: 'Medição de agosto.26' },
      ]),
      getTarefasByAtividade: callback([]),
    });
    vi.stubGlobal('ProjetoAjax', {
      listarPorUsuarioAreaApontamento: callback([
        {
          id: 11,
          codigo: 'F01C0078.0',
          nome: 'PETROBRAS_SUSTENTAÇÃO CERTIFICARE',
        },
      ]),
    });
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return Promise.resolve(
        new Response(html, {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await runInjectedChannelApiWrite({
      kind: 'PROJETOS',
      project: 'PETROBRAS_SUSTENTAÇÃO CERTIFICARE',
      activityType: 'Nenhum',
      activity: 'ME04_Medição de agosto.26',
      task: 'Nenhum',
      date: '2026-08-18',
      duration: '02:00',
      durationMinutes: 120,
      expectedExistingMinutes: 180,
      timeoutMs: 100,
      commit: false,
    });

    expect(result).toMatchObject({ status: 'filled', resultingMinutes: 180 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      credentials: 'include',
    });
  });

  it('envia um POST e só conclui depois que o extrato confirma a duração', async () => {
    const html = `<!doctype html><form name="apontamentoForm" action="/channel/apontamento.do" method="post">
      <input type="hidden" name="org.apache.struts.taglib.html.TOKEN" value="synthetic-token">
      <input type="hidden" name="participanteSelecionado" value="synthetic-user">
      <input type="hidden" name="action"><input type="hidden" name="key">
      <input id="tpApontamentoProjeto" type="radio" name="tipoApontamento" value="0">
      <select id="apontamento.idTipoAtividadeProjeto" name="apontamento.idTipoAtividadeProjeto"><option value="0">Nenhum</option></select>
      <select id="apontamento.idTarefa" name="apontamento.idTarefa"><option value="-1">Nenhum</option></select>
      <input name="data"><input name="apontamento.duracao">
    </form>`;
    const callback =
      (value: unknown) =>
      (...args: unknown[]): void =>
        (args.at(-1) as (result: unknown) => void)(value);
    let reads = 0;
    vi.stubGlobal('ID_EMPRESA', 'synthetic-company');
    vi.stubGlobal('ApontamentoAjax', {
      listarApontamentoPorData: (...args: unknown[]) => {
        reads++;
        (args.at(-1) as (result: unknown) => void)(
          reads === 1
            ? { lista: [] }
            : {
                lista: [{ dataFormatada: '18/08/2026', totalDuracao: 7.5 }],
              },
        );
      },
      isStaff: callback(false),
      getAtividadesByProjeto: callback([
        { id: 22, nome: 'ATIVIDADE_SINTETICA' },
      ]),
      getTarefasByAtividade: callback([]),
    });
    vi.stubGlobal('ProjetoAjax', {
      listarPorUsuarioAreaApontamento: callback([
        { id: 11, nome: 'PROJETO_SINTETICO' },
      ]),
    });
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      return Promise.resolve(
        new Response(init?.method === 'POST' ? 'saved' : html, {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await runInjectedChannelApiWrite({
      kind: 'PROJETOS',
      project: 'PROJETO_SINTETICO',
      activityType: 'Nenhum',
      activity: 'ATIVIDADE_SINTETICA',
      task: 'Nenhum',
      date: '2026-08-18',
      duration: '07:30',
      durationMinutes: 450,
      timeoutMs: 100,
    });

    expect(result).toMatchObject({
      status: 'filled',
      resultingMinutes: 450,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const post = fetchMock.mock.calls[1];
    expect(post?.[1]).toMatchObject({ method: 'POST' });
    const body = post?.[1]?.body;
    expect(body).toBeInstanceOf(URLSearchParams);
    expect((body as URLSearchParams).get('action')).toBe('salvar');
    expect(
      (body as URLSearchParams).get('apontamento.projetosSelecionado'),
    ).toBe('11');
    expect(
      (body as URLSearchParams).get('apontamento.notificacaoSelecionada'),
    ).toBe('22');
    expect((body as URLSearchParams).get('data')).toBe('18/08/2026');
    expect((body as URLSearchParams).get('apontamento.duracao')).toBe('07:30');
  });

  it('prepara AVULSO resolvendo cliente, natureza, tipo e comentário por contrato', async () => {
    const html = `<!doctype html><form name="apontamentoForm" action="/channel/apontamento.do" method="post">
      <input type="hidden" name="participanteSelecionado" value="synthetic-user">
      <input type="hidden" name="action"><input type="hidden" name="key">
      <input id="tpApontamentoAvulso" type="radio" name="tipoApontamento" value="2">
      <input name="apontamento.clienteSelecionadoAvulso" value="-1">
      <select id="apontamento.tipoOperacaoSelecionado" name="apontamento.tipoOperacaoSelecionado">
        <option value="0">Nenhum</option><option value="13">13. Formação/Capacitação</option>
      </select>
      <select id="apontamento.idTipoAtividadeAvulso" name="apontamento.idTipoAtividadeAvulso"><option value="-1">Nenhum</option></select>
      <textarea name="apontamento.comentario"></textarea>
      <input name="data"><input name="apontamento.duracao">
    </form><script>var idAreaUsuario = 53;</script>`;
    const callback =
      (value: unknown) =>
      (...args: unknown[]): void =>
        (args.at(-1) as (result: unknown) => void)(value);
    vi.stubGlobal('ID_EMPRESA', 'synthetic-company');
    vi.stubGlobal('ID_AREA_USUARIO_LOGADO', 53);
    let saved = false;
    vi.stubGlobal('ApontamentoAjax', {
      listarApontamentoPorData: (...args: unknown[]) =>
        (args.at(-1) as (result: unknown) => void)({
          lista: saved
            ? [{ dataFormatada: '21/08/2026', totalDuracao: 0.5 }]
            : [],
        }),
    });
    vi.stubGlobal('ClienteAjax', {
      campoApropriacaoAutocomplete: callback([
        { id: 1, nome: 'CERTI' },
        { id: 2, nome: 'CERTI AMAZONAS' },
      ]),
    });
    vi.stubGlobal('TipoAtividadeAjax', {
      getTipoAtividadePorArea: callback([
        { id: 695, codigo: '99601', nome: 'Lightning Talk' },
      ]),
    });
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') saved = true;
      return Promise.resolve(
        new Response(init?.method === 'POST' ? 'saved' : html, {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await runInjectedChannelApiWrite({
      kind: 'AVULSO',
      client: 'CERTI',
      operationNature: '13. Formação/Capacitação',
      activityType: '99601 - Lightning Talk',
      comments: 'Lightning Talk',
      date: '2026-08-21',
      duration: '00:30',
      durationMinutes: 30,
      timeoutMs: 100,
    });

    expect(result).toMatchObject({ status: 'filled', resultingMinutes: 30 });
    expect(vi.mocked(fetchMock)).toHaveBeenCalledTimes(2);
    const body = vi.mocked(fetchMock).mock.calls[1]?.[1]
      ?.body as URLSearchParams;
    expect(body.get('tipoApontamento')).toBe('2');
    expect(body.get('apontamento.clienteSelecionadoAvulso')).toBe('1');
    expect(body.get('apontamento.tipoOperacaoSelecionado')).toBe('13');
    expect(body.get('apontamento.idTipoAtividadeAvulso')).toBe('695');
    expect(body.get('apontamento.comentario')).toBe('Lightning Talk');
  });
});

describe('adapter Channel de leitura', () => {
  it('detecta login, extrato, formulário e página desconhecida pelos seletores Ruby', async () => {
    await loadFixture('login');
    expect(detectChannelPage(document)).toBe('login');
    await loadFixture('extract');
    expect(detectChannelPage(document)).toBe('extract');
    await loadFixture('form');
    expect(detectChannelPage(document)).toBe('entry-form');
    document.body.replaceChildren();
    expect(detectChannelPage(document)).toBe('unknown');
  });

  it('filtra período, escolhe Não paginar e preserva ordem, duplicatas e duração textual', async () => {
    await loadFixture('extract');
    const filter =
      document.querySelector<HTMLInputElement>('[value*="Filtrar"]');
    filter?.addEventListener('click', () => {
      setTimeout(() => {
        const previous = document.querySelector('#tblListagem');
        const replacement = document.createElement('tbody');
        replacement.id = 'tblListagem';
        replacement.textContent = [
          '18/08/2026 07:00',
          '18/08/2026 7:30',
          '19/08/2026 08:00',
        ].join('\n');
        previous?.replaceWith(replacement);
      }, 5);
    });

    const result = await readChannelExtract(document, {
      startDate: '26/07/2026',
      endDate: '25/08/2026',
      timeoutMs: 200,
      pollIntervalMs: 1,
    });

    expect(
      document.querySelector<HTMLInputElement>('[name="dataInicial"]')?.value,
    ).toBe('26/07/2026');
    expect(
      document.querySelector<HTMLInputElement>('[name="dataFinal"]')?.value,
    ).toBe('25/08/2026');
    expect(
      document.querySelector<HTMLSelectElement>('#totalItensPagina')
        ?.selectedOptions[0]?.text,
    ).toBe('Não paginar');
    expect(result).toEqual({
      rows: [
        {
          rowIndex: 0,
          date: '2026-08-18',
          duration: '07:00',
          durationMinutes: 420,
        },
        {
          rowIndex: 1,
          date: '2026-08-18',
          duration: '7:30',
          durationMinutes: 450,
        },
        {
          rowIndex: 2,
          date: '2026-08-19',
          duration: '08:00',
          durationMinutes: 480,
        },
      ],
      errors: [],
    });
    expect(document.querySelector<HTMLInputElement>('#data')).toBeNull();
  });

  it('mantém erros de linha sanitizados sem perder linhas válidas', () => {
    expect(
      parseChannelExtract('18/08/2026 07:30\nlinha inválida\n19/08/2026 08:00'),
    ).toEqual({
      rows: [
        {
          rowIndex: 0,
          date: '2026-08-18',
          duration: '07:30',
          durationMinutes: 450,
        },
        {
          rowIndex: 2,
          date: '2026-08-19',
          duration: '08:00',
          durationMinutes: 480,
        },
      ],
      errors: [{ rowIndex: 1, code: 'invalid-row' }],
    });
  });

  it('executa a leitura autocontida usada por chrome.scripting sem escrever no formulário', async () => {
    await loadFixture('extract');
    document
      .querySelector('[value*="Filtrar"]')
      ?.addEventListener('click', () => {
        const replacement = document.createElement('tbody');
        replacement.id = 'tblListagem';
        replacement.textContent = '18/08/2026 07:00\n18/08/2026 7:30';
        document.querySelector('#tblListagem')?.replaceWith(replacement);
      });

    const result = await runInjectedChannelRead(
      { startDate: '26/07/2026', endDate: '25/08/2026', timeoutMs: 100 },
      document,
    );

    expect(result).toMatchObject({
      ok: true,
      rows: [
        {
          rowIndex: 0,
          date: '2026-08-18',
          duration: '07:00',
          durationMinutes: 420,
        },
        {
          rowIndex: 1,
          date: '2026-08-18',
          duration: '7:30',
          durationMinutes: 450,
        },
      ],
    });
    expect(document.querySelector<HTMLInputElement>('#data')).toBeNull();
  });

  it('recusa leitura enquanto o formulário de apontamento está aberto', async () => {
    await loadFixture('form');

    await expect(
      runInjectedChannelRead(
        { startDate: '26/07/2026', endDate: '25/08/2026', timeoutMs: 100 },
        document,
      ),
    ).resolves.toEqual({ ok: false, code: 'entry-form-open' });
    await expect(
      readChannelExtract(document, {
        startDate: '26/07/2026',
        endDate: '25/08/2026',
        timeoutMs: 100,
      }),
    ).rejects.toMatchObject({ code: 'entry-form-open' });
    expect(console.warn).toHaveBeenCalledWith(
      '[PontoNaCerti][ChannelRead]',
      expect.objectContaining({
        status: 'failed',
        code: 'entry-form-open',
        entryForm: true,
        extractRows: false,
      }),
    );
    const serializedLogs = JSON.stringify(vi.mocked(console.warn).mock.calls);
    expect(serializedLogs).not.toContain('PROJETO_SINTETICO');
    expect(serializedLogs).not.toContain('18/08/2026');
  });
});

describe('adapter Channel de preenchimento PROJETOS', () => {
  it('seleciona por prefixo, emite eventos mínimos, confirma valores e nunca submete', async () => {
    await loadFixture('form');
    const form = document.querySelector<HTMLFormElement>('#apontamento_diario');
    const submit = vi.fn((event: SubmitEvent) => event.preventDefault());
    form?.addEventListener('submit', submit);
    const inputEvents = vi.fn();
    document.querySelector('#data')?.addEventListener('input', inputEvents);
    document
      .querySelector('#apontamento\\.duracao')
      ?.addEventListener('change', inputEvents);

    const fill = await fillChannelProject(document, assignment());

    expect(fill).toEqual({
      date: '2026-08-18',
      requestedMinutes: 450,
      resultingMinutes: 450,
      status: 'filled',
    });
    expect(
      document.querySelector<HTMLInputElement>('#tpApontamentoProjeto')
        ?.checked,
    ).toBe(true);
    expect(
      document.querySelector<HTMLSelectElement>(
        '[id="apontamento.projetosSelecionado"]',
      )?.selectedOptions[0]?.text,
    ).toMatch(/^PROJETO_SINTETICO/);
    expect(document.querySelector<HTMLInputElement>('#data')?.value).toBe(
      '18/08/2026',
    );
    expect(
      document.querySelector<HTMLInputElement>('[id="apontamento.duracao"]')
        ?.value,
    ).toBe('07:30');
    expect(inputEvents).toHaveBeenCalledTimes(2);
    expect(submit).not.toHaveBeenCalled();
  });

  it('encontra os controles PROJETOS fora do formulário diário como no DOM autenticado', async () => {
    await loadFixture('form');
    const form = document.querySelector('#apontamento_diario');
    for (const selector of [
      '#tpApontamentoProjeto',
      '[id="apontamento.projetosSelecionado"]',
      '[id="apontamento.idTipoAtividadeProjeto"]',
      '[id="apontamento.notificacaoSelecionada"]',
      '[id="apontamento.idTarefa"]',
    ]) {
      const control = document.querySelector(selector);
      if (control) form?.before(control);
    }

    const fill = await runInjectedChannelFill(
      {
        kind: 'PROJETOS',
        project: 'PROJETO_SINTETICO',
        activityType: 'Nenhum',
        activity: 'ATIVIDADE_SINTETICA',
        task: 'Nenhum',
        date: '2026-08-18',
        duration: '07:30',
        durationMinutes: 450,
      },
      document,
    );

    expect(fill.status).toBe('filled');
    expect(document.querySelector<HTMLInputElement>('#data')?.value).toBe(
      '18/08/2026',
    );
  });

  it('aguarda opções dependentes carregadas após selecionar PROJETOS', async () => {
    await loadFixture('form');
    const projectType = document.querySelector('#tpApontamentoProjeto');
    const project = document.querySelector<HTMLSelectElement>(
      '[id="apontamento.projetosSelecionado"]',
    );
    const activity = document.querySelector<HTMLSelectElement>(
      '[id="apontamento.notificacaoSelecionada"]',
    );
    project?.replaceChildren();
    activity?.replaceChildren();
    projectType?.addEventListener('click', () => {
      setTimeout(() => {
        const option = document.createElement('option');
        option.text = 'PROJETO_SINTETICO — descrição';
        project?.append(option);
      }, 5);
    });
    project?.addEventListener('change', () => {
      setTimeout(() => {
        const option = document.createElement('option');
        option.text = 'ATIVIDADE_SINTETICA — descrição';
        activity?.append(option);
      }, 5);
    });

    const fill = await runInjectedChannelFill(
      {
        kind: 'PROJETOS',
        project: 'PROJETO_SINTETICO',
        activityType: 'Nenhum',
        activity: 'ATIVIDADE_SINTETICA',
        task: 'Nenhum',
        date: '2026-08-18',
        duration: '07:30',
        durationMinutes: 450,
        timeoutMs: 100,
      },
      document,
    );

    expect(fill).toMatchObject({ status: 'filled' });
    expect(project?.selectedOptions[0]?.text).toMatch(/^PROJETO_SINTETICO/);
    expect(activity?.selectedOptions[0]?.text).toMatch(/^ATIVIDADE_SINTETICA/);
  });

  it('reconsulta controles substituídos pelo AJAX do Channel', async () => {
    await loadFixture('form');
    const option = (text: string): HTMLOptionElement => {
      const value = document.createElement('option');
      value.text = text;
      return value;
    };
    document
      .querySelector('#tpApontamentoProjeto')
      ?.addEventListener('click', () => {
        setTimeout(() => {
          const project = document.createElement('select');
          project.id = 'apontamento.projetosSelecionado';
          project.append(option('PROJETO_SINTETICO — descrição'));
          document
            .querySelector('[id="apontamento.projetosSelecionado"]')
            ?.replaceWith(project);
          project.addEventListener('change', () => {
            setTimeout(() => {
              const activityType = document.createElement('select');
              activityType.id = 'apontamento.idTipoAtividadeProjeto';
              activityType.append(option('Nenhum tipo relacionado'));
              document
                .querySelector('[id="apontamento.idTipoAtividadeProjeto"]')
                ?.replaceWith(activityType);
              activityType.addEventListener('change', () => {
                setTimeout(() => {
                  const activity = document.createElement('select');
                  activity.id = 'apontamento.notificacaoSelecionada';
                  activity.append(option('ATIVIDADE_SINTETICA — descrição'));
                  document
                    .querySelector('[id="apontamento.notificacaoSelecionada"]')
                    ?.replaceWith(activity);
                }, 5);
              });
            }, 5);
          });
        }, 5);
      });

    const fill = await runInjectedChannelFill(
      {
        kind: 'PROJETOS',
        project: 'PROJETO_SINTETICO',
        activityType: 'Nenhum',
        activity: 'ATIVIDADE_SINTETICA',
        task: 'Nenhum',
        date: '2026-08-18',
        duration: '07:30',
        durationMinutes: 450,
        timeoutMs: 200,
      },
      document,
    );

    expect(fill).toMatchObject({ status: 'filled' });
    expect(
      document.querySelector<HTMLSelectElement>(
        '[id="apontamento.projetosSelecionado"]',
      )?.selectedOptions[0]?.text,
    ).toMatch(/^PROJETO_SINTETICO/);
  });

  it('aceita a data padrão de um formulário novo quando a duração está vazia', async () => {
    await loadFixture('form');
    const date = document.querySelector<HTMLInputElement>('#data');
    if (date) date.value = '22/08/2026';

    const fill = await runInjectedChannelFill(
      {
        kind: 'PROJETOS',
        project: 'PROJETO_SINTETICO',
        activityType: 'Nenhum',
        activity: 'ATIVIDADE_SINTETICA',
        task: 'Nenhum',
        date: '2026-08-18',
        duration: '07:30',
        durationMinutes: 450,
      },
      document,
    );

    expect(fill).toMatchObject({ status: 'filled' });
    expect(date?.value).toBe('18/08/2026');
  });

  it('não sobrescreve um formulário ocupado e trata repetição idempotente', async () => {
    await loadFixture('form');
    const first = await fillChannelProject(document, assignment());
    const repeated = await fillChannelProject(document, assignment());
    const occupied = await fillChannelProject(
      document,
      assignment({
        date: civilDate('2026-08-19'),
        durationMinutes: 480,
        duration: '08:00',
      }),
    );

    expect(first.status).toBe('filled');
    expect(repeated.status).toBe('already-correct');
    expect(occupied).toMatchObject({
      status: 'failed',
      code: 'entry-form-occupied',
    });
    expect(document.querySelector<HTMLInputElement>('#data')?.value).toBe(
      '18/08/2026',
    );
    expect(
      document.querySelector<HTMLInputElement>('[id="apontamento.duracao"]')
        ?.value,
    ).toBe('07:30');
  });

  it('faz preflight das opções e retorna erro por item sem preenchimento parcial', async () => {
    await loadFixture('form');
    const fill = await fillChannelProject(
      document,
      assignment({ activity: 'ATIVIDADE_INEXISTENTE' }),
    );

    expect(fill).toMatchObject({
      status: 'not-found',
      code: 'option-prefix-not-found',
    });
    expect(document.querySelector<HTMLInputElement>('#data')?.value).toBe('');
    expect(
      document.querySelector<HTMLInputElement>('[id="apontamento.duracao"]')
        ?.value,
    ).toBe('');
    expect(
      document.querySelector<HTMLInputElement>('#tpApontamentoProjeto')
        ?.checked,
    ).toBe(true);
  });

  it('reconhece login e não toca no formulário', async () => {
    await loadFixture('login');
    const fill = await fillChannelProject(document, assignment());
    expect(fill).toMatchObject({ status: 'failed', code: 'login-required' });
    expect(document.querySelector('[name="password"]')).not.toBeNull();
  });

  it('registra diagnóstico estrutural sanitizado quando o preenchimento falha', async () => {
    document.body.replaceChildren();

    const fill = await runInjectedChannelFill(
      {
        kind: 'PROJETOS',
        project: 'PROJETO_SINTETICO',
        activityType: 'Nenhum',
        activity: 'ATIVIDADE_SINTETICA',
        task: 'Nenhum',
        date: '2026-08-18',
        duration: '07:30',
        durationMinutes: 450,
      },
      document,
    );

    expect(fill).toMatchObject({
      status: 'not-found',
      code: 'include-entry-not-found',
    });
    expect(console.warn).toHaveBeenCalledWith(
      '[PontoNaCerti][ChannelFill]',
      expect.objectContaining({
        status: 'not-found',
        code: 'include-entry-not-found',
        includeEntry: false,
        entryForm: false,
      }),
    );
    const serializedLogs = JSON.stringify(vi.mocked(console.warn).mock.calls);
    expect(serializedLogs).not.toContain('PROJETO_SINTETICO');
    expect(serializedLogs).not.toContain('ATIVIDADE_SINTETICA');
    expect(serializedLogs).not.toContain('2026-08-18');
    expect(serializedLogs).not.toContain('07:30');
  });

  it('abre o formulário assíncrono e a função injetada preenche um único item sem submit', async () => {
    await loadFixture('extract');
    const formHtml = await readFile(
      resolve(projectRoot, 'tests/fixtures/target/form.html'),
      'utf8',
    );
    const parsedForm = new DOMParser().parseFromString(formHtml, 'text/html');
    const form = parsedForm.querySelector<HTMLFormElement>(
      '#apontamento_diario',
    );
    const submit = vi.fn((event: SubmitEvent) => event.preventDefault());
    form?.addEventListener('submit', submit);
    document
      .querySelector('#incluirNovoApontamento')
      ?.addEventListener('click', () => {
        setTimeout(() => {
          if (form) document.body.append(form);
        }, 5);
      });

    const result = await runInjectedChannelFill(
      {
        kind: 'PROJETOS',
        project: 'PROJETO_SINTETICO',
        activityType: 'Nenhum',
        activity: 'ATIVIDADE_SINTETICA',
        task: 'Nenhum',
        date: '2026-08-18',
        duration: '07:30',
        durationMinutes: 450,
        timeoutMs: 100,
      },
      document,
    );

    expect(result).toEqual({
      date: '2026-08-18',
      requestedMinutes: 450,
      resultingMinutes: 450,
      status: 'filled',
    });
    expect(document.querySelector<HTMLInputElement>('#data')?.value).toBe(
      '18/08/2026',
    );
    expect(submit).not.toHaveBeenCalled();
  });

  it('cancela waits pendentes sem mutação adicional', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      waitForCondition(() => undefined, 'condição sintética', {
        signal: controller.signal,
        timeoutMs: 100,
      }),
    ).rejects.toMatchObject({ code: 'cancelled' });
  });
});
