from django.db import migrations, models


def convert_json_to_char(apps, schema_editor):
    """Set all existing codigos_color to 'xxxx'."""
    Modulo = apps.get_model('api', 'Modulo')
    Modulo.objects.all().update(codigos_color='xxxx')


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0022_foto_fabricacion_codigos_color'),
    ]

    operations = [
        # First remove the JSONField default so we can alter to CharField
        migrations.RemoveField(
            model_name='modulo',
            name='codigos_color',
        ),
        migrations.AddField(
            model_name='modulo',
            name='codigos_color',
            field=models.CharField(
                blank=True,
                default='xxxx',
                help_text='4 chars: y=yellow, g=green, c=cyan, v=violet, m=magenta, o=orange, x=skip',
                max_length=4,
            ),
        ),
        migrations.RunPython(convert_json_to_char, migrations.RunPython.noop),
    ]
