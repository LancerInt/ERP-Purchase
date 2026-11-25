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
    """Render a template's HTML to a real PDF (xhtml2pdf / ReportLab).

    xhtml2pdf is pure-Python (no system binaries), so it works on this
    standalone where WeasyPrint's native deps aren't available. If the
    library is missing or a document fails to render, we fall back to the
    old behaviour of returning the raw HTML bytes, so a PDF send never hard-
    fails — it just degrades to an HTML attachment.
    """

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
        """Return a BytesIO of a real PDF for `full_html`, else the HTML bytes."""
        try:
            from xhtml2pdf import pisa
            buf = io.BytesIO()
            result = pisa.CreatePDF(src=full_html, dest=buf, encoding='utf-8')
            if not result.err and buf.getbuffer().nbytes:
                buf.seek(0)
                return buf
        except Exception:
            pass
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
