"""Hard-delete a user and the records that reference them.

The User Management UI deliberately DEACTIVATES (never hard-deletes) a user
that has transaction history, so real audit trails are never lost. But test
accounts created during setup have only throwaway records, and you want them
gone before going live. This command is that escape hatch.

Safety:
  * Dry-run by default — it only reports what would be deleted. Pass --confirm
    to actually delete.
  * Refuses to touch a superuser.
  * Deletes the user's PROTECT/RESTRICT-referencing rows first (clearing the
    block), then the user (whose CASCADE/SET_NULL refs go automatically).
  * Runs in a transaction. If any record turns out to be protected by a
    dependency NOT owned by this user (i.e. real data references it), it
    aborts and rolls back — so you can never silently wipe live records.

Usage (on the Render shell):
    python manage.py purge_user rajkumar            # dry-run, shows the blast radius
    python manage.py purge_user rajkumar --confirm  # actually delete
"""
from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError
from django.db import models, transaction
from django.db.models.deletion import ProtectedError, RestrictedError

PROTECTIVE = {models.PROTECT, models.RESTRICT}
BLOCK_ERRORS = (ProtectedError, RestrictedError)


class Command(BaseCommand):
    help = "Hard-delete a TEST user and every record that references them (dry-run unless --confirm)."

    def add_arguments(self, parser):
        parser.add_argument('username', help='Username or email of the user to purge.')
        parser.add_argument(
            '--confirm', action='store_true',
            help='Actually delete. Without this flag the command only reports what would be deleted.',
        )

    def handle(self, *args, **opts):
        User = get_user_model()
        ident = (opts['username'] or '').strip()
        user = (
            User.objects.filter(username__iexact=ident).first()
            or User.objects.filter(email__iexact=ident).first()
        )
        if not user:
            raise CommandError(f"No user found with username/email '{ident}'.")
        if user.is_superuser:
            raise CommandError(
                f"'{user.username}' is a superuser — refusing to purge. Remove superuser "
                "status first if you really mean to delete it."
            )

        # Walk every model that points at this user via a FK.
        protect_targets = []   # (label, queryset) — block a plain delete, clear first
        cascade_note = []      # (label, count) — informational; user.delete() handles them
        for rel in user._meta.related_objects:
            if rel.many_to_many:
                continue
            model = rel.related_model
            field_name = rel.field.name
            # _base_manager (not .objects) so soft-delete managers can't hide a
            # blocking row from us.
            qs = model._base_manager.filter(**{field_name: user})
            count = qs.count()
            if not count:
                continue
            label = f"{model._meta.label}.{field_name}"
            if getattr(rel, 'on_delete', None) in PROTECTIVE:
                protect_targets.append((label, qs))
            else:
                cascade_note.append((label, count))

        self.stdout.write(self.style.MIGRATE_HEADING(
            f"User: {user.username} ({user.email or 'no email'}) — id {user.pk}"))
        if protect_targets:
            self.stdout.write("Protected records that WILL BE DELETED first:")
            for label, qs in protect_targets:
                self.stdout.write(f"  - {label}: {qs.count()}")
        else:
            self.stdout.write("No protected records — a normal delete would already work.")
        if cascade_note:
            self.stdout.write("Cascade / SET_NULL references (handled automatically):")
            for label, count in cascade_note:
                self.stdout.write(f"  - {label}: {count}")

        if not opts['confirm']:
            self.stdout.write(self.style.WARNING(
                "\nDRY-RUN — nothing deleted. Re-run with --confirm to delete the above and the user."))
            return

        username = user.username
        try:
            with transaction.atomic():
                # Fixed-point loop: some protected rows protect each other (e.g. an
                # Invoice protects the PO it's on). Keep deleting what we can, using
                # a savepoint per attempt, until everything's gone or nothing moves.
                remaining = list(protect_targets)
                progressed = True
                while remaining and progressed:
                    progressed = False
                    still = []
                    for label, qs in remaining:
                        try:
                            with transaction.atomic():
                                qs.delete()
                            progressed = True
                        except BLOCK_ERRORS:
                            still.append((label, qs))
                    remaining = still
                if remaining:
                    blockers = ", ".join(label for label, _ in remaining)
                    raise CommandError(
                        "Aborted — these are protected by a dependency NOT owned by this "
                        f"user (looks like real data references them): {blockers}"
                    )
                user.delete()
        except BLOCK_ERRORS as exc:
            raise CommandError(f"Aborted — a real dependency still references this user: {exc}")

        self.stdout.write(self.style.SUCCESS(
            f"Deleted user '{username}' and all records it owned."))
