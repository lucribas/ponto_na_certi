# Ponto na Certi

Extensão Chrome Manifest V3 que lê as batidas do espelho de ponto no Ahgora e os eventos do Google Calendar, compara os dados com o Channel e registra automaticamente as marcações de projetos selecionadas. Ela reutiliza sessões já autenticadas e não solicita nem armazena credenciais.

## Instalação e comandos

Requisitos: Node.js 24 LTS, npm 11+ e Chrome/Chromium 116+. Os testes de paridade são autocontidos; o oráculo opcional contra o código Ruby legado só é executado quando `apps/standalone/source/Ahgora.rb` e `Expert.rb` estão disponíveis localmente e não entra no runtime nem no pacote.

Execute em `apps/chrome-extension`:

| Ordem | Finalidade                            | Comando exato                              |
| ----: | ------------------------------------- | ------------------------------------------ |
|     1 | Instalação imutável                   | `npm ci`                                   |
|     2 | Chromium do e2e                       | `npm run e2e:install`                      |
|     3 | Desenvolvimento (encerrar com Ctrl+C) | `npm run dev`                              |
|     4 | Typecheck                             | `npm run typecheck`                        |
|     5 | Lint/formato                          | `npm run lint`                             |
|     6 | Unitários                             | `npm run test:unit`                        |
|     7 | Paridade Ruby/TypeScript              | `npm run test:parity`                      |
|     8 | Integração DOM                        | `npm run test:integration`                 |
|     9 | E2E Chromium                          | `npm run test:e2e`                         |
|    10 | Smoke autenticado opt-in              | `npm run test:authenticated`               |
|    11 | Fluxo real headless opt-in            | `npm run test:authenticated:headless-flow` |
|    12 | Todas as suítes locais                | `npm test`                                 |
|    13 | Build                                 | `npm run build`                            |
|    14 | ZIP reproduzível                      | `npm run package`                          |
|    15 | Prévia local do site de release       | `npm run release:site`                     |

Após `npm run build`, abra `chrome://extensions`, habilite o modo do desenvolvedor, escolha **Carregar sem compactação** e selecione `apps/chrome-extension/dist`. `npm run package` gera `artifacts/ponto-na-certi-extension-0.1.0.zip` somente com o runtime da extensão. O comando `npm run dev` usa `dist-dev`, preservando a build instalável em `dist`.

### Configuração do Google Calendar

O consentimento é solicitado pela própria extensão, mas o publicador precisa configurar uma vez as credenciais que identificam o aplicativo:

1. No Google Cloud, crie ou escolha um projeto, habilite a **Google Calendar API** e configure a tela de consentimento OAuth. Para uso restrito à organização, prefira audiência **Interna**; para testes externos, cadastre as contas como usuários de teste.
2. Se já possuir a chave pública da extensão (por exemplo, a fornecida para a distribuição definitiva), copie `.env.example` para `.env.local`, preencha primeiro `CHROME_EXTENSION_PUBLIC_KEY`, execute `npm run build` e carregue `dist` em `chrome://extensions`. Para desenvolvimento apenas local, pode deixar essa variável vazia e manter sempre o mesmo caminho absoluto de `dist` no mesmo perfil Chrome.
3. Copie o ID mostrado em `chrome://extensions`. No Google Cloud, crie um OAuth Client ID do tipo **Chrome Extension** e informe esse ID no campo **Item ID**.
4. Preencha `GOOGLE_OAUTH_CLIENT_ID` em `.env.local`, execute novamente `npm run build`, recarregue `dist` e confirme no manifesto gerado que existem `oauth2`, os dois escopos somente leitura e, quando configurada, a propriedade `key`. Nunca coloque a chave privada de empacotamento no repositório.

O ID usado para criar o cliente OAuth deve ser igual ao mostrado em `chrome://extensions`. Em uma publicação pela Chrome Web Store, use o ID definitivo atribuído à extensão. Alterar o ID exige criar ou ajustar o cliente OAuth correspondente.

## Releases e página de instalação

