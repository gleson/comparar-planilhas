"""Motor de comparação: normalização, ordenação, alinhamento e diff."""

import re
from collections import defaultdict, deque

# número com decimal por vírgula, opcionalmente milhar por ponto: 1.234,56 / 1,5
_RE_BR_NUM = re.compile(r"^-?\d{1,3}(\.\d{3})+(,\d+)?$|^-?\d+(,\d+)?$")


def parse_number(s: str) -> float | None:
    s = s.strip()
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        pass
    if _RE_BR_NUM.match(s):
        try:
            return float(s.replace(".", "").replace(",", "."))
        except ValueError:
            return None
    return None


def make_normalizer(opts: dict):
    ignore_case = opts.get("ignore_case", False)
    ignore_space = opts.get("ignore_space", False)
    ignore_numfmt = opts.get("ignore_numfmt", False)

    def normalize(value: str) -> str:
        v = value
        if ignore_space:
            v = " ".join(v.split())
        else:
            v = v.strip()
        if ignore_numfmt:
            n = parse_number(v)
            if n is not None:
                return repr(n)
        if ignore_case:
            v = v.casefold()
        return v

    return normalize


def _sort_key(row: list[str], cols: list[int]):
    key = []
    for c in cols:
        v = row[c] if c < len(row) else ""
        n = parse_number(v)
        if n is not None:
            key.append((0, n, ""))
        else:
            key.append((1, 0.0, v.casefold()))
    return tuple(key)


def excel_col_name(i: int) -> str:
    name = ""
    i += 1
    while i > 0:
        i, rem = divmod(i - 1, 26)
        name = chr(65 + rem) + name
    return name


def compare(rows_a: list[list[str]], rows_b: list[list[str]], options: dict) -> dict:
    """Compara duas matrizes de strings e retorna o modelo unificado do diff.

    options: has_header, mode ('position'|'key'), key_cols,
             sort_cols_a / sort_cols_b (ou sort_cols para os dois lados),
             ignore_case, ignore_space, ignore_numfmt
    """
    has_header = options.get("has_header", True)
    mode = options.get("mode", "position")
    key_cols = options.get("key_cols") or []
    sort_cols = options.get("sort_cols") or []
    sort_a = options.get("sort_cols_a")
    sort_b = options.get("sort_cols_b")
    sort_a = sort_cols if sort_a is None else sort_a
    sort_b = sort_cols if sort_b is None else sort_b
    normalize = make_normalizer(options)

    header_a = rows_a[0] if has_header and rows_a else []
    header_b = rows_b[0] if has_header and rows_b else []
    data_a = rows_a[1:] if has_header else list(rows_a)
    data_b = rows_b[1:] if has_header else list(rows_b)

    n_cols = max(
        len(header_a), len(header_b),
        max((len(r) for r in data_a), default=0),
        max((len(r) for r in data_b), default=0),
    )

    def pad(row):
        return row + [""] * (n_cols - len(row))

    header_a, header_b = pad(header_a), pad(header_b)

    headers = []
    for c in range(n_cols):
        label = header_a[c] if has_header and header_a[c] else ""
        if not label and has_header and header_b[c]:
            label = header_b[c]
        headers.append(label or excel_col_name(c))

    header_mismatch = has_header and any(
        normalize(header_a[c]) != normalize(header_b[c]) for c in range(n_cols)
    )

    # índice original (posição na área de dados do arquivo) acompanha a linha
    indexed_a = [(i, pad(r)) for i, r in enumerate(data_a)]
    indexed_b = [(i, pad(r)) for i, r in enumerate(data_b)]

    if sort_a:
        indexed_a.sort(key=lambda t: _sort_key(t[1], sort_a))
    if sort_b:
        indexed_b.sort(key=lambda t: _sort_key(t[1], sort_b))

    # Alinhamento -> lista de pares ((a_idx, a_row) | None, (b_idx, b_row) | None)
    pairs = []
    if mode == "key" and key_cols:
        def key_of(row):
            return tuple(normalize(row[c]) if c < len(row) else "" for c in key_cols)

        b_by_key: dict[tuple, deque] = defaultdict(deque)
        for i, r in indexed_b:
            b_by_key[key_of(r)].append((i, r))
        for i, r in indexed_a:
            bucket = b_by_key.get(key_of(r))
            if bucket:
                pairs.append(((i, r), bucket.popleft()))
            else:
                pairs.append(((i, r), None))
        for key, bucket in b_by_key.items():
            for item in bucket:
                pairs.append((None, item))
    else:
        la, lb = len(indexed_a), len(indexed_b)
        for i in range(max(la, lb)):
            pairs.append((
                indexed_a[i] if i < la else None,
                indexed_b[i] if i < lb else None,
            ))

    rows = []
    diffs = []
    diff_cells = 0
    only_a = only_b = 0
    for u, (pa, pb) in enumerate(pairs):
        if pa and pb:
            (ia, ra), (ib, rb) = pa, pb
            diff_cols = [c for c in range(n_cols) if normalize(ra[c]) != normalize(rb[c])]
            status = "matched"
            diff_cells += len(diff_cols)
            for c in diff_cols:
                diffs.append({"row": u, "col": c})
            rows.append({"i": u, "status": status, "a_idx": ia, "b_idx": ib,
                         "a": ra, "b": rb, "diff_cols": diff_cols})
        elif pa:
            ia, ra = pa
            only_a += 1
            diffs.append({"row": u, "col": None})
            rows.append({"i": u, "status": "only_a", "a_idx": ia, "b_idx": None,
                         "a": ra, "b": None, "diff_cols": []})
        else:
            ib, rb = pb
            only_b += 1
            diffs.append({"row": u, "col": None})
            rows.append({"i": u, "status": "only_b", "a_idx": None, "b_idx": ib,
                         "a": None, "b": rb, "diff_cols": []})

    return {
        "headers": headers,
        "n_cols": n_cols,
        "has_header": has_header,
        "rows": rows,
        "diffs": diffs,
        "summary": {
            "diff_cells": diff_cells,
            "rows_only_a": only_a,
            "rows_only_b": only_b,
            "rows_total": len(rows),
            "rows_a": len(data_a),
            "rows_b": len(data_b),
            "header_mismatch": header_mismatch,
            "diff_count": len(diffs),
        },
    }
