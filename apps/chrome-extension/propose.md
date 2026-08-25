# Migração da automação Ruby para uma extensão Chrome Manifest V3

Você está trabalhando na raiz de um repositório que contém uma automação standalone escrita em Ruby.

Sua missão é analisar profundamente essa implementação Ruby e criar, dentro do mesmo repositório, uma extensão para Google Chrome que reproduza o comportamento existente com a maior fidelidade possível.

Não entregue apenas uma análise, um plano, pseudocódigo ou snippets. Inspecione o repositório, implemente os arquivos, execute os testes, execute o build e deixe a extensão pronta para ser carregada no Chrome como uma extensão descompactada.

## Contexto funcional

A automação atual executa três responsabilidades principais:

1. Acessa um site que apresenta o espelho de ponto do usuário.
2. Extrai as horas trabalhadas por dia e aplica regras de negócio.
3. Acessa outro site e preenche as horas nos projetos correspondentes.

Na nova solução:

* o usuário fará login manualmente nos dois sites;
* o usuário manterá os dois sites abertos em abas separadas;
* a extensão não deve solicitar, capturar, armazenar ou transmitir senhas;
* a extensão deve operar usando as sessões já autenticadas nas abas;
* a extensão deve capturar os dados na aba do espelho de ponto;
* a extensão deve aplicar exatamente as regras de negócio existentes no Ruby;
* a extensão deve preencher os dados na aba do sistema de projetos;
* o código Ruby existente é a principal especificação funcional e deve ser tratado como fonte de verdade;
* não invente regras, seletores, arredondamentos ou comportamentos que não estejam sustentados pelo código existente.

A extensão não terá Ruby em runtime. Toda lógica necessária à execução no navegador deve ser portada para TypeScript ou JavaScript.

## Comportamento durante a execução desta tarefa

Antes de alterar qualquer arquivo:

1. Execute `git status`.
2. Não descarte nem sobrescreva modificações existentes do usuário.
3. Não use `git reset --hard`, `git clean`, checkout destrutivo ou comandos equivalentes.
4. Não faça commits nem pushes sem solicitação explícita.
5. Identifique o package manager e as ferramentas já existentes.
6. Leia todos os arquivos relevantes do projeto Ruby, incluindo, quando existirem:

   * `README`;
   * `Gemfile`;
   * `Gemfile.lock`;
   * executáveis em `bin/`;
   * código em `lib/`, `app/` ou diretórios equivalentes;
   * configurações;
   * arquivos YAML, JSON ou CSV;
   * testes;
   * fixtures;
   * scripts auxiliares;
   * exemplos de execução;
   * arquivos relacionados a Selenium, Watir, Capybara, Nokogiri ou ferramentas similares.

Se houver um `AGENTS.md`, preserve seu conteúdo e atualize-o apenas quando necessário. Se não houver, crie um `AGENTS.md` curto e objetivo após entender o repositório, incluindo:

* estrutura relevante do projeto;
* comandos de instalação;
* comandos de build;
* comandos de lint;
* comandos de testes;
* restrições de segurança;
* definição de pronto;
* localização da implementação Ruby legada;
* localização da nova extensão.

Não pare depois de apresentar o plano. Continue até a implementação e validação, exceto diante de um bloqueio técnico real que não possa ser resolvido a partir do repositório.

Quando houver informação incompleta, faça a melhor inferência sustentada pelo código, documente a suposição e prossiga. Não fabrique seletores ou URLs silenciosamente.

Quando o ambiente suportar subagentes e isso trouxer benefício real, distribua atividades independentes, por exemplo:

* auditoria da implementação Ruby;
* arquitetura da extensão;
* estratégia de testes de paridade;
* revisão de segurança e permissões.

A thread principal deve revisar e integrar todos os resultados.

## Fase 1 — Engenharia reversa da implementação Ruby

Analise a implementação Ruby antes de portar o código.

