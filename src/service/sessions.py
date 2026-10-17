"""Anonymous sessions for the live-test service (TB-039).

A visitor needs no account: the service issues a random bearer token on request (the website does it on first visit, the
CLI on first use). Only the token's SHA-256 is stored, with its expiry and a salted hash of the client address (for the
session-creation limit), never the token or the raw address. Runs are owned by a session; another session cannot see
them. A share token, created by the owner, grants read access to one run and can be revoked. A session can belong to an
account (src/service/accounts.py); the owner of its runs is then the account (u:<id>), so they follow the user across
sessions and devices."""
import hashlib, hmac, secrets, sqlite3, threading, time
from pathlib import Path
from typing import Optional


def digest(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


class SessionStore:
    def __init__(self, path: Path, ttl_s: int, token_bytes: int):
        self.path, self.ttl_s, self.token_bytes = path, ttl_s, token_bytes
        self.lock = threading.Lock()
        salt_file = path.with_suffix('.salt')
        if not salt_file.exists():
            salt_file.write_text(secrets.token_hex(32))
            salt_file.chmod(0o600)
        self.salt = salt_file.read_text().strip()
        with self._db() as db:
            db.execute('CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, created_at REAL, expires_at REAL, client_hash TEXT)')
            if 'user_id' not in {r['name'] for r in db.execute('PRAGMA table_info(sessions)')}:
                db.execute('ALTER TABLE sessions ADD COLUMN user_id TEXT')

    def _db(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        return db

    def client_hash(self, client: str) -> str:
        return hmac.new(self.salt.encode(), client.encode(), hashlib.sha256).hexdigest()

    def create(self, client: str, user_id: Optional[str] = None, ttl_s: Optional[int] = None) -> tuple[str, float]:
        token = secrets.token_urlsafe(self.token_bytes)
        t = time.time()
        expires = t + (ttl_s or self.ttl_s)
        with self.lock, self._db() as db:
            db.execute('INSERT INTO sessions (token_hash, created_at, expires_at, client_hash, user_id) VALUES (?,?,?,?,?)', (digest(token), t, expires, self.client_hash(client), user_id))
        return token, expires

    def info(self, token: Optional[str]) -> Optional[dict]:
        """{'owner', 'session', 'user_id'} for a valid, unexpired session, or None. The owner is u:<user id> for an
        account session and the token's hash for a guest."""
        if not token or len(token) > 256:
            return None
        h = digest(token)
        with self._db() as db:
            row = db.execute('SELECT expires_at, user_id FROM sessions WHERE token_hash=?', (h,)).fetchone()
        if not row or row['expires_at'] <= time.time():
            return None
        return {'owner': f"u:{row['user_id']}" if row['user_id'] else h, 'session': h, 'user_id': row['user_id']}

    def owner(self, token: Optional[str]) -> Optional[str]:
        i = self.info(token)
        return i['owner'] if i else None

    def delete_for_user(self, user_id: str):
        with self.lock, self._db() as db:
            db.execute('DELETE FROM sessions WHERE user_id=?', (user_id,))

    def recent_for_client(self, client: str, window_s: int) -> int:
        with self._db() as db:
            return db.execute('SELECT COUNT(*) FROM sessions WHERE client_hash=? AND created_at>?', (self.client_hash(client), time.time() - window_s)).fetchone()[0]

    def delete(self, owner: str):
        with self.lock, self._db() as db:
            db.execute('DELETE FROM sessions WHERE token_hash=?', (owner,))

    def expired(self, now: Optional[float] = None) -> list[dict]:
        with self._db() as db:
            return [dict(r) for r in db.execute('SELECT token_hash, user_id FROM sessions WHERE expires_at<=?', (now or time.time(),))]

    def all_rows(self) -> list[dict]:
        with self._db() as db:
            return [dict(r) for r in db.execute('SELECT * FROM sessions')]
