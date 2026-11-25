"""Seed the default Purchase Order (and RFQ) email templates.

The PO / RFQ send-email flows are fully built, but no EmailTemplate rows exist
in this standalone, so the send pages show "No templates found" and the Send
button stays disabled. These give each document its own template with the
placeholders the PO/RFQ email context builds ({{po_number}}, {{vendor_name}},
{{product_table}}, {{company_*}}, totals, …). Ported verbatim from production
(communications 0002/0005). Idempotent (get_or_create by unique name).
"""
from django.db import migrations


# ── Purchase Order ───────────────────────────────────────────────────────
PO_SUBJECT = "Purchase Order {{po_number}} from {{company_name}}"

PO_BODY = """
<div style="font-family: Arial, sans-serif; max-width: 700px; margin: 0 auto;">
  <div style="background: #14532d; color: white; padding: 20px 30px;">
    <h1 style="margin: 0; font-size: 22px;">{{company_name}}</h1>
    <p style="margin: 5px 0 0 0; font-size: 13px; opacity: 0.9;">Purchase Order</p>
  </div>
  <div style="padding: 25px 30px; background: #ffffff; border: 1px solid #e2e8f0;">
    <p style="font-size: 14px; color: #333;">Dear <strong>{{vendor_name}}</strong>,</p>
    <p style="font-size: 14px; color: #333; line-height: 1.6;">
      Please find our Purchase Order <strong>{{po_number}}</strong> below, with the
      full document attached as a PDF. Kindly confirm acceptance and expected
      delivery.
    </p>
    <h3 style="color: #14532d; font-size: 15px; margin-top: 25px;">Ordered Items</h3>
    {{product_table}}
    <p style="font-size: 13px; color: #555; margin-top: 20px;"><strong>Payment terms:</strong> {{payment_terms}} &nbsp; | &nbsp; <strong>Freight:</strong> {{freight_terms}}</p>
    <p style="font-size: 14px; color: #333; margin-top: 25px; line-height: 1.6;">
      Questions? Reach us at
      <a href="mailto:{{company_email}}" style="color: #14532d;">{{company_email}}</a>
      or call <strong>{{company_phone}}</strong>.
    </p>
    <p style="font-size: 14px; color: #333; margin-top: 20px;">
      Best regards,<br><strong>{{company_name}}</strong><br>
      <span style="font-size: 12px; color: #666;">{{company_address}}</span>
    </p>
  </div>
  <div style="background: #f7fafc; padding: 12px 30px; font-size: 11px; color: #999; border-top: 1px solid #e2e8f0;">
    This is a system-generated purchase order from {{company_name}}.
  </div>
</div>
"""

PO_PDF_HEADER = """
<div style="display: flex; justify-content: space-between; align-items: flex-start;">
  <div>
    <h1 style="margin: 0; color: #14532d; font-size: 22px;">{{company_name}}</h1>
    <p style="margin: 3px 0; font-size: 11px; color: #666;">{{company_address}}</p>
    <p style="margin: 3px 0; font-size: 11px; color: #666;">GSTIN: {{company_gstin}}</p>
    <p style="margin: 3px 0; font-size: 11px; color: #666;">Phone: {{company_phone}} | Email: {{company_email}}</p>
  </div>
  <div style="text-align: right;">
    <h2 style="margin: 0; color: #14532d; font-size: 18px;">PURCHASE ORDER</h2>
    <p style="margin: 5px 0; font-size: 12px;"><strong>PO No:</strong> {{po_number}}</p>
    <p style="margin: 3px 0; font-size: 12px;"><strong>Date:</strong> {{po_date}}</p>
  </div>
</div>
"""

PO_PDF_BODY = """
<div style="margin-top: 20px;">
  <div style="background: #f7fafc; padding: 12px; border: 1px solid #e2e8f0; border-radius: 3px; margin-bottom: 20px;">
    <h3 style="margin: 0 0 8px 0; font-size: 13px; color: #14532d;">VENDOR</h3>
    <table style="width: 100%; border: none;">
      <tr><td style="border:none;padding:3px 0;font-size:12px;width:120px;color:#666;"><strong>Vendor:</strong></td><td style="border:none;padding:3px 0;font-size:12px;">{{vendor_name}}</td></tr>
      <tr><td style="border:none;padding:3px 0;font-size:12px;color:#666;"><strong>Address:</strong></td><td style="border:none;padding:3px 0;font-size:12px;">{{vendor_address}}</td></tr>
      <tr><td style="border:none;padding:3px 0;font-size:12px;color:#666;"><strong>Email:</strong></td><td style="border:none;padding:3px 0;font-size:12px;">{{vendor_email}}</td></tr>
    </table>
  </div>
  <h3 style="font-size: 13px; color: #14532d; margin-bottom: 10px;">ORDERED ITEMS</h3>
  {{product_table}}
  <p style="font-size: 12px; color: #333; margin-top: 15px;"><strong>Payment Terms:</strong> {{payment_terms}} &nbsp; | &nbsp; <strong>Freight:</strong> {{freight_terms}}</p>
  <p style="font-size: 12px; color: #333;"><strong>Notes:</strong> {{notes}}</p>
</div>
"""

