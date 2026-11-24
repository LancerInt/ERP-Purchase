from django.db import models
from common.models import BaseModel


class EmailTemplate(BaseModel):
    name = models.CharField(max_length=255)
    subject = models.CharField(max_length=500, blank=True, default='')
    body_html = models.TextField(blank=True, default='')
    pdf_header_html = models.TextField(blank=True, default='')
    pdf_body_html = models.TextField(blank=True, default='')
    pdf_footer_html = models.TextField(blank=True, default='')
    is_default = models.BooleanField(default=False, db_index=True)

    class Meta:
        db_table = 'communications_email_template'
        ordering = ['-is_default', 'name']

    def __str__(self):
        return self.name

    def save(self, *args, **kwargs):
        if self.is_default:
            EmailTemplate.objects.filter(is_default=True).exclude(pk=self.pk).update(is_default=False)
        super().save(*args, **kwargs)


class EmailLog(BaseModel):
    rfq = models.ForeignKey(
        'purchase.RFQHeader', on_delete=models.SET_NULL,
        null=True, blank=True, related_name='email_logs',
    )
    po = models.ForeignKey(
        'purchase.PurchaseOrder', on_delete=models.SET_NULL,
        null=True, blank=True, related_name='email_logs',
    )
    template = models.ForeignKey(
        EmailTemplate, on_delete=models.SET_NULL,
        null=True, blank=True, related_name='email_logs',
    )
    vendor = models.ForeignKey(
        'master.Vendor', on_delete=models.SET_NULL,
        null=True, blank=True, related_name='email_logs',
    )
    to_email = models.CharField(max_length=255, blank=True, default='')
    vendor_email = models.CharField(max_length=255, blank=True, default='')
    subject = models.CharField(max_length=500, blank=True, default='')
    body_html = models.TextField(blank=True, default='')
    body_preview = models.TextField(blank=True, default='')
    email_sent = models.BooleanField(default=True, db_index=True)
    pdf_generated = models.BooleanField(default=False)
    sent_by = models.ForeignKey(
        'auth.User', on_delete=models.SET_NULL,
        null=True, blank=True, related_name='sent_emails',
    )
    error_message = models.TextField(blank=True, default='')
    status = models.CharField(
        max_length=20, default='SENT',
        choices=[('SENT', 'Sent'), ('FAILED', 'Failed')],
    )
    sent_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = 'communications_email_log'
        ordering = ['-sent_at']

    def __str__(self):
        return f'{self.to_email} — {self.subject[:50]}'
