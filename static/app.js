/* Compara Planilhas — frontend */
"use strict";

const $ = (id) => document.getElementById(id);

const state = {
  files: { a: null, b: null },        // {path, name, type, sheets}
  diff: null,
  meta: { a: null, b: null },         // metadados retornados pelo compare
  grids: { a: null, b: null },        // apis do AG Grid
  pending: { a: new Map(), b: new Map() }, // "idx:col" -> valor editado
  onlyDiffs: false,
  onlyMatches: false,
  diffPos: -1,
  diffOrder: null,                    // diffs na ordem em que aparecem na tela
  lastCell: null,                     // {i, col} última célula clicada
  sortSource: null,                   // {side, col} grade/coluna que comanda a ordenação
  history: [],                        // edições aplicadas: {side, i, col, before, after}
  historyPos: 0,                      // quantas entradas de history estão aplicadas
  historySkip: [],                    // mudanças vindas do próprio desfazer/refazer
  search: { text: "", matches: [], pos: -1, rows: new Set(),
            cells: { a: new Set(), b: new Set() } },
  syncingScroll: false,
  syncingSelection: false,
  syncingSort: false,
  syncingWidth: false,
};

async function api(path, body) {
  const resp = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  if (!resp.ok) {
    let msg = `Erro ${resp.status}`;
    try { msg = (await resp.json()).detail || msg; } catch (_) {}
    throw new Error(msg);
  }
  return resp.json();
}

/* ---------------- setup: arquivos e abas ---------------- */

async function browse(side) {
  try {
    const r = await api("/api/pick-file");
    if (!r.dialog_available) {
      setMsg("Diálogo de arquivo indisponível neste sistema — digite o caminho completo no campo.", true);
      $(`path-${side}`).focus();
      return;
    }
    if (r.path) {
      $(`path-${side}`).value = r.path;
      await inspect(side);
    }
  } catch (e) {
    setMsg(e.message, true);
  }
}

// leituras de arquivo em andamento — doCompare espera por elas antes de ler
// state.files (digitar o caminho e clicar em "Comparar" dispara as duas coisas
// quase ao mesmo tempo).
const inspecting = { a: null, b: null };

function inspect(side) {
  const p = doInspect(side);
  inspecting[side] = p;
  p.finally(() => { if (inspecting[side] === p) inspecting[side] = null; });
  return p;
}

async function doInspect(side) {
  const path = $(`path-${side}`).value.trim();
  const info = $(`info-${side}`);
  state.files[side] = null;
  info.classList.remove("error");
  info.textContent = "";
  $(`sheet-row-${side}`).classList.add("hidden");
  if (!path) { refreshCompareButton(); return; }
  try {
    const r = await api("/api/inspect", { path });
    state.files[side] = r;
    info.textContent = `${r.name} (${r.type})`;
    const sel = $(`sheet-${side}`);
    sel.innerHTML = "";
    if (r.sheets.length > 0) {
      for (const s of r.sheets) {
        const opt = document.createElement("option");
        opt.value = s; opt.textContent = s;
        sel.appendChild(opt);
      }
      $(`sheet-row-${side}`).classList.remove("hidden");
    }
  } catch (e) {
    info.textContent = e.message;
    info.classList.add("error");
  }
  refreshCompareButton();
  await refreshColumns();
}

function sideReq(side) {
  const f = state.files[side];
  return { path: f.path, sheet: f.sheets.length ? $(`sheet-${side}`).value : null };
}

function fillColumnSelect(sel, labels) {
  const prev = new Set([...sel.selectedOptions].map(o => o.value));
  sel.innerHTML = "";
  labels.forEach((label, i) => {
    const opt = document.createElement("option");
    opt.value = String(i); opt.textContent = label;
    opt.selected = prev.has(String(i));
    sel.appendChild(opt);
  });
}

async function refreshColumns() {
  const sels = [$("key-cols"), $("sort-cols-a"), $("sort-cols-b")];
  if (!state.files.a || !state.files.b) {
    for (const sel of sels) sel.innerHTML = "";
    return;
  }
  try {
    const r = await api("/api/preview", {
      a: sideReq("a"), b: sideReq("b"),
      has_header: $("opt-header").checked,
    });
    fillColumnSelect($("key-cols"), r.columns);
    fillColumnSelect($("sort-cols-a"), r.columns_a || r.columns);
    fillColumnSelect($("sort-cols-b"), r.columns_b || r.columns);
  } catch (e) {
    setMsg(e.message, true);
  }
}