O workflow [`chrome-extension-quality.yml`](../../.github/workflows/chrome-extension-quality.yml) executa lint, typecheck, testes unitários, paridade Ruby, integração, E2E, smoke da extensão empacotada em Chrome headless e geração do ZIP em cada pull request ou push para `main` que altere a extensão.

Para publicar uma versão:

1. Em `apps/chrome-extension`, execute `npm version 0.2.0 --no-git-tag-version` (substituindo pela versão desejada) para atualizar `package.json` e `package-lock.json`; depois coloque o mesmo valor em `manifest.json`.
2. Integre a alteração em `main` e confirme que o workflow de qualidade passou.
3. No GitHub, abra **Actions → Release Chrome extension → Run workflow** e selecione `main`. Marque **Publicar também o site de instalação** somente se desejar atualizar o GitHub Pages.
4. O workflow repete todos os testes, recusa uma versão cuja tag já exista e cria a tag `vX.Y.Z` e o GitHub Release com ZIP e checksum. A criação da release não depende do GitHub Pages.

Para usar a opção do site, abra antes **Settings → Pages → Build and deployment** e escolha **GitHub Actions** como origem. A página ficará em `https://lucribas.github.io/ponto_na_certi/` e oferecerá um ZIP estável (`latest`), o ZIP versionado, SHA-256 e instruções para instalação/atualização manual. O ZIP não é instalável com um clique: por segurança, o Chrome exige extraí-lo e usar **Carregar sem compactação** em `chrome://extensions` enquanto a extensão não estiver na Chrome Web Store.

`npm run release:site` permite revisar localmente o conteúdo que será publicado em `release-site/`. A pasta é descartável e ignorada pelo Git; a fonte versionada da página fica em `site/`.

## Uso

