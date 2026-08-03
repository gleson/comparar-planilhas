#!/usr/bin/env python3
"""Inicia o Compara Planilhas (Linux/Windows).

Na primeira execução cria o ambiente virtual, instala as dependências e baixa
o AG Grid. Depois inicia o servidor local e abre o navegador.

O .venv é criado com um Python dentro da faixa declarada em requirements.txt
(linha `# python_requires:`). Se o Python que executou este script estiver fora
dessa faixa — por exemplo uma versão alfa recém-baixada do python.org —, o
script procura um interpretador estável já instalado na máquina e usa esse.

Uso: python run.py [--port 8765]
"""

# Permite rodar sob interpretadores antigos até chegar na checagem de versão.
from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import sys
import threading
import urllib.request
import webbrowser
from pathlib import Path

BASE = Path(__file__).resolve().parent
VENV = BASE / ".venv"
VENDOR = BASE / "static" / "vendor"
REQUIREMENTS = BASE / "requirements.txt"

# Módulos que precisam existir no .venv (o app não usa pandas/numpy).
REQUIRED_IMPORTS = "import fastapi, uvicorn, openpyxl, xlrd, odf"

AG_GRID_VERSION = "31.3.4"
VENDOR_FILES = {
    "ag-grid-community.min.js":
        f"https://cdn.jsdelivr.net/npm/ag-grid-community@{AG_GRID_VERSION}/dist/ag-grid-community.min.js",
    "ag-grid.css":
        f"https://cdn.jsdelivr.net/npm/ag-grid-community@{AG_GRID_VERSION}/styles/ag-grid.css",
    "ag-theme-quartz.css":
        f"https://cdn.jsdelivr.net/npm/ag-grid-community@{AG_GRID_VERSION}/styles/ag-theme-quartz.css",
}

DEFAULT_RANGE = ((3, 10), (3, 15))  # usado se requirements.txt não declarar nada


# --------------------------------------------------------------------------
# Escolha do interpretador
# --------------------------------------------------------------------------

def python_range():
    """Lê `# python_requires: >=3.10,<3.15` do requirements.txt."""
    try:
        text = REQUIREMENTS.read_text(encoding="utf-8")
    except OSError:
        return DEFAULT_RANGE
    m = re.search(r"#\s*python_requires:\s*(.+)", text)
    if not m:
        return DEFAULT_RANGE
    low, high = DEFAULT_RANGE
    for part in m.group(1).split(","):
        v = re.match(r"(>=|<)\s*(\d+)\.(\d+)", part.strip())
        if not v:
            continue
        ver = (int(v.group(2)), int(v.group(3)))
        if v.group(1) == ">=":
            low = ver
        else:
            high = ver
    return low, high


LOW, HIGH = python_range()
RANGE_TXT = f"{LOW[0]}.{LOW[1]} a {HIGH[0]}.{HIGH[1] - 1}"


def version_ok(major, minor, releaselevel) -> bool:
    """Estável e dentro da faixa suportada."""
    return releaselevel == "final" and LOW <= (major, minor) < HIGH


def probe(python: str):
    """Devolve (major, minor, releaselevel) de um executável Python, ou None."""
    try:
        out = subprocess.run(
            [python, "-c",
             "import sys;print(sys.version_info[0], sys.version_info[1], "
             "sys.version_info[3])"],
            capture_output=True, text=True, timeout=30,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if out.returncode != 0:
        return None
    parts = out.stdout.split()
    if len(parts) != 3:
        return None
    try:
        return int(parts[0]), int(parts[1]), parts[2]
    except ValueError:
        return None


def candidate_pythons() -> list:
    """Interpretadores plausíveis na máquina, do mais novo para o mais antigo."""
    found = []
    versions = [(HIGH[0], m) for m in range(HIGH[1] - 1, LOW[1] - 1, -1)]

    if sys.platform == "win32":
        launcher = shutil.which("py")
        if launcher:
            # `py -0p` lista os interpretadores registrados e seus caminhos.
            try:
                out = subprocess.run([launcher, "-0p"], capture_output=True,
                                     text=True, timeout=30)
                for token in re.findall(r"[A-Za-z]:\\\S[^\r\n]*?python\.exe",
                                        out.stdout):
                    if token not in found:
                        found.append(token)
            except (OSError, subprocess.SubprocessError):
                pass
        local = os.environ.get("LOCALAPPDATA")
        if local:
            for major, minor in versions:
                exe = (Path(local) / "Programs" / "Python" /
                       f"Python{major}{minor}" / "python.exe")
                if exe.exists() and str(exe) not in found:
                    found.append(str(exe))
    else:
        for major, minor in versions:
            exe = shutil.which(f"python{major}.{minor}")
            if exe and exe not in found:
                found.append(exe)
        for name in ("python3", "python"):
            exe = shutil.which(name)
            if exe and exe not in found:
                found.append(exe)
    return found


def pick_python() -> str:
    """Escolhe um Python estável dentro da faixa suportada."""
    if version_ok(sys.version_info[0], sys.version_info[1],
                  sys.version_info[3]):
        return sys.executable

    atual = ".".join(str(p) for p in sys.version_info[:3])
    if sys.version_info[3] != "final":
        atual += f" ({sys.version_info[3]})"

    for exe in candidate_pythons():
        info = probe(exe)
        if info and version_ok(info[0], info[1], info[2]):
            print(f"Python {atual} não é suportado; "
                  f"usando o Python {info[0]}.{info[1]} de {exe}")
            return exe

    sys.exit(
        f"\nPython {atual} não é suportado por este programa.\n"
        f"Instale uma versão estável do Python na faixa {RANGE_TXT} "
        "(https://www.python.org/downloads/) e rode de novo.\n"
        "Versões alfa/beta ainda não têm pacotes prontos no PyPI: a instalação "
        "tentaria compilar o pydantic-core e falharia em máquinas sem o "
        "Visual Studio Build Tools."
    )


# --------------------------------------------------------------------------
# Ambiente virtual
# --------------------------------------------------------------------------

def venv_python() -> Path:
    if sys.platform == "win32":
        return VENV / "Scripts" / "python.exe"
    return VENV / "bin" / "python"


def ensure_venv() -> None:
    py = venv_python()

    if py.exists():
        info = probe(str(py))
        if info is None or not version_ok(info[0], info[1], info[2]):
            versao = f"{info[0]}.{info[1]}" if info else "desconhecida"
            print(f"O .venv atual usa Python {versao}, fora da faixa "
                  f"suportada ({RANGE_TXT}); recriando…")
            shutil.rmtree(VENV, ignore_errors=True)

    if not py.exists():
        base = pick_python()
        print("Criando ambiente virtual (.venv)…")
        subprocess.run([base, "-m", "venv", str(VENV)], check=True)

    check = subprocess.run([str(py), "-c", REQUIRED_IMPORTS],
                           capture_output=True)
    if check.returncode == 0:
        return

    print("Instalando dependências…")
    install = subprocess.run(
        [str(py), "-m", "pip", "install", "-q", "-r", str(REQUIREMENTS)])
    if install.returncode != 0:
        sys.exit(
            "\nFalha ao instalar as dependências.\n"
            "Verifique sua conexão com a internet. Se o erro acima citar "
            "compilação (pydantic-core, link.exe, Rust), apague a pasta .venv, "
            f"instale um Python estável na faixa {RANGE_TXT} e rode de novo."
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
