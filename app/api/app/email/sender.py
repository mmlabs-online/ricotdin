"""Outgoing email (ARC-05). SMTP with implicit TLS (465) or STARTTLS (587); never logs bodies,
links or tokens."""

from dataclasses import dataclass, field
from email.message import EmailMessage as MimeMessage
from email.utils import formatdate, make_msgid
from typing import Protocol

import aiosmtplib

from app.core.settings import Settings
from app.email.templates import EmailMessage


class MailNotConfigured(RuntimeError):
    """SMTP is not configured; nothing was sent."""


class MailFailed(RuntimeError):
    """The SMTP server refused or could not be reached (detail is safe to log)."""


class Mailer(Protocol):
    async def send(self, to: str, message: EmailMessage) -> None: ...


@dataclass(frozen=True)
class SentMail:
    to: str
    subject: str
    text: str
    html: str


@dataclass
class MemoryMailer:
    """For tests: keeps every message."""

    outbox: list[SentMail] = field(default_factory=list)

    async def send(self, to: str, message: EmailMessage) -> None:
        self.outbox.append(SentMail(to, message.subject, message.text, message.html))


class NullMailer:
    async def send(self, to: str, message: EmailMessage) -> None:
        raise MailNotConfigured("SMTP_HOST is not set")


@dataclass(frozen=True)
class SmtpMailer:
    host: str
    port: int
    username: str | None
    password: str | None = field(repr=False)
    sender: str
    timeout: float = 15.0

    async def send(self, to: str, message: EmailMessage) -> None:
        mime = MimeMessage()
        mime["From"] = self.sender
        mime["To"] = to  # validated: no whitespace or control characters
        mime["Subject"] = message.subject
        mime["Date"] = formatdate(localtime=False)
        mime["Message-ID"] = make_msgid(domain=self.host)
        mime.set_content(message.text)
        mime.add_alternative(message.html, subtype="html")
        try:
            await aiosmtplib.send(
                mime,
                hostname=self.host,
                port=self.port,
                username=self.username,
                password=self.password,
                use_tls=self.port == 465,
                start_tls=self.port != 465,
                timeout=self.timeout,
            )
        except aiosmtplib.SMTPException as exc:
            raise MailFailed(type(exc).__name__) from None


def mailer_from_settings(settings: Settings) -> Mailer:
    if not settings.smtp_host:
        return NullMailer()
    sender = settings.mail_from or settings.smtp_user
    if not sender:
        raise ValueError("MAIL_FROM (or SMTP_USER) is required when SMTP_HOST is set")
    return SmtpMailer(
        host=settings.smtp_host,
        port=settings.smtp_port,
        username=settings.smtp_user,
        password=settings.smtp_password.get_secret_value() if settings.smtp_password else None,
        sender=sender,
    )
