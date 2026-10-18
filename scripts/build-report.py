#!/usr/bin/env python3
"""TB-047: build the technical report from stored artifacts (configs/report.yaml).

research/report.template.md is prose with placeholders {{source:path|format}}. Every number in the report comes from a
placeholder that reads a committed artifact; the build fails if the template's own text carries a digit or a number word
outside the allowed identifier patterns (task, amendment and source IDs, holdout names, ISO dates), if a cited path or link
target does not exist, or if a forbidden overclaiming phrase appears. Writes research/report.md and the claim ledger
research/report-claims.json (each claim: source file, path, raw value, rendered text, report line).

  build-report.py            build
  build-report.py --check    build in memory and fail if the committed report or ledger differs"""
import csv, json, os, re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CFG = json.loads((ROOT / 'configs/report.yaml').read_text())
PH = re.compile(r'\{\{([a-z0-9_]+):([^|}]*)\|([a-z0-9_]+)\}\}')
_cache: dict = {}
# The technical report (TB-047) and every further document built the same way (configs/report.yaml extra_documents).
DOCS = [{'task_id': 'TB-047', 'template': CFG['template'], 'report': CFG['report'], 'claims': CFG['claims']}, *CFG.get('extra_documents', [])]


def load(alias: str):
    if alias not in _cache:
        spec = CFG['sources'][alias]
        path = ROOT / spec['file']
        kind = spec.get('kind', 'json')
        if kind == 'json':
            _cache[alias] = json.loads(path.read_text())
        elif kind == 'jsonl':
            _cache[alias] = [json.loads(l) for l in path.read_text().splitlines() if l.strip()]
        elif kind == 'csv':
            with open(path, newline='') as f:
                _cache[alias] = list(csv.DictReader(f))
        else:
            raise SystemExit(f'unknown source kind {kind}')
    return _cache[alias]


def split_path(path: str) -> list[str]:
    parts, buf, depth = [], '', 0
    for ch in path:
        if ch == '<' and depth == 0:  # <literal.key>: a key that itself contains dots
            if buf:
                parts.append(buf); buf = ''
            depth = -1; continue
        if depth == -1:
            if ch == '>':
                parts.append('<' + buf + '>'); buf = ''; depth = 0
            else:
                buf += ch
            continue
        if ch == '[':
            if buf:
                parts.append(buf); buf = ''
            depth += 1; buf += ch
        elif ch == ']':
            depth -= 1; buf += ch; parts.append(buf); buf = ''
        elif ch == '.' and depth == 0:
            if buf:
                parts.append(buf); buf = ''
        else:
            buf += ch
    if buf:
        parts.append(buf)
    return parts


def resolve(value, path: str):
    for part in split_path(path):
        if part.startswith('<') and part.endswith('>'):
            value = value[part[1:-1]]
        elif part == '#count':
            value = len(value)
        elif part.startswith('[') and part.endswith(']'):
            inner = part[1:-1]
            if inner.startswith('distinct:'):
                value = sorted({x[inner.split(':', 1)[1]] for x in value})
            elif inner.startswith(('where:', 'except:')):
                op, rest = inner.split(':', 1)
                k, v = rest.split('=', 1)
                value = [x for x in value if (str(x.get(k)) == v) == (op == 'where')]
            elif '=' in inner:
                k, v = inner.split('=', 1)
                hits = [x for x in value if str(x.get(k)) == v]
                if len(hits) != 1:
                    raise KeyError(f'selector {part} matched {len(hits)} items')
                value = hits[0]
            else:
                value = value[int(inner)]
        else:
            value = value[part]
    return value


def fmt(v, f: str) -> str:
    if f == 'raw':
        return str(v)
    if f == 'int':
        return f'{int(v):,}' if int(v) >= 10000 else str(int(v))
    if f == 'pp':      # a fraction difference, signed percentage points
        return f'{v * 100:+.1f} pp'
    if f == 'ppv':     # already in percentage points
        return f'{v:+.1f} pp'
    if f == 'ci':      # a fraction interval, signed percentage points
        return f'[{v[0] * 100:+.1f}, {v[1] * 100:+.1f}]'
    if f == 'civ':     # an interval already in percentage points
        return f'[{v[0]:+.1f}, {v[1]:+.1f}]'
    if f == 'pct':
        return f'{v * 100:.1f}%'
    if f == 'pctint':
        return f'{round(v * 100)}%'
    if f == 'wilson':
        return f'[{v[0] * 100:.1f}%, {v[1] * 100:.1f}%]'
    if f == 's':       # milliseconds as seconds
        return f'{v / 1000:.1f} s'
    if f == 'sec':     # seconds
        return f'{v:.1f} s'
    if f == 'f1':
        return f'{v:.1f}'
    if f == 'f2':
        return f'{v:.2f}'
    if f == 'f3':
        return f'{v:.3f}'
    if f == 'mean':    # a signed mean difference
        return f'{v:+,.0f}'
    if f == 'cimean':
        return f'[{v[0]:+,.0f}, {v[1]:+,.0f}]'
    if f == 'list':
        return '; '.join(str(x) for x in v)
    if f == 'mmss':    # seconds as m:ss
        return f'{int(v) // 60}:{int(v) % 60:02d}'
    if f == 'kappa':
        return f'{v:.2f}'
    raise SystemExit(f'unknown format {f}')


def blank_fences(text: str) -> str:
    out, inside = [], False
    for line in text.splitlines():
        if line.strip().startswith('```'):
            inside = not inside
            out.append('')
        else:
            out.append('' if inside else line)
    return '\n'.join(out)