1. Clique na action para abrir o painel lateral.
2. Em **Abrir, autenticar e conectar**, use **Detectar abas ou abrir logins**. A extensão abre Ahgora, Channel e Google Calendar e pede em conjunto o acesso opcional aos quatro hosts exatos. Se já houver uma aba do Ahgora ou do Channel, ela será reutilizada por até 10 segundos; se a autenticação não for confirmada nesse prazo, uma nova aba do sistema será aberta automaticamente, sem fechar a anterior. Barras e mensagens independentes mostram carregamento, espera pelo preenchimento automático, envio e confirmação das três conexões. Enquanto o processo estiver ativo, **Parar login** interrompe as novas tentativas automáticas. Se o gerenciador de senhas preencher usuário e senha, ela aciona o submit sem copiar esses valores e registra as abas automaticamente.
3. Normalmente não há outra interação. **Detectar abas ou abrir logins** solicita em conjunto os acessos do Ahgora, Channel e Google Calendar, reutiliza sessões abertas e inicia as três conexões. Enquanto houver login pendente, o painel verifica passivamente as abas, além de reagir às navegações. Um formulário que permaneça oculto no DOM não é confundido com login aberto; a página de trabalho e seu marcador estrutural são confirmados antes do registro automático. Quando as três conexões estiverem prontas, a etapa 1 é recolhida automaticamente e mostra **Concluído**; captura e envio permanecem bloqueados até lá. Clique no título para reabrir a etapa. **Verificar logins novamente** também permite repetir a leitura sem abrir abas duplicadas. Se a permissão for recusada, a interface explica por que ela é necessária e oferece **Permitir acesso e tentar novamente**. **Acesso manual** permanece como fallback para Ahgora e Channel. O Google Calendar fica sempre habilitado e seu progresso aparece como o terceiro card da etapa.
4. As cinco etapas funcionam como um acordeão: clique no cabeçalho para expandir ou recolher, mantendo no máximo uma etapa aberta. Os links **Conectar**, **Regras**, **Capturar**, **Revisar** e **Enviar** no progresso inicial também expandem e levam diretamente à etapa correspondente. No card **Regras**, os totais permanecem visíveis no cabeçalho fechado; expanda-o e use **Gerenciar TAGs** para abrir o diálogo de definição de marcações e depois **Obter do Channel**. A extensão consulta todos os projetos disponíveis e, para cada projeto, somente as atividades permitidas ao usuário autenticado; o resultado e a data da consulta ficam no cache local. Escolha projeto e atividade; o nome da TAG é criado automaticamente como `Projeto — Atividade`. **Copiar de item RAG…** abre um assistente inline que filtra os catálogos, identifica itens Projeto compatíveis e preenche projeto, atividade, tipo, tarefa e observações após confirmar uma correspondência exata no cache do Channel; a TAG só é criada depois da revisão e do clique normal em **Salvar TAG**. Itens avulsos, de não apontamento ou dependentes de uma TAG existente aparecem como incompatíveis. **Opções avançadas desta TAG** define Tipo de atividade e Tarefa, ambos `Nenhum` por padrão, além das Observações opcionais; esses valores são salvos e usados junto com a TAG, inclusive no campo de observações do Channel. É possível manter várias TAGs, editar uma preservando suas referências, excluir uma e marcar uma delas como padrão. **Gerenciar templates e regras** abre o diálogo de distribuições e regras semanais. **Gerenciar catálogos de apontamentos RAG**, abaixo do botão do Google Calendar, abre um diálogo independente para atualizar ou restaurar as fontes RAG. Os gerenciadores podem ser fechados pelo `X`, por **Fechar** ou pela tecla `Esc`.
5. Ainda no card **Regras**, **Templates de marcações** permite criar e editar diretamente nome, duração original e marcações do template; a edição mantém o identificador usado pelas regras semanais. Em **Repetir em**, os sete dias aparecem por extenso. No topo da extensão, **Config.** abre o diálogo com radio buttons para escolher entre **Google Calendar via aba**, o modo padrão, e **Google Calendar via API**. O primeiro registra uma aba e executa nela o GET autenticado de exportação ZIP/ICS, sem ler cookies; o segundo usa OAuth e escopos somente leitura e está disponível somente para usuários de teste cadastrados pelo mantenedor. O aviso e o link para solicitar acesso aparecem apenas quando o modo API está selecionado. Trocar o modo preserva as regras, limpa somente os calendários da conexão anterior e pede uma nova conexão. No próximo clique em **Detectar abas ou abrir logins**, uma aba do Calendar é reutilizada ou aberta junto aos demais acessos; conclua o login e clique novamente se necessário. O modo de aba só lista calendários que a conta pode exportar e pode ser bloqueado pelo administrador da organização. Use **Gerenciar regras automáticas do Google Calendar** para escolher calendários e ajustar regras. Na primeira inicialização, cada evento único de `reunioes-rag.json` gera uma regra ativa em que o título ou a descrição do evento deve conter o texto RAG; a importação é versionada, não duplica destinos já configurados e preserva alterações posteriores do usuário. Toda regra pode ser editada mantendo sua prioridade e identidade; regras importadas do RAG também oferecem **Restaurar** para recuperar a configuração original. Em cada regra, **Origem da marcação** oferece as mesmas TAGs e fontes RAG da edição diária; depois escolha a **TAG** ou a **Marcação**, incluindo uma TAG contextual quando a marcação exigir. A primeira regra ativa compatível vence; eventos correspondentes reservam sua duração antes das regras semanais e da TAG padrão. A prévia identifica evento, horário, regra e frases encontradas. Sobreposição, soma acima do Ahgora ou destino removido exigem revisão manual.
6. A área **Preferências rápidas**, no topo, reúne tema, ajuda, tamanho do texto e monitoramento do almoço. Tema e ajuda usam ícones acompanhados de texto; `A−` e `A+` ajustam as letras entre 80% e 140%; e **Monitorar almoço** é um interruptor que informa permanentemente se está ativo e quais horários serão verificados. TAGs completas, catálogo, TAG padrão, tema, monitoramento e tamanho das letras persistem localmente entre operações.
7. Na etapa **3. Capturar e comparar**, **Mês atual** é a opção padrão e **Mês anterior** aparece logo abaixo; também é possível informar um intervalo inclusivo. Overrides aceitam uma linha `AAAA-MM-DD=HH:MM,HH:MM,...` e permanecem apenas em `storage.session`. Uma instalação nova não contém TAG particular predefinida. Na primeira captura sem TAG padrão, a extensão procura a marcação válida mais recente do período lido no Channel, cria e persiste uma TAG com seu projeto e atividade e a usa como referência para os novos dias; se nenhuma marcação trouxer ambos os campos, a captura continua para revisão sem inventar um destino. A TAG inferida é reconciliada com o catálogo por ID ou por rótulo normalizado, inclusive quando o catálogo acrescenta códigos ou usa separadores diferentes; TAGs antigas são reparadas na captura seguinte. Use **Capturar e comparar**; as consultas independentes do Ahgora, Channel e Google Calendar são iniciadas em paralelo, e suas barras mostram separadamente consulta em andamento, quantidade recebida, conclusão ou falha. O progresso do Calendar diferencia conexão e configuração pendentes. A etapa final **Comparação** permanece aguardando até todas as fontes terminarem; então cruza snapshots completos e prepara os dias para revisão, independentemente da ordem de conclusão das consultas. **Parar captura** aparece somente durante a execução e descarta seu resultado tardio. Quando a comparação termina, **4. Revisar apontamentos** é expandida automaticamente.
8. Na etapa **4. Revisar apontamentos**, cada dia novo começa com uma marcação de `100%` e a TAG padrão. Em **Dividir por**, use os radio buttons visíveis para escolher **Percentual** ou **Duração**. Nos dois modos, um slider com subdivisões permanece sincronizado com o campo digitável; o percentual vai de `0%` a `100%`, enquanto a duração vai de `00:00` ao saldo máximo disponível para a marcação. A escala de duração usa intervalos redondos adaptados ao total, como 10 minutos, 30 minutos ou 1 hora. Ao reduzir o valor, uma nova marcação com o saldo restante e a TAG padrão aparece automaticamente, usando a mesma unidade escolhida. O saldo também pode ser reduzido para criar outras marcações, e cada uma aceita sua própria TAG. O resumo mantém `Distribuído` igual ao total capturado e `Falta 00:00`. Cada linha já existente detalha as marcações, projetos e atividades lidos do Channel. Cada marcação removível apresenta **Excluir** à direita; o clique inicia a exclusão diretamente, usa o identificador exato do Channel e atualiza a prévia depois da confirmação do backend. Azul-claro indica item disponível para envio, verde-claro indica igualdade/confirmação, amarelo-claro indica divergência e vermelho-claro indica erro ou bloqueio. Itens iguais ou divergentes não exibem checkbox de envio.
9. Em cada linha nova, escolha a TAG no dropdown — a TAG padrão aparece primeiro e já vem selecionada — e use somente o checkbox para incluir ou retirar o dia da seleção; **Selecionar restantes** marca todos os pendentes. O total **Selecionados para enviar** acompanha essas decisões.
10. Depois que ao menos um item enviável for marcado, a etapa **5. Enviar ao Channel** libera **Enviar selecionados** e **Cancelar operação**. **Enviar selecionados** é a autorização única para toda a seleção. A barra da própria etapa mostra a data em revalidação e a contagem confirmada (`n de N`). Enquanto houver envio ativo, **Parar envio** impede o próximo POST; como um POST já despachado não pode ser desfeito, a interface exige capturar e comparar novamente. Cada confirmação transforma a linha em **Já igual**, mostra o projeto/atividade realmente aplicados, atualiza a cor para verde e remove o item dos totais pendentes.
11. **Cancelar operação** impede o despacho das próximas requisições. Uma requisição que já chegou ao Channel não pode ser revertida pela extensão.

