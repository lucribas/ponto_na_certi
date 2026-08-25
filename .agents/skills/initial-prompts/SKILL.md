---
name: "initial-prompts"
description: "Use para criar ou atualizar prompts iniciais de planejamento deste repositório. Trabalha apenas em artefatos `*_initial.md` e orienta o fluxo `initial → plan → plan-results`, com ondas sequenciais e gates independentes."
---

# Ahgora Channel Integration — Initial Prompts

## Objetivo

Criar ou atualizar prompts iniciais de planejamento coerentes com o estado real do repositório Ahgora Channel Integration.

A skill trabalha somente no artefato `<slug>_initial.md`. Esse artefato deve:

- orientar a leitura do contexto relevante;
- ancorar o planejamento no código e nos testes existentes;
- definir `<slug>_plan.md` como saída da etapa seguinte;
- preparar um plano reutilizável como prompt de implementação;
- explicar que a execução será registrada em `<slug>_plan-results.md`.

Não gere o plano nem implemente código ao executar esta skill.

## Convenção e destino

- Use `<slug>_initial.md` para arquivos novos. Não crie novos arquivos `*_inicial.md`.
- Use `docs/` como destino padrão, criando o diretório quando necessário. Use uma subpasta existente apenas quando ela já representar o escopo ou a governança do trabalho.
- Não renomeie nem normalize artefatos históricos apenas para aplicar esta convenção.
- Mantenha `<slug>_initial.md`, `<slug>_plan.md` e `<slug>_plan-results.md` no mesmo diretório.

## Leitura antes da edição

Antes de criar ou atualizar o prompt inicial:

1. Obtenha do usuário o número máximo de ondas `N`, salvo quando ele já estiver definido no pedido ou no artefato existente.
2. Descubra `$ROOT` pela raiz do workspace ou do repositório Git. Não suponha caminhos pessoais nem repositórios irmãos.
3. Leia os `AGENTS.md` aplicáveis, quando existirem.
4. Leia os READMEs, prompts, planos, resultados, código, testes e configurações pertinentes ao pedido.
5. Inspecione `git status` e preserve alterações do usuário.

Não exija arquivos de governança que não existam. Quando houver divergência documental, priorize o comportamento verificável no código, nos testes e nas configurações executáveis, e peça que o plano registre a divergência.

## Contexto deste repositório

Considere as áreas abaixo somente quando forem pertinentes ao pedido:

- `apps/standalone/`: automação Ruby legada, seus testes, configurações de exemplo e documentação;
- `apps/chrome-extension/`: implementação da extensão Chrome e seus artefatos de produto, build e teste;
- `docs/`: documentação e famílias de prompts, quando existirem.

Na migração ou evolução da extensão, trate o comportamento observável da aplicação Ruby como referência funcional, salvo decisão explícita em contrário. Verifique especialmente regras de negócio, formatos de data e duração, seletores e fluxo de Ahgora e Channel, confirmação antes de gravar, modo dry-run e prevenção de exposição de credenciais.

Arquivos locais com credenciais, logs, screenshots, PDFs, CSVs ou dados pessoais não devem ser copiados para prompts. Consulte-os apenas se forem necessários e autorizados; registre no artefato somente conclusões não sensíveis.

## Estrutura do prompt inicial

Cada `<slug>_initial.md` deve conter:

1. `# <Título>`
2. `## Leitura Obrigatória`
3. `## Contexto`
4. `## Saída Esperada`
5. `## Prompt Base`

Em `Saída Esperada`:

- indique o caminho do `<slug>_plan.md` relativo a `$ROOT`;
- proíba implementação nesta etapa;
- exija um plano acionável, incremental e rastreável;
- peça o registro de decisões técnicas, premissas, riscos, pendências, validações e divergências encontradas.

Em `Prompt Base`, inclua apenas o que for sustentado pelo repositório ou pelo pedido: objetivo, estado atual, áreas a inspecionar, comportamento esperado, contratos, decisões necessárias, restrições, entregáveis e estratégia de validação. Não invente seletores, URLs, regras de negócio nem arquitetura.

## Fluxo exigido no plano

Peça que o `<slug>_plan.md` comece com uma abertura operacional equivalente a:

