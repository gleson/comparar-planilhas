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
  diffPos: -1,
  lastCell: null,                     // {i, col} última célula clicada
  syncingScroll: false,
  syncingSelection: false,
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

async function inspect(side) {
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

async function refreshColumns() {
  const keySel = $("key-cols"), sortSel = $("sort-cols");
  if (!state.files.a || !state.files.b) {
    keySel.innerHTML = ""; sortSel.innerHTML = "";
    return;
  }
  try {
    const r = await api("/api/preview", {
      a: sideReq("a"), b: sideReq("b"),
      has_header: $("opt-header").checked,
    });
    for (const sel of [keySel, sortSel]) {
      const prev = new Set([...sel.selectedOptions].map(o => o.value));
      sel.innerHTML = "";
      r.columns.forEach((label, i) => {
        const opt = document.createElement("option");
        opt.value = String(i); opt.textContent = label;
        opt.selected = prev.has(String(i));
        sel.appendChild(opt);
      });
    }
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
    sort_cols: selectedInts($("sort-cols")),
    ignore_case: $("opt-ignore-case").checked,
    ignore_space: $("opt-ignore-space").checked,
    ignore_numfmt: $("opt-ignore-numfmt").checked,
  };
}

async function doCompare() {
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
      cellClassRules: {
        "cell-edited": (p) => !p.data.__missing &&
          pend.has(pendKey(p.data.__idx, c)),
        "cell-diff": (p) => !p.data.__missing &&
          !pend.has(pendKey(p.data.__idx, c)) &&
          p.data.__diffCols.includes(c),
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
    isExternalFilterPresent: () => state.onlyDiffs,
    doesExternalFilterPass: (node) => node.data.__hasDiff,
    onCellValueChanged: (p) => onCellEdited(side, p),
    onCellClicked: (p) => {
      if (p.colDef.field) {
        state.lastCell = { i: p.data.__i, col: parseInt(p.colDef.field.slice(1), 10) };
      }
    },
    onSelectionChanged: () => syncSelection(side),
    onFirstDataRendered: () => { if (side === "b") attachScrollSync(); },
  };
}

function renderResults(resp, warnings) {
  state.diff = resp.diff;
  state.meta.a = resp.a;
  state.meta.b = resp.b;
  state.diffPos = -1;
  state.lastCell = null;

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
  $("summary").innerHTML =
    `<b class="diff">${s.diff_cells}</b>&nbsp;célula(s) diferente(s) · ` +
    `<b class="onlya">${s.rows_only_a}</b>&nbsp;linha(s) só em A · ` +
    `<b class="onlyb">${s.rows_only_b}</b>&nbsp;linha(s) só em B · ` +
    `${s.rows_a}×${s.rows_b} linhas`;
  updateDiffCounter();
  updateSaveButtons();
}

function showWarnings(list) {
  const el = $("warnings");
  if (!list || list.length === 0) { el.classList.add("hidden"); return; }
  el.innerHTML = list.map(w => `⚠️ ${escapeHtml(w)}`).join("<br>");
  el.classList.remove("hidden");
}

function escapeHtml(s) {
  const d = document.createElement("span");
  d.textContent = s;
  return d.innerHTML;
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
  if (newVal === original) {
    state.pending[side].delete(key);
  } else {
    state.pending[side].set(key, newVal);
  }
  p.api.refreshCells({ rowNodes: [p.node], force: true });
  updateSaveButtons();
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
  return state.diff ? state.diff.diffs : [];
}

function updateDiffCounter() {
  const total = visibleDiffs().length;
  $("diff-counter").textContent = total === 0 ? "sem diferenças" :
    (state.diffPos >= 0 ? `${state.diffPos + 1} de ${total}` : `${total} diferença(s)`);
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
  for (const o of $("sort-cols").options) o.selected = false;
});
$("btn-compare").addEventListener("click", doCompare);
$("btn-toggle-setup").addEventListener("click", () => {
  $("setup").classList.toggle("hidden");
});
$("only-diffs").addEventListener("change", (e) => {
  state.onlyDiffs = e.target.checked;
  state.grids.a.onFilterChanged();
  state.grids.b.onFilterChanged();
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
