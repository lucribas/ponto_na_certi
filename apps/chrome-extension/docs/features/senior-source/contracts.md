# Contratos da integração Senior

> Registro do planejamento. As decisões implementadas e evidências posteriores estão em [implementation-results.md](implementation-results.md), incluindo ajustes no `/count` e nos campos de estado.

Proposta para implementação. As URLs de leitura observadas estão na
[análise original](../../senior-source-analysis.md); tipos e mensagens novos ainda
não fazem parte da extensão. A origem Senior é exatamente
`https://gestaodoponto.certi.org.br`, sem wildcard de subdomínios.

## Captura comum

```ts
type PunchSourceId = 'ahgora' | 'senior';
type DateRange = { start: CivilDate; end: CivilDate };

interface CaptureSourceRequest {
  requestId: string;
  provider: PunchSourceId;
  binding: SourceBinding;
  range: DateRange;
  today: CivilDate;
  signal?: AbortSignal; // Somente no worker; não atravessa executeScript.
}

type CaptureSourceResult =
  | {
      ok: true;
      provider: PunchSourceId;
      days: readonly CapturedPunchDay[];
      coverage: SourceCoverage;
    }
  | {
      ok: false;
      provider: PunchSourceId;
      error: {
        code: SourceErrorCode;
        message: string;
        retryable: boolean;
      };
    };
```

O wrapper Ahgora traduz contratos/erros existentes e calcula `mirrorMonths` para
seu próprio intervalo. A cobertura é uma união discriminada: Ahgora usa
`method: 'months'` e `queriedMonths`, com respostas validadas; Senior usa
`method: 'count'`, `expectedDayCount` e `receivedDayCount`. Não inventar um endpoint
de contagem Ahgora; Senior exige contagem validada.

`requestId` correlaciona sondagem e operação; não é credencial. O worker revalida
binding e revisão antes/depois de cada chamada. A função injetada recebe somente
DTO serializável, intervalo e contexto mínimo. Não recebe `AbortSignal`, funções
ou instâncias de cliente através de `executeScript`.

## Consulta Senior

Sequência proposta:

1. Confirmar HTTPS/origem exata, rota `time-adjustment/employee/{subject}/...`,
   ausência de formulário de login visível e disponibilidade do cliente `$http`.
   Descobrir subject pela rota atual, conferindo contra o binding esperado.
2. Determinar meses candidatos: meses civis do intervalo decorrido e um vizinho
   anterior/posterior. Para cada candidato necessário, consultar GET
   `/gestaoponto-backend/api/codigos-calculo/buscar-codigo-calculo-competencia`
   com `colaborador`, `competencia=AAAA-MM-01` e `isTelaColaborador=S`.
3. Ler `result.codigoCalculo` e `result.colaborador`; validar tipos e limites.
   Parar a descoberta quando competências distintas cobrirem o intervalo inteiro.
   A lista finita de candidatos é o limite da busca; cobertura ausente é erro,
   não um loop aberto. Competência fora do intervalo pode ser ignorada; falha de
   autenticação ou resposta inválida nunca é transformada em “fora do intervalo”.
4. Para cada competência relevante, consultar a interseção inclusiva entre suas
   datas e o intervalo da fonte. Usar o código numérico `codigoCalculo` no GET
   `/gestaoponto-backend/api/acertoPontoColaboradorPeriodo/colaborador/{subject}`.
   Parâmetros: `codigoCalculo`, `dataInicial`, `dataFinal`, `isTelaColaborador=S`,
   `orderby=-dataApuracao`. Não enviar `filtraPendencias`.
5. Consultar `/count` para o mesmo contexto. O contrato sem filtro deve ser
   confirmado em G0; usar `result.total`, nunca `totalPendencia`, para verificar
   quantidade de dias únicos. Divergência pode ser mudança concorrente: repetir
   uma vez a leitura completa daquele intervalo; persistindo, falhar a captura.
6. Validar wrapper `{apuracao, colaborador}`, competência e sujeito resolvido.
   Filtrar datas solicitadas, conferir duplicidades, normalizar e devolver apenas
   DTO de dias/avisos. Dias sem batidas entram na cobertura, mas não viram horas.

G0 deve registrar a resposta observada de competência indisponível. Até isso estar
definido, não mapear qualquer 404/400 para “nenhum dado”. Uma competência contendo
datas necessárias que não possa ser consultada impede a liberação da prévia.
Competências futuras não são exigidas: `range.end` já vem limitado a hoje.

A resolução por candidatos cobre os períodos observados. Se uma instalação futura
retornar competências com limites além dos candidatos e deixar lacuna, informar
`PERIOD_NOT_AVAILABLE`; ampliar a estratégia somente com evidência do contrato.

## Limites de execução e falhas

- GETs Senior executados sequencialmente, timeout proposto de 30 segundos por
  requisição e no máximo uma repetição para erro de transporte, 429 ou 5xx.