Se uma aba registrada do Ahgora ou do Channel for fechada — ou navegar para outra origem — a extensão invalida somente aquela conexão, exibe um alerta de **Reconexão necessária**, reabre a etapa de conexão e bloqueia captura e envio até que as abas necessárias sejam reconectadas. O ícone da extensão também recebe um indicador de atenção.

O Channel continua recebendo um item por requisição. A fila é sequencial e interrompe na primeira resposta ausente ou divergente para evitar repetição ambígua.

## Períodos e paridade

- default: mês-calendário anterior, sempre na janela 26–25, independentemente do dia atual;
- mês explícito: janela 26 do mês anterior até 25 do mês escolhido;
- intervalo: início e fim inclusivos, com início não posterior ao fim;
- modo anual, CSV, `OPERACOES`, `AVULSO` e regras históricas do Expert estão fora do escopo;
- linhas Channel repetidas preservam a ordem e a última linha da data vence; não são somadas;
- divergências existentes são exibidas e não corrigidas;
- o parser de batidas preserva o comportamento Ruby, mostra avisos para valores incomuns/pares invertidos e bloqueia duração não positiva antes do formulário.

## Permissões e dados

O manifesto usa `activeTab`, `identity`, `scripting`, `storage` e `sidePanel`; não declara permissões de host obrigatórias. Antes do build de distribuição, defina `GOOGLE_OAUTH_CLIENT_ID` com um OAuth Client ID do tipo extensão Chrome, vinculado ao ID estável da extensão. `CHROME_EXTENSION_PUBLIC_KEY` pode injetar a chave pública no manifesto para estabilizar o ID de builds descompactadas. Sem o Client ID, o build não inclui uma configuração `oauth2` inválida; o modo OAuth fica indisponível, mas o modo por aba continua utilizável. O OAuth do Calendar usa somente os escopos `calendar.events.readonly` e `calendar.calendarlist.readonly`; o token fica sob responsabilidade de `chrome.identity` e não é persistido pela aplicação. Os acessos a `https://www.googleapis.com/*` e `https://calendar.google.com/*` são opcionais e solicitados apenas no gesto de conexão do modo correspondente. Os três hosts exatos de Ahgora/Channel também são permissões opcionais para login, registro automático e execução nas páginas abertas pela extensão. O usuário pode recusá-las; nesse caso, o gesto `activeTab` em cada aba permanece como fallback temporário. Os requests Ahgora/Channel e o GET de exportação do Calendar rodam no contexto principal da página para que o navegador aplique a sessão mantida pelo próprio sistema; a extensão não lê cookies e não persiste tokens ou credenciais. No modo aba, o ZIP/ICS é mantido somente em memória durante conexão/captura, limitado a 32 MB, e recorrências são expandidas apenas para o período solicitado. `chrome.storage.session` contém a operação corrente e IDs das abas; `chrome.storage.local` contém catálogo Channel, TAGs, regras, estado de ativação, modo de acesso e IDs dos calendários selecionados, mas não o conteúdo dos eventos.

