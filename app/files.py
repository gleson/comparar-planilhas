"""Leitura de planilhas (csv, xls, xlsx, ods) e utilitários de arquivo."""

import csv
import subprocess
import sys
from datetime import date, datetime, time
from pathlib import Path

import pandas as pd

SUPPORTED_EXTS = {".csv", ".xls", ".xlsx", ".ods"}

CSV_ENCODINGS = ["utf-8-sig", "utf-8", "cp1252", "latin-1"]


def file_type(path: str) -> str:
    return Path(path).suffix.lower().lstrip(".")


def validate_path(path: str) -> Path:
    p = Path(path).expanduser()
    if not p.is_file():
        raise ValueError(f"Arquivo não encontrado: {p}")
    if p.suffix.lower() not in SUPPORTED_EXTS:
        raise ValueError(
            f"Formato não suportado: '{p.suffix}'. Use csv, xls, xlsx ou ods."
        )
    return p


def pick_file_dialog() -> str | None:
    """Abre um diálogo nativo de seleção de arquivo (tkinter) em subprocesso.

    Retorna o caminho escolhido, "" se cancelado, ou None se o diálogo
    não estiver disponível (sem tkinter/ambiente gráfico).
    """
    code = (
        "import tkinter as tk\n"
        "from tkinter import filedialog\n"
        "r = tk.Tk(); r.withdraw(); r.attributes('-topmost', True)\n"
        "print(filedialog.askopenfilename(title='Selecione a planilha',"
        " filetypes=[('Planilhas', '*.csv *.xls *.xlsx *.ods'), ('Todos', '*.*')]))"
    )
    try:
        proc = subprocess.run(
            [sys.executable, "-c", code],
            capture_output=True, text=True, timeout=600,
        )
    except Exception:
        return None
    if proc.returncode != 0:
        return None
    return proc.stdout.strip()


def detect_csv(path: Path) -> tuple[str, str]:
    """Detecta (encoding, delimitador) de um csv."""
    raw = path.read_bytes()
    encoding = "utf-8"
    for enc in CSV_ENCODINGS:
        try:
            raw.decode(enc)
            encoding = enc
            break
        except UnicodeDecodeError:
            continue
    sample = raw.decode(encoding, errors="replace")[:64 * 1024]
    try:
        delimiter = csv.Sniffer().sniff(sample, delimiters=",;\t|").delimiter
    except csv.Error:
        delimiter = ";" if sample.count(";") > sample.count(",") else ","
    return encoding, delimiter


def list_sheets(path: Path) -> list[str]:
    if path.suffix.lower() == ".csv":
        return []
    xl = pd.ExcelFile(path)
    try:
        return [str(s) for s in xl.sheet_names]
    finally:
        xl.close()


def fmt_cell(v) -> str:
    """Converte um valor de célula para o texto exibido."""
    if v is None:
        return ""
    if isinstance(v, float):
        if v != v:  # NaN
            return ""
        if v.is_integer() and abs(v) < 1e15:
            return str(int(v))
        return repr(v)
    if isinstance(v, bool):
        return "VERDADEIRO" if v else "FALSO"
    if isinstance(v, datetime):
        if v.hour == v.minute == v.second == 0 and v.microsecond == 0:
            return v.strftime("%d/%m/%Y")
        return v.strftime("%d/%m/%Y %H:%M:%S")
    if isinstance(v, (date, time)):
        return v.strftime("%d/%m/%Y") if isinstance(v, date) else v.strftime("%H:%M:%S")
    return str(v)


def load_table(path: Path, sheet: str | None) -> list[list[str]]:
    """Carrega uma aba como matriz de strings, com linhas de mesmo comprimento."""
    if path.suffix.lower() == ".csv":
        encoding, delimiter = detect_csv(path)
        with open(path, newline="", encoding=encoding) as f:
            rows = [list(r) for r in csv.reader(f, delimiter=delimiter)]
    else:
        df = pd.read_excel(
            path, sheet_name=sheet, header=None, dtype=object,
            keep_default_na=False, na_values=[],
        )
        rows = [[fmt_cell(v) for v in row] for row in df.itertuples(index=False)]

    n_cols = max((len(r) for r in rows), default=0)
    for r in rows:
        r.extend([""] * (n_cols - len(r)))
    # Remove linhas totalmente vazias no fim
    while rows and all(c == "" for c in rows[-1]):
        rows.pop()
    return rows
