# Modelo de dados da captura por fonte

> Registro do planejamento. As decisões implementadas e evidências posteriores estão em [implementation-results.md](implementation-results.md), incluindo ajustes no `/count` e nos campos de estado.

Modelo proposto para implementação, ainda não existente no código. Os tipos abaixo
usam datas civis `YYYY-MM-DD`, intervalos inclusivos e `PunchSourceId` igual a
`'ahgora' | 'senior'`.

## Intervalos e contexto da fonte

| Entidade                | Campos e regras                                                                                                                         |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| DateRange               | `start`, `end`; datas válidas e início menor ou igual ao fim                                                                            |
| ResolvedPeriod          | `mode`, `start`, `end`; intervalo solicitado, sem `mirrorMonths` no contrato comum                                                      |
| SourceSlice             | `provider`, `start`, `end`; parte disjunta do intervalo decorrido, cortada em 2026-09-21                                                |
| SourcePlan              | `requestedPeriod`, `capturePeriod`, `slices`; fim da captura limitado a hoje; intervalo totalmente futuro não inicia captura            |
| SourceBinding           | `id`, `origin`, `provider`, `subjectKey?`; subjectKey Senior vem da rota autenticada e fica apenas em storage.session                   |
| SeniorCalculationPeriod | `competence`, `calculationCode`, `calculationId`, `subjectKey`, `start`, `end`; sempre obtidos da API, nunca constantes por funcionário |

`subjectKey` do binding identifica o colaborador da página. Uma resposta de
competência pode resolver outro vínculo do mesmo colaborador; essa relação deve
ser validada pelo retorno do resolvedor, sem exigir igualdade artificial entre
identificadores históricos. Não permitir que a UI informe um colaborador arbitrário.

## Dias normalizados

| Entidade         | Campos e regras                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| CapturedPunchDay | `provider`, `date`, `times`, `warnings`; apenas horários efetivos no intervalo correto                                               |
| SourceDayWarning | `code`, `severity: 'notice'                                                                                                          | 'requires-review' | 'blocked'`, `message`; diagnóstico mínimo, sem dados sensíveis do payload |
| SourceWorkRecord | `provider`, `date`, `durationMinutes`, `duration`; criado apenas após validação/cálculo                                              |
| SourceCoverage   | `provider`, `start`, `end` e comprovação discriminada por fornecedor; cobertura consultada, não promessa de batida em cada dia civil |

Para Senior, cobertura usa `method: 'count'`, `expectedDayCount` e
`receivedDayCount`. Para Ahgora, usa `method: 'months'` e `queriedMonths`, todos
validados pelo contrato mensal existente. Não inventar contagem remota Ahgora.

O DTO interno Senior mantém `dataAcesso`, `dataApuracao`, `horaAcesso`, `uso` e
`origem` até terminar a validação. Identificadores de marcação podem ser usados
transitoriamente para conferir duplicidades; não são necessários no estado público.
Não persistir o objeto `colaborador`, fotos, justificativas pessoais ou payload bruto.

Regras de normalização:

1. Campo ausente ou inválido onde se espera array de marcações não equivale a vazio.
2. Array vazio é dado válido; não produz um registro com jornada presumida.
3. Campos de data/hora devem ser válidos; uso/origem não suportado bloqueia o dia,
   sem remover silenciosamente uma marcação para tornar a quantidade par.
4. Data de acesso diferente do dia apurado, pares invertidos ou ordem ambígua
   bloqueiam o dia Senior nesta versão. Não ordenar apenas HH:MM para ocultar
   virada de dia, nem deduplicar marcações distintas só porque têm o mesmo horário.
5. Dia duplicado idêntico entre consultas pode ser consolidado; respostas
   conflitantes para a mesma fonte/data interrompem a captura.
6. Status/incidente conhecido de pendência gera `requires-review`; status presente
   de semântica desconhecida deve informar que requer revisão, sem afirmar aprovação.
7. Não converter todo `verificado=false` em aviso. Não interpretar saldo devedor
   como duração trabalhada ou motivo automático para invalidar batidas existentes.

## Operação v2

Alterações propostas em `OperationData`:

- `version: 2`.
- `sourceTabs: Partial<Record<PunchSourceId, SourceBinding>>` substitui `sourceTab`.
- `requestedPeriod: PeriodRequest` está disponível antes de conectar; configuração
  final e pedido de captura devem concordar com esse período.
- `sourcePlan?: SourcePlan` e `sourceCoverage?: SourceCoverage[]` registram o plano
  usado na captura atual; `resolvedPeriod` continua identificando o pedido completo.
- `pendingConnection?: { role: 'source'; provider: PunchSourceId } | { role: 'target' }`
  substitui o papel pendente sem fornecedor.
- `loginPreparation.sources` mantém estado/detalhe por fornecedor; Channel mantém
  seu estado próprio. Login manual Senior é monitorado sem depender de autoSubmit.
- `captureProgress.sources` contém somente as fontes necessárias. Channel,
  Calendar e comparação preservam seus estados. O cálculo de monotonicidade em
  `isStaleOperationState` considera todas as fontes dessa revisão.
- `sourceRows` passa a usar `SourceWorkRecord`. `PreviewItem` recebe `sourceProvider`,
  `sourceDuration` e `sourceWarnings`; substitui `ahgoraDuration`.
- `tabConnectionIssues` identifica também o fornecedor e a troca de sujeito na
  mesma origem. `targetTab`, `calendarTab`, filas, revisão e locks continuam existindo.

O estado público expõe apenas dados necessários aos cards, totais e revisão.
Não expor `subjectKey` ao painel se o contrato atual não precisar dele.

## Transições e invalidação

- **Período definido:** resolver fontes; manter bindings úteis; zerar prévia,
  seleção, fila e cobertura de captura anterior; incrementar revisão.
- **Período alterado durante captura/envio:** recusar a alteração até parar a ação;
  não trocar silenciosamente o contexto de uma operação em andamento.
- **Captura:** validar fontes obrigatórias; obter lock; consultar; validar revisão
  após retornos; publicar prévia somente quando todas as leituras obrigatórias
  estiverem completas. Uma fonte não necessária não participa do guard.
- **Falha/cancelamento:** manter diagnóstico, sem permitir envio a partir de uma
  coleção parcial. Retorno tardio não modifica o estado mais recente.
- **Binding perdido/troca de colaborador:** invalidar prévia e solicitar reconexão
  e recaptura. Revalidar também no início da captura, pois troca de sessão pode
  ocorrer sem evento de mudança de origem.
- **Envio:** preservar `executeValidatedChannelFill`, `operationId`, `revision`,
  intenção de parada e ausência de await entre última validação e despacho.

## Compatibilidade e migração

`loadOperationData` deve reconhecer v1 antes do guard v2. Converter v1 em uma nova
operação v2 em setup, com novo operationId, sem filas, seleções ou resultados
capturados. Pode preservar a configuração válida do período como entrada, mas as
abas devem passar por nova descoberta/revalidação. Informar a necessidade de
recaptura sem bloquear permanentemente a abertura do painel.

Não modificar `storage.local` de TAGs, catálogos, templates e Calendar. Não retomar
POST pendente. A nova captura lê o Channel para reconciliar eventual envio anterior.
Versão desconhecida/corrompida segue tratamento explícito, sem limpar todos os dados
do usuário. Testar reidratação de painel e suspensão do service worker em v2.
