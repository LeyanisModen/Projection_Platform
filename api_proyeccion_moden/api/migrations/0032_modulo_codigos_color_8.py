from django.db import migrations, models


def pad_codigos_color(apps, schema_editor):
    Modulo = apps.get_model('api', 'Modulo')
    for m in Modulo.objects.all():
        value = (m.codigos_color or '').ljust(8, 'x')[:8]
        if value != m.codigos_color:
            m.codigos_color = value
            m.save(update_fields=['codigos_color'])


def noop(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0031_detallemodulofase_metros'),
    ]

    operations = [
        migrations.AlterField(
            model_name='modulo',
            name='codigos_color',
            field=models.CharField(
                blank=True,
                default='xxxxxxxx',
                help_text="Up to 8 chars: y=yellow, g=green, c=cyan, v=violet, m=magenta, o=orange, x=skip",
                max_length=8,
            ),
        ),
        migrations.RunPython(pad_codigos_color, reverse_code=noop),
    ]
