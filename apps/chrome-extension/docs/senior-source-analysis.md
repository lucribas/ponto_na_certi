# Análise da fonte Senior e plano de integração

A integração deve consultar o Ahgora até 20/09/2026 e a Senior a partir de
21/09/2026, inclusive. Intervalos que atravessam o corte precisam combinar as
duas fontes. A consulta autenticada da Senior foi comprovada por execução no
contexto principal da página, disparada pela extensão Chrome do projeto.

Esta análise foi realizada em 29/09/2026. O ano do corte foi inferido do contexto
da solicitação e coincide com os registros observados. Este documento planeja a
implementação; o adaptador de produção ainda não foi alterado.

O [plano detalhado de implementação](features/senior-source/plan.md) transforma
estas evidências em ondas, contratos, modelo de dados e critérios de aceite.

## Método e limites da inspeção

Foi executado `npm run build`, incluindo a verificação do pacote, com sucesso.
Uma cópia temporária de `dist` foi carregada em Chromium com interface gráfica,
perfil novo e permissão de host restrita a
`https://gestaodoponto.certi.org.br/*`. O usuário autenticou esse perfil.

A instrumentação acompanhou as requisições da interface, seus parâmetros e o
formato das respostas. As sondagens de API foram executadas a partir do service
worker da extensão usando `chrome.scripting.executeScript`, em `world: 'MAIN'`.
Não foram enviados acertos, justificativas, assinaturas ou apontamentos. O modal
de marcações foi aberto para inspeção e fechado por Cancelar. A navegação mensal
da própria Senior emitiu POSTs de consulta, sem corpo.

Foram inspecionados uma conta, a competência corrente e a anterior. A interface
identificou a versão 6.10.4.139. Os contratos descritos são observações dessa
instalação, não uma garantia pública de estabilidade da API. Identificadores de
pessoas e valores de autenticação não integram este documento.

## Acesso e autenticação

- Entrada indicada pelo usuário:
  `https://gestaodoponto.certi.org.br/gestaoponto-frontend/time-adjustment/employee/`.
- No perfil novo, esse acesso direto terminou em `/gestaoponto-frontend/not-found`.
  A raiz `/gestaoponto-frontend/` abriu `/gestaoponto-frontend/login`.
- Campos de login observados: `#index-vm-username`, `#index-vm-password` e botão
  `Autenticar`. A sondagem detectou apenas presença dos campos.
- Após autenticação, a rota foi
  `/gestaoponto-frontend/time-adjustment/employee/{colaborador}/all`.
  O identificador deve ser descoberto na sessão/rota atual, nunca fixado no código.
- `fetch` com `credentials: 'include'`, para o GET observado de apuração, retornou
  HTTP 401. Portanto, cookies aplicados pelo navegador não bastaram nessa sondagem.
- A mesma consulta por `angular.element(document.body).injector().get('$http')`
  retornou HTTP 200 com os nove dias da tela, quando chamada pela extensão.
  A requisição da aplicação contém cabeçalhos `assertion` e `zone-offset`;
  seus valores não precisam atravessar a fronteira da extensão.

**Proposta:** reutilizar o cliente `$http` da página para GETs de leitura, com
detecção explícita de sua disponibilidade. Assim, a aplicação administra seus
interceptadores de autenticação. Não copiar tokens de storage ou cookies para
o service worker. Tratar sessão expirada, cliente indisponível, timeout e resposta
incompatível como erros próprios; não recorrer a leitura incompleta do DOM.
Essa dependência de AngularJS deve ficar confinada ao adaptador Senior.

## Contrato de consulta observado

Todos os caminhos abaixo usam a mesma origem, sob
`/gestaoponto-backend/api`. Os nomes entre chaves são parâmetros descobertos em
tempo de execução.

