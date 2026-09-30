# Plano de implementação da fonte Senior

Status: implementado; validação e decisões finais em [implementation-results.md](implementation-results.md).
Data: 29/09/2026. Branch durante o planejamento: `main`.

A extensão passará a ler batidas da Senior desde **21/09/2026, inclusive**,
mantendo Ahgora para datas anteriores. O usuário continuará revisando as horas
antes de enviar apontamentos ao Channel. Um intervalo misto será capturado como
uma operação única, com origem identificada por dia e validação das duas fontes.

Este plano usa a [análise instrumentada](../../senior-source-analysis.md), que
comprovou a consulta autenticada pela extensão e identificou o contrato da Senior.
O ano de corte é uma premissa do contexto, consistente com a amostra real.

## Artefatos e método

- [Decisões e evidências](research.md).
- [Modelo de dados e transições de estado](data-model.md).
- [Contratos de captura e mensagens](contracts.md).
- [Roteiro de implementação e validação](quickstart.md).

O fluxo automático `speckit-plan` não foi executado: `.specify`, especificação
formal, constituição, templates, hooks e scripts de setup não existem neste
checkout. Seus passos de pesquisa, desenho e validação foram adaptados à pasta de
documentação existente. Não foram criados uma constituição, branch ou contexto de
agente artificiais. Os requisitos desta feature estão definidos abaixo.

## Escopo e decisões de produto

1. Até 20/09/2026 a fonte é Ahgora; desde 21/09/2026 a fonte é Senior. A regra usa
   datas civis dos registros, independentemente da data de instalação da extensão.
2. A primeira entrega **preserva a seleção mensal 26 a 25**, inclusive o modo
   `default` existente. Essa é uma premissa conservadora deste plano, não uma
   preferência já confirmada pelo usuário. A recomendação anterior de acompanhar
   o fechamento Senior fica para uma alteração específica de calendário.
3. Mostrar sempre o intervalo efetivo junto à seleção mensal. A competência
   Senior é um agrupamento interno de consulta; seus limites vêm da API e não
   alteram o intervalo solicitado. Intervalos explícitos continuam disponíveis.
   A captura de ponto termina em `min(fim solicitado, hoje)`: datas futuras não
   exigem competências ainda indisponíveis. Um intervalo inteiramente futuro
   produz orientação para escolher datas já decorridas, sem liberar envio.
4. Senior somente para leitura. Login manual assistido por detecção passiva;
   automação de envio do formulário Senior não é necessária nesta entrega.
5. Manter cálculo por batidas, TAGs, regras, Calendar, alocações, overrides e
   proteções de envio ao Channel. Remover nomes Ahgora apenas dos contratos comuns.
6. Jornadas Senior entre datas diferentes ficam bloqueadas para envio nesta
   entrega, com motivo explícito. Suporte ao cálculo noturno completo é separado.
7. Pendências Senior devem ser visíveis. Dias calculáveis com pendência exigem
   seleção individual; ações de seleção em lote não os selecionam. A decisão no
   painel não representa aprovação ou acerto no sistema Senior.

Não fazem parte da entrega: gravar ponto na Senior, justificar incidentes, aprovar
acertos, alterar banco de horas, importar salários/afastamentos, adicionar novas
regras trabalhistas ou substituir a integração de escrita do Channel.

## Requisitos e critérios de aceite

