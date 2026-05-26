from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0044_mesa_unique_indice_y_sin_legacy'),
    ]

    operations = [
        migrations.AddField(
            model_name='proyecto',
            name='estrategia_bastidor',
            field=models.CharField(
                choices=[
                    ('SECUENCIAL', 'Secuencial'),
                    ('AISLAR_CENTRAL_GIRADO', 'Aislar central girado'),
                ],
                default='SECUENCIAL',
                help_text=(
                    'Estrategia de agrupacion: SECUENCIAL = corte solo por longitud; '
                    'AISLAR_CENTRAL_GIRADO = separa modulos central_girado del resto.'
                ),
                max_length=32,
            ),
        ),
        migrations.AddField(
            model_name='modulo',
            name='tipo_modulo',
            field=models.CharField(
                blank=True,
                choices=[
                    ('CENTRAL', 'Central'),
                    ('CENTRAL_GIRADO', 'Central girado'),
                    ('LADO_LARGO', 'Lado largo'),
                    ('LADO_CORTO', 'Lado corto'),
                    ('ESQUINA', 'Esquina'),
                ],
                default='',
                help_text=(
                    'Tipologia del modulo para agrupacion: '
                    'CENTRAL, CENTRAL_GIRADO, LADO_LARGO, LADO_CORTO, ESQUINA.'
                ),
                max_length=32,
            ),
        ),
    ]