| Consulta                   | Método e caminho                                                     | Parâmetros relevantes                                                                       |
| -------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Competência específica     | GET `/codigos-calculo/buscar-codigo-calculo-competencia`             | `colaborador`, `competencia=AAAA-MM-01`, `isTelaColaborador=S`                              |
| Dias da apuração           | GET `/acertoPontoColaboradorPeriodo/colaborador/{colaborador}`       | `codigoCalculo`, `dataInicial`, `dataFinal`, `isTelaColaborador=S`, `orderby=-dataApuracao` |
| Contagem de dias           | GET `/acertoPontoColaboradorPeriodo/colaborador/{colaborador}/count` | Datas e código de cálculo; a interface também usa `filtraPendencias=COLABORADOR`            |
| Colaborador na competência | GET `/colaboradores/{colaborador}/buscar-transferido/competencia`    | `competencia`                                                                               |

A consulta GET por competência devolveu `result.codigoCalculo` e
`result.colaborador`. O código de cálculo contém `codigoCalculo`, `id`,
`competencia`, `inicioApuracao`, `fimApuracao`, `inicioAcerto`, `fimAcerto`,
`temAnterior` e `temPosterior`. Datas de acerto e datas de apuração são distintas;
o período de captura deve usar as de apuração. O código e o colaborador resolvidos
devem ser usados na leitura daquela competência, inclusive para contemplar
transferências de vínculo; esse último caso ainda precisa de validação real.

Na abertura inicial, a interface também usou POST
`/codigos-calculo/buscar-codigo-calculo-inicial`. Na navegação anterior, usou POST
`/codigos-calculo/navegar-anterior`, com `codigoCalculo` no formato do campo `id`,
`colaborador` e `isTelaColaborador=S`. A futura captura pode preferir o GET por
competência, já validado, sem depender da navegação visual.

A leitura dos dias devolve `{ apuracao: [...], colaborador: {...} }`.
Cada dia contém `dataApuracao`, `marcacoes`, eventualmente `marcacoesPrevistas`,
`situacoesApuradas`, `status` e `incidentes`. As marcações incluem `dataAcesso`,
`dataApuracao`, `horaAcesso`, `origem`, `uso`, `sequencia` e `marcacaoOriginal`.

Não foram observados parâmetros de paginação na consulta de apuração. A consulta
completa trouxe nove dias, consistente com `result.total=9` da contagem. Isso
valida a amostra, mas não comprova ausência de limites para períodos maiores.
O adaptador deve comparar cobertura/contagem e distinguir ausência de dados de
resposta incompleta.

## Períodos e escolha da fonte

A competência OUT/2026 observada cobre **21/09/2026 a 20/10/2026**. A competência
SET/2026 anterior cobre **20/08/2026 a 20/09/2026** e retornou zero dias nesta conta.
Portanto, não se deve extrapolar uma fórmula fixa para todas as competências:
as datas retornadas pela Senior são a referência para suas consultas.

O projeto atualmente resolve a seleção mensal em 26 do mês anterior a 25 do mês
selecionado, e calcula `mirrorMonths` segundo o Ahgora. Esse agrupamento não serve
para a Senior. Separar três decisões:

1. O intervalo desejado pelo usuário.
2. A divisão desse intervalo pela data de corte da fonte.
3. As competências necessárias para consultar cada fornecedor.

**Preferência mensal ainda não confirmada:** acompanhar o fechamento Senior na
seleção por mês ou preservar 26 a 25. A recomendação desta análise é acompanhar a
Senior nas novas competências, com transição explícita. O plano detalhado adota
como premissa conservadora preservar 26 a 25 na primeira entrega e tratar a
mudança de calendário separadamente; isso não impede consultar competências Senior.

Os intervalos explícitos permitem especificar a migração sem ambiguidade:

| Intervalo solicitado    | Leituras necessárias                             |
| ----------------------- | ------------------------------------------------ |
| Até 20/09/2026          | Ahgora                                           |
| Desde 21/09/2026        | Senior                                           |
| 26/08/2026 a 25/09/2026 | Ahgora de 26/08 a 20/09; Senior de 21/09 a 25/09 |
| 21/09/2026 a 20/10/2026 | Senior, competência OUT/2026                     |