Identifique e documente:

### Fluxo de execução

* entrypoint principal;
* argumentos de linha de comando;
* variáveis de ambiente;
* arquivos de configuração;
* URLs acessadas;
* sequência de navegação;
* autenticação atualmente executada;
* estados esperados das páginas;
* condições para sucesso e falha;
* tratamento de erros;
* retries;
* timeouts;
* sleeps;
* screenshots e logs;
* arquivos intermediários;
* ações de submissão ou confirmação final.

### Scraping do espelho de ponto

Para cada informação capturada, identifique:

* arquivo e método Ruby responsável;
* página de origem;
* seletor CSS, XPath, texto ou estratégia de localização;
* existência de iframe;
* existência de paginação;
* existência de tabela virtualizada;
* carregamento assíncrono;
* tratamento de linhas ausentes;
* formato de data;
* formato de horário;
* intervalos de entrada e saída;
* pausas;
* total diário;
* horas extras;
* banco de horas;
* ausência;
* feriado;
* fim de semana;
* observações;
* arredondamentos;
* timezone e locale.

### Regras de negócio

Liste individualmente todas as regras encontradas no Ruby, incluindo:

* conversão de horários;
* cálculo de duração;
* tratamento de virada de dia;
* intervalo de almoço;
* arredondamento;
* distribuição entre projetos;
* limites mínimos e máximos;
* dias ignorados;
* tratamento de feriados;
* tratamento de finais de semana;
* horas extras;
* compensações;
* validações;
* diferenças entre horas trabalhadas e horas lançadas;
* precedência entre configurações;
* regras excepcionais;
* valores default;
* mensagens de erro.

Não simplifique as regras apenas porque alguma implementação pareça estranha. Primeiro preserve o comportamento. Qualquer proposta de correção deve ser separada da migração e documentada como mudança potencial, sem ser aplicada silenciosamente.

### Preenchimento do sistema de projetos

Identifique:

* páginas acessadas;
* seleção de período;
* seleção de projeto;
* seleção de atividade;
* seleção de usuário;
* seletores;
* campos preenchidos;
* formato esperado dos valores;
* eventos disparados;
* botões clicados;
* navegação entre dias;
* submissão;
* confirmação;
* prevenção de duplicidade;
* validações feitas pela página;
* mensagens de sucesso e erro;
* esperas por atualizações do DOM;
* comportamento diante de valores previamente preenchidos.

### Dependências incompatíveis com extensão

Identifique qualquer funcionalidade Ruby que dependa de:

* filesystem;
* shell;
* banco de dados;
* bibliotecas nativas;
* navegador controlado por WebDriver;
* downloads;
* uploads;
* geração de arquivos;
* serviços externos;
* chamadas HTTP independentes do navegador;
* cookies manipulados diretamente;
* credenciais;
* CAPTCHA;
* certificados de cliente;
* autenticação integrada;
* recursos inacessíveis a uma extensão.

Para cada incompatibilidade, implemente uma alternativa adequada ao navegador ou documente claramente a limitação.

## Artefato de mapeamento

Crie:

```text
docs/ruby-to-extension-mapping.md
```

Esse documento deve conter uma matriz com, no mínimo:

| Código Ruby | Responsabilidade | Comportamento observado | Código TypeScript correspondente | Teste de paridade | Status |
| ----------- | ---------------- | ----------------------- | -------------------------------- | ----------------- | ------ |

A matriz deve permitir rastrear cada regra importante desde a origem Ruby até a nova implementação.

## Fase 2 — Arquitetura da extensão

Implemente uma extensão Chrome baseada em Manifest V3.

Use TypeScript com `strict: true`.

Use a menor quantidade razoável de dependências. Se o repositório não tiver uma stack frontend definida, prefira:

* TypeScript;
* HTML e CSS;
* uma ferramenta de build simples e mantida;
* Vitest ou ferramenta equivalente para testes unitários;
* Playwright para testes de integração quando viável.

