# Implementação Senior — 0.2.0

Implementada em 29/09/2026. O corte é **21/09/2026, inclusive**. A fonte é escolhida
por data civil; intervalos mistos são divididos sem sobreposição. O fechamento
mensal permanece **26 a 25** e a captura de ponto termina no máximo em hoje.

## Comportamento entregue

- Período escolhido antes da conexão, com indicação de datas e fontes necessárias.
- Captura Ahgora histórica e Senior por consultas autenticadas GET, usando o cliente
  Angular da página em `MAIN` através de `chrome.scripting.executeScript`.
- Login Senior manual, descoberta de aba autenticada, registro manual opcional e
  identificação do colaborador pela rota. Nenhuma credencial é copiada.
- Resolução dos limites reais das competências e conferência entre contagem e dias.
  Falha de qualquer fonte impede liberar uma prévia parcial para envio.
- Cálculo pelas batidas realizadas; previstas, original aninhada e saldos não somam horas.
- Pendências exigem seleção individual. Horários inválidos, dias vazios, batidas
  ímpares e jornadas entre datas diferentes ficam bloqueados para envio.
- Alterar período, perder uma conexão obrigatória ou trocar colaborador descarta
  captura e fila. Fechar uma fonte dispensada pelo período preserva a prévia.
- Operação transitória v1 é descartada na migração; TAGs e regras locais permanecem.
- Monitoramento de almoço consulta a fonte de hoje, independentemente do período
  escolhido no painel. Erros de leitura não geram alerta de batida ausente.

## Ajustes em relação ao planejamento

1. **Contagem:** na sessão real, `/count` sem `filtraPendencias` respondeu HTTP 500.
   Com `filtraPendencias=COLABORADOR`, retornou `total=5` e `totalPendencia=4` para
   21–25/09. O adaptador utiliza **total**. A consulta dos dias **omite** esse filtro,
   preservando o conjunto Todos mesmo quando a página aberta está em Pendentes.
2. **Competência indisponível:** consultar novembro devolveu a competência atual,
   de 21/09 a 20/10, em vez de um marcador explícito de indisponibilidade. A cobertura
   usa os limites devolvidos; repetir esse fallback não autoriza datas fora deles.
   Resposta vazia/null é tratada defensivamente como ausência de cobertura; esse
   formato não foi observado na conta real. Erros de acesso nunca viram sucesso vazio.
3. **Estado:** mantidos `sourceTab` para Ahgora e `seniorTab` para Senior, em vez do
   mapa `sourceTabs` proposto. Progresso e login adicionam campos Senior opcionais.
   Isso preserva os consumidores legados. `sourceBinding` e `requiredSources`
   concentram a escolha; contratos de comparação usam `sourceDuration/sourceMinutes`.
4. **Contrato comum:** adotado DTO mínimo de dias/avisos/erro. A validação da cobertura
   permanece dentro de cada adaptador, sem persistir payload bruto nem metadados
   intermediários. Revisão e cancelamento são verificados pelo runner antes/depois
   de cada consulta. Um GET em trânsito pode terminar, mas seu resultado é descartado.
5. `ResolvedPeriod.mirrorMonths` foi preservado por compatibilidade; Senior não usa
   esse campo. O adaptador Ahgora recebe o intervalo recortado e seus meses calculados.
6. A revisão identificou comparação de objetos de período por `JSON.stringify`,
   sensível à ordem das propriedades após serialização do Chrome. Ela foi substituída
   por comparação dos campos, com regressão unitária e na extensão empacotada.

## Evidência real sanitizada

Chromium de teste com extensão temporária, sessão autenticada manualmente e funções
de produção disparadas pela extensão. Somente leituras; nenhuma gravação Senior ou
Channel foi realizada.

| Consulta | Resultado |
| --- | --- |
| 21–25/09/2026 | 5 dias, batidas por dia: 4, 4, 2, 0, 4 |
| Duração calculada, na ordem devolvida (25 → 21/09) | 497, 427, 234, 0, 464 minutos |
| Conferência com tabela visível | 4/4 dias com batidas coincidiram |
| Tela Todos versus Pendentes | Mesmo resultado completo de captura |
| Apenas 25/09 | 1 dia, 4 batidas, 08:17 |
| Novembro | Fallback para 21/09–20/10; datas conferidas |

## Verificações e limites

Os resultados finais dos comandos constam em `tasks.md` e no registro de
`docs/manual-validation.md`. O teste headless usa a extensão compilada, origem Senior
exata e respostas sintéticas; cobre captura, pendências, mudança de colaborador,
fonte dispensada e alertas. As fixtures de integração cobrem intervalos mistos,
duas competências, cancelamento, resposta incompleta, transporte e migração.

Uma consulta real atravessando **duas competências Senior com dados** não estava
disponível na conta durante o ensaio; sua cobertura é sintética. Jornadas noturnas
continuam bloqueadas. Os quatro testes opcionais do oráculo Ruby dependem do código
legado ausente neste checkout; a paridade autocontida é executada normalmente.

O ZIP é gerado em `artifacts/ponto-na-certi-extension-0.2.0.zip`. Para atualizar,
extraia-o e recarregue a extensão em `chrome://extensions`; reconecte os sites e
capture novamente antes de enviar. Nenhuma publicação remota faz parte desta entrega.

## Correção de interface — 0.2.1

O seletor visível passa a determinar imediatamente os cards de conexão e captura.
A inicialização persiste esse período antes de detectar abas; a ausência de período
salvo usa o mês atual, igual ao seletor, evitando considerar um mês anterior oculto.

Login, alertas de conexão e verificação periódica consideram somente as fontes
necessárias. Retomar login por navegação ignora fontes dispensadas e verifica a
permissão apenas do site relevante. A preparação da captura não anuncia uma
consulta Ahgora quando somente Senior é necessária.

Regressão: cenários histórico, Senior e misto verificam visibilidade nas etapas 1/3,
permissões exatas e ausência de login pendente das fontes dispensadas. A integração
confirma que o adaptador Senior não é chamado em intervalos históricos, e Ahgora
não é chamado após o corte. Validação: 131 unitários, 93 de integração, 24 E2E,
typecheck e lint aprovados; os quatro E2E afetados foram repetidos após o ajuste final.
Pacote atualizado: `artifacts/ponto-na-certi-extension-0.2.1.zip`.
