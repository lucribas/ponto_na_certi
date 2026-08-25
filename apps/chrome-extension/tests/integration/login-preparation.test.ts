import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  EXISTING_LOGIN_TAB_AUTH_TIMEOUT_MS,
  LOGIN_SITES,
  isLoginWorkPageUrl,
  probeLoginDocument,
  rankLoginTabCandidates,
  shouldOpenFreshLoginTab,
  submitAutofilledLogin,
} from '../../src/sites/login';

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('preparação das páginas de login', () => {
  it('abre uma nova aba somente quando a aba reutilizada não autentica em 10 segundos', () => {
    expect(EXISTING_LOGIN_TAB_AUTH_TIMEOUT_MS).toBe(10_000);
    expect(shouldOpenFreshLoginTab(true, false)).toBe(true);
    expect(shouldOpenFreshLoginTab(true, true)).toBe(false);
    expect(shouldOpenFreshLoginTab(false, false)).toBe(false);
  });

  it('prioriza uma página de trabalho aberta e ignora abas de outras origens', () => {
    const [work, login] = rankLoginTabCandidates(
      [
        {
          id: 8,
          url: 'https://www.ahgora.com.br/externo/index/a128879',
          active: true,
        },
        {
          id: 12,
          url: 'https://app.ahgora.com.br/externo/mirror',
          active: false,
        },
        { id: 3, url: 'https://example.com/', active: true },
      ],
      LOGIN_SITES[0],
    );

    expect(work?.id).toBe(12);
    expect(login?.id).toBe(8);
    expect(isLoginWorkPageUrl(LOGIN_SITES[0], work?.url ?? '')).toBe(true);
  });

  it('mantém a aba anteriormente associada como primeira opção', () => {
    const candidates = rankLoginTabCandidates(
      [
        {
          id: 4,
          url: 'https://channel.certi.org.br/channel/login.do',
        },
        {
          id: 9,
          url: LOGIN_SITES[1].destinationUrl,
          active: true,
        },
      ],
      LOGIN_SITES[1],
      4,
    );

    expect(candidates.map(({ id }) => id)).toEqual([4, 9]);
  });

  it('aciona o submit somente depois que os dois campos já estão preenchidos', async () => {
    document.body.innerHTML = `
      <form id="login">
        <input name="user" value="usuario-preenchido">
        <input name="password" value="senha-preenchida">
        <button type="submit">Entrar</button>
      </form>
    `;
    let submits = 0;
    document.querySelector('form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      submits++;
    });

    await expect(
      submitAutofilledLogin({
        formSelector: '#login',
        usernameSelector: '[name="user"]',
        passwordSelector: '[name="password"]',
        timeoutMs: 10,
      }),
    ).resolves.toBe('submitted');
    expect(submits).toBe(1);
  });

  it('não submete quando o gerenciador de senhas ainda não preencheu a senha', async () => {
    document.body.innerHTML = `
      <form id="login">
        <input name="user" value="usuario-preenchido">
        <input name="password" value="">
        <button type="submit">Entrar</button>
      </form>
    `;
    const submit = vi.fn((event: Event) => event.preventDefault());
    document.querySelector('form')?.addEventListener('submit', submit);

    await expect(
      submitAutofilledLogin({
        formSelector: '#login',
        usernameSelector: '[name="user"]',
        passwordSelector: '[name="password"]',
        timeoutMs: 1,
      }),
    ).resolves.toBe('not-filled');
    expect(submit).not.toHaveBeenCalled();
  });

  it('aciona o login quando o Chrome protege o valor visual com webkit-autofill', async () => {
    document.body.innerHTML = `
      <form id="login">
        <input name="user" value="">
        <input name="password" value="">
        <button type="submit">Entrar</button>
      </form>
    `;
    const fields = document.querySelectorAll<HTMLInputElement>('input');
    for (const field of fields) {
      vi.spyOn(field, 'matches').mockImplementation(
        (selector) => selector === ':-webkit-autofill',
      );
    }
    const submit = vi.fn((event: Event) => event.preventDefault());
    document.querySelector('form')?.addEventListener('submit', submit);

    await expect(
      submitAutofilledLogin({
        formSelector: '#login',
        usernameSelector: '[name="user"]',
        passwordSelector: '[name="password"]',
        timeoutMs: 10,
      }),
    ).resolves.toBe('submitted');
    expect(submit).toHaveBeenCalledOnce();
  });

  it('reconhece uma página de trabalho interativa sem esperar o load completo', async () => {
    vi.spyOn(document, 'readyState', 'get').mockReturnValue('interactive');

    await expect(
      submitAutofilledLogin({
        formSelector: '#login',
        usernameSelector: '[name="user"]',
        passwordSelector: '[name="password"]',
        loginPathnames: ['/login'],
        timeoutMs: 10_000,
      }),
    ).resolves.toBe('already-authenticated');
  });

  it('reconhece sessão autenticada quando o Ahgora mantém o formulário oculto no DOM', async () => {
    document.body.innerHTML = `
      <section aria-hidden="true">
        <form id="boxLogin">
          <input name="matricula">
          <input name="senha" type="password">
        </form>
      </section>
      <iframe id="mirror"></iframe>
    `;
    vi.spyOn(document, 'readyState', 'get').mockReturnValue('complete');

    expect(probeLoginDocument('#boxLogin', '#mirror')).toMatchObject({
      ready: true,
      formPresent: true,
      formVisible: false,
      workMarkerPresent: true,
    });
    await expect(
      submitAutofilledLogin({
        formSelector: '#boxLogin',
        usernameSelector: '[name="matricula"]',
        passwordSelector: '[name="senha"]',
        loginPathnames: ['/externo/index/a128879'],
        timeoutMs: 10,
      }),
    ).resolves.toBe('already-authenticated');
  });
});