```md
seja:
- $ROOT=<raiz do repositório atual, descoberta pelo workspace ou Git>
- $PLAN_PATH=<caminho do plano relativo a $ROOT>
- N=<número máximo de ondas definido para este trabalho>

durante a execução do plano:
- execute até N ondas sequencialmente;
- depois de cada onda, execute um gate independente contra os requisitos, o código atual e validações proporcionais ao risco;
- se um gate falhar, corrija a onda com base nos achados e repita o gate, limitando-o a três ciclos de correção;
- após o terceiro ciclo sem aprovação, interrompa a progressão, registre a pendência e aguarde direcionamento do usuário;
- depois da última onda aprovada, execute um gate final independente de integração ou e2e proporcional ao escopo;
- registre o resultado em <caminho relativo a $ROOT de *_plan-results.md>, incluindo escopo implementado, decisões, premissas, validações, observações, pendências residuais e melhorias futuras.
```

O plano deve separar cada onda de implementação, seu gate correspondente e o gate final. O arquivo inicial não executa ondas, não cria agentes e não implementa código.

## Conteúdo por tipo de pedido

### Nova funcionalidade

Inspecione os aplicativos e fluxos afetados, seus contratos, testes e documentação. Delimite a primeira entrega, as integrações necessárias e o que fica fora do escopo.

### Migração ou paridade entre aplicações

Mapeie o comportamento relevante de `apps/standalone/` para `apps/chrome-extension/`. Exija rastreabilidade entre regra legada, implementação nova e teste de paridade. Separe correções funcionais desejadas da reprodução fiel do comportamento existente.

### Nova rodada ou evolução

Leia o `*_plan.md` e o `*_plan-results.md` anteriores, quando existirem, e confronte-os com o código entregue. Descreva o delta da rodada, as pendências resolvidas e as que permanecem fora dela.

### Mudança transversal

Inspecione build, testes, configurações, documentação, segurança e compatibilidade nas áreas afetadas. Para mudanças na extensão Chrome, avalie permissões do Manifest V3, isolamento entre contextos, uso das sessões autenticadas e ausência de armazenamento ou transmissão de senhas.

## Checklist de qualidade

Antes de concluir, valide que o prompt:

- usa `<slug>_initial.md` e aponta para os destinos de `plan` e `plan-results`;
- cobre apenas o escopo e os componentes realmente envolvidos;
- usa caminhos relativos a `$ROOT` e não contém caminhos pessoais ou referências a outros repositórios;
- exige a leitura das instruções, documentação, código, testes e configurações aplicáveis que realmente existam;
- trata código, testes e configurações executáveis como fontes de verdade;
- não inclui credenciais nem dados pessoais provenientes de artefatos locais;
- pede somente o plano nesta etapa;
- limita a execução a até `N` ondas, com um gate independente por onda, no máximo três ciclos de correção por gate e um gate final.

## Template

```md
# <Título>

## Leitura Obrigatória

Antes de gerar o plano, leia:

- <AGENTS.md aplicáveis, se existirem>
- <READMEs, prompts, planos e resultados anteriores pertinentes>
- <código, testes e configurações relevantes em apps/standalone e/ou apps/chrome-extension>

Em divergências, priorize o comportamento verificável no código, nos testes e nas configurações executáveis. Registre divergências documentais relevantes.

## Contexto

- `$ROOT` é a raiz do repositório atual, descoberta pelo workspace ou Git.
- Este artefato está em `<caminho relativo a $ROOT>/<slug>_initial.md`.
- Áreas envolvidas: <apps/standalone, apps/chrome-extension e/ou documentação>.
- Estado verificável: <fatos atuais e recorte desta rodada>.

## Saída Esperada

Gere exclusivamente o plano em `<caminho relativo a $ROOT>/<slug>_plan.md`; não implemente código nesta etapa.

O plano deve conter resumo executivo, estado atual, análise dos comportamentos e contratos afetados, decisões técnicas, premissas, riscos, execução em até `N` ondas sequenciais, gate independente após cada onda, gate final, estratégia de validação e pendências. Inclua a abertura operacional exigida e o destino de `<slug>_plan-results.md`.

## Prompt Base

### Objetivo

<objetivo e recorte da rodada>

### Áreas e fontes a inspecionar

- <caminhos de código, testes, documentação e configuração>

### Decisões e restrições

- <comportamentos, contratos, segurança, compatibilidade, limites e itens fora do escopo>

### Validação esperada

- <testes unitários, integração, build, smoke ou e2e proporcionais ao escopo>
```

## Saída da skill

Entregue somente o prompt inicial criado ou atualizado e informe o valor de `N` usado. Não gere o plano nem implemente código nesta etapa.