Nunca completar ausência da Senior com Ahgora após o corte. Cada data tem uma
fonte responsável; sobreposição entre respostas deve ser filtrada pelos limites
solicitados e duplicidade conflitante deve produzir erro.

## Normalização e revisão

- Usar `apuracao[].dataApuracao` como dia de trabalho e `marcacoes` como origem
  das batidas. Ignorar `marcacoesPrevistas`: houve dia sem batidas realizadas com
  quatro horários previstos preenchidos.
- Não somar `marcacaoOriginal` às marcações atuais. Trata-se de um objeto aninhado
  presente na amostra, não de uma segunda batida a acrescentar.
- Calcular duração pelos pares de marcações. A amostra de 25/09 soma **08:17**,
  embora “Trabalhando” mostre **08:00** e “Crédito Banco de Horas” mostre **00:17**.
  Somar indiscriminadamente situações também pode incluir débitos ou outros saldos.
- A API trouxe origens `D` e `E`, e a tela mostrou `uso=2` como “Marcação de Ponto”.
  Não filtrar apenas marcações eletrônicas: a tela inclui uma marcação digitada.
  Outros usos, origens, exclusões e substituições ainda exigem casos de contrato.
- Preservar data de acesso e metadados necessários até validar a ordenação e a
  associação ao dia de trabalho. O cálculo atual só subtrai horários HH:MM; uma
  jornada entre datas diferentes não deve ser convertida silenciosamente em saldo
  negativo. Suportar a virada de dia ou bloquear esse caso com mensagem explícita.
- Manter alertas para quantidade ímpar, horário inválido e pares inconsistentes.
  Ausência de marcações não representa automaticamente uma jornada de oito horas.
- A tela apresenta pendências e “Com o gestor” mesmo quando existem marcações.
  Capturar esses metadados e exibi-los para revisão. A relação completa entre códigos
  de status e aprovação ainda não foi validada; não tratar todo dia com status como
  inválido nem apresentá-lo como definitivamente aprovado.
- Consultar todos os dias sem `filtraPendencias`. A aba “Pendentes” retornou somente
  quatro dos nove dias, através desse parâmetro. O resultado da extensão não deve
  depender da aba `all`, `pending` ou `total` que estiver aberta.

## Plano de implementação

| Etapa | Mudança                                                                                                              | Critério de conclusão                                                                                          |
| ----- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 1     | Criar contrato comum de captura e resolução de fontes por data                                                       | Corte inclusivo em 21/09; intervalos mistos sem lacunas ou duplicidades                                        |
| 2     | Implementar `sites/senior` com descoberta de colaborador, GET de competência e GET de apuração via cliente da página | Consulta da mesma amostra por execução real da extensão; normalização fiel à tela                              |
| 3     | Integrar abas, permissões, login e progresso por fornecedor                                                          | Período Senior funciona sem conexão Ahgora; período misto valida ambas as abas                                 |
| 4     | Integrar cálculo, revisão e alertas                                                                                  | Duração calculada pelas batidas; procedência e pendências visíveis; alertas consultam a fonte da data corrente |
| 5     | Ajustar seleção mensal conforme decisão do usuário e documentar transição                                            | Competências históricas e novas com limites explícitos; intervalos livres preservados                          |
| 6     | Executar testes de contrato, integração e smoke autenticado de leitura                                               | Resultados conferidos com a Senior; regressão Ahgora e fluxo Channel preservados                               |

Pontos concretos do código:

- `src/sites/source`: preservar o adaptador Ahgora; extrair somente os contratos
  que realmente são comuns e acrescentar um adaptador Senior separado.
- `src/domain/period.ts`: separar `mirrorMonths` do período comum e acrescentar
  roteamento por data; resolver competências Senior a partir dos metadados da API.
