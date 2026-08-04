"""Compara Planilhas — aplicação web local (FastAPI)."""

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import compare as compare_mod
from . import files, report, save

BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "static"

app = FastAPI(title="Compara Planilhas")

# Estado da sessão (app local, um usuário)
STATE: dict = {"a": None, "b": None, "options": None, "diff": None}


@app.on_event("startup")
def _warm_up_readers():
    """Importa openpyxl/xlrd/odfpy em segundo plano.

    São imports caros (300ms a 1,4s) e feitos sob demanda na leitura; fazê-los
    enquanto o usuário ainda escolhe os arquivos evita a espera no primeiro uso.
    """
    import threading

    def _load():
        for mod in ("openpyxl", "xlrd", "odf.opendocument"):
            try:
                __import__(mod)
            except Exception:
                pass

    threading.Thread(target=_load, daemon=True).start()


class InspectReq(BaseModel):
    path: str


class SideReq(BaseModel):
    path: str
    sheet: str | None = None


class PreviewReq(BaseModel):
    a: SideReq
    b: SideReq
    has_header: bool = True


class Options(BaseModel):
    has_header: bool = True
    mode: str = "position"          # "position" | "key"
    key_cols: list[int] = []
    sort_cols: list[int] = []       # compatibilidade: usado nos dois lados
    sort_cols_a: list[int] | None = None
    sort_cols_b: list[int] | None = None
    ignore_case: bool = False
    ignore_space: bool = False
    ignore_numfmt: bool = False


class CompareReq(BaseModel):
    a: SideReq
    b: SideReq
    options: Options


class Edit(BaseModel):
    row: int
    col: int
    value: str


class SaveReq(BaseModel):
    side: str                        # "a" | "b"
    edits: list[Edit]


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.post("/api/pick-file")
def pick_file():
    result = files.pick_file_dialog()
    if result is None:
        return {"path": None, "dialog_available": False}
    return {"path": result or None, "dialog_available": True}


@app.post("/api/inspect")
def inspect(req: InspectReq):
    try:
        p = files.validate_path(req.path)
        return {
            "path": str(p),
            "name": p.name,
            "type": files.file_type(str(p)),
            "sheets": files.list_sheets(p),
        }
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(400, f"Erro ao ler o arquivo: {e}")


def _col_labels(header: list[str], n_cols: int, has_header: bool) -> list[str]:
    labels = []
    for c in range(n_cols):
        name = header[c].strip() if c < len(header) else ""
        letter = compare_mod.excel_col_name(c)
        labels.append(f"{letter} — {name}" if name and has_header else letter)
    return labels


@app.post("/api/preview")
def preview(req: PreviewReq):
    """Rótulos de coluna para os seletores de chave e de ordenação.

    `columns` usa o cabeçalho de A (as colunas-chave são por posição, valem
    para as duas planilhas); `columns_a` e `columns_b` trazem o cabeçalho de
    cada planilha, para os seletores de ordenação de cada lado.
    """
    try:
        pa = files.validate_path(req.a.path)
        pb = files.validate_path(req.b.path)
        rows_a = files.load_table(pa, req.a.sheet)
        rows_b = files.load_table(pb, req.b.sheet)
    except ValueError as e:
        raise HTTPException(400, str(e))
    cols_a = max((len(r) for r in rows_a), default=0)
    cols_b = max((len(r) for r in rows_b), default=0)
    n_cols = max(cols_a, cols_b)
    header_a = rows_a[0] if req.has_header and rows_a else []
    header_b = rows_b[0] if req.has_header and rows_b else []
    return {
        "columns": _col_labels(header_a, n_cols, req.has_header),
        "columns_a": _col_labels(header_a, cols_a, req.has_header),
        "columns_b": _col_labels(header_b, cols_b, req.has_header),
    }


def _run_compare() -> dict:
    a, b, opts = STATE["a"], STATE["b"], STATE["options"]
    rows_a = files.load_table(Path(a["path"]), a["sheet"])
    rows_b = files.load_table(Path(b["path"]), b["sheet"])
    diff = compare_mod.compare(rows_a, rows_b, opts)
    STATE["diff"] = diff
    return diff


@app.post("/api/compare")
def do_compare(req: CompareReq):
    try:
        pa = files.validate_path(req.a.path)
        pb = files.validate_path(req.b.path)
    except ValueError as e:
        raise HTTPException(400, str(e))
    STATE["a"] = {"path": str(pa), "sheet": req.a.sheet, "name": pa.name}
    STATE["b"] = {"path": str(pb), "sheet": req.b.sheet, "name": pb.name}
    STATE["options"] = req.options.model_dump()
    try:
        diff = _run_compare()
    except Exception as e:
        raise HTTPException(400, f"Erro ao comparar: {e}")
    return {"a": STATE["a"], "b": STATE["b"], "diff": diff}


@app.post("/api/save")
def do_save(req: SaveReq):
    if req.side not in ("a", "b") or STATE[req.side] is None:
        raise HTTPException(400, "Sessão de comparação não iniciada.")
    meta = STATE[req.side]
    try:
        result = save.apply_edits(
            Path(meta["path"]), meta["sheet"], STATE["options"]["has_header"],
            [e.model_dump() for e in req.edits],
        )
    except Exception as e:
        raise HTTPException(400, f"Erro ao salvar: {e}")
    # .xls é salvo como cópia .xlsx: a sessão passa a apontar para a cópia,
    # para que a re-comparação reflita as edições.
    if result["saved_path"] != meta["path"]:
        meta["path"] = result["saved_path"]
        meta["name"] = Path(result["saved_path"]).name
    try:
        diff = _run_compare()
    except Exception as e:
        raise HTTPException(400, f"Salvo, mas houve erro ao re-comparar: {e}")
    return {"saved_path": result["saved_path"], "warnings": result["warnings"],
            "a": STATE["a"], "b": STATE["b"], "diff": diff}


@app.post("/api/report")
def do_report():
    if not STATE.get("diff"):
        raise HTTPException(400, "Nenhuma comparação para exportar.")
    data = report.build_report(STATE["diff"], STATE["a"], STATE["b"])
    return Response(
        content=data,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition":
                 'attachment; filename="relatorio_comparacao.xlsx"'},
    )


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