Não introduza React, Angular, Vue ou outro framework apenas para criar uma pequena interface de popup. Use um framework somente se houver justificativa técnica clara ou se o repositório já estiver padronizado nele.

A organização sugerida é:

```text
extension/
  manifest.json
  package.json
  tsconfig.json
  src/
    background/
      service-worker.ts
    content/
      source-site.ts
      target-site.ts
    domain/
      models.ts
      business-rules.ts
      normalization.ts
      validation.ts
    sites/
      source/
        adapter.ts
        selectors.ts
      target/
        adapter.ts
        selectors.ts
    messaging/
      messages.ts
      validation.ts
    ui/
      popup.html
      popup.ts
      popup.css
    shared/
      errors.ts
      logging.ts
      dates.ts
      time.ts
      wait.ts
  tests/
    unit/
    integration/
    fixtures/
  docs/
  scripts/
```

Ajuste essa estrutura quando o projeto existente justificar outra organização, mas mantenha separadas:

* interação com o DOM;
* regras de negócio;
* coordenação entre abas;
* interface do usuário;
* configurações;
* tipos de mensagens;
* testes.

## Responsabilidades dos componentes

### Content script do site de origem

Responsável por:

* detectar se a página correta está aberta;
* detectar se o usuário parece autenticado;
* aguardar o carregamento real do espelho de ponto;
* localizar os elementos usando os seletores extraídos do Ruby;
* extrair os dados;
* normalizar os dados;
* devolver um DTO serializável;
* retornar erros detalhados sem incluir dados sensíveis desnecessários.

O content script de origem não deve conhecer detalhes do formulário do site de destino.

### Módulo de domínio

Responsável por:

* portar as regras do Ruby;
* trabalhar com funções puras sempre que possível;
* validar entradas e saídas;
* manter datas sem ambiguidades de timezone;
* representar durações internamente como minutos ou segundos inteiros, conforme a precisão exigida pelo Ruby;
* evitar cálculos usando números decimais de ponto flutuante quando isso puder alterar valores de horas;
* produzir um resultado normalizado que possa ser exibido e preenchido.

Datas sem horário devem ser representadas como datas civis, por exemplo `YYYY-MM-DD`, sem conversão acidental para UTC.

Não aplique arredondamento que não exista no Ruby.

### Service worker

Responsável por:

* coordenar o fluxo;
* localizar abas candidatas;
* validar os domínios das abas;
* detectar múltiplas abas correspondentes;
* comunicar-se com os content scripts;
* armazenar apenas o estado transitório necessário;
* enviar progresso e erros para a interface;
* nunca manipular DOM diretamente;
* nunca armazenar credenciais.

Use mensagens tipadas, preferencialmente com discriminated unions, por exemplo:

```typescript
type ExtensionMessage =
  | { type: "DETECT_SOURCE_PAGE" }
  | { type: "EXTRACT_TIMESHEET"; operationId: string }
  | { type: "PREVIEW_RESULT"; operationId: string; payload: unknown }
  | { type: "FILL_TARGET"; operationId: string; payload: unknown }
  | { type: "SUBMIT_TARGET"; operationId: string }
  | { type: "CANCEL_OPERATION"; operationId: string };
```

Não aceite mensagens apenas porque possuem um campo `type`. Faça validação em runtime dos dados importantes.

Valide também:

* origem da mensagem;
* aba remetente;
* URL da aba;
* operação corrente;
* formato do payload.

### Content script do site de destino

Responsável por:

* detectar a página correta;
* detectar se o usuário está autenticado;
* selecionar o período adequado;
* localizar cada dia e cada campo;
* preencher os valores;
* disparar eventos compatíveis com a aplicação;
* confirmar que a aplicação reconheceu o valor;
* detectar erros de validação;
* produzir um relatório linha a linha;
* não submeter dados automaticamente sem ação explícita.

