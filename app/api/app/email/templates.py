"""Transactional emails (ARC-05): verification and password reset, bilingual EN + VI. Pure.

Links carry the token in the URL fragment (``#token=``): fragments are never sent to a server,
so the token does not end up in web-server or proxy access logs. The web app posts it to the API.
"""

from dataclasses import dataclass
from html import escape


@dataclass(frozen=True)
class EmailMessage:
    subject: str
    text: str
    html: str


def action_link(web_origin: str, path: str, token: str) -> str:
    return f"{web_origin.rstrip('/')}/{path.lstrip('/')}#token={token}"


def _render(
    subject: str, en: tuple[str, str, str], vi: tuple[str, str, str], link: str
) -> EmailMessage:
    (en_intro, en_button, en_note), (vi_intro, vi_button, vi_note) = en, vi
    text = f"{en_intro}\n\n{link}\n\n{en_note}\n\n----\n\n{vi_intro}\n\n{link}\n\n{vi_note}\n"
    href = escape(link, quote=True)

    def block(intro: str, button: str, note: str) -> str:
        return (
            f"<p>{escape(intro)}</p>"
            f'<p><a href="{href}">{escape(button)}</a></p>'
            f'<p style="color:#666;font-size:13px">{escape(note)}</p>'
        )

    html = (
        '<!doctype html><html><body style="font-family:sans-serif">'
        f"{block(en_intro, en_button, en_note)}<hr>{block(vi_intro, vi_button, vi_note)}"
        "</body></html>"
    )
    return EmailMessage(subject, text, html)


def verification_email(link: str) -> EmailMessage:
    return _render(
        "Verify your Ricotdin email / Xác minh email Ricotdin",
        (
            "Welcome to Ricotdin. Confirm your email address to finish creating your account.",
            "Verify email",
            "The link expires in 24 hours. If you did not sign up, ignore this email.",
        ),
        (
            "Chào mừng bạn đến với Ricotdin. Xác minh email để hoàn tất tạo tài khoản.",
            "Xác minh email",
            "Liên kết hết hạn sau 24 giờ. Nếu bạn không đăng ký, hãy bỏ qua email này.",
        ),
        link,
    )


def reset_password_email(link: str) -> EmailMessage:
    return _render(
        "Reset your Ricotdin password / Đặt lại mật khẩu Ricotdin",
        (
            "Someone asked to reset the password of your Ricotdin account.",
            "Choose a new password",
            "The link expires in 1 hour. If it was not you, ignore this email; "
            "your password stays the same.",
        ),
        (
            "Có yêu cầu đặt lại mật khẩu cho tài khoản Ricotdin của bạn.",
            "Đặt mật khẩu mới",
            "Liên kết hết hạn sau 1 giờ. Nếu không phải bạn, hãy bỏ qua email này; "
            "mật khẩu của bạn không thay đổi.",
        ),
        link,
    )