Fixtures sintéticas comprovam o contrato local, não compatibilidade com páginas autenticadas. Antes de usar em dados reais, siga [docs/manual-validation.md](docs/manual-validation.md). Arquitetura e manutenção dos adapters estão em [docs/architecture.md](docs/architecture.md).

O smoke autenticado é deliberadamente opt-in. Ele recebe URLs e credenciais somente por variáveis de ambiente e autentica um contexto efêmero do Chrome. O caminho direto consulta as APIs e prepara o POST completo, mas usa `commit: false`; nenhuma gravação real é executada pelo teste. Para usar a configuração legada local: `set -a; source ../standalone/config.sh; RUN_AUTHENTICATED_SMOKE=1 npm run test:authenticated`.

O runner `test:authenticated:headless-flow` carrega a extensão empacotada em um perfil Chromium efêmero com permissões de host exatas apenas para as duas origens configuradas. Ele exige `RUN_AUTHENTICATED_HEADLESS_FLOW=1`, `CHANNEL_FLOW_START` e `CHANNEL_FLOW_END`. Sem `CHANNEL_FLOW_COMMIT=1`, apenas captura e compara. Com esse flag, envia POSTs reais somente se todas as datas estiverem ausentes e sem avisos, confirma cada gravação pelo Channel e repete a comparação exigindo igualdade. Exemplo não destrutivo: `set -a; source ../standalone/config.sh; RUN_AUTHENTICATED_HEADLESS_FLOW=1 CHANNEL_FLOW_START=2026-08-20 CHANNEL_FLOW_END=2026-08-21 npm run test:authenticated:headless-flow`.

