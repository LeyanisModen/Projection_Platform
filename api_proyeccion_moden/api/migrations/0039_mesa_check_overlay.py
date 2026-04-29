from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0038_fotofabricacion_check_fields'),
    ]

    operations = [
        migrations.AddField(
            model_name='mesa',
            name='check_overlay',
            field=models.CharField(
                blank=True,
                help_text=(
                    "Latest _check result for this mesa: "
                    "'success' | 'error' | 'no_camera' | null."
                ),
                max_length=16,
                null=True,
            ),
        ),
    ]