| ID   | Cenário                                 | Resultado verificável                                                                         |
| ---- | --------------------------------------- | --------------------------------------------------------------------------------------------- |
| RF01 | Intervalo até 20/09/2026                | Somente Ahgora é exigido como fonte de ponto                                                  |
| RF02 | Intervalo desde 21/09/2026              | Somente Senior é exigida como fonte de ponto                                                  |
| RF03 | Intervalo atravessa o corte             | Partes inclusivas e disjuntas; mesma data nunca soma as duas fontes                           |
| RF04 | Captura Senior                          | Mesmo conjunto de dias e batidas da consulta Todos, mesmo com Pendentes aberto                |
| RF05 | Batidas previstas/originais e saldos    | Somente marcações efetivas entram no cálculo; 08:17 não vira 08:00                            |
| RF06 | Dia inválido, vazio ou pendente         | Mensagem apropriada; nenhum preenchimento de jornada presumida; bloqueios não selecionáveis   |
| RF07 | Fonte obrigatória falha                 | Prévia não é liberada como completa; envio indisponível até recaptura bem-sucedida            |
| RF08 | Mudança de período ou conexão           | Fontes necessárias recalculadas; prévia e seleções antigas invalidadas                        |
| RF09 | Atualização da extensão com operação v1 | Nova operação exige captura; nenhuma fila antiga é retomada; configurações locais preservadas |
| RF10 | Alertas de almoço                       | Consultam a fonte responsável por hoje e abrem esse fornecedor                                |
| RF11 | Cancelamento e concorrência             | Resultados antigos não restauram prévia nem iniciam nova consulta/escrita                     |
| RF12 | Envio de apontamentos                   | Revisão, seleção, idempotência e validação antes do POST Channel continuam funcionando        |

Exemplos obrigatórios: 20/09–20/09 → Ahgora; 21/09–21/09 → Senior;
20/09–21/09 → uma data em cada fonte; setembro/2026 → 26/08–25/09,
dividido em 26/08–20/09 e 21/09–25/09. Outubro/2026, mantendo a regra atual,
é 26/09–25/10 e pode exigir duas competências Senior depois de ambas terem datas
decorridas. Uma competência necessária já decorrida e indisponível não deve ser
confundida com uma resposta vazia válida.

## Contexto técnico e arquitetura

Manter TypeScript, Chrome Manifest V3, Vite, APIs `chrome.scripting` e storage
existentes; Node 24 e npm conforme CI. Usar Vitest para domínio/contratos e
Playwright para testes da extensão empacotada. Não adicionar biblioteca de runtime.

O domínio resolve o intervalo e divide as fontes. Cada adaptador conhece apenas
seus agrupamentos de consulta. O coordenador normaliza, consolida e calcula os dias,
aguarda Channel/Calendar segundo as regras existentes e publica a prévia. A camada
Senior usa `$http` da página em MAIN; credenciais nunca atravessam essa fronteira.

Estrutura proposta, relativa a `apps/chrome-extension`:

```text
src/domain/source-routing.ts           corte e divisão por datas civis
src/sites/punch-source.ts              contrato comum, sem registro genérico de plugins
src/sites/source/*                     adaptador Ahgora preservado
src/sites/senior/contracts.ts          DTO mínimo e erros Senior
src/sites/senior/injected.ts           probe e consultas GET no MAIN
src/sites/senior/chrome-runner.ts       executeScript e retorno serializável
src/sites/senior/adapter.ts             competências, validação e normalização
src/sites/senior/index.ts               exports públicos do adaptador
```

Alterações transversais: `domain/period.ts`, `domain/comparison.ts`,
`application/types.ts`, `application/storage.ts`, mensagens/validação,
`sites/login.ts`, service worker/coordenador, UI, alertas, manifest, testes e docs.
Evitar mover o adaptador Ahgora inteiro: um wrapper adapta seu resultado existente
ao contrato comum e calcula seus `mirrorMonths` a partir da parte atribuída a ele.

## Ondas de implementação

As ondas são sequenciais. Cada uma só encerra quando seu gate passa. Problemas do
contrato real devem corrigir o desenho antes de ampliar a implementação.

### Onda 0 consolidar os contratos restantes

- Confirmar contagem de Todos sem filtro de pendências; comparar dias únicos e
  `result.total` para o mesmo intervalo e colaborador.
- Validar GET de duas competências adjacentes e distinguir competência inexistente,
  falta de autorização e resposta vazia. Usar o próximo período disponível; caso
  ainda não exista, registrar a resposta de indisponibilidade e testar o caso de
  múltiplas competências com fixture sintética.
- Conferir metadados de uso, origens, ordem e pendências com a tela, sem salvar
  alterações. Registrar limites dos casos não disponíveis na conta de teste.