Quando o site usar React, Angular, Vue ou componentes controlados, não presuma que atribuir diretamente `element.value` será suficiente. Use a estratégia compatível com o comportamento real da página, incluindo setter nativo e eventos `input`, `change`, `blur` ou outros somente quando necessários.

Não simule cliques indiscriminadamente.

### Popup da extensão

Implemente uma interface em português do Brasil com, no mínimo:

* situação da aba do espelho de ponto;
* situação da aba do sistema de projetos;
* indicação de login não detectado;
* seleção de aba quando houver mais de uma candidata;
* botão para capturar as horas;
* período detectado;
* tabela de pré-visualização;
* total de horas capturado;
* total que será preenchido;
* divergências;
* avisos;
* botão “Preencher”;
* relatório do preenchimento;
* botão de cancelamento quando aplicável;
* opção de submissão final somente quando suportada pela automação Ruby.

A interface deve distinguir claramente:

1. Capturado.
2. Validado.
3. Preenchido no formulário.
4. Confirmado pelo site.
5. Enviado definitivamente.

O modo padrão deve ser:

* capturar;
* exibir prévia;
* preencher;
* deixar o usuário revisar.

Se o código Ruby atualmente confirma ou envia o formulário, implemente também “Preencher e enviar”, mas:

* mantenha a opção desabilitada por padrão;
* exija confirmação explícita;
* informe quantos dias e quantas horas serão enviados;
* não execute a ação automaticamente ao abrir a extensão.

## Modelo de dados

Crie um modelo de domínio baseado nos dados reais encontrados no Ruby.

Um formato possível, que deve ser adaptado à implementação encontrada, é:

```typescript
interface WorkDay {
  date: string;
  workedMinutes: number;
  intervals?: Array<{
    start: string;
    end: string;
  }>;
  breakMinutes?: number;
  overtimeMinutes?: number;
  status?: string;
  notes?: string[];
  source?: {
    rawDate?: string;
    rawWorkedTime?: string;
    rowIndex?: number;
  };
}

interface ProjectEntry {
  date: string;
  projectId?: string;
  projectName?: string;
  activityId?: string;
  activityName?: string;
  minutes: number;
  notes?: string[];
}

interface TransferPlan {
  period: {
    startDate: string;
    endDate: string;
  };
  workDays: WorkDay[];
  projectEntries: ProjectEntry[];
  totalWorkedMinutes: number;
  totalAllocatedMinutes: number;
  warnings: string[];
  errors: string[];
}
```

Não force esse modelo se o Ruby exigir outro. Preserve as informações necessárias para reproduzir as regras.

## Seletores e adapters

Centralize os detalhes de cada site em adapters e arquivos de seletores.

Não espalhe seletores pelo código.

Ao converter XPath Ruby:

* prefira CSS quando ele for estável e equivalente;
* mantenha XPath por meio de `document.evaluate` quando a conversão para CSS reduzir a robustez;
* não substitua seletores conhecidos por seletores inventados;
* priorize atributos estáveis;
* evite classes geradas dinamicamente;
* registre qual seletor veio de qual trecho Ruby.

Crie utilitários como:

```typescript
waitForElement(...)
waitForCondition(...)
waitForDomStable(...)
waitForValueAccepted(...)
```

Use `MutationObserver` ou polling limitado por timeout quando apropriado.

Não use sleeps fixos como mecanismo principal de sincronização. Quando o Ruby usa `sleep`, descubra qual condição ele estava aguardando e transforme isso em uma espera por condição observável.

Todos os waits devem ter:

* timeout;
* mensagem de erro;
* possibilidade de cancelamento quando viável;
* contexto do elemento ou etapa aguardada.

## Iframes, Shadow DOM e contexto da página

Verifique se os elementos estão:

