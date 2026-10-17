"""Accounts for the live-test service (TB-039): sign-up, email verification, sign-in, password reset and change, deletion.

Guests need none of this (src/service/sessions.py); an account keeps runs across devices for longer and, once its email is
verified, gets higher quotas. Passwords are hashed with scrypt (a random salt per password, parameters stored with the
hash) and compared in constant time; plain passwords are never stored or logged. Verification and reset tokens are random,
single-use, short-lived and stored only as SHA-256 hashes. Failed sign-ins lock the account for a while. Responses never
reveal whether an email address has an account."""
import hashlib, hmac, re, secrets, sqlite3, threading, time
from pathlib import Path
from typing import Any, Optional

EMAIL = re.compile(r'^[^@\s]{1,64}@[^@\s]{1,189}\.[A-Za-z]{2,}$')


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


class Accounts:
    def __init__(self, path: Path, cfg: dict[str, Any]):
        self.path, self.cfg = path, cfg
        self.lock = threading.Lock()
        with self._db() as db:
            db.execute('CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE, password_hash TEXT, verified INTEGER, created_at REAL, failed_logins INTEGER DEFAULT 0, locked_until REAL DEFAULT 0)')
            db.execute('CREATE TABLE IF NOT EXISTS tokens (token_hash TEXT PRIMARY KEY, purpose TEXT, user_id TEXT, expires_at REAL)')

    def _db(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        return db

    # ---- passwords ------------------------------------------------------------------------------------------------------
    def hash_password(self, password: str) -> str:
        p = self.cfg['scrypt']
        salt = secrets.token_bytes(16)
        dk = hashlib.scrypt(password.encode(), salt=salt, n=p['n'], r=p['r'], p=p['p'], maxmem=p['maxmem'], dklen=32)
        return f"scrypt${p['n']}${p['r']}${p['p']}${salt.hex()}${dk.hex()}"

    def check_password(self, password: str, stored: str) -> bool:
        try:
            _, n, r, p, salt, dk = stored.split('$')
            got = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=int(n), r=int(r), p=int(p), maxmem=self.cfg['scrypt']['maxmem'], dklen=32)
            return hmac.compare_digest(got.hex(), dk)
        except (ValueError, TypeError):
            return False

    def password_problem(self, password: str, email: str) -> Optional[str]:
        pol = self.cfg['password_policy']
        if not isinstance(password, str) or not pol['min_length'] <= len(password) <= pol['max_length']:
            return f"the password must be {pol['min_length']} to {pol['max_length']} characters"
        local = email.split('@')[0].lower()
        if len(local) >= 4 and local in password.lower():
            return 'the password must not contain your email name'
        if len(set(password)) < pol['min_distinct_characters']:
            return 'the password is too repetitive'
        return None

    # ---- users ----------------------------------------------------------------------------------------------------------
    @staticmethod
    def normalise(email: str) -> str:
        return (email or '').strip().lower()

    def by_email(self, email: str) -> Optional[dict]:
        with self._db() as db:
            row = db.execute('SELECT * FROM users WHERE email=?', (self.normalise(email),)).fetchone()
        return dict(row) if row else None

    def by_id(self, user_id: str) -> Optional[dict]:
        with self._db() as db:
            row = db.execute('SELECT * FROM users WHERE id=?', (user_id,)).fetchone()
        return dict(row) if row else None

    def create(self, email: str, password: str) -> dict:
        user = {'id': secrets.token_hex(12), 'email': self.normalise(email), 'password_hash': self.hash_password(password), 'verified': 0, 'created_at': time.time()}
        with self.lock, self._db() as db:
            db.execute('INSERT INTO users (id,email,password_hash,verified,created_at) VALUES (?,?,?,?,?)', tuple(user.values()))
        return user

    def authenticate(self, email: str, password: str) -> tuple[Optional[dict], str]:
        """(user, reason). Unknown email and wrong password give the same answer; a locked account says so only after the
        right password, so lockout cannot be used to probe which addresses exist."""
        user = self.by_email(email)
        if not user:
            self.check_password(password, self.hash_password('decoy-to-equalise-timing'))
            return None, 'wrong email or password'
        ok = self.check_password(password, user['password_hash'])
        now = time.time()
        if user['locked_until'] > now:
            return None, 'wrong email or password' if not ok else f"too many failed sign-ins: try again in {int((user['locked_until'] - now) // 60) + 1} minutes"
        with self.lock, self._db() as db:
            if ok:
                db.execute('UPDATE users SET failed_logins=0, locked_until=0 WHERE id=?', (user['id'],))
                return user, 'ok'
            failed = user['failed_logins'] + 1
            locked = now + self.cfg['lockout']['minutes'] * 60 if failed >= self.cfg['lockout']['max_failed'] else 0
            db.execute('UPDATE users SET failed_logins=?, locked_until=? WHERE id=?', (0 if locked else failed, locked, user['id']))
        return None, 'wrong email or password'

    def set_password(self, user_id: str, password: str):
        with self.lock, self._db() as db:
            db.execute('UPDATE users SET password_hash=?, failed_logins=0, locked_until=0 WHERE id=?', (self.hash_password(password), user_id))

    def mark_verified(self, user_id: str):
        with self.lock, self._db() as db:
            db.execute('UPDATE users SET verified=1 WHERE id=?', (user_id,))

    def delete(self, user_id: str):
        with self.lock, self._db() as db:
            db.execute('DELETE FROM tokens WHERE user_id=?', (user_id,))
            db.execute('DELETE FROM users WHERE id=?', (user_id,))

    # ---- single-use tokens (verification, reset) ------------------------------------------------------------------------
    def issue(self, purpose: str, user_id: str) -> str:
        token = secrets.token_urlsafe(32)
        with self.lock, self._db() as db:
            db.execute('DELETE FROM tokens WHERE user_id=? AND purpose=?', (user_id, purpose))  # one live token per purpose
            db.execute('INSERT INTO tokens VALUES (?,?,?,?)', (token_hash(token), purpose, user_id, time.time() + self.cfg['token_ttl_minutes'][purpose] * 60))
        return token

    def redeem(self, purpose: str, token: str) -> Optional[str]:
        """The user id for a valid, unexpired token of this purpose; the token is consumed either way."""
        if not token or len(token) > 256:
            return None
        h = token_hash(token)
        with self.lock, self._db() as db:
            row = db.execute('SELECT * FROM tokens WHERE token_hash=?', (h,)).fetchone()
            db.execute('DELETE FROM tokens WHERE token_hash=?', (h,))
        return row['user_id'] if row and row['purpose'] == purpose and row['expires_at'] > time.time() else None