function refreshCompareButton() {
  $("btn-compare").disabled = !(state.files.a && state.files.b);
}

function setMsg(text, isError) {
  const el = $("setup-msg");
  el.textContent = text || "";
  el.classList.toggle("error", !!isError);
}

function selectedInts(sel) {
  return [...sel.selectedOptions].map(o => parseInt(o.value, 10));
}

function currentOptions() {
  return {
    has_header: $("opt-header").checked,
    mode: document.querySelector('input[name="mode"]:checked').value,
    key_cols: selectedInts($("key-cols")),
    sort_cols_a: selectedInts($("sort-cols-a")),
    sort_cols_b: selectedInts($("sort-cols-b")),
    ignore_case: $("opt-ignore-case").checked,
    ignore_space: $("opt-ignore-space").checked,
    ignore_numfmt: $("opt-ignore-numfmt").checked,
  };
}

async function doCompare() {
  await Promise.all([inspecting.a, inspecting.b]);
  if (!state.files.a || !state.files.b) {
    setMsg("Escolha os dois arquivos antes de comparar.", true);
    refreshCompareButton();
    return;
  }
  const opts = currentOptions();
  if (opts.mode === "key" && opts.key_cols.length === 0) {
    setMsg("Selecione ao menos uma coluna-chave para o alinhamento por chave.", true);
    return;
  }
  setMsg("Comparando…");
  $("btn-compare").disabled = true;
  try {
    const r = await api("/api/compare", {
      a: sideReq("a"), b: sideReq("b"), options: opts,
    });
    state.pending.a.clear();
    state.pending.b.clear();
    renderResults(r, []);
    setMsg("");
    $("setup").classList.add("hidden");
    $("btn-toggle-setup").classList.remove("hidden");
    $("search-group").classList.remove("hidden");
    $("results").classList.remove("hidden");
  } catch (e) {
    setMsg(e.message, true);
  } finally {
    refreshCompareButton();
  }
}

/* ---------------- resultados: grades ---------------- */

function pendKey(idx, col) { return `${idx}:${col}`; }

function buildRowData(side) {
  const diff = state.diff;
  const pend = state.pending[side];
  return diff.rows.map((r) => {
    const vals = side === "a" ? r.a : r.b;
    const idx = side === "a" ? r.a_idx : r.b_idx;
    const row = {
      __i: r.i, __status: r.status, __idx: idx,
      __missing: vals === null,
      __diffCols: r.diff_cols,
      __hasDiff: r.status !== "matched" || r.diff_cols.length > 0,
    };
    for (let c = 0; c < diff.n_cols; c++) {
      const edited = idx !== null ? pend.get(pendKey(idx, c)) : undefined;
      row["c" + c] = vals === null ? "" : (edited !== undefined ? edited : vals[c]);
    }
    return row;
  });
}

function buildColumnDefs(side) {
  const diff = state.diff;
  const pend = state.pending[side];
  const defs = [{
    headerName: "#",
    valueGetter: (p) => p.data.__missing ? "" :
      p.data.__idx + (diff.has_header ? 2 : 1),
    width: 64, pinned: "left", editable: false,
    cellClass: "rownum", suppressMovable: true, resizable: false,
  }];
  for (let c = 0; c < diff.n_cols; c++) {
    defs.push({
      field: "c" + c,
      headerName: diff.headers[c],
      editable: (p) => !p.data.__missing,
      flex: 1,
      minWidth: 110,
      sortable: true,
      comparator: makeComparator(side, c),
      cellClassRules: {
        "cell-edited": (p) => !p.data.__missing &&
          pend.has(pendKey(p.data.__idx, c)),
        "cell-diff": (p) => !p.data.__missing &&
          !pend.has(pendKey(p.data.__idx, c)) &&
          p.data.__diffCols.includes(c),
        "cell-found": (p) => !p.data.__missing &&
          state.search.cells[side].has(cellKey(p.data.__i, c)),
        "cell-found-active": (p) => isActiveMatch(side, p.data.__i, c),
      },
    });
  }
  return defs;
}