* no frame principal;
* em iframe de mesmo domínio;
* em iframe de outro domínio;
* em Shadow DOM aberto;
* em Shadow DOM fechado;
* renderizados em canvas;
* disponíveis apenas em variáveis JavaScript internas da página.

Quando houver iframe:

* declare somente as permissões necessárias;
* configure `all_frames` apenas quando necessário;
* inclua o domínio exato do frame;
* identifique corretamente em qual frame a mensagem está sendo processada.

Quando os dados estiverem disponíveis apenas no contexto JavaScript principal da página:

* prefira primeiro uma solução pelo DOM;
* use execução no mundo principal somente quando realmente necessária;
* limite o dado transferido;
* valide toda mensagem;
* não exponha funções privilegiadas;
* documente a decisão.

## Permissões e segurança

Use permissões mínimas.

Não use:

```json
"<all_urls>"
```

a menos que seja tecnicamente inevitável e esteja claramente justificado, o que não é esperado para este projeto.

Extraia do Ruby ou das configurações os domínios exatos dos dois sistemas.

Prefira permissões semelhantes a:

```json
{
  "permissions": [
    "storage"
  ],
  "host_permissions": [
    "https://dominio-exato-do-ponto/*",
    "https://dominio-exato-do-projeto/*"
  ]
}
```

Adicione `"scripting"`, `"tabs"` ou outras permissões somente quando forem realmente necessárias.

Não solicite a permissão `"cookies"` apenas para aproveitar sessões existentes.

A extensão deve:

* usar a sessão já aberta pelo usuário;
* não ler senhas;
* não armazenar cookies;
* não armazenar tokens;
* não registrar conteúdo sensível em logs;
* não enviar telemetria;
* não usar analytics;
* não carregar código remoto;
* não usar `eval`;
* não usar `new Function`;
* não inserir scripts de terceiros;
* respeitar a CSP da extensão;
* limitar a comunicação aos domínios esperados.

Use:

* `chrome.storage.session` para dados transitórios da operação;
* `chrome.storage.local` somente para preferências não sensíveis;
* memória sempre que a persistência não for necessária.

Considere as horas trabalhadas e os projetos como dados pessoais. Não mantenha histórico permanente por padrão.

Implemente redaction nos logs. O modo de diagnóstico não deve imprimir:

* senha;
* token;
* cookie;
* cabeçalhos de autenticação;
* conteúdo completo de páginas;
* nomes ou informações pessoais sem necessidade.

## Autenticação

Se o Ruby atualmente preenche usuário e senha, não porte essa parte literalmente.

Substitua por:

* detecção de sessão autenticada;
* detecção da página de login;
* mensagem para o usuário abrir a aba e autenticar-se;
* retomada da operação após o login.

A extensão não deve tentar contornar:

* CAPTCHA;
* MFA;
* autenticação biométrica;
* políticas de sessão;
* controles corporativos.

## Robustez

Implemente:

* identificação inequívoca das abas;
* tratamento de zero, uma ou múltiplas abas candidatas;
* detecção de navegação durante a operação;
* cancelamento;
* timeouts;
* mensagens de erro acionáveis;
* progresso por etapa;
* idempotência;
* prevenção de preenchimento duplicado;
* comparação com valores já existentes;
* detecção de dias ausentes;
* relatório de preenchimento parcial;
* recuperação segura após falha.

O relatório de cada linha deve incluir algo semelhante a:

```typescript
interface FillResult {
  date: string;
  requestedMinutes: number;
  previousMinutes?: number;
  resultingMinutes?: number;
  status:
    | "filled"
    | "already-correct"
    | "skipped"
    | "not-found"
    | "validation-error"
    | "failed";
  message?: string;
}
```

Antes da submissão, compare:

* total capturado;
* total resultante das regras;
* total que será preenchido;
* total reconhecido pelo site;
* valores anteriormente existentes.

Não trate preenchimento parcial como sucesso completo.

## Fase 3 — Testes de paridade com o Ruby

A principal exigência da migração é equivalência comportamental.

