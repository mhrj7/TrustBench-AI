"""Secret lookup for the live-test service (TB-039): one place that reads provider keys and service tokens.

Order: the environment variable NAME; a file named by NAME_FILE (how Docker, Kubernetes and most hosts mount secrets);
<mount dir>/<name> (Docker/Compose secrets); the project's .env (local development only). Values are never logged:
`RedactSecrets` is a logging filter that replaces every known secret value in any record with a placeholder."""
import logging, os
from pathlib import Path
from typing import Iterable, Optional

ROOT = Path(__file__).resolve().parents[2]
MOUNT_DIR = Path(os.environ.get('TRUSTBENCH_SECRETS_DIR', '/run/secrets'))
PLACEHOLDER = '[redacted secret]'
_known: set[str] = set()


def get(name: Optional[str]) -> Optional[str]:
    if not name:
        return None
    value = os.environ.get(name) or _from_file(os.environ.get(f'{name}_FILE')) or _from_file(MOUNT_DIR / name.lower()) or _from_dotenv(name)
    if value:
        remember(value)
    return value or None


def remember(value: Optional[str]):
    """Register a value (for example a visitor's key for the duration of one run) so log redaction covers it."""
    if value and len(value) >= 8:
        _known.add(value)


def forget(value: Optional[str]):
    _known.discard(value or '')


def known() -> Iterable[str]:
    return tuple(_known)


def _from_file(path) -> Optional[str]:
    try:
        return Path(path).read_text().strip() or None if path else None
    except OSError:
        return None


def _from_dotenv(name: str) -> Optional[str]:
    env = ROOT / '.env'
    if os.environ.get('TRUSTBENCH_NO_DOTENV') == '1' or not env.exists():  # tests and CI read no local keys
        return None
    for line in env.read_text().splitlines():
        if '=' in line and line.split('=', 1)[0].strip() == name:
            return line.split('=', 1)[1].strip().strip('"').strip("'") or None
    return None


def scrub(text: str) -> str:
    for value in sorted(_known, key=len, reverse=True):
        text = text.replace(value, PLACEHOLDER)
    return text


class RedactSecrets(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        message = record.getMessage()
        clean = scrub(message)
        if clean != message:
            record.msg, record.args = clean, ()
        return True


def install_log_redaction(names: Iterable[str] = ('', 'uvicorn', 'uvicorn.error', 'uvicorn.access', 'fastapi')):
    for name in names:
        logger = logging.getLogger(name)
        if not any(isinstance(f, RedactSecrets) for f in logger.filters):
            logger.addFilter(RedactSecrets())
        for handler in logger.handlers:
            if not any(isinstance(f, RedactSecrets) for f in handler.filters):
                handler.addFilter(RedactSecrets())
