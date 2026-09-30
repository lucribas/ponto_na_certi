# Decisões técnicas para a fonte Senior

> Registro do planejamento. As decisões implementadas e evidências posteriores estão em [implementation-results.md](implementation-results.md), incluindo ajustes no `/count` e nos campos de estado.

Estas decisões dão suporte ao [plano](plan.md). A evidência primária é a
[inspeção instrumentada de 29/09/2026](../../senior-source-analysis.md). Não foi
necessário substituir a evidência desta instalação por documentação genérica.

## Roteamento por data

**Decisão:** corte único em 2026-09-21, inclusivo para Senior. Dividir intervalos
antes de consultar; não escolher fonte pela data atual, pela aba ativa ou por
uma preferência global do usuário.

**Motivo:** preserva histórico e permite setembro/2026 misto. **Alternativas:**
trocar permanentemente Ahgora por Senior perderia histórico; fallback entre fontes
por ausência poderia importar registros da fonte errada.

## Calendário apresentado ao usuário

**Decisão de escopo:** manter 26 a 25 nesta entrega; mostrar o intervalo completo.
Acompanhar o fechamento Senior continua sendo recomendação para uma mudança de
calendário separada. Esta opção conservadora resolve o plano sem presumir resposta
à pergunta anterior sobre a preferência mensal.

**Motivo:** adicionar uma fonte não requer alterar o significado de uma seleção
existente. A Senior permite consultar subintervalos. **Alternativa:** mudança para
21 a 20 exigiria definir setembro de transição, histórico e modo default, além de
comunicar a alteração ao usuário. A API ainda mostrou um período anterior iniciado
em 20/08; suas competências não devem ser calculadas por uma fórmula universal.

## Transporte autenticado

**Decisão:** injeção MAIN e `$http` do AngularJS já presente na Senior, somente GET.
**Evidência:** fetch com cookies retornou 401; a mesma leitura pelo `$http` disparado
pela extensão retornou 200 com nove dias. **Alternativas:** copiar assertion/token
para a extensão é desnecessário; raspar o DOM depende de filtro, carregamento e
edição visual. O adaptador falha de forma explícita se o cliente deixar de existir.

## Competências e cobertura

**Decisão:** resolver competências pelo GET observado, usar `inicioApuracao` e
`fimApuracao`, e capturar apenas a interseção com o intervalo decorrido da fonte.
Consultar meses civis candidatos com vizinhos e validar a cobertura pelas datas
reais retornadas. Falta de cobertura após a busca limitada é erro explícito.

**Motivo:** a consulta requer código de cálculo e pode precisar de mais de uma
competência. **Alternativas:** usar `mirrorMonths` do Ahgora ou consultar apenas a
competência aberta gera lacunas. Não consultar meses futuros apenas porque o
intervalo selecionado termina no futuro. A forma de resposta para competência
inexistente e o contador sem filtro serão consolidados no gate G0.

## Duração e dados não suportados

**Decisão:** calcular pelas marcações correntes, ignorar previstas e não expandir
`marcacaoOriginal`. Aceitar marcação digitada e eletrônica comprovadas na amostra.
Preservar metadados mínimos para bloquear usos desconhecidos e virada de dia.

**Evidência:** um dia de 08:17 mostra 08:00 em Trabalhando e 00:17 em crédito; um
dia vazio contém horários previstos. **Alternativas:** usar saldos de apuração ou
preencher horários ausentes altera o total a apontar. Não ampliar o cálculo Ahgora
por inferência sobre fusos ou jornadas noturnas da Senior.

## Pendências e ausência de batidas

**Decisão:** pendências reais do dia geram aviso e impedem seleção em lote;
seleção individual é possível se as batidas forem calculáveis. Bloqueios de
formato/virada de dia impedem envio. `verificado=false` sozinho não é evidência de
problema: apareceu também em dias sem aviso. Dia sem batidas não gera oito horas
nem alerta de almoço baseado em dado ausente.

**Motivo:** a Senior pode exibir marcações junto de pendências. **Alternativas:**
descartar todos esses dias perde informação; seleção automática os apresenta como
prontos. A extensão não interpreta seleção como aprovação de RH.

## Estado e conexões

**Decisão:** operação v2, bindings por fonte, captura invalidada após mudança de
período/identidade. Configurações locais permanecem no modelo atual. Operação v1
vira nova operação sem fila ou prévia reutilizada.

**Motivo:** contratos atuais usam `sourceTab` e campos Ahgora. **Alternativa:**
renomear campos sem versionar pode reidratar seleções com origem ambígua. Não é
necessário criar uma plataforma genérica de plugins: são dois adaptadores conhecidos.

## Validação ainda necessária durante implementação

O planejamento não afirma que casos não observados já funcionam. G0 e G2 incluem
contagem sem filtro, competência indisponível, múltiplas competências, transferência
de vínculo e fixture para limite de resposta. Os últimos dois podem não existir na
conta de smoke; nesse caso o suporte conservador e os testes sintéticos ficam
registrados como tal. Incompatibilidade de contrato bloqueia captura; a entrega não
depende de inventar payloads reais ou de editar o ponto para produzir exemplos.