Não se limite a escrever testes com resultados inventados. Use a implementação Ruby como oráculo sempre que possível.

### Testes existentes

Primeiro:

* descubra como instalar as gems;
* execute os testes Ruby existentes;
* registre o baseline;
* não altere expectativas apenas para fazer os testes passarem.

### Golden master

Crie uma estratégia de golden master/paridade.

Quando tecnicamente possível:

1. Crie entradas JSON ou fixtures determinísticas.
2. Execute a regra Ruby original sobre essas entradas.
3. Capture a saída normalizada do Ruby.
4. Execute a versão TypeScript sobre as mesmas entradas.
5. Compare as saídas.
6. Faça o teste falhar diante de qualquer divergência não documentada.

Se a lógica Ruby estiver misturada com Selenium ou Watir, crie um adapter mínimo para expor as regras existentes sem alterar seu comportamento.

Não faça uma grande refatoração do Ruby somente para facilitar os testes.

Crie fixtures para, no mínimo:

* dia normal;
* hora com minutos;
* ausência;
* feriado;
* fim de semana;
* hora extra;
* intervalo incompleto;
* linha ausente;
* dado inválido;
* virada de dia, se suportada;
* arredondamento em limites;
* diferença entre total trabalhado e alocado;
* valor já preenchido;
* múltiplos projetos;
* período sem registros;
* duplicidade;
* erro intermediário.

Inclua casos reais já presentes nos testes ou configurações do projeto, removendo dados pessoais.

### Fixtures de HTML

Quando houver HTML de exemplo ou possibilidade de derivá-lo sem dados sensíveis, crie:

```text
extension/tests/fixtures/source/
extension/tests/fixtures/target/
```

Use páginas locais representativas para testar:

* extração;
* normalização;
* preenchimento;
* eventos;
* mudanças assíncronas no DOM;
* mensagens de erro.

Não inclua páginas corporativas completas ou dados pessoais no repositório.

### Testes unitários

Teste separadamente:

* parsing de datas;
* parsing de horários;
* conversão em minutos;
* formatação para o site de destino;
* regras de negócio;
* arredondamento;
* validações;
* distribuição de horas;
* cálculo de totais;
* mensagens;
* validação de payloads.

### Testes de integração

Quando viável, crie um teste com Playwright que:

* carregue a extensão;
* abra uma página local simulando o site de ponto;
* abra outra página local simulando o sistema de projetos;
* execute a captura;
* valide a prévia;
* execute o preenchimento;
* confirme os valores no DOM;
* confirme que nenhuma submissão ocorreu sem confirmação explícita.

Se o ambiente não permitir executar extensão no navegador durante esta tarefa, implemente os testes e documente o comando e a limitação. Não declare que o E2E passou sem evidência.

## Diagnóstico e manutenção

Crie um modo de diagnóstico opcional que ajude a identificar alterações nos sites.

O diagnóstico pode apresentar:

* URL atual;
* página detectada;
* seletores encontrados;
* seletores ausentes;
* quantidade de linhas;
* frames detectados;
* tempo de espera;
* etapa em que ocorreu a falha.

Não inclua dados sensíveis.

Quando um seletor não puder ser extraído do Ruby ou validado por fixture:

* centralize-o em configuração;
* use um nome descritivo;
* marque a necessidade de validação;
* apresente uma mensagem clara;
* não esconda o problema atrás de um seletor genérico.

## Documentação

Crie ou atualize:

```text
extension/README.md
extension/docs/architecture.md
extension/docs/manual-validation.md
docs/ruby-to-extension-mapping.md
AGENTS.md
```

O README deve incluir:

* pré-requisitos;
* versão mínima suportada do Node;
* instalação;
* build;
* testes;
* lint;
* typecheck;
* geração do pacote;
* carregamento como extensão descompactada;
* configuração dos domínios;
* fluxo de uso;
* permissões;
* política de dados;
* limitações;
* troubleshooting.

