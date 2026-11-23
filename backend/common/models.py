import uuid
from django.db import models
from django.conf import settings
from django.utils.translation import gettext_lazy as _


class BaseModel(models.Model):
    """
    Abstract base model for all ERP entities.
    Provides common fields for audit trail and soft deletion.
    """
    id = models.UUIDField(
        primary_key=True,
        default=uuid.uuid4,
        editable=False,
        help_text=_('Unique identifier')
    )
    created_at = models.DateTimeField(
        auto_now_add=True,
        help_text=_('Creation timestamp')
    )
    updated_at = models.DateTimeField(
        auto_now=True,
        help_text=_('Last modification timestamp')
    )
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        related_name='%(class)s_created_by',
        null=True,
        blank=True,
        help_text=_('User who created this record')
    )
    updated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        related_name='%(class)s_updated_by',
        null=True,
        blank=True,
        help_text=_('User who last updated this record')
    )
    is_active = models.BooleanField(
        default=True,
        db_index=True,
        help_text=_('Soft delete flag')
    )

    class Meta:
        abstract = True
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['is_active', '-created_at']),
            models.Index(fields=['created_by']),
            models.Index(fields=['updated_by']),
        ]

    def __str__(self):
        if hasattr(self, 'name'):
            return self.name
        if hasattr(self, 'code'):
            return self.code
        return str(self.id)

    @classmethod
    def from_db(cls, db, field_names, values):
        instance = super().from_db(db, field_names, values)
        # Remember the persisted is_active so the Archive's post_save signal can
        # tell a soft-delete (True→False) from a restore (False→True).
        if 'is_active' in field_names:
            instance._loaded_is_active = values[field_names.index('is_active')]
        return instance

    def soft_delete(self):
        """Perform soft deletion."""
        self.is_active = False
        self.save(update_fields=['is_active', 'updated_at'])

    def restore(self):
        """Restore soft-deleted record."""
        self.is_active = True
        self.save(update_fields=['is_active', 'updated_at'])