- `src/domain/punches.ts` e `src/domain/comparison.ts`: manter o cálculo validado e
  remover a associação semântica exclusiva a Ahgora (`compareAhgoraWithChannel`,
  `ahgoraMinutes`, `ahgoraDuration`), com compatibilidade na transição de estado.
- `src/application/types.ts`: substituir a única `sourceTab` por bindings por
  fornecedor, generalizar `CaptureProgress` e `LoginPreparation` e registrar fonte
  nos dias da prévia. Projetar tratamento de operações persistidas antigas:
  invalidar capturas incompatíveis e exigir recaptura, preservando TAGs e regras.
- `src/messaging/messages.ts` e `validation.ts`: identificar fornecedor no registro
  de fonte e validar mensagens recebidas; não confiar apenas no rótulo `source`.
- `src/sites/login.ts` e `src/background/service-worker.ts`: descobrir/abrir as
  fontes necessárias, detectar login Senior e revalidar origem e aba por fornecedor.
  Preservar cancelamento e proteção contra resultados de operações antigas.
- `src/background/coordinator.ts`: capturar as partes do intervalo, consolidar dias
  e comparar com Channel somente após todas as fontes obrigatórias concluírem.
  Falha de uma fonte não pode se passar por captura completa.
- `manifest.json`: acrescentar o host Senior como permissão opcional. A permissão
  obrigatória foi usada apenas na cópia efêmera de teste.
- `src/ui/side-panel.*`, `src/application/punch-alerts.ts` e monitor no service worker:
  rótulos de fonte, conexão, mensagens e destino das notificações devem acompanhar
  o fornecedor. Os alertas usam a data de hoje, não o mês selecionado no painel.
- README, arquitetura, validação manual e runners autenticados: incluir Senior e
  permitir testar sua leitura sem exigir credenciais Ahgora ou escrita no Channel.

## Evidências de validação e testes necessários

| Sondagem executada                             | Resultado                         |
| ---------------------------------------------- | --------------------------------- |
| Build da extensão e verificação do pacote      | Sucesso                           |
| Injeção MAIN pela extensão na página Senior    | Sucesso                           |
| GET de apuração com fetch e cookies            | HTTP 401                          |
| Mesmo GET pelo cliente da página, via extensão | HTTP 200, nove dias               |
| GET de competência específica                  | HTTP 200, limites 21/09 a 20/10   |
| Intervalo inclusivo 21/09 a 21/09              | HTTP 200, um dia                  |
| Intervalo inclusivo 21/09 a 25/09              | HTTP 200, cinco dias              |
| Intervalo futuro 30/09 a 20/10                 | HTTP 200, lista vazia             |
| Competência anterior, pela interface           | Zero dias nesta conta             |
| Filtro Pendentes                               | Quatro dias, contra nove em Todos |

Adicionar testes sintéticos para limites 20/09 e 21/09, intervalo misto,
competências distintas, dias vazios com horários previstos, marcação digitada,
batidas ímpares, virada de dia, duplicidades, pendências, transferência de vínculo,
sessão expirada, resposta parcial e cancelamento. Não usar identificadores reais
ou credenciais em fixtures.

O smoke Senior deve consultar e comparar datas escolhidas com a interface, sem
enviar acertos. O runner atual `authenticated-headless-flow.mjs` pressupõe Ahgora
e Channel e não pode ser usado sem adaptação como validação Senior.

Antes de liberar: typecheck, lint, testes unitários e de integração pertinentes,
regressão dos adaptadores existentes, build/verificação do pacote e smoke
autenticado Senior. Os testes da implementação não foram executados nesta análise,
pois ela ainda não existe.

## Referências

- [Página Senior indicada pelo usuário](https://gestaodoponto.certi.org.br/gestaoponto-frontend/time-adjustment/employee/)
- [Entrada Senior validada no perfil novo](https://gestaodoponto.certi.org.br/gestaoponto-frontend/)
- [Arquitetura atual](architecture.md)
- [Validação manual existente](manual-validation.md)
- [Runners e comandos do projeto](../README.md)
