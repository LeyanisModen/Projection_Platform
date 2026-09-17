from django.db import migrations, models


PREFIX = 'PENDING_TOKEN:'


def move_pending_tokens(apps, schema_editor):
    """Pairings in flight at deploy time keep working: the raw token used to
    live in Mesa.last_error with a PENDING_TOKEN: prefix."""
    Mesa = apps.get_model('api', 'Mesa')
    for mesa in Mesa.objects.filter(last_error__startswith=PREFIX).iterator():
        mesa.pending_device_token = mesa.last_error[len(PREFIX):]
        mesa.last_error = None
        mesa.save(update_fields=['pending_device_token', 'last_error'])


def restore_pending_tokens(apps, schema_editor):
    Mesa = apps.get_model('api', 'Mesa')
    pending = Mesa.objects.exclude(pending_device_token__isnull=True).exclude(pending_device_token='')
    for mesa in pending.iterator():
        mesa.last_error = PREFIX + mesa.pending_device_token
        mesa.save(update_fields=['last_error'])


class Migration(migrations.Migration):
    dependencies = [('api', '0055_office_worker_color')]
    operations = [
        migrations.AddField(
            model_name='mesa',
            name='pending_device_token',
            field=models.CharField(blank=True, max_length=128, null=True),
        ),
        migrations.RunPython(move_pending_tokens, restore_pending_tokens),
    ]
