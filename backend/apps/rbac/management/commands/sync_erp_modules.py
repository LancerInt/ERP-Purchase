"""Create ERPModule rows for any page whose view gates on a module it lacks.

Runs automatically after every `migrate` (see rbac/apps.py), so a deploy picks
up new pages on its own. This command is for looking before you leap, and for
fixing a stale DB without a full migrate.

    python manage.py sync_erp_modules --dry-run     # report only
    python manage.py sync_erp_modules               # create the missing rows

Never deletes or deactivates anything — see module_sync.
"""
from django.core.management.base import BaseCommand


class Command(BaseCommand):
    help = 'Register ERPModule rows for routed views that declare module_name.'

    def add_arguments(self, p):
        p.add_argument('--dry-run', action='store_true',
                       help='Show what would be created; write nothing.')

    def handle(self, *args, **o):
        from rbac.module_sync import sync

        w = self.stdout.write
        r = sync(dry_run=o['dry_run'])

        w('')
        w(f'  modules already registered   {r["existing"]:>4}')
        w(f'  missing rows                 {len(r["created"]):>4}')
        if r['created']:
            w('')
            for name, slug, cat in r['created']:
                verb = 'would create' if o['dry_run'] else 'created'
                w(self.style.SUCCESS(f'  {verb}: {name}  [{cat}]  /{slug}'))

        # No category means the row exists but appears in NO Permissions tab,
        # so nobody can grant it — worth saying out loud rather than leaving to
        # be discovered by a locked-out user.
        if r['uncategorised']:
            w('')
            w(self.style.WARNING(
                '  NO CATEGORY — these render in no Permissions tab. Set '
                '`module_category` on the view, or add its app to APP_CATEGORY:'))
            for n in r['uncategorised']:
                w(self.style.WARNING(f'      {n}'))

        w('')
        if o['dry_run']:
            w(self.style.WARNING('DRY RUN — nothing was written.'))
        elif not r['created']:
            w('Registry already in step with the routed views.')
        else:
            w(self.style.SUCCESS('Done. The new modules now appear on the '
                                 'Permissions page for their category.'))