- Criar fixtures mínimas sintéticas de competência, dia completo, vazio, pendente
  e respostas de erro. Não salvar payloads reais completos ou cabeçalhos secretos.

**Gate G0:** contrato documentado suficiente para a leitura comum; nenhuma hipótese
de contagem/autenticação tratada como validada. Casos excepcionais sem amostra têm
bloqueio explícito e teste sintético correspondente.

### Onda 1 domínio e contrato comum

- Introduzir `PunchSourceId`, intervalo comum e `planSourceSlices` com constante
  `2026-09-21` centralizada. Não comparar timestamps UTC para escolher a fonte.
- Separar `mirrorMonths` do contrato comum: continuar calculando-os no caminho
  Ahgora, mantendo suas regras e testes de paridade.
- Adaptar captura Ahgora ao resultado comum; generalizar comparação e campos de
  duração da prévia. Manter fonte e avisos por dia durante toda a composição.
- Definir contratos v2 de operação/mensagens antes de conectar Senior ao painel.

**Gate G1:** RF01–RF03 comprovados em testes puros; resultados de cálculo/comparação
Ahgora equivalentes aos anteriores; typecheck e testes afetados passam.

### Onda 2 adaptador Senior de leitura

- Reconhecer origem, rota de colaborador e disponibilidade do cliente autenticado.
- Implementar consultas de competência, contagem e dias seguindo [contracts.md](contracts.md).
- Validar cobertura das competências e tamanho/coerência das respostas antes de
  converter marcações. Filtrar o intervalo novamente no adapter.
- Normalizar batidas e avisos; bloquear jornadas entre datas e usos não suportados;
  ignorar previstas e objetos de marcação original.
- Definir timeout por GET, cancelamento lógico entre requisições, descarte de
  resultados antigos e retentativas limitadas para falhas transitórias de leitura.
- Criar smoke opt-in Senior separado do runner Ahgora/Channel, com login manual em
  perfil efêmero e consultas instrumentadas disparadas pela extensão.

**Gate G2:** RF04–RF06 demonstrados com fixtures e smoke real; contagem e amostra de
horários conferem com Todos; nenhuma credencial persiste na extensão; nenhum
endpoint de escrita Senior é chamado pelo adaptador ou pelo smoke.

### Onda 3 conexão e orquestração com múltiplas fontes

- Migrar `OperationData` para v2 conforme [data-model.md](data-model.md).
- Substituir referências posicionais `LOGIN_SITES[0]` por definições nomeadas.
  Adicionar host opcional Senior e preservar fallback por `activeTab`.
- Tornar o período visível/editável antes de Conectar. Enviar período ao worker
  antes da descoberta de abas; abrir e solicitar acesso apenas às fontes necessárias.
- A detecção passiva Senior deve funcionar mesmo com `autoSubmit=false`; hoje o
  monitor da UI depende desse flag e precisa ser desacoplado.
- Registrar bindings por fornecedor. Detectar fechamento, perda de origem ou troca
  de colaborador na mesma origem; invalidar a captura correspondente.
- Capturar partes da fonte sequencialmente, na ordem do intervalo. Channel e Calendar
  podem conservar o paralelismo atual; serializar gravações de progresso no storage.
- Revalidar estado e binding antes de cada injeção e depois do retorno. Após falha,
  recapturar todas as fontes necessárias; não reaproveitar fragmentos de outra revisão.

**Gate G3:** RF07–RF09 e RF11 passam; fonte desnecessária desconectada não bloqueia a
operação; período misto incompleto nunca habilita envio. Revisar também os guards
anteriores a APPLY/ADVANCE, que hoje exigem uma única `sourceTab`.

### Onda 4 revisão e alertas

- Exibir cartões de conexão e progresso por fonte requerida. Usar “Ponto” para
  total agregado e “Ahgora”/“Senior” como procedência de cada dia.
- Trocar `ahgoraDuration`/`ahgoraMinutes` por campos genéricos em cards, totais,
  alocações, divergências e mensagens. Não renomear funções específicas do Ahgora.
