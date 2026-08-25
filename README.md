# Ponto na Certi

![Sincronizador de ponto e projetos](ponto_na_certi.png)

Extensão para Google Chrome que automatiza o apontamento de projetos na Fundação CERTI:

- lê as batidas do espelho de ponto no Ahgora;
- lê eventos do Google Calendar;
- compara os dados existentes;
- registra no Channel as marcações de projetos revisadas e selecionadas pelo usuário.

A extensão reutiliza as sessões já autenticadas no navegador e apresenta uma prévia antes de qualquer gravação. Ela não solicita nem armazena credenciais.

## Extensão Chrome

O código, os comandos de desenvolvimento, a documentação de permissões e as instruções de instalação estão em [`apps/chrome-extension`](apps/chrome-extension/README.md).

Início rápido:

```bash
cd apps/chrome-extension
npm ci
npm run build
```

Depois, abra `chrome://extensions`, habilite o modo do desenvolvedor e carregue a pasta `apps/chrome-extension/dist` sem compactação.

## Sistemas integrados

- **Ahgora:** leitura do espelho de ponto;
- **Google Calendar:** leitura de calendários e eventos;
- **Channel:** leitura, comparação e registro das marcações de projetos.

## Licença

Distribuído sob a licença MIT. Consulte [`LICENSE`](LICENSE).
