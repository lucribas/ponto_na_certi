# Execução e validação da implementação Senior

Este roteiro acompanha as ondas e gates do [plano](plan.md). Comandos novos são
explicitamente identificados; não estão disponíveis antes da implementação.

## Preparação

1. Ler o plano, contratos e modelo de dados. Verificar `git status` e preservar
   alterações locais. Criar branch de trabalho no início da implementação conforme
   o fluxo do mantenedor; o planejamento não criou branch nem commit.
2. Usar Node 24 e npm compatível com o projeto. Executar `npm ci` em
   `apps/chrome-extension` quando as dependências não estiverem instaladas.
3. Rodar a baseline de typecheck/testes antes de mudanças abrangentes e registrar
   falhas prévias. Não atribuir falhas existentes à feature sem investigação.
4. Na onda 0, usar Chromium de teste com cópia efêmera da extensão, login manual e
   permissão apenas para a origem Senior. Não alterar o ponto para gerar amostras.

## Ordem de trabalho e verificações

| Onda | Trabalho central                                        | Verificação antes da próxima onda                                   |
| ---- | ------------------------------------------------------- | ------------------------------------------------------------------- |
| 0    | Confirmar contrato e preparar fixtures sintéticas       | G0: contagem, indisponibilidade e exemplos documentados             |
| 1    | Intervalos, roteamento, contrato comum e wrapper Ahgora | Typecheck, unitários de período/fonte, paridade e integração Ahgora |
| 2    | Adaptador Senior, normalização e runner autenticado     | Testes de contrato; GET real disparado pela extensão; G2            |
| 3    | Estado v2, período antes da conexão, abas e coordenador | Migração, mensagens, operações mistas, cancelamento e falhas; G3    |
| 4    | Cards, seleção e alertas por fornecedor                 | Integração UI/alertas, revisão e regressão da escrita; G4           |
| 5    | E2E, documentação e pacote                              | Suíte completa, smoke real e inspeção de permissões; G5             |

Não repetir a suíte inteira em cada pequena alteração. Durante cada onda executar
os testes afetados; ao final da mudança transversal executar os comandos da CI:

```bash
cd apps/chrome-extension
npm run typecheck
npm run lint
npm test
npm run test:chrome-headless
npm run package
```

`npm test` inclui unitários, paridade, integração e E2E. O package executa build e
verificação do pacote. Instalar Chromium com `npm run e2e:install` quando necessário.
Validar também geração do site de instalação conforme o workflow de qualidade se
os textos da release/site forem alterados.

## Smoke Senior autenticado

Comando implementado:

```bash
RUN_SENIOR_AUTHENTICATED_SMOKE=1 SENIOR_SMOKE_START=2026-09-21 SENIOR_SMOKE_END=2026-09-25 npm run test:senior:authenticated
```

Fazer login na janela criada. O teste deve obter bindings e disparar o adaptador
pela extensão, não somente testar um fetch externo. Conferir conjunto de datas,
quantidade de marcações e duração de dias amostrados com a tela. Não fixar a
contagem de 29/09 para execuções posteriores: acertos podem mudar os dados reais.

Validar também um único dia, Todos versus Pendentes e, quando disponível, intervalo
que use duas competências. Amostras ausentes na conta ficam cobertas por fixtures
e são declaradas como não verificadas ao vivo. Nenhuma gravação Channel é necessária
para validar a leitura Senior.

## Checklist manual de aceite

- [ ] Período histórico usa somente Ahgora como fonte de ponto.
- [ ] Período desde 21/09 usa Senior sem pedir conexão Ahgora.
- [ ] Intervalo misto requer ambas e identifica a origem de cada dia.
- [ ] Seletor mensal mantém 26 a 25 e mostra as datas efetivas.
- [ ] Datas futuras não exigem competências ainda não abertas.
- [ ] Marcações previstas e original aninhada não acrescentam horas.
- [ ] Dia sem batidas permanece sem jornada presumida.
- [ ] Dia com pendência é visível e não entra em seleção em lote.
- [ ] Dia bloqueado por formato/virada de data não pode ser enviado.
- [ ] Filtro aberto na Senior não altera o conjunto capturado.
- [ ] Recusa de permissão oferece registro manual; login manual é detectado.
- [ ] Fechar aba/trocar colaborador invalida captura antes de envio.
- [ ] Alterar período invalida prévia e recalcula conexões necessárias.
- [ ] Cancelamento ou falha de uma fonte impede resultado parcial utilizável.
- [ ] Atualizar a extensão exige recaptura, preservando TAGs/regras locais.
- [ ] Alertas usam a fonte de hoje e não interpretam erro como batida ausente.
- [ ] Channel mantém seleção, parada e idempotência nos testes de regressão.

## Registro da entrega

Atualizar `docs/manual-validation.md` com versão da extensão/site, data do ensaio,
intervalos, resultados e limitações. Guardar somente evidências sanitizadas.
Conferir manifest/ZIP e alinhamento de versões antes de preparar release.

A instalação usa o fluxo existente de recarregar a extensão. Migração v1 → v2
invalida prévias; o próximo capture reconcilia o Channel. No retorno a build antigo,
remover somente a operação transitória incompatível, nunca todo storage local;
esse build não pode consultar Senior e não deve ser usado para preencher seu período.

A lista foi criada no planejamento. Evidências executadas e limitações constam de
[implementation-results.md](implementation-results.md); caixas vazias não equivalem a falhas.
