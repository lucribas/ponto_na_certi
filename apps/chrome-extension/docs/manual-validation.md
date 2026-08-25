# Validação manual controlada

Execute somente com autorização e participação do usuário. Não copie HTML, screenshots, datas, horas, projetos, nomes, tokens ou mensagens pessoais. Registre apenas `data da validação`, `pass/fail`, `etapa` e `seletor lógico`.

## Preparação

- [ ] Build local passou e `dist/` foi carregado como extensão descompactada.
- [ ] **Detectar abas ou abrir logins** solicita em conjunto os acessos do Ahgora, Channel e Google Calendar, abre ou reutiliza os três destinos e mostra seus cards de progresso na mesma lista.
- [ ] **Acesso manual** fica oculto quando as duas abas foram conectadas e aparece somente se a permissão/login automático não concluir.
- [ ] A extensão não registra nem retorna conteúdo dos campos de login; autofill ausente nunca dispara submit.
- [ ] Uma sessão Ahgora já autenticada é reconhecida mesmo se `#boxLogin` continuar oculto no DOM e sem ocorrer nova navegação da aba.
- [ ] Quando Ahgora, Channel e Google Calendar ficam conectados, a etapa 1 recolhe automaticamente, mostra `Concluído` e continua acessível pelo título.
- [ ] Captura e envio permanecem bloqueados enquanto qualquer uma das três conexões da etapa 1 estiver pendente.
- [ ] As cinco etapas podem ser expandidas e recolhidas pelo cabeçalho; ao abrir **2. Regras** ou qualquer outra etapa, a etapa anteriormente aberta é recolhida e nunca há duas abertas ao mesmo tempo.
- [ ] Com **2. Regras** recolhida, os totais de TAGs, templates e regras continuam visíveis no cabeçalho.
- [ ] Em **2. Regras**, **Gerenciar catálogos de apontamentos RAG** aparece abaixo do botão do Google Calendar e abre um diálogo próprio; os controles RAG não aparecem mais em **Definição de marcações de ponto no Channel**.
- [ ] Crie um item não `SKIP` em `reunioes-rag`; o checkbox de regra Calendar começa desmarcado e, quando marcado, cria uma regra ativa de título + descrição com a frase do evento.
- [ ] Renomeie esse item com a regra automática intacta e confirme nome/frase atualizados; personalize a regra, renomeie novamente e confirme que a personalização foi preservada.
- [ ] Referencie um item RAG em uma regra Calendar e em uma entrada de template. Ao excluir, confirme que o gerenciador mostra ambas as contagens, exige outro item não `SKIP` e só exclui por **Reatribuir e excluir**; **Cancelar** não altera dados.
- [ ] Importe em modo **Substituir** um CSV que omita itens referenciados. A prévia lista remoções, a aplicação pede confirmação destrutiva clara e, ao confirmar, remove também regras/entradas afetadas sem referências órfãs.
- [ ] Crie e altere itens, depois valide **Restaurar** no item, **Restaurar fonte** e **Restaurar todas**. Itens criados que desaparecerão são explicitamente informados antes da aplicação.
- [ ] Simule falha em `chrome.storage.local.set` ao criar, editar, excluir, reatribuir ou importar; após o erro, catálogo, regras e templates continuam exatamente no estado anterior.
- [ ] O catálogo foi obtido do Channel; a contagem e a data do cache aparecem sem expor credenciais.
- [ ] Uma TAG com projeto, atividade, tipo de atividade e tarefa foi salva, escolhida como padrão e persistiu após fechar/reabrir o painel.
- [ ] Em um perfil limpo, confirme que não existe TAG predefinida; na primeira captura, a marcação válida mais recente do Channel vira a TAG padrão persistida e aparece selecionada nos dias novos.
- [ ] Sem marcação do Channel que contenha projeto e atividade, confirme que a captura termina para revisão sem criar uma TAG ou selecionar um destino inexistente.
- [ ] Em **Preferências rápidas**, tema e ajuda têm ícones legíveis, texto visível e foco de teclado; o tema persiste e mantém contraste adequado nos modos claro e escuro.
- [ ] Os controles `A−`/`A+` alteram e persistem o tamanho das letras sem quebrar o layout; o percentual atual tem nome acessível.
- [ ] **Monitorar almoço** funciona como interruptor acessível, persiste a escolha e mantém visível o estado (`Ativo`/`Desativado`) e os quatro horários de verificação.
- [ ] Com o painel em 360 px de largura, os controles superiores se reorganizam sem rolagem horizontal nem sobreposição.
- [ ] Use primeiro o smoke com `commit: false`; uma gravação real só deve ser validada quando houver item autorizado para apontamento.
- [ ] Em um dia novo de 08:00, confirme que a prévia começa com `100%`, 08:00 e a TAG padrão.
- [ ] Troque a primeira marcação para duração `03:00`; confirme a criação imediata do saldo `05:00`, também em duração, com a TAG padrão.
- [ ] Troque o saldo para percentual e altere-o para `25%`; confirme três marcações (`03:00`, `02:00`, `37,5%`), com o último saldo também em percentual, `Distribuído 08:00` e `Falta 00:00`.
- [ ] Escolha TAGs diferentes, envie e confirme no Extrato que as três marcações totalizam 08:00 no mesmo dia.