function gridOptions(side) {
  return {
    columnDefs: buildColumnDefs(side),
    rowData: buildRowData(side),
    getRowId: (p) => String(p.data.__i),
    rowSelection: "multiple",
    animateRows: false,
    enableCellTextSelection: false,
    stopEditingWhenCellsLoseFocus: true,
    defaultColDef: { resizable: true, sortable: false, suppressMovable: true },
    rowClassRules: {
      "row-only-this": (p) => p.data.__status === "only_" + side,
      "row-missing": (p) => p.data.__missing,
    },
    isExternalFilterPresent: () => state.onlyDiffs || state.onlyMatches,
    doesExternalFilterPass: (node) =>
      (!state.onlyDiffs || node.data.__hasDiff) &&
      (!state.onlyMatches || !state.search.text || state.search.rows.has(node.data.__i)),
    onCellValueChanged: (p) => onCellEdited(side, p),
    onCellClicked: (p) => {
      if (p.colDef.field) {
        state.lastCell = { i: p.data.__i, col: parseInt(p.colDef.field.slice(1), 10) };
        showCellValue(side, p.data.__i, state.lastCell.col);
      } else {
        clearCellValue();   // coluna "#": é seleção de linha, não de célula
      }
    },
    onSortChanged: (p) => onSortChanged(side, p),
    onColumnResized: (p) => onColumnResized(side, p),
    onFirstDataRendered: () => {
      attachSortSync(side);
      if (side === "b") attachScrollSync();
    },
    onSelectionChanged: () => syncSelection(side),
  };
}

function renderResults(resp, warnings) {
  state.diff = resp.diff;
  state.meta.a = resp.a;
  state.meta.b = resp.b;
  state.diffPos = -1;
  state.diffOrder = null;
  clearCellValue();
  clearHistory();

  $("label-a").textContent = `Planilha A — ${resp.a.name}` +
    (resp.a.sheet ? ` · aba: ${resp.a.sheet}` : "");
  $("label-b").textContent = `Planilha B — ${resp.b.name}` +
    (resp.b.sheet ? ` · aba: ${resp.b.sheet}` : "");

  for (const side of ["a", "b"]) {
    if (state.grids[side]) {
      state.grids[side].setGridOption("columnDefs", buildColumnDefs(side));
      state.grids[side].setGridOption("rowData", buildRowData(side));
    } else {
      state.grids[side] = agGrid.createGrid($(`grid-${side}`), gridOptions(side));
    }
    state.grids[side].onFilterChanged();
  }

  const s = resp.diff.summary;
  const allWarnings = [...(warnings || [])];
  if (s.header_mismatch) {
    allWarnings.push("Atenção: os cabeçalhos das duas planilhas são diferentes. " +
      "A comparação é feita pela posição das colunas.");
  }
  showWarnings(allWarnings);
  const sum = $("summary");
  sum.innerHTML =
    `<b class="diff">${s.diff_cells}</b>&nbsp;≠ · ` +
    `<b class="onlya">${s.rows_only_a}</b>&nbsp;só&nbsp;A · ` +
    `<b class="onlyb">${s.rows_only_b}</b>&nbsp;só&nbsp;B · ` +
    `${s.rows_a}×${s.rows_b}`;
  sum.title =
    `${s.diff_cells} célula(s) com valor diferente · ` +
    `${s.rows_only_a} linha(s) só na planilha A · ` +
    `${s.rows_only_b} linha(s) só na planilha B · ` +
    `${s.rows_a} linhas em A × ${s.rows_b} linhas em B`;
  runSearch($("search-input").value);
  updateDiffCounter();
  updateSaveButtons();
}

// Ocupa uma linha só, dividida com a barra de valor da célula: o texto é
// cortado com reticências e o aviso completo fica no title (dica do mouse).
function showWarnings(list) {
  const el = $("warnings");
  if (!list || list.length === 0) {
    el.classList.add("hidden");
    el.removeAttribute("title");
    return;
  }
  const full = list.join(" · ");
  el.textContent = `⚠️ ${full}`;
  el.title = full;
  el.classList.remove("hidden");
}

function escapeHtml(s) {
  const d = document.createElement("span");
  d.textContent = s;
  return d.innerHTML;
}

/* ---------------- ordenação sincronizada ----------------
   As duas grades são pareadas linha a linha, então quem manda na ordem é
   sempre uma única grade (state.sortSource): a outra usa os MESMOS valores
   como critério, o que mantém o alinhamento A ↔ B. */

const collator = new Intl.Collator("pt-BR", { numeric: true, sensitivity: "base" });

