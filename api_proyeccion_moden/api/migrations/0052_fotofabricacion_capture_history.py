from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0051_adaptive_superior_queue'),
    ]

    operations = [
        migrations.AlterUniqueTogether(
            name='fotofabricacion',
            unique_together=set(),
        ),
    ]
