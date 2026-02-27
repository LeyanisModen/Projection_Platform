from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("api", "0020_alter_mesaqueueitem_unique_together"),
    ]

    operations = [
        migrations.AlterUniqueTogether(
            name="mesaqueueitem",
            unique_together=set(),
        ),
        migrations.AddConstraint(
            model_name="mesaqueueitem",
            constraint=models.UniqueConstraint(
                condition=models.Q(status__in=["EN_COLA", "MOSTRANDO"]),
                fields=("modulo", "fase"),
                name="unique_active_modulo_fase_assignment",
            ),
        ),
    ]