function parseNumber(v) {
  const s = String(v == null ? "" : v).trim();
  if (!s || !/^[-+]?[\d.,\s]*\d[\d.,\s]*%?$/.test(s)) return null;
  let t = s.replace(/[\s%]/g, "");
  t = t.lastIndexOf(",") > t.lastIndexOf(".")
    ? t.replace(/\./g, "").replace(",", ".")
    : t.replace(/,/g, "");
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function compareValues(va, vb) {
  const a = String(va == null ? "" : va);
  const b = String(vb == null ? "" : vb);
  if (a === b) return 0;
  const na = parseNumber(a), nb = parseNumber(b);
  if (na !== null && nb !== null && na !== nb) return na - nb;
  return collator.compare(a, b);
}

// valor exibido hoje (já com edições pendentes) da coluna col na grade side
function displayedValue(side, unifiedIndex, col) {
  const grid = state.grids[side];
  const node = grid && grid.getRowNode(String(unifiedIndex));
  return node ? node.data["c" + col] : "";
}

function makeComparator(side, col) {
  return (va, vb, nodeA, nodeB, isDescending) => {
    const src = state.sortSource;
    let a = va, b = vb;
    if (src && src.side !== side) {           // grade espelhada: usa os valores da origem
      a = displayedValue(src.side, nodeA.data.__i, col);
      b = displayedValue(src.side, nodeB.data.__i, col);
    }
    const ea = a == null || a === "", eb = b == null || b === "";
    if (ea || eb) {                           // vazios (e linhas ausentes) sempre no fim
      if (ea && eb) return 0;
      return (ea ? 1 : -1) * (isDescending ? -1 : 1);
    }
    return compareValues(a, b);
  };
}

// registra qual grade/coluna o usuário clicou ANTES do AG Grid ordenar
function attachSortSync(side) {
  const header = $(`grid-${side}`).querySelector(".ag-header");
  if (!header || header.dataset.sortSync) return;
  header.dataset.sortSync = "1";
  header.addEventListener("click", (ev) => {
    const cell = ev.target.closest && ev.target.closest(".ag-header-cell[col-id]");
    if (!cell) return;
    clearCellValue();       // clicar num cabeçalho é escolher coluna, não célula
    const colId = cell.getAttribute("col-id");
    if (/^c\d+$/.test(colId)) {
      state.sortSource = { side, col: parseInt(colId.slice(1), 10) };
    }
  }, true);
}

function sortModelOf(api) {
  return api.getColumnState()
    .filter(c => c.sort)
    .map(c => ({ colId: c.colId, sort: c.sort, sortIndex: c.sortIndex }));
}

function onSortChanged(side, params) {
  if (state.syncingSort) return;
  const model = sortModelOf(params.api);
  if (model.length === 0) state.sortSource = null;
  const other = state.grids[side === "a" ? "b" : "a"];
  if (other) {
    state.syncingSort = true;
    try {
      other.applyColumnState({ state: model, defaultState: { sort: null } });
    } finally {
      state.syncingSort = false;
    }
  }
  $("btn-clear-order").disabled = model.length === 0;
  afterOrderChanged();
}

function clearSort() {
  state.sortSource = null;
  state.syncingSort = true;
  try {
    for (const side of ["a", "b"]) {
      if (state.grids[side]) {
        state.grids[side].applyColumnState({ defaultState: { sort: null } });
      }
    }
  } finally {
    state.syncingSort = false;
  }
  $("btn-clear-order").disabled = true;
  afterOrderChanged();
}

// a ordem visual mudou: navegação de diferenças e de busca acompanham a tela
function afterOrderChanged() {
  state.diffOrder = null;
  state.diffPos = -1;
  if (state.search.matches.length > 0) {
    sortByDisplay(state.search.matches);
    state.search.pos = -1;
    updateSearchCounter();
  }
  updateDiffCounter();
}

// posição na tela da linha unificada i (ordem atual das grades)
function displayIndex(i) {
  for (const side of ["a", "b"]) {
    const grid = state.grids[side];
    const node = grid && grid.getRowNode(String(i));
    if (node && node.rowIndex != null) return node.rowIndex;
  }
  return Number.MAX_SAFE_INTEGER;
}

function sortByDisplay(list) {
  const pos = new Map();
  for (const item of list) {
    if (!pos.has(item.i)) pos.set(item.i, displayIndex(item.i));
  }
  list.sort((x, y) =>
    (pos.get(x.i) - pos.get(y.i)) ||
    (x.side === y.side ? 0 : x.side === "a" ? -1 : 1) ||
    ((x.col == null ? -1 : x.col) - (y.col == null ? -1 : y.col)));
  return list;
}

/* ---------------- largura de coluna espelhada ---------------- */

function onColumnResized(side, params) {
  if (state.syncingWidth || !params.finished || !params.column) return;
  const other = state.grids[side === "a" ? "b" : "a"];
  if (!other) return;
  const cols = params.columns && params.columns.length ? params.columns : [params.column];
  state.syncingWidth = true;
  try {
    other.applyColumnState({
      state: cols.map(c => ({ colId: c.getColId(), width: c.getActualWidth(), flex: null })),
    });
  } finally {
    state.syncingWidth = false;
  }
}

/* ---------------- valor da célula (barra estilo Excel) ---------------- */

function showCellValue(side, unifiedIndex, col) {
  const diff = state.diff;
  const node = state.grids[side].getRowNode(String(unifiedIndex));
  if (!diff || !node) return;
  const bar = $("cell-value");
  const rowLabel = node.data.__missing ? "—" :
    String(node.data.__idx + (diff.has_header ? 2 : 1));
  $("cell-ref").textContent =
    `${side.toUpperCase()} · linha ${rowLabel} · ${diff.headers[col]}`;
  const value = node.data.__missing ? "" : String(node.data["c" + col] ?? "");
  bar.textContent = value === "" ?
    (node.data.__missing ? "(linha inexistente)" : "(vazio)") : value;
  bar.title = value;
  bar.classList.toggle("empty", value === "");
}

// nada de célula selecionada (clique num cabeçalho ou no número da linha):
// a barra continua no lugar, só que vazia
function clearCellValue() {
  state.lastCell = null;
  $("cell-ref").textContent = "";
  const bar = $("cell-value");
  bar.textContent = "";
  bar.removeAttribute("title");
  bar.classList.remove("empty");
}

/* ---------------- busca de texto ---------------- */

function cellKey(i, col) { return i + ":" + col; }

function normText(s) {
  return String(s == null ? "" : s)
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function isActiveMatch(side, i, col) {
  const m = state.search.matches[state.search.pos];
  return !!m && m.side === side && m.i === i && m.col === col;
}

function runSearch(text, keepPos) {
  const s = state.search;
  const prev = s.matches[s.pos];
  s.text = (text || "").trim();
  s.matches = [];
  s.rows = new Set();
  s.cells = { a: new Set(), b: new Set() };
  s.pos = -1;
  const q = normText(s.text);
  if (q && state.diff && state.grids.a && state.grids.b) {
    for (const r of state.diff.rows) {
      for (const side of ["a", "b"]) {
        const node = state.grids[side].getRowNode(String(r.i));
        if (!node || node.data.__missing) continue;
        for (let c = 0; c < state.diff.n_cols; c++) {
          if (normText(node.data["c" + c]).includes(q)) {
            s.matches.push({ i: r.i, side, col: c });
            s.cells[side].add(cellKey(r.i, c));
            s.rows.add(r.i);
          }
        }
      }
    }
    sortByDisplay(s.matches);
    if (keepPos && prev) {
      const at = s.matches.findIndex(
        m => m.i === prev.i && m.side === prev.side && m.col === prev.col);
      s.pos = at;
    }
  }
  updateSearchCounter();
  for (const side of ["a", "b"]) {
    if (!state.grids[side]) continue;
    if (state.onlyMatches) state.grids[side].onFilterChanged();
    state.grids[side].refreshCells({ force: true });
  }
}

function updateSearchCounter() {
  const s = state.search;
  const el = $("search-counter");
  if (!s.text) el.textContent = "—";
  else if (s.matches.length === 0) el.textContent = "nada encontrado";
  else el.textContent = s.pos >= 0 ?
    `${s.pos + 1} de ${s.matches.length}` : `${s.matches.length} ocorrência(s)`;
  const none = s.matches.length === 0;
  $("btn-find-prev").disabled = none;
  $("btn-find-next").disabled = none;
  el.classList.toggle("nores", !!s.text && none);
}

function gotoMatch(step) {
  const s = state.search;
  if (s.matches.length === 0) return;
  s.pos = (s.pos + step + s.matches.length) % s.matches.length;
  const m = s.matches[s.pos];
  for (const side of ["a", "b"]) {
    const grid = state.grids[side];
    const node = grid.getRowNode(String(m.i));
    if (!node || node.rowIndex == null) continue;
    grid.ensureIndexVisible(node.rowIndex, "middle");
    grid.ensureColumnVisible("c" + m.col);
  }
  const grid = state.grids[m.side];
  const node = grid.getRowNode(String(m.i));
  if (node) grid.flashCells({ rowNodes: [node], columns: ["c" + m.col] });
  showCellValue(m.side, m.i, m.col);
  state.lastCell = { i: m.i, col: m.col };
  for (const side of ["a", "b"]) state.grids[side].refreshCells({ force: true });
  updateSearchCounter();
}

/* ---------------- scroll sincronizado ---------------- */

function attachScrollSync() {
  const els = {};
  for (const side of ["a", "b"]) {
    els[side] = {
      v: $(`grid-${side}`).querySelector(".ag-body-viewport"),
      h: $(`grid-${side}`).querySelector(".ag-center-cols-viewport"),
    };
  }
  const link = (from, to, axis) => {
    const prop = axis === "v" ? "scrollTop" : "scrollLeft";
    els[from][axis].addEventListener("scroll", () => {
      if (state.syncingScroll) return;
      state.syncingScroll = true;
      els[to][axis][prop] = els[from][axis][prop];
      requestAnimationFrame(() => { state.syncingScroll = false; });
    });
  };
  link("a", "b", "v"); link("b", "a", "v");
  link("a", "b", "h"); link("b", "a", "h");
}

/* ---------------- seleção espelhada ---------------- */

function syncSelection(fromSide) {
  if (state.syncingSelection) return;
  state.syncingSelection = true;
  try {
    const from = state.grids[fromSide];
    const to = state.grids[fromSide === "a" ? "b" : "a"];
    const ids = new Set(from.getSelectedNodes().map(n => n.id));
    to.forEachNode(n => n.setSelected(ids.has(n.id)));
  } finally {
    setTimeout(() => { state.syncingSelection = false; }, 0);
  }
}

/* ---------------- edição e gravação ---------------- */

function onCellEdited(side, p) {
  if (p.data.__missing || !p.colDef.field) return;
  const col = parseInt(p.colDef.field.slice(1), 10);
  const key = pendKey(p.data.__idx, col);
  const original = originalValue(side, p.data.__i, col);
  const newVal = p.newValue == null ? "" : String(p.newValue);
  const oldVal = p.oldValue == null ? "" : String(p.oldValue);
  // o AG Grid entrega este evento de forma assíncrona, então o desfazer/refazer
  // marca antes a mudança que vai provocar, para não gravá-la como edição nova
  const mark = historyMark(side, p.data.__i, col, newVal);
  const skipAt = state.historySkip.indexOf(mark);
  if (skipAt >= 0) {
    state.historySkip.splice(skipAt, 1);
  } else if (newVal !== oldVal) {
    state.history.length = state.historyPos;      // descarta o ramo refeito
    state.history.push({ side, i: p.data.__i, col, before: oldVal, after: newVal });
    state.historyPos = state.history.length;
    updateHistoryButtons();
  }
  if (newVal === original) {
    state.pending[side].delete(key);
  } else {
    state.pending[side].set(key, newVal);
  }
  p.api.refreshCells({ rowNodes: [p.node], force: true });
  updateSaveButtons();
  if (state.lastCell && state.lastCell.i === p.data.__i && state.lastCell.col === col) {
    showCellValue(side, p.data.__i, col);
  }
  if (state.search.text) runSearch(state.search.text, true);
}

/* ---------------- desfazer / refazer ---------------- */

function updateHistoryButtons() {
  const undo = state.historyPos > 0;
  const redo = state.historyPos < state.history.length;
  $("btn-undo").disabled = !undo;
  $("btn-redo").disabled = !redo;
  $("btn-undo").title = undo ?
    `Desfazer a edição em ${describeEdit(state.history[state.historyPos - 1])} (Ctrl+Z)` :
    "Nada para desfazer (Ctrl+Z)";
  $("btn-redo").title = redo ?
    `Refazer a edição em ${describeEdit(state.history[state.historyPos])} (Ctrl+Y)` :
    "Nada para refazer (Ctrl+Y)";
}

function describeEdit(edit) {
  const node = state.grids[edit.side] && state.grids[edit.side].getRowNode(String(edit.i));
  const linha = node && !node.data.__missing ?
    node.data.__idx + (state.diff.has_header ? 2 : 1) : "?";
  return `${edit.side.toUpperCase()} · linha ${linha} · ${state.diff.headers[edit.col]}`;
}

function historyMark(side, i, col, value) {
  return `${side}|${i}|${col}|${value}`;
}

function clearHistory() {
  state.history = [];
  state.historyPos = 0;
  state.historySkip = [];
  updateHistoryButtons();
}

function stepHistory(dir) {
  const edit = dir < 0 ? state.history[state.historyPos - 1] : state.history[state.historyPos];
  if (!edit) return;
  const grid = state.grids[edit.side];
  const node = grid.getRowNode(String(edit.i));
  if (!node) return;
  const value = dir < 0 ? edit.before : edit.after;
  state.historySkip.push(historyMark(edit.side, edit.i, edit.col, value));
  node.setDataValue("c" + edit.col, value);
  state.historyPos += dir < 0 ? -1 : 1;
  updateHistoryButtons();
  if (node.rowIndex != null) {
    grid.ensureIndexVisible(node.rowIndex, "middle");
    grid.ensureColumnVisible("c" + edit.col);
    grid.flashCells({ rowNodes: [node], columns: ["c" + edit.col] });
  }
  state.lastCell = { i: edit.i, col: edit.col };
  showCellValue(edit.side, edit.i, edit.col);
}

function originalValue(side, unifiedIndex, col) {
  const r = state.diff.rows[unifiedIndex];
  const vals = side === "a" ? r.a : r.b;
  return vals ? vals[col] : "";
}

function updateSaveButtons() {
  for (const side of ["a", "b"]) {
    const n = state.pending[side].size;
    const btn = $(`btn-save-${side}`);
    btn.textContent = n > 0 ?
      `💾 Salvar ${side.toUpperCase()} (${n})` : `💾 Salvar ${side.toUpperCase()}`;
    btn.classList.toggle("dirty", n > 0);
    btn.disabled = n === 0;
  }
}

async function doSave(side) {
  const pend = state.pending[side];
  if (pend.size === 0) return;
  const edits = [...pend.entries()].map(([key, value]) => {
    const [row, col] = key.split(":").map(Number);
    return { row, col, value };
  });
  const btn = $(`btn-save-${side}`);
  btn.disabled = true;
  btn.textContent = "Salvando…";
  try {
    const r = await api("/api/save", { side, edits });
    pend.clear();
    renderResults(r, r.warnings);
  } catch (e) {
    alert(e.message);
  } finally {
    updateSaveButtons();
  }
}

/* ---------------- copiar A <-> B ---------------- */

function copyValue(fromSide, toSide) {
  const cell = state.lastCell;
  if (!cell) {
    alert("Clique primeiro numa célula para escolher o que copiar.");
    return;
  }
  const fromNode = state.grids[fromSide].getRowNode(String(cell.i));
  const toNode = state.grids[toSide].getRowNode(String(cell.i));
  if (!fromNode || !toNode) return;
  if (toNode.data.__missing) {
    alert("A linha correspondente não existe na planilha de destino.");
    return;
  }
  if (fromNode.data.__missing) {
    alert("A linha selecionada não existe na planilha de origem.");
    return;
  }
  const field = "c" + cell.col;
  toNode.setDataValue(field, fromNode.data[field]);
}

/* ---------------- navegação entre diferenças ---------------- */

function visibleDiffs() {
  if (!state.diff) return [];
  if (!state.sortSource) return state.diff.diffs;
  if (!state.diffOrder) {
    state.diffOrder = sortByDisplay(
      state.diff.diffs.map(d => ({ i: d.row, row: d.row, col: d.col, side: "a" })));
  }
  return state.diffOrder;
}

function updateDiffCounter() {
  const total = visibleDiffs().length;
  const el = $("diff-counter");
  el.textContent = total === 0 ? "sem dif." :
    (state.diffPos >= 0 ? `${state.diffPos + 1}/${total}` : `${total} dif.`);
  el.title = total === 0 ? "Nenhuma diferença encontrada" :
    (state.diffPos >= 0 ? `Diferença ${state.diffPos + 1} de ${total}` :
      `${total} diferença(s) — use ◀ ▶ para percorrer`);
  $("btn-prev").disabled = $("btn-next").disabled = total === 0;
}

function gotoDiff(step) {
  const diffs = visibleDiffs();
  if (diffs.length === 0) return;
  state.diffPos = (state.diffPos + step + diffs.length) % diffs.length;
  const d = diffs[state.diffPos];
  for (const side of ["a", "b"]) {
    const grid = state.grids[side];
    const node = grid.getRowNode(String(d.row));
    if (!node || node.rowIndex == null) continue;
    grid.ensureIndexVisible(node.rowIndex, "middle");
    if (d.col != null) {
      grid.ensureColumnVisible("c" + d.col);
      grid.flashCells({ rowNodes: [node], columns: ["c" + d.col] });
    } else {
      grid.flashCells({ rowNodes: [node] });
    }
  }
  if (d.col != null) {
    state.lastCell = { i: d.row, col: d.col };
    const nodeA = state.grids.a.getRowNode(String(d.row));
    showCellValue(nodeA && !nodeA.data.__missing ? "a" : "b", d.row, d.col);
  }
  updateDiffCounter();
}

/* ---------------- relatório ---------------- */

async function exportReport() {
  const resp = await fetch("/api/report", { method: "POST" });
  if (!resp.ok) {
    let msg = "Erro ao gerar o relatório.";
    try { msg = (await resp.json()).detail || msg; } catch (_) {}
    alert(msg);
    return;
  }
  const blob = await resp.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "relatorio_comparacao.xlsx";
  link.click();
  URL.revokeObjectURL(url);
}

/* ---------------- eventos ---------------- */

$("browse-a").addEventListener("click", () => browse("a"));
$("browse-b").addEventListener("click", () => browse("b"));
$("path-a").addEventListener("change", () => inspect("a"));
$("path-b").addEventListener("change", () => inspect("b"));
$("sheet-a").addEventListener("change", refreshColumns);
$("sheet-b").addEventListener("change", refreshColumns);
$("opt-header").addEventListener("change", refreshColumns);
for (const radio of document.querySelectorAll('input[name="mode"]')) {
  radio.addEventListener("change", () => {
    $("key-cols-wrap").classList.toggle("hidden",
      document.querySelector('input[name="mode"]:checked').value !== "key");
  });
}
$("clear-sort").addEventListener("click", () => {
  for (const id of ["sort-cols-a", "sort-cols-b"]) {
    for (const o of $(id).options) o.selected = false;
  }
});
$("btn-compare").addEventListener("click", doCompare);
$("btn-toggle-setup").addEventListener("click", () => {
  $("setup").classList.toggle("hidden");
});
$("only-diffs").addEventListener("change", (e) => {
  state.onlyDiffs = e.target.checked;
  state.grids.a.onFilterChanged();
  state.grids.b.onFilterChanged();
  afterOrderChanged();
});
$("only-matches").addEventListener("change", (e) => {
  state.onlyMatches = e.target.checked;
  state.grids.a.onFilterChanged();
  state.grids.b.onFilterChanged();
  afterOrderChanged();
});
let searchTimer = null;
$("search-input").addEventListener("input", (e) => {
  const text = e.target.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => runSearch(text), 200);
});
$("search-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    clearTimeout(searchTimer);
    if (state.search.text !== e.target.value.trim()) runSearch(e.target.value);
    gotoMatch(e.shiftKey ? -1 : 1);
  } else if (e.key === "Escape") {
    e.target.value = "";
    runSearch("");
    e.target.blur();
  }
});
$("btn-find-prev").addEventListener("click", () => gotoMatch(-1));
$("btn-find-next").addEventListener("click", () => gotoMatch(1));
$("btn-clear-order").addEventListener("click", clearSort);
$("btn-undo").addEventListener("click", () => stepHistory(-1));
$("btn-redo").addEventListener("click", () => stepHistory(1));
document.addEventListener("keydown", (e) => {
  if ($("results").classList.contains("hidden")) return;
  const ctrl = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (ctrl && key === "f") {
    e.preventDefault();
    $("search-input").focus();
    $("search-input").select();
  } else if (ctrl && key === "z" && !e.shiftKey) {
    e.preventDefault();
    stepHistory(-1);
  } else if (ctrl && (key === "y" || (key === "z" && e.shiftKey))) {
    e.preventDefault();
    stepHistory(1);
  }
});
$("btn-prev").addEventListener("click", () => gotoDiff(-1));
$("btn-next").addEventListener("click", () => gotoDiff(1));
$("btn-copy-ab").addEventListener("click", () => copyValue("a", "b"));
$("btn-copy-ba").addEventListener("click", () => copyValue("b", "a"));
$("btn-save-a").addEventListener("click", () => doSave("a"));
$("btn-save-b").addEventListener("click", () => doSave("b"));
$("btn-recompare").addEventListener("click", async () => {
  const dirty = state.pending.a.size + state.pending.b.size;
  if (dirty > 0 && !confirm(
    `Há ${dirty} edição(ões) não salva(s) que serão descartadas. Continuar?`)) {
    return;
  }
  try {
    const r = await api("/api/compare", {
      a: { path: state.meta.a.path, sheet: state.meta.a.sheet },
      b: { path: state.meta.b.path, sheet: state.meta.b.sheet },
      options: currentOptions(),
    });
    state.pending.a.clear();
    state.pending.b.clear();
    renderResults(r, []);
  } catch (e) {
    alert(e.message);
  }
});
$("btn-report").addEventListener("click", exportReport);

updateSaveButtons();
updateSearchCounter();
updateHistoryButtons();