## Ahgora

- [ ] No fallback sem permissão opcional, registrar a aba exige clique na action e o painel mostra o tab ID sem exibir URL.
- [ ] Página/login é reconhecida; estado não autenticado produz erro acionável e sanitizado.
- [ ] `/api-espelho/apuracao/` responde JSON usando cookie de sessão ou bearer da própria página.
- [ ] Cada referência mensal é consultada diretamente sem navegação no calendário.
- [ ] O período padrão mostra o mês atual; **Mês anterior** aparece logo abaixo no seletor.
- [ ] Mês explícito e intervalo inclusivo consultam espelhos esperados.
- [ ] Dias sem batidas e com quantidade ímpar são ignorados/avisados; pares e overrides preservam o cálculo observado.
- [ ] A barra Ahgora fica indeterminada somente durante o GET e termina com contagem real ou erro próprio.

## Channel — leitura

- [ ] Registrar exige gesto separado; navegação/reload que perde concessão pede reconcessão.
- [ ] `ApontamentoAjax.listarApontamentoPorData` responde diretamente para o período solicitado, sem clique em Filtrar.
- [ ] Sem `participanteSelecionado`/`ID_EMPRESA` na página, um GET do Extrato recupera o contexto antes do DWR; falhas distinguem participante e empresa.
- [ ] A barra Channel inicia junto com Ahgora e Calendar, fica indeterminada durante contexto/DWR e termina com quantidade real ou erro próprio, independentemente da ordem de conclusão.
- [ ] A barra **Comparação** permanece aguardando enquanto qualquer fonte está em andamento, inicia somente após todas terminarem e conclui com a quantidade de dias preparada para revisão.
- [ ] Quando o Channel termina antes do Ahgora, a revisão ainda contém todos os dias calculados do Ahgora; nenhuma atualização antiga do progresso substitui a prévia final.
- [ ] Uma TAG criada da última marcação do Extrato resolve projeto/atividade no cache mesmo quando o catálogo inclui códigos ou separadores diferentes; ela abre para edição e o saldo é encontrado no envio.
- [ ] Uma TAG inferida antiga com IDs vazios é reparada na captura seguinte, sem precisar ser excluída e recriada.
- [ ] Cada linha é lida na ordem; duplicidade não é somada e a última linha vence na comparação.
- [ ] A leitura detalhada mostra projeto e atividade nas linhas existentes.
- [ ] Cada marcação detalhada e removível mostra **Excluir** à direita e o clique inicia a exclusão diretamente, sem abrir diálogo de confirmação.
- [ ] **Excluir** remove somente o `id` escolhido, relê o mesmo dia e atualiza cores, totais e prévia; falta de permissão mantém o botão desabilitado com explicação.
- [ ] Dia igual não vira candidato; divergência é mostrada e não corrigida; data exclusiva Channel não aparece na prévia.

## Channel — envio direto

- [ ] Prévia começa vazia e dry-run não altera nenhum controle.
- [ ] Cada linha nova inicia com a TAG padrão e permite escolher outra TAG antes da seleção.
- [ ] TAGs, templates e automações aparecem em um único card `Regras`; captura e seus progressos estão na etapa 3, revisão na etapa 4 e envio na etapa 5.
- [ ] O Google Calendar fica sempre habilitado e aparece como o terceiro card da etapa 1, sem switch nem botão de conexão separado.
- [ ] O card do Google Calendar tem o mesmo tratamento visual dos cards Ahgora/Channel e concentra status, progresso e mensagens explicativas.
- [ ] **Config.**, ao lado de **Ajuda**, abre um diálogo; nele, dois radio buttons iniciam em **Google Calendar via aba**, permitem escolher **Google Calendar via API** e pedem nova conexão sem remover as regras ao trocar o modo.
- [ ] O aviso de acesso restrito e o link para solicitar inclusão como usuário de teste ficam ocultos no modo via aba e aparecem somente no modo API.
- [ ] Os cinco itens do progresso inicial são links; clicar em **Conectar**, **Regras**, **Capturar**, **Revisar** ou **Enviar** expande, focaliza e leva à etapa correspondente, fechando a etapa que estava aberta.
- [ ] O diálogo explica que a API é restrita a usuários de teste e abre a composição do Gmail em uma nova aba, com destinatário, assunto e corpo preenchidos para solicitar acesso.
- [ ] Nenhum estado da interface oferece o botão **Desconectar Google Calendar**; uma conexão existente oferece **Atualizar calendários**.
- [ ] No modo aba, o botão principal pede também `calendar.google.com`, reutiliza uma aba aberta ou abre uma nova e orienta concluir o login antes da segunda tentativa.
- [ ] Com sessão válida, o GET `calendar/exporticalzip` retorna ZIP sem download visível; calendários exportáveis aparecem na seleção e eventos/recorrências do período entram nas regras.
- [ ] Fechar a aba do Calendar desativa somente essa conexão; não encerra a conta Google nem afeta Ahgora/Channel. Exportação bloqueada pelo administrador e arquivo acima de 32 MB produzem mensagens acionáveis.
- [ ] `Capturado`, `Novos para revisar (pré-seleção)` e `A preencher (selecionados)` mostram horas e contagens coerentes; marcar/desmarcar o checkbox atualiza imediatamente o último total sem alterar os dois primeiros e não existe botão Recusar/Recusado.
- [ ] Preflight resolve projeto, atividade e tarefa por DWR e obtém token Struts por GET, sem alterar controles.
- [ ] O clique único em **Enviar selecionados** produz no máximo um POST por item selecionado e não pede confirmação intermediária.
- [ ] Antes e depois de cada POST, o extrato é consultado; igual é idempotente e divergência interrompe a fila.
- [ ] Resposta ausente/ambígua interrompe a fila para conferência, sem retry automático.
- [ ] Cancelar durante a fila impede o próximo despacho; um POST já recebido pelo servidor não é revertido.
- [ ] `Parar login`, `Parar captura` e `Parar envio` aparecem apenas durante seus respectivos progressos e desaparecem após interromper.
- [ ] Parar captura descarta seu resultado tardio; parar envio bloqueia o próximo POST e exige nova comparação para reconciliar eventual POST já despachado.