### Escopo exato dos testes de navegador

O e2e carrega a extensão e duas páginas HTTP sintéticas, incluindo o iframe Ahgora, mas começa de uma prévia colocada em `storage.session`: ele comprova renderização, seleção inicialmente vazia, bloqueio de duplo clique e reidratação. Ele não é chamado de fluxo completo porque o Playwright não concede `activeTab` pela action real.

O fluxo automatizado padrão depois do gesto fica na integração coordenada: ela comprova captura, leitura, comparação, seleção e envio sequencial de toda a fila após uma única ação. Os testes de contrato usam respostas sintéticas e o smoke autenticado valida os contratos reais sem fazer POST de gravação. A gravação real automatizada fica isolada no runner headless opt-in descrito acima.

## Catálogos RAG

Os catálogos de reuniões e a decisão de interface estão documentados em
[`docs/rag-catalogs.md`](docs/rag-catalogs.md). Gere novamente os JSONs com
`npm run convert:rag` sempre que um dos CSVs de `docs/rag` for alterado.

Na extensão, expanda **2. Regras** e abra **Gerenciar catálogos de apontamentos
RAG** para criar, editar, excluir, restaurar e transferir itens por CSV. A
importação valida e converte o arquivo localmente, mostra uma prévia e exige
confirmação quando a substituição remove itens. Regras do Calendar e entradas de
templates nunca ficam órfãs silenciosamente: a exclusão permite reatribuir as
referências e as restaurações/importações destrutivas informam e removem os
consumidores afetados na mesma gravação. Se a persistência falhar, catálogo e
configuração voltam ao estado anterior. **Restaurar fonte** e **Restaurar todas**
voltam aos catálogos empacotados nesta versão; itens originais alterados também
podem ser restaurados individualmente.

## Limitações e solução de problemas

### Diagnóstico no console

As mensagens de diagnóstico começam com `[PontoNaCerti]` e registram apenas códigos, origens, IDs técnicos, contagens e presença/ausência de elementos. Projeto, atividade, datas, horas, conteúdo das páginas e credenciais não são impressos.

1. Abra `chrome://extensions`, localize **Ponto na Certi** e clique no link **service worker** para ver registro de abas, requests e erros de coordenação.
2. Nas abas, filtre o Console por `[PontoNaCerti][AhgoraApi]`, `[ChannelCatalog]`, `[ChannelApiRead]` ou `[ChannelApiWrite]`.
3. Reproduza o erro e filtre o Console por `PontoNaCerti`. Ao relatar o problema, copie o objeto completo dessas mensagens e informe a ação executada.

- **Acesso perdido/aba navegou:** escolha Registrar novamente e clique na action na aba correta.
- **Login/API indisponível:** autentique-se manualmente e mantenha a aba Channel no Extrato, onde o cliente DWR necessário está carregado.
- **Contexto Channel ausente:** a extensão faz um GET autenticado do Extrato para recuperar participante e empresa antes do DWR. Se ainda falhar, a mensagem distingue participante, empresa, login ou cliente DWR ausente; o Console registra somente a origem estrutural desses valores.
- **Registro existente:** duração igual é tratada como idempotente; duração divergente interrompe a fila e não é sobrescrita.
- **Fila parcial:** resultados anteriores são verdadeiros por item; itens restantes continuam pendentes. Não interprete como lote concluído.
- **Validação real de escrita:** o smoke comum apenas prepara tokens, IDs e corpo. Somente **Enviar selecionados** ou o runner headless com `CHANNEL_FLOW_COMMIT=1` enviam apontamentos reais; ambos confirmam o resultado relendo o Channel.