# ── RFQ ──────────────────────────────────────────────────────────────────
RFQ_SUBJECT = "Request for Quotation - {{rfq_number}} from {{company_name}}"

RFQ_BODY = """
<div style="font-family: Arial, sans-serif; max-width: 700px; margin: 0 auto;">
  <div style="background: #1a365d; color: white; padding: 20px 30px;">
    <h1 style="margin: 0; font-size: 22px;">{{company_name}}</h1>
    <p style="margin: 5px 0 0 0; font-size: 13px; opacity: 0.9;">Request for Quotation</p>
  </div>
  <div style="padding: 25px 30px; background: #ffffff; border: 1px solid #e2e8f0;">
    <p style="font-size: 14px; color: #333;">Dear <strong>{{vendor_name}}</strong>,</p>
    <p style="font-size: 14px; color: #333; line-height: 1.6;">
      We would like to invite you to submit a quotation for the following items.
      Please find the details below and the complete RFQ document attached as a PDF.
    </p>
    <h3 style="color: #1a365d; font-size: 15px; margin-top: 25px;">Items Required</h3>
    {{product_table}}
    <p style="font-size: 14px; color: #333; margin-top: 25px; line-height: 1.6;">
      Questions? Reach us at
      <a href="mailto:{{company_email}}" style="color: #1a365d;">{{company_email}}</a>
      or call <strong>{{company_phone}}</strong>.
    </p>
    <p style="font-size: 14px; color: #333; margin-top: 20px;">
      Best regards,<br><strong>{{company_name}}</strong><br>
      <span style="font-size: 12px; color: #666;">{{company_address}}</span>
    </p>
  </div>
  <div style="background: #f7fafc; padding: 12px 30px; font-size: 11px; color: #999; border-top: 1px solid #e2e8f0;">
    This is a system-generated RFQ from {{company_name}}.
  </div>
</div>
"""

RFQ_PDF_HEADER = """
<div style="display: flex; justify-content: space-between; align-items: flex-start;">
  <div>
    <h1 style="margin: 0; color: #1a365d; font-size: 22px;">{{company_name}}</h1>
    <p style="margin: 3px 0; font-size: 11px; color: #666;">{{company_address}}</p>
    <p style="margin: 3px 0; font-size: 11px; color: #666;">GSTIN: {{company_gstin}}</p>
    <p style="margin: 3px 0; font-size: 11px; color: #666;">Phone: {{company_phone}} | Email: {{company_email}}</p>
  </div>
  <div style="text-align: right;">
    <h2 style="margin: 0; color: #1a365d; font-size: 18px;">REQUEST FOR QUOTATION</h2>
    <p style="margin: 5px 0; font-size: 12px;"><strong>RFQ No:</strong> {{rfq_number}}</p>
    <p style="margin: 3px 0; font-size: 12px;"><strong>Date:</strong> {{date}}</p>
  </div>
</div>
"""

RFQ_PDF_BODY = """
<div style="margin-top: 20px;">
  <h3 style="font-size: 13px; color: #1a365d; margin-bottom: 10px;">ITEMS REQUIRED</h3>
  {{product_table}}
</div>
"""

PDF_FOOTER = """
<div style="text-align: center; font-size: 10px; color: #999;">
  <p style="margin: 3px 0;">This is a system-generated document from {{company_name}}.</p>
  <p style="margin: 3px 0;">For queries: {{company_email}} | {{company_phone}}</p>
  <p style="margin: 3px 0;">Generated on: {{date}}</p>
</div>
"""


def seed(apps, schema_editor):
    EmailTemplate = apps.get_model('communications', 'EmailTemplate')
    EmailTemplate.objects.get_or_create(
        name='Purchase Order Email',
        defaults=dict(
            subject=PO_SUBJECT,
            body_html=PO_BODY.strip(),
            pdf_header_html=PO_PDF_HEADER.strip(),
            pdf_body_html=PO_PDF_BODY.strip(),
            pdf_footer_html=PDF_FOOTER.strip(),
            is_default=True,
        ),
    )
    EmailTemplate.objects.get_or_create(
        name='RFQ Email',
        defaults=dict(
            subject=RFQ_SUBJECT,
            body_html=RFQ_BODY.strip(),
            pdf_header_html=RFQ_PDF_HEADER.strip(),
            pdf_body_html=RFQ_PDF_BODY.strip(),
            pdf_footer_html=PDF_FOOTER.strip(),
            is_default=False,
        ),
    )


def unseed(apps, schema_editor):
    EmailTemplate = apps.get_model('communications', 'EmailTemplate')
    EmailTemplate.objects.filter(
        name__in=['Purchase Order Email', 'RFQ Email']
    ).delete()


class Migration(migrations.Migration):

    dependencies = [
        ('communications', '0003_emaillog_body_preview_emaillog_error_message_and_more'),
    ]

    operations = [
        migrations.RunPython(seed, unseed),
    ]
