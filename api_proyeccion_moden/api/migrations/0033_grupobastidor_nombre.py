from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0032_modulo_codigos_color_8'),
    ]

    operations = [
        migrations.AddField(
            model_name='grupobastidor',
            name='nombre',
            field=models.CharField(
                blank=True,
                default='',
                help_text='Alias opcional del grupo (p.ej. "Fachada norte"). Vacio => se usa el indice.',
                max_length=120,
            ),
        ),
    ]