## MV3, retomada e resultado

- [ ] Fechar/navegar uma aba interrompe com pedido de registro, sem escrever na aba errada.
- [ ] Reiniciar o service worker pelo painel de extensões conserva a operação transitória e permite reabrir o side panel.
- [ ] Operação antiga/concorrente não consegue comandar a operação atual.
- [ ] Duplo clique em capturar/aplicar/avançar produz somente uma ação e os controles de efeito ficam indisponíveis enquanto `inFlight` estiver ativo; `Cancelar operação` continua disponível.
- [ ] Cancelar uma fila enquanto `tabs.get`/revalidação está em andamento resulta em zero novos `executeScript`; se o despacho corrente já ocorreu, ele não é desfeito, mas nenhum item seguinte é iniciado.
- [ ] Ao cancelar sob latência artificial de `storage.session`, a intenção aparece antes da persistência e ainda bloqueia o despacho; após reiniciar o worker, o estado `cancelled` persistido mantém a fila bloqueada.
- [ ] Resultado distingue preenchido, já correto, ignorado, não encontrado, validação e falha; parcial não aparece como concluído.
- [ ] Badge contém apenas `…`, contagem, `!` ou `✓`, sem horas/datas/projeto.

## Registro sanitizado

| Data       | Etapa                | Seletor lógico                 | Pass/fail | Observação estrutural                                                        |
| ---------- | -------------------- | ------------------------------ | --------- | ---------------------------------------------------------------------------- |
| 2026-08-22 | Ahgora               | iframe/mês/calendário/override | pass      | Captura e cálculo reais concluídos com saída sanitizada.                     |
| 2026-08-22 | Channel leitura      | extrato/período/linhas         | pass      | Leitura e comparação reais concluídas sem escrita.                           |
| 2026-08-23 | Channel formulário   | PROJETOS/data/duração          | pass      | Combos AJAX reconsultados; valores configurados reconhecidos.                |
| 2026-08-23 | Channel configuração | prefixos projeto/atividade     | pass      | O resultado anterior era falso negativo por referência DOM obsoleta.         |
| 2026-08-22 | Channel envio legado | submit/requestSubmit           | pass      | Nenhuma submissão ocorreu no adapter DOM anterior.                           |
| 2026-08-23 | APIs diretas         | Ahgora JSON/Channel DWR        | pass      | Leitura e preflight real passaram; POST de gravação permaneceu desabilitado. |
| 2026-08-23 | Channel navegação    | Extrato/formulário aberto      | pass      | Leitura real passa no Extrato; formulário aberto é recusado com orientação.  |
| 2026-08-23 | Channel contexto     | fallback Extrato/DWR           | pass      | Contexto removido da página foi recuperado por GET antes da leitura DWR.     |
| 2026-08-23 | Login assistido      | autofill/submit/destinos       | pass      | Autofill simulado; a extensão acionou ambos e abriu as páginas de trabalho.  |
| 2026-08-23 | Progresso real       | Ahgora/Channel                 | pass      | Três transições intermediárias observadas no estado da extensão headless.    |
| 2026-08-23 | Catálogo/TAGs        | projetos/atividades/cache      | pass      | 11 projetos e 12 atividades consultados; combinação padrão reconhecida.      |
| 2026-08-23 | Leitura detalhada    | projeto/atividade por dia      | pass      | Dias 20–21/08 exibiram duração, projeto e atividade no Chrome headless.      |
