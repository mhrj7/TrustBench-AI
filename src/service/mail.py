"""Outgoing mail for account emails (TB-039). Two senders, chosen by configs/live-service.yaml accounts.mail:

- smtp: when the SMTP host secret is set (src/service/secrets.py), sent over STARTTLS with the configured credentials;
- outbox: otherwise, each message is written to <data dir>/outbox/ (local development, tests, and deployments without
  mail, where accounts still work but stay unverified).

Messages contain only the recipient, a subject and a link with a single-use token; never a password or provider key."""
import json, smtplib, ssl, time
from email.message import EmailMessage
from pathlib import Path
from typing import Any

from src.service import secrets as sec


class Mailer:
    def __init__(self, cfg: dict[str, Any], outbox: Path):
        self.cfg, self.outbox = cfg, outbox

    @property
    def mode(self) -> str:
        return 'smtp' if sec.get(self.cfg['smtp_host_secret']) else 'outbox'

    def send(self, to: str, subject: str, body: str) -> str:
        if self.mode == 'smtp':
            msg = EmailMessage()
            msg['From'], msg['To'], msg['Subject'] = sec.get(self.cfg['from_secret']) or self.cfg['default_from'], to, subject
            msg.set_content(body)
            with smtplib.SMTP(sec.get(self.cfg['smtp_host_secret']), int(sec.get(self.cfg['smtp_port_secret']) or self.cfg['default_smtp_port']), timeout=20) as s:
                s.starttls(context=ssl.create_default_context())
                user, password = sec.get(self.cfg['smtp_user_secret']), sec.get(self.cfg['smtp_password_secret'])
                if user and password:
                    s.login(user, password)
                s.send_message(msg)
            return 'smtp'
        self.outbox.mkdir(parents=True, exist_ok=True)
        (self.outbox / f'{time.time_ns()}.json').write_text(json.dumps({'to': to, 'subject': subject, 'body': body, 'at': time.time()}))
        return 'outbox'