- Mostrar pendências separadas de bloqueios técnicos. Seleção em lote pula dias
  com pendência; seleção individual preserva a revisão explícita do usuário.
- Consultar alertas com intervalo de um dia e fonte de hoje, independentemente do
  período aberto no painel. Falha ou dado ausente não gera aviso de batida faltante.
- Guardar fornecedor/data na identificação da notificação para abrir a página
  correspondente. Não abrir abas nem pedir novas permissões por alarme em segundo plano.

**Gate G4:** RF05, RF06, RF08, RF10 e RF12 passam em integração/UI; revisão e envio
Channel continuam usando as proteções existentes de autorização e idempotência.

### Onda 5 regressão e preparação da entrega

- Acrescentar fixtures E2E Senior, cenário misto e migração v1 → v2. Repetir o smoke
  em extensão empacotada e registrar versão do site, intervalo e resultados sanitizados.
- Executar a suíte da CI e conferir permissões do ZIP gerado.
- Atualizar README, arquitetura, validação manual, descrição do manifest e site de
  instalação onde o produto se apresenta como exclusivamente Ahgora.
- Documentar instalação/recarga e necessidade de nova captura após atualização.
  Preparar release sem publicá-la como parte deste trabalho de planejamento.

**Gate G5:** todos os RF cobertos; comandos de qualidade passam; evidências de leitura
real anexadas à validação manual. No rollback, builds antigos não leem operação v2:
limpar apenas `operationData` ao voltar de versão e recapturar, preservando storage
local; uma versão antiga continua sem suporte Senior e não é fallback para datas novas.

## Matriz de testes e rastreabilidade

| Grupo                   | Casos essenciais                                                                                        | Requisitos            |
| ----------------------- | ------------------------------------------------------------------------------------------------------- | --------------------- |
| Unitários de roteamento | Corte, intervalo vazio inválido, mês misto, anos diferentes, datas civis                                | RF01–RF03             |
| Contrato Senior         | Competências, wrapper result, contagem, filtros, schema inválido, dias repetidos, sessão expirada       | RF04, RF07            |
| Normalização            | Previstas, original aninhada, E/D, 08:17, vazios, ímpares, horários inválidos, virada de dia            | RF05, RF06            |
| Estado e mensagens      | v1 → v2, schemas, remetente, binding/colaborador trocado, período alterado                              | RF08, RF09            |
| Coordenador             | Ahgora apenas, Senior apenas, misto, falha de uma parte, cancelamento e resposta tardia                 | RF01–RF03, RF07, RF11 |
| Painel e alertas        | Permissão negada, login manual, requisitos antes de Conectar, pendências, alerta da fonte de hoje       | RF06, RF08, RF10      |
| Regressão Channel       | Duplo clique, revisão, seleção, parada antes do despacho, idempotência e igualdade pós-POST em fixtures | RF11, RF12            |
| Smoke real              | GET pela extensão, Todos versus Pendentes, um dia, intervalo parcial, nenhuma escrita                   | RF02, RF04, RF05      |

## Gates de arquitetura e limites

Sem constituição formal, estes gates vêm do comportamento/documentação existentes:
permissões exatas e opcionais; sessão mantida pelo site; nenhuma gravação Senior;
estado transitório separado das configurações; revisão antes do Channel; proteção
por `operationId`, `revision` e intenção de cancelamento; testes das fronteiras.
O desenho atende a esses gates. Eles precisam ser reavaliados no código ao fim de G3
e G5; este plano não equivale à execução dessas validações.

Riscos restantes: API interna/AngularJS podem mudar, contagem ainda precisa da
sondagem G0, casos noturnos e outros usos de marcação não foram vistos na amostra,
competências futuras podem não existir. Cada risco tem erro/bloqueio explícito;
nenhum autoriza completar dados por estimativa ou usar a fonte errada.

O plano está pronto para implementação com a premissa mensal acima. Nenhum teste
da feature é marcado como aprovado antes de existir implementação. A validação
deste planejamento se limita à consistência entre artefatos, referências locais
e formatação Markdown.
