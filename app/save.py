"""Gravação de edições no arquivo original, por formato."""

import csv
import shutil
from pathlib import Path

import pandas as pd

from .files import detect_csv


def _coerce(value: str):
    """Converte o texto editado para o tipo mais natural ao gravar em planilha."""
    if value == "":
        return None
    try:
        return int(value)
    except ValueError:
        pass
    try:
        return float(value)
    except ValueError:
        pass
    return value


def _backup(path: Path) -> None:
    bak = path.with_name(path.name + ".bak")
    if not bak.exists():
        shutil.copy2(path, bak)


def apply_edits(path: Path, sheet: str | None, has_header: bool,
                edits: list[dict]) -> dict:
    """Aplica edições {row, col, value} no arquivo original.

    `row` é o índice 0-based na área de dados (sem contar o cabeçalho).
    Retorna {"saved_path": str, "warnings": [str]}.
    """
    ext = path.suffix.lower()
    offset = 1 if has_header else 0
    warnings: list[str] = []

    if ext == ".csv":
        _backup(path)
        encoding, delimiter = detect_csv(path)
        with open(path, newline="", encoding=encoding) as f:
            rows = [list(r) for r in csv.reader(f, delimiter=delimiter)]
        for e in edits:
            r, c = e["row"] + offset, e["col"]
            while len(rows) <= r:
                rows.append([])
            while len(rows[r]) <= c:
                rows[r].append("")
            rows[r][c] = e["value"]
        with open(path, "w", newline="", encoding=encoding) as f:
            csv.writer(f, delimiter=delimiter).writerows(rows)
        return {"saved_path": str(path), "warnings": warnings}

    if ext == ".xlsx":
        import openpyxl

        _backup(path)
        wb = openpyxl.load_workbook(path)
        ws = wb[sheet] if sheet else wb.active
        for e in edits:
            ws.cell(row=e["row"] + offset + 1, column=e["col"] + 1,
                    value=_coerce(e["value"]))
        wb.save(path)
        return {"saved_path": str(path), "warnings": warnings}

    if ext in (".ods", ".xls"):
        # Formatos regravados por completo via pandas (dados de todas as abas
        # preservados; formatação visual não).
        all_sheets = pd.read_excel(
            path, sheet_name=None, header=None, dtype=object,
            keep_default_na=False, na_values=[],
        )
        target = sheet if sheet in all_sheets else next(iter(all_sheets))
        df = all_sheets[target]
        for e in edits:
            r, c = e["row"] + offset, e["col"]
            while df.shape[0] <= r:
                df.loc[df.shape[0]] = [None] * df.shape[1]
            while df.shape[1] <= c:
                df[df.shape[1]] = None
            df.iat[r, c] = _coerce(e["value"])
            all_sheets[target] = df

        if ext == ".ods":
            _backup(path)
            out_path = path
            warnings.append(
                "Arquivo .ods regravado: os dados de todas as abas foram "
                "preservados, mas a formatação visual foi perdida."
            )
        else:
            out_path = path.with_suffix(".xlsx")
            warnings.append(
                "Arquivos .xls (formato legado) não podem ser regravados com "
                f"segurança: as edições foram salvas em '{out_path.name}', ao "
                "lado do original, que não foi alterado."
            )

        engine = "odf" if ext == ".ods" else "openpyxl"
        with pd.ExcelWriter(out_path, engine=engine) as writer:
            for name, sdf in all_sheets.items():
                sdf.to_excel(writer, sheet_name=name, header=False, index=False)
        return {"saved_path": str(out_path), "warnings": warnings}

    raise ValueError(f"Formato não suportado para gravação: {ext}")
