import io
import re
from django.conf import settings


class TemplateEngine:
    """Replace {{placeholder}} tags in a template string with context values."""

    def render(self, template_text, context):
        text = template_text or ''
        for key, value in context.items():
            text = text.replace('{{' + key + '}}', str(value) if value else '')
        text = re.sub(r'\{\{[a-zA-Z_]+\}\}', '', text)
        return text


class PDFGenerator:
    """Stub PDF generator — builds HTML and wraps it in a BytesIO buffer."""

    @staticmethod
    def build_full_html(template, context):
        engine = TemplateEngine()
        header = engine.render(getattr(template, 'pdf_header_html', '') or '', context)
        body = engine.render(getattr(template, 'pdf_body_html', '') or '', context)
        footer = engine.render(getattr(template, 'pdf_footer_html', '') or '', context)
        if not header and not body and not footer:
            body = engine.render(getattr(template, 'body_html', '') or '', context)
        return f'<html><body>{header}{body}{footer}</body></html>'

    @staticmethod
    def generate(full_html):
        buf = io.BytesIO(full_html.encode('utf-8'))
        buf.seek(0)
        return buf


def get_mailer(purpose='purchase', company_code=None):
    if company_code:
        env_key = f'{company_code}_{purpose.upper()}_EMAIL_HOST_USER'
        custom = getattr(settings, env_key, None)
        if custom:
            host = getattr(settings, f'{company_code}_{purpose.upper()}_EMAIL_HOST', None)
            port = getattr(settings, f'{company_code}_{purpose.upper()}_EMAIL_PORT', 587)
            password = getattr(settings, f'{company_code}_{purpose.upper()}_EMAIL_HOST_PASSWORD', '')
            if host:
                from django.core.mail import get_connection
                conn = get_connection(
                    host=host, port=port,
                    username=custom, password=password,
                    use_tls=True,
                )
                return (custom, conn)
            return (custom, None)
    from_email = getattr(settings, 'DEFAULT_FROM_EMAIL', 'purchase@company.com')
    return (from_email, None)
