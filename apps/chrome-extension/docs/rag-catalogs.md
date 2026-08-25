# Catálogos RAG de apontamento

## Fontes e geração

Os CSVs mantidos em `docs/rag` são contratos de entrada. O comando abaixo os
converte de forma determinística para os assets usados pela extensão:

```bash
npm run convert:rag
```

Os arquivos gerados ficam em `assets/rag` e são empacotados separadamente pelo
Vite. Cada item preserva a linha original, grupo, evento, orientação de duração,
comentário e campos brutos, além do destino interpretado.

## Atualização pelo usuário

Em **2. Regras → Gerenciar catálogos de apontamentos RAG**, o usuário pode
pesquisar e filtrar itens, criar, editar, excluir, restaurar e importar ou
exportar uma fonte em CSV. A conversão acontece localmente e o catálogo
atualizado fica em `chrome.storage.local`; nenhuma linha da planilha é enviada a
outro serviço.

Quando grupo e nome do evento continuam iguais, a importação conserva o ID do
item anterior. Assim, templates e regras do Google Calendar permanecem ligados
ao apontamento. No modo **Mesclar**, linhas ausentes são mantidas. No modo
**Substituir**, a prévia lista quantos itens desaparecerão e a aplicação exige
confirmação explícita; regras e entradas de templates afetadas são informadas e
removidas na mesma persistência, evitando referências quebradas. Se a remoção
esvaziar um template, ele também é excluído; regras semanais deixam de usá-lo,
normalizam a participação dos templates restantes para 100% e são removidas se
nenhum template sobreviver.

Ao excluir um item sem dependências, basta confirmar. Se ele estiver em regras
do Calendar ou entradas de templates, o próprio gerenciador exige a escolha de
outro item que não seja `SKIP` e oferece **Reatribuir e excluir**. A alteração do
catálogo e de todas as referências é gravada como uma unidade e sofre rollback
em memória se `chrome.storage.local` falhar.

Na criação de um item não `SKIP` em `reunioes-rag`, um checkbox desmarcado por
padrão pode criar uma regra Calendar que procura o nome do evento no título e
na descrição. Se o item for renomeado depois, apenas uma regra automática ainda
intacta recebe o novo nome e frase; regras personalizadas são preservadas.

**Restaurar** recupera um item original alterado e remove um item criado pelo
usuário após confirmação quando necessário. **Restaurar fonte** e **Restaurar
todas** reativam os JSONs empacotados e apresentam o mesmo resumo destrutivo
antes de remover itens criados e seus consumidores.

## Tipos interpretados

| Tipo                 | Preenchimento no Channel                          | Complemento do usuário |
| -------------------- | ------------------------------------------------- | ---------------------- |
| `PROJECT` fixo       | Projeto, tipo, atividade e tarefa                 | Nenhum                 |
| `PROJECT` contextual | Projeto e/ou atividade vêm da TAG                 | TAG contextual         |
| `AD_HOC`             | Cliente, natureza, tipo de atividade e comentário | Nenhum                 |
| `SKIP`               | Não gera escrita                                  | Item fica desabilitado |

Quando a planilha usa `CERTI` como projeto junto de uma atividade contextual,
o conversor o interpreta como contexto e exige uma TAG. `CERTI` é um cliente do
fluxo Avulso e não identifica, por si só, um projeto do Channel.

## Decisão de UI/UX

A escolha fica dentro de cada marcação porque uma divisão diária pode usar
destinos diferentes. A ordem é:

1. escolher a origem (`Minhas TAGs` ou um catálogo RAG);
2. filtrar e escolher um item agrupado pela seção da planilha;
3. conferir a prévia compacta do destino;
4. escolher uma TAG somente quando o item for contextual;
5. definir percentual ou duração.

O filtro com seleção agrupada evita uma lista plana de dezenas de opções. A
divulgação progressiva remove campos irrelevantes dos itens fixos e Avulsos,
mas mantém o destino visível antes do envio. A implementação usa controles HTML
nativos, rótulos explícitos, grupos e opções desabilitadas, seguindo os padrões
de interação de [combobox](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/)
e [listbox agrupada](https://www.w3.org/WAI/ARIA/apg/patterns/listbox/).

## Validação

- testes unitários validam contagens, schema, interpretação dos quatro tipos,
  reatribuição e limpeza de referências;
- testes de integração verificam as atribuições e os corpos de POST de Projeto
  e Avulso;
- o E2E valida troca de fonte, busca, CRUD/importação, persistência e o
  rollback conjunto do catálogo e das regras quando `chrome.storage.local`
  recusa a gravação;
- o teste autenticado destrutivo é opt-in por
  `RUN_AUTHENTICATED_RAG_WRITE=1`. Ele usa somente 21/08/2026, confirma os dois
  modelos, remove as marcações de teste e restaura o total capturado do Ahgora
  no projeto padrão, inclusive em caso de falha intermediária.
