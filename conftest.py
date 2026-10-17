"""Repository-wide pytest settings. JUnit reports are committed as evidence, so they must not carry the machine they ran on:
after the junitxml plugin writes a report, its hostname attribute is replaced."""
import re
from pathlib import Path

import pytest

PLACEHOLDER = 'redacted'


@pytest.hookimpl(trylast=True)
def pytest_sessionfinish(session):
    xml = session.config.getoption('xmlpath', None)
    if xml and Path(xml).exists():
        text = Path(xml).read_text()
        Path(xml).write_text(re.sub(r'hostname="[^"]*"', f'hostname="{PLACEHOLDER}"', text))
