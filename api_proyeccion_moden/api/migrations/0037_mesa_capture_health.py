from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0036_grupobastidor_asignado_a'),
    ]

    operations = [
        migrations.AddField(
            model_name='mesa',
            name='capture_service_online',
            field=models.BooleanField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='mesa',
            name='camera_sharpness',
            field=models.CharField(
                blank=True,
                help_text="Reported by the mini-PC: 'ok' | 'warning' | 'blurry' | 'unknown'.",
                max_length=16,
                null=True,
            ),
        ),
    ]
