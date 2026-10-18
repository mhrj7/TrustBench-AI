#!/usr/bin/env python3
"""TB-048: no novelty, security-guarantee, publication or résumé claim in the project's public text exceeds the evidence.

Scans the tracked public text named in configs/claims.yaml for overclaim phrases. Every hit must match an allowlist entry
(file, a substring of the line, a reason: a negation, a description of another work, or a technical sense of the word);
an unmatched hit or a stale allowlist entry fails. Files under portfolio/ (TB-052) may only use numbers that the claim
ledgers resolve from stored artifacts. Writes research/claims-check.json.

  check-claims.py"""
import fnmatch, json, re, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CFG = json.loads((ROOT / 'configs/claims.yaml').read_text())


def tracked() -> list[str]:
    return subprocess.run(['git', 'ls-files', '--cached', '--others', '--exclude-standard'], cwd=ROOT, capture_output=True, text=True, check=True).stdout.split('\n')


def targets() -> list[str]:
    files = [f for f in tracked() if f and any(fnmatch.fnmatch(f, p) for p in CFG['scan'])]
    return sorted(f for f in files if not any(fnmatch.fnmatch(f, p) for p in CFG['exclude']))


def scan():
    rx = {kind: re.compile('|'.join(f'(?:{p})' for p in pats), re.I) for kind, pats in CFG['patterns'].items()}
    hits = []
    for f in targets():
        for n, line in enumerate((ROOT / f).read_text(errors='replace').splitlines(), 1):
            for kind, r in rx.items():
                for m in r.finditer(line):
                    hits.append({'file': f, 'line': n, 'kind': kind, 'match': m.group(0), 'text': line.strip()})
    return hits


def portfolio_numbers() -> list[str]:
    allowed = set()
    for ledger in CFG['ledgers']:
        for c in json.loads((ROOT / ledger).read_text())['items']:
            allowed |= set(re.findall(r'[-+]?\d[\d,]*(?:\.\d+)?', c['rendered']))
    problems = []
    for f in tracked():
        if f.startswith('portfolio/') and f.endswith('.md'):
            for n, line in enumerate((ROOT / f).read_text().splitlines(), 1):
                for num in re.findall(r'(?<![\w-])[-+]?\d[\d,]*(?:\.\d+)?', re.sub(r'\b(TB|A|RW|M)-?\d+\b|\b\d{4}-\d{2}-\d{2}\b', ' ', line)):
                    if num not in allowed:
                        problems.append(f'{f}:{n}: number {num} is not in a claim ledger')
    return problems


def main():
    hits = scan()
    allow = CFG['allow']
    used, unmatched = set(), []
    for h in hits:
        entry = next((i for i, a in enumerate(allow) if a['file'] == h['file'] and a['contains'] in h['text']), None)
        if entry is None:
            unmatched.append(h)
        else:
            used.add(entry); h['allowed_because'] = allow[entry]['reason']
    stale = [a for i, a in enumerate(allow) if i not in used]
    portfolio = portfolio_numbers()
    out = {'task_id': 'TB-048', 'files_scanned': len(targets()), 'hits': len(hits), 'allowed': len(hits) - len(unmatched),
           'unmatched': unmatched, 'stale_allow_entries': stale, 'portfolio_problems': portfolio,
           'portfolio_files': sorted(f for f in tracked() if f.startswith('portfolio/')),
           'ok': not unmatched and not stale and not portfolio, 'allowed_hits': [h for h in hits if 'allowed_because' in h]}
    (ROOT / CFG['output']).write_text(json.dumps(out, indent=1) + '\n')
    print(json.dumps({k: out[k] for k in ('ok', 'files_scanned', 'hits', 'allowed')} | {'unmatched': len(unmatched), 'stale': len(stale), 'portfolio_problems': len(portfolio)}))
    for h in unmatched:
        print(f"UNMATCHED {h['kind']}: {h['file']}:{h['line']}: {h['match']!r} in: {h['text'][:200]}")
    for a in stale:
        print(f"STALE allow entry: {a['file']}: {a['contains']}")
    for p in portfolio:
        print('PORTFOLIO', p)
    sys.exit(0 if out['ok'] else 1)


if __name__ == '__main__':
    main()
