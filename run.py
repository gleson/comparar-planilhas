#!/usr/bin/env python3
"""Inicia o Compara Planilhas (Linux/Windows).

Na primeira execução cria o ambiente virtual, instala as dependências e baixa
o AG Grid. Depois inicia o servidor local e abre o navegador.

Uso: python run.py [--port 8765]
"""

import argparse
import subprocess
import sys
import threading
import urllib.request
import venv
import webbrowser
from pathlib import Path

BASE = Path(__file__).resolve().parent
VENV = BASE / ".venv"
VENDOR = BASE / "static" / "vendor"

AG_GRID_VERSION = "31.3.4"
VENDOR_FILES = {
    "ag-grid-community.min.js":
        f"https://cdn.jsdelivr.net/npm/ag-grid-community@{AG_GRID_VERSION}/dist/ag-grid-community.min.js",
    "ag-grid.css":
        f"https://cdn.jsdelivr.net/npm/ag-grid-community@{AG_GRID_VERSION}/styles/ag-grid.css",
    "ag-theme-quartz.css":
        f"https://cdn.jsdelivr.net/npm/ag-grid-community@{AG_GRID_VERSION}/styles/ag-theme-quartz.css",
}


def venv_python() -> Path:
    if sys.platform == "win32":
        return VENV / "Scripts" / "python.exe"
    return VENV / "bin" / "python"


def ensure_venv() -> None:
    py = venv_python()
    if not py.exists():
        print("Criando ambiente virtual (.venv)…")
        venv.create(VENV, with_pip=True)
    check = subprocess.run(
        [str(py), "-c", "import fastapi, uvicorn, pandas, openpyxl, xlrd, odf"],
        capture_output=True,
    )
    if check.returncode != 0:
        print("Instalando dependências…")
        subprocess.run(
            [str(py), "-m", "pip", "install", "-q", "-r",
             str(BASE / "requirements.txt")],
            check=True,
        )


def ensure_vendor() -> None:
    VENDOR.mkdir(parents=True, exist_ok=True)
    for name, url in VENDOR_FILES.items():
        dest = VENDOR / name
        if dest.exists():
            continue
        print(f"Baixando {name}…")
        try:
            urllib.request.urlretrieve(url, dest)
        except Exception as e:
            sys.exit(f"Falha ao baixar {url}: {e}\n"
                     "Verifique sua conexão com a internet e tente de novo.")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true",
                        help="não abrir o navegador automaticamente")
    args = parser.parse_args()

    ensure_venv()
    ensure_vendor()

    url = f"http://localhost:{args.port}"
    if not args.no_browser:
        threading.Timer(1.5, lambda: webbrowser.open(url)).start()
    print(f"Compara Planilhas em {url}  (Ctrl+C para encerrar)")
    subprocess.run(
        [str(venv_python()), "-m", "uvicorn", "app.main:app",
         "--host", "127.0.0.1", "--port", str(args.port)],
        cwd=BASE,
    )


if __name__ == "__main__":
    main()
