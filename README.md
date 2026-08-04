# Compara Planilhas

Sistema local para comparar duas planilhas (csv, xls, xlsx ou ods) lado a lado
no navegador, com destaque das diferenças, edição das células e gravação no
arquivo original.

## Como usar

Requisitos: **Python 3.10 a 3.14 estável** (Linux ou Windows) e internet na
primeira execução (para baixar as dependências).

```
python run.py
```

O navegador abre automaticamente em `http://localhost:8765`.

> **Não use versões alfa/beta do Python** (ex.: 3.15.0a5, a mais recente na
> página de downloads do python.org). Para elas ainda não existem pacotes
> prontos no PyPI, e a instalação tentaria compilar o `pydantic-core` em
> Rust/MSVC — o que falha em máquinas sem o Visual Studio Build Tools.
> A faixa suportada fica declarada no `requirements.txt`
> (`# python_requires: >=3.10,<3.15`); o `run.py` a lê, e se o Python usado
> estiver fora dela procura automaticamente um interpretador estável já
> instalado na máquina para criar o `.venv` (no Windows via `py -0p`).

1. Selecione os dois arquivos (botão **Procurar…** ou digitando o caminho).
2. Escolha a aba de cada planilha (xls/xlsx/ods).
3. Ajuste as opções e clique em **Comparar planilhas**.

## Funcionalidades

- Formatos: **csv, xls, xlsx, ods**, com seleção de aba.
- Duas grades empilhadas (A em cima, B embaixo) com **rolagem sincronizada**
  nos dois eixos e **seleção de linhas espelhada** (Ctrl/Shift para várias).
- Células com valores diferentes destacadas em âmbar; linhas presentes em só
  uma das planilhas destacadas em vermelho (só em A) / verde (só em B).
- **Alinhamento por posição** ou **por coluna(s)-chave** (detecta linhas
  adicionadas/removidas mesmo fora de ordem), com **ordenação prévia**
  opcional, escolhida **separadamente para cada planilha** (útil quando as
  duas têm as mesmas colunas em ordem ou com nomes diferentes).
- Opções de normalização: ignorar maiúsculas/minúsculas, espaços extras e
  formato numérico (`1,5` ≡ `1.50`).
- **Navegação entre diferenças** (◀/▶ com contador) e filtro
  "só linhas com diferenças".
- **Ordenação por coluna**: clique no cabeçalho para ordenar (crescente →
  decrescente → sem ordenação; Shift+clique acrescenta outras colunas).
  A ordem é aplicada às **duas grades ao mesmo tempo**, usando os valores da
  planilha em que você clicou — assim as linhas continuam pareadas A ↔ B.
  Números são ordenados como números (`10,5` antes de `20`), o texto respeita
  acentuação do português, e linhas ausentes/vazias vão para o fim.
  O botão **↕ Ordem original** desfaz a ordenação.
- **Busca de texto** (campo 🔎 na barra de título ou `Ctrl+F`): realça todas as
  ocorrências nas duas planilhas, ignorando maiúsculas/minúsculas e acentos.
  `Enter` / `Shift+Enter` (ou ◀/▶) percorrem as ocorrências, `Esc` limpa, e o
  filtro "só encontradas" esconde o resto.
- **Barra de valor da célula** (estilo Excel): mostra o conteúdo completo da
  célula clicada, sem precisar alargar a coluna. Fica vazia quando a seleção
  não é de uma célula (cabeçalho de coluna ou número da linha).
- **Largura de coluna espelhada**: redimensionar uma coluna em A ajusta a
  mesma coluna em B (e vice-versa).
- **Edição inline** (duplo clique) com gravação no arquivo original
  (botões Salvar A/Salvar B) e botões **Copiar A → B / B → A** para resolver
  divergências.
- **Desfazer/refazer** as edições ainda não salvas (botões ↶ ↷, `Ctrl+Z` e
  `Ctrl+Y`); o histórico é zerado a cada gravação ou nova comparação.
- **Exportar relatório** `.xlsx` com resumo e as duas planilhas com as
  diferenças destacadas.

## Observações sobre gravação

| Formato | Comportamento |
|---|---|
| csv | Regravado por completo (mesmo delimitador e encoding) |
| xlsx | Editado no lugar; demais abas e formatação preservadas |
| ods | Regravado: dados de todas as abas preservados, formatação visual perdida |
| xls | Formato legado: edições são salvas numa cópia `.xlsx` ao lado do original |

Antes da primeira gravação é criado um backup `arquivo.ext.bak` ao lado do
original.