O documento de validação manual deve possuir uma sequência reproduzível:

1. Fazer login no sistema de ponto.
2. Abrir o período correto.
3. Fazer login no sistema de projetos.
4. Abrir o período correto.
5. Abrir o popup.
6. Confirmar as abas detectadas.
7. Capturar.
8. Conferir os totais.
9. Preencher.
10. Conferir cada linha.
11. Confirmar ou cancelar a submissão.
12. Registrar divergências sem dados sensíveis.

## Scripts esperados

Forneça comandos equivalentes a:

```json
{
  "scripts": {
    "dev": "...",
    "build": "...",
    "typecheck": "...",
    "lint": "...",
    "test": "...",
    "test:unit": "...",
    "test:integration": "...",
    "package": "..."
  }
}
```

Adapte aos recursos realmente implementados.

O comando de empacotamento deve gerar um arquivo instalável ou ZIP em diretório claramente documentado, por exemplo:

```text
extension/artifacts/
```

Não inclua:

* dependências de desenvolvimento desnecessárias;
* secrets;
* `.env` real;
* dumps de página;
* dados pessoais;
* credenciais;
* diretórios temporários;
* artefatos gigantes.

## Critérios de aceite

A tarefa somente estará concluída quando:

* o código Ruby tiver sido analisado;
* as regras estiverem documentadas;
* a matriz Ruby → TypeScript existir;
* a extensão usar Manifest V3;
* a extensão compilar;
* TypeScript estiver em modo estrito;
* os content scripts de origem e destino existirem;
* o service worker coordenar as abas;
* o popup apresentar captura, prévia e preenchimento;
* nenhuma senha for manipulada;
* as permissões estiverem limitadas;
* a lógica de negócio estiver separada do DOM;
* existirem testes de paridade;
* existirem testes unitários;
* o build passar;
* o typecheck passar;
* o lint passar;
* os testes executáveis passarem;
* a documentação explicar como carregar a extensão;
* limitações de validação no ambiente real estiverem explicitadas;
* nenhuma alegação de sucesso estiver baseada apenas em suposição.

## Verificação final obrigatória

Antes de encerrar:

1. Execute os testes Ruby aplicáveis.
2. Execute a suíte TypeScript.
3. Execute o typecheck.
4. Execute o lint.
5. Execute o build.
6. Execute o empacotamento.
7. Inspecione o conteúdo final do `manifest.json`.
8. Verifique se não há `<all_urls>`.
9. Verifique se não há secrets.
10. Verifique se não há credenciais em logs, fixtures ou documentação.
11. Verifique se o ZIP contém somente os arquivos necessários à extensão.
12. Execute `git diff --check`.
13. Execute `git status`.
14. Revise as alterações como se estivesse fazendo code review.

Corrija os problemas encontrados antes de concluir.

## Formato da resposta final

Ao concluir, informe:

### Implementado

Resumo objetivo do que foi criado.

### Mapeamento do Ruby

Principais arquivos e métodos Ruby portados e seus destinos TypeScript.

### Arquitetura

Descrição resumida dos componentes.

### Verificações executadas

Para cada comando:

* comando;
* resultado;
* quantidade de testes;
* falhas ou avisos.

### Arquivos principais

Liste os arquivos relevantes criados ou alterados.

### Como executar

Comandos exatos para:

* instalar;
* testar;
* compilar;
* empacotar;
* carregar no Chrome.

### Validação manual pendente

Liste somente o que realmente exige acesso aos sites autenticados.

### Limitações e riscos

Informe de maneira explícita:

* seletores ainda não validados;
* comportamentos impossíveis de testar localmente;
* diferenças conhecidas em relação ao Ruby;
* decisões assumidas;
* riscos de alteração futura do DOM.

Não diga que a migração está completa ou equivalente se os testes e evidências não sustentarem essa afirmação.