def lint(template: str, doc: dict | None = None) -> list[str]:
    doc = doc or DOCS[0]
    problems = []
    prose = PH.sub(' ', template)
    prose = blank_fences(prose)  # fenced blocks (diagrams, commands) are code, not claims; line numbers are kept
    prose_no_code = re.sub(r'`[^`]*`', ' ', prose)
    prose_no_code = re.sub(r'\]\([^)]*\)', ']', prose_no_code)   # link targets are paths, not claims
    allowed = [re.compile(p) for p in CFG['allowed_identifier_patterns']]
    for n, line in enumerate(prose_no_code.splitlines(), 1):
        stripped = line
        for rx in allowed:
            stripped = rx.sub(' ', stripped)
        if re.search(r'\d', stripped):
            problems.append(f'template line {n}: a literal digit outside a placeholder or identifier: {line.strip()[:120]}')
        words = re.findall(r'\b(' + '|'.join(CFG['number_words']) + r')\b', stripped, flags=re.I)
        if words:
            problems.append(f'template line {n}: number word {words} outside a placeholder: {line.strip()[:120]}')
    for phrase in [f for f in CFG['forbidden_phrases'] if f not in doc.get('forbidden_phrases_exempt', [])]:
        if re.search(phrase, template, flags=re.I):
            problems.append(f'forbidden overclaiming phrase: {phrase}')
    for target in re.findall(r'\]\(([^)#]+)(?:#[^)]*)?\)', template) + re.findall(r'`((?:[\w.-]+/)+[\w.-]+\.[a-z]{2,5})`', template):
        if target.startswith(('http', '{{')) or target in {Path(d['claims']).name for d in DOCS}:  # ledgers are written by this build; placeholders render to URLs
            continue
        p = (ROOT / doc['report']).parent / target if not (ROOT / target).exists() else ROOT / target
        if not p.exists():
            problems.append(f'cited path does not exist: {target}')
    return problems


def render(doc: dict | None = None) -> tuple[str, list[dict]]:
    doc = doc or DOCS[0]
    template = (ROOT / doc['template']).read_text()
    problems = lint(template, doc)
    claims, out_lines = [], []
    for n, line in enumerate(template.splitlines(), 1):
        def sub(m):
            alias, path, f = m.groups()
            try:
                raw = resolve(load(alias), path)
            except (KeyError, IndexError, TypeError, ValueError) as e:
                problems.append(f'template line {n}: {alias}:{path} does not resolve ({e})')
                return '??'
            text = fmt(raw, f)
            claims.append({'id': len(claims) + 1, 'source': CFG['sources'][alias]['file'], 'path': path, 'format': f,
                           'value': raw if isinstance(raw, (int, float, str, list)) else str(raw), 'rendered': text, 'template_line': n})
            return text
        out_lines.append(PH.sub(sub, line))
    if problems:
        sys.exit(f"{doc['report']} build failed:\n  " + '\n  '.join(problems))
    report = '\n'.join(out_lines) + '\n'
    leftover = [n for n, l in enumerate(out_lines, 1) if '{{' in l or '}}' in l]
    if leftover:
        sys.exit(f'report build failed: unrendered placeholder on report lines {leftover}')
    report_lines = report.splitlines()
    for c in claims:  # locate each claim in the rendered report (the template and report line numbers coincide)
        c['report_line'] = c['template_line']
        assert c['rendered'] in report_lines[c['report_line'] - 1]
    return report, claims


def content_hash(src: str) -> str:
    import hashlib
    raw = (ROOT / src).read_bytes()
    if src.endswith('.json') or src.endswith('.yaml'):
        try:
            obj = json.loads(raw)
        except json.JSONDecodeError:
            return hashlib.sha256(raw).hexdigest()
        if isinstance(obj, dict):
            obj = {k: v for k, v in obj.items() if k not in CFG['content_hash_ignores_keys']}
        raw = json.dumps(obj, sort_keys=True).encode()
    return hashlib.sha256(raw).hexdigest()


def build(doc: dict) -> tuple[str, str]:
    report, claims = render(doc)
    if doc.get('claim_table'):  # TB-052: each number with the run or report it comes from, in the document itself
        rows = ['', '## Claim-to-evidence table', '', 'Every number above, the file it is read from and its path in that file.', '',
                '| Value | Source | Path |', '| --- | --- | --- |']
        start = len(report.splitlines()) + len(rows)
        for i, c in enumerate(claims, 1):
            rows.append(f"| {c['rendered']} | [`{c['source']}`]({os.path.relpath(ROOT / c['source'], (ROOT / doc['report']).parent)}) | `{c['path']}` |")
            c['table_line'] = start + i
        report = report + '\n'.join(rows) + '\n'
    sources = {src: content_hash(src) for src in sorted({c['source'] for c in claims})}
    ledger = json.dumps({'task_id': doc['task_id'], 'report': doc['report'], 'claims': len(claims),
                         'sources_content_sha256': sources, 'content_hash_note': CFG['content_hash_note'], 'items': claims}, indent=1) + '\n'
    return report, ledger


def main():
    out, stale = {}, []
    for doc in DOCS:
        report, ledger = build(doc)
        for path, text in ((doc['report'], report), (doc['claims'], ledger)):
            if '--check' in sys.argv:
                if not (ROOT / path).exists() or (ROOT / path).read_text() != text:
                    stale.append(path)
            else:
                (ROOT / path).write_text(text)
        out[doc['report']] = json.loads(ledger)['claims']
    if stale:
        sys.exit(f'out of date (run scripts/build-report.py): {stale}')
    print(json.dumps({'ok': True, 'claims': out}))


if __name__ == '__main__':
    main()
