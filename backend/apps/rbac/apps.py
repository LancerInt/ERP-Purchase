import logging

from django.apps import AppConfig
from django.db.models.signals import post_migrate

logger = logging.getLogger(__name__)


def _sync_modules(sender, **kwargs):
    """Register ERPModule rows for any routed view gating on a module it lacks.

    Hung off post_migrate because the deploy already runs `migrate`, so a new
    page's permission row appears without anyone remembering to write the
    twelfth hand-rolled seed migration. Only creates; see rbac.module_sync.

    Deliberately never raises: a permissions bookkeeping step must not be able
    to fail a deploy that has already applied its schema changes. A failure is
    logged and fixed with `manage.py sync_erp_modules`.
    """
    try:
        from rbac.module_sync import sync
        r = sync()
        if r['created']:
            logger.info('rbac: registered %d new module(s): %s', len(r['created']),
                        ', '.join(n for n, _s, _c in r['created']))
        if r['uncategorised']:
            logger.warning('rbac: module(s) with no category render in no '
                           'Permissions tab: %s', ', '.join(r['uncategorised']))
    except Exception:                                   # noqa: BLE001
        logger.exception('rbac: module sync failed; run sync_erp_modules')


class RbacConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'rbac'
    verbose_name = 'Role-Based Access Control'

    def ready(self):
        import rbac.signals  # noqa: F401
        # `sender=self` so this fires once, after RBAC's own tables exist —
        # not once per installed app.
        post_migrate.connect(_sync_modules, sender=self)