- Não repetir 401/403, contrato inválido ou indisponibilidade funcional. Na UI,
  diferenciar autenticação expirada de acesso negado quando a resposta permitir.
- Usar timeout suportado pelo cliente da página; `Promise.race` sozinho não
  cancela a requisição. Cancelamento da operação impede a próxima consulta e
  descarta o retorno já em trânsito. Abort físico adicional é opcional nesta versão.
- Não fazer POST, PATCH, PUT ou DELETE no adaptador. POSTs de navegação da interface
  foram apenas evidência de inspeção, não requisito do adaptador final.
- Diagnóstico registra fornecedor, etapa, contagens e código de erro. Não registrar
  headers, payload bruto, identificação pessoal, senhas ou tokens.

Erros comuns propostos: `CANCELLED`, `TAB_UNAVAILABLE`, `ORIGIN_CHANGED`,
`SUBJECT_CHANGED`, `LOGIN_REQUIRED`, `ACCESS_DENIED`, `CLIENT_UNAVAILABLE`,
`PERIOD_NOT_AVAILABLE`, `SOURCE_DATA_INVALID`, `INCOMPLETE_RESPONSE`,
`CONFLICTING_DAYS`, `TIMEOUT`, `NETWORK_ERROR`.

Um erro de transporte/contrato falha a fonte. Um dia com conteúdo reconhecido mas
não suportado gera bloqueio daquele dia e permanece visível na revisão. Os demais
dias podem ser revisados após a captura completa; falha global não tem esse efeito.

## Mensagens entre painel e worker

Manter o envelope `{type, operationId}` e validação de remetente existentes.
Tipos propostos devem ser implementados juntos no emissor, handler e guard:

| Mensagem                                   | Alteração                                                                                                             |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `SET_OPERATION_PERIOD`                     | Nova; recebe somente `period: PeriodRequest`; valida, resolve fontes e invalida prévia antiga                         |
| `OPEN_LOGIN_PAGES`                         | Usa o período já aceito no estado; login Senior manual, monitorado sem autoSubmit                                     |
| `DISCOVER_OPEN_TABS`                       | Descobre fornecedores necessários ao período; não exige a presença do outro fornecedor                                |
| `SET_PENDING_ROLE` / `REGISTER_ACTIVE_TAB` | Para role source, exige `provider`; para target, não aceita provider                                                  |
| `CAPTURE_AND_COMPARE`                      | `config.period` deve coincidir com o período aceito; recomputar plano no worker, não aceitar slices arbitrárias da UI |
| `CAPTURE_SOURCE`                           | Usa todas as slices necessárias da operação atual; resultado comum                                                    |
| `CHECK_LOGIN_STATUS`                       | Verifica cada fornecedor requerido e estado do Channel; Senior independente de autoSubmit                             |

Mudanças locais no seletor de período invalidam visualmente o envio de imediato.
Antes de Conectar ou Capturar, aguardar confirmação de `SET_OPERATION_PERIOD`.
A chamada `chrome.permissions.request` deve continuar associada ao gesto do usuário:
calcular os hosts necessários no painel de forma síncrona, pedir acesso no clique,
e só depois aguardar mensagens. O worker recalcula e valida a mesma lista.

Os outros comandos de seleção/escrita não aceitam fornecedor livre: o item já
possui procedência validada. Guardas de aba e revisão permanecem ativos também em
`APPLY_SELECTED`, `APPLY_ITEM` e `ADVANCE_QUEUE`.

## Contrato da interface

O seletor de período fica acessível antes da conexão. Exibir intervalo e fontes
necessárias; cartões/progresso somente para essas fontes. Exibir a soma como
“Ponto”, com procedência por dia. Nenhum detalhe de Angular, endpoint ou código de
competência precisa aparecer no fluxo normal do usuário.

Manter ação de reconexão por fonte. Se a permissão opcional for negada, oferecer
registro manual por gesto activeTab. A sessão Senior deve ser concluída na página;
o painel não contém campos de credenciais.

Dias bloqueados não são selecionáveis. Dias com pendência exigem seleção individual
e aviso visível; os critérios de prontidão do Channel continuam valendo. Em falha
global, mostrar qual fonte/intervalo falhou e oferecer nova captura completa.

## Smoke autenticado

Acrescentar comando proposto `npm run test:senior:authenticated`, disponível na implementação,
com flag `RUN_SENIOR_AUTHENTICATED_SMOKE=1`, `SENIOR_SMOKE_START` e
`SENIOR_SMOKE_END`. O runner abre perfil temporário com extensão, permite login
manual, consulta somente a origem Senior e encerra/limpa o perfil ao terminar.

Não aceitar senha por argumento de linha de comando, não reutilizar cookies por
extração e não exigir configuração Ahgora/Channel. Saída: status, intervalo,
contagens, comparação com a tela e erros sanitizados. Falha de login produz
instrução clara e timeout finito; não exportar HAR autenticado.
