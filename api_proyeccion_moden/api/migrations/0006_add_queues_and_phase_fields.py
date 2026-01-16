# Generated manually for mod:en database restructuring
# Renames FK fields and adds queue system

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ('api', '0005_remove_mesa_imagen_id_mesa_imagen_actual_and_more'),
    ]

    operations = [
        # =====================================================================
        # STEP 1: Rename FK fields to Django convention (remove _id suffix)
        # =====================================================================
        migrations.RenameField(
            model_name='proyecto',
            old_name='usuario_id',
            new_name='usuario',
        ),
        migrations.RenameField(
            model_name='modulo',
            old_name='proyecto_id',
            new_name='proyecto',
        ),
        migrations.RenameField(
            model_name='imagen',
            old_name='modulo_id',
            new_name='modulo',
        ),
        migrations.RenameField(
            model_name='mesa',
            old_name='usuario_id',
            new_name='usuario',
        ),

        # =====================================================================
        # STEP 2: Add new fields to Imagen
        # =====================================================================
        migrations.AddField(
            model_name='imagen',
            name='fase',
            field=models.CharField(
                choices=[('INFERIOR', 'Inferior'), ('SUPERIOR', 'Superior')],
                default='INFERIOR',
                max_length=20
            ),
        ),
        migrations.AddField(
            model_name='imagen',
            name='orden',
            field=models.PositiveIntegerField(default=1),
        ),
        migrations.AddField(
            model_name='imagen',
            name='version',
            field=models.PositiveIntegerField(default=1),
        ),
        migrations.AddField(
            model_name='imagen',
            name='activo',
            field=models.BooleanField(default=True),
        ),
        migrations.AddField(
            model_name='imagen',
            name='checksum',
            field=models.CharField(blank=True, max_length=64, null=True),
        ),
        # Make 'tipo' nullable (legacy field)
        migrations.AlterField(
            model_name='imagen',
            name='tipo',
            field=models.CharField(blank=True, max_length=200, null=True),
        ),
        # Increase url max_length
        migrations.AlterField(
            model_name='imagen',
            name='url',
            field=models.CharField(max_length=500),
        ),

        # =====================================================================
        # STEP 3: Add new fields to Modulo
        # =====================================================================
        migrations.AddField(
            model_name='modulo',
            name='inferior_hecho',
            field=models.BooleanField(default=False),
        ),
        migrations.AddField(
            model_name='modulo',
            name='superior_hecho',
            field=models.BooleanField(default=False),
        ),
        migrations.AddField(
            model_name='modulo',
            name='estado',
            field=models.CharField(
                choices=[
                    ('PENDIENTE', 'Pendiente'),
                    ('EN_PROGRESO', 'En Progreso'),
                    ('COMPLETADO', 'Completado'),
                    ('CERRADO', 'Cerrado')
                ],
                default='PENDIENTE',
                max_length=20
            ),
        ),
        migrations.AddField(
            model_name='modulo',
            name='cerrado',
            field=models.BooleanField(default=False),
        ),
        migrations.AddField(
            model_name='modulo',
            name='cerrado_at',
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='modulo',
            name='cerrado_by',
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name='modulos_cerrados',
                to=settings.AUTH_USER_MODEL
            ),
        ),

        # =====================================================================
        # STEP 4: Add new fields to Mesa
        # =====================================================================
        migrations.AddField(
            model_name='mesa',
            name='locked',
            field=models.BooleanField(default=False),
        ),
        migrations.AddField(
            model_name='mesa',
            name='blackout',
            field=models.BooleanField(default=False),
        ),
        migrations.AddField(
            model_name='mesa',
            name='last_seen',
            field=models.DateTimeField(blank=True, null=True),
        ),

        # =====================================================================
        # STEP 5: Create ModuloQueue table
        # =====================================================================
        migrations.CreateModel(
            name='ModuloQueue',
            fields=[
                ('id', models.AutoField(primary_key=True, serialize=False)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('activa', models.BooleanField(default=True)),
                ('created_by', models.ForeignKey(
                    blank=True,
                    null=True,
                    on_delete=django.db.models.deletion.SET_NULL,
                    related_name='modulo_queues_creadas',
                    to=settings.AUTH_USER_MODEL
                )),
                ('proyecto', models.OneToOneField(
                    on_delete=django.db.models.deletion.CASCADE,
                    related_name='modulo_queue',
                    to='api.proyecto'
                )),
            ],
            options={
                'db_table': 'api_modulo_queue',
            },
        ),

        # =====================================================================
        # STEP 6: Create ModuloQueueItem table
        # =====================================================================
        migrations.CreateModel(
            name='ModuloQueueItem',
            fields=[
                ('id', models.AutoField(primary_key=True, serialize=False)),
                ('position', models.PositiveIntegerField(default=0)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('added_by', models.ForeignKey(
                    blank=True,
                    null=True,
                    on_delete=django.db.models.deletion.SET_NULL,
                    related_name='modulo_queue_items_added',
                    to=settings.AUTH_USER_MODEL
                )),
                ('modulo', models.ForeignKey(
                    on_delete=django.db.models.deletion.CASCADE,
                    related_name='queue_items',
                    to='api.modulo'
                )),
                ('queue', models.ForeignKey(
                    on_delete=django.db.models.deletion.CASCADE,
                    related_name='items',
                    to='api.moduloqueue'
                )),
            ],
            options={
                'db_table': 'api_modulo_queue_item',
                'ordering': ['position'],
            },
        ),

        # =====================================================================
        # STEP 7: Create MesaQueueItem table
        # =====================================================================
        migrations.CreateModel(
            name='MesaQueueItem',
            fields=[
                ('id', models.AutoField(primary_key=True, serialize=False)),
                ('fase', models.CharField(
                    choices=[('INFERIOR', 'Inferior'), ('SUPERIOR', 'Superior')],
                    max_length=20
                )),
                ('position', models.PositiveIntegerField(default=0)),
                ('status', models.CharField(
                    choices=[
                        ('EN_COLA', 'En Cola'),
                        ('MOSTRANDO', 'Mostrando'),
                        ('HECHO', 'Hecho')
                    ],
                    default='EN_COLA',
                    max_length=20
                )),
                ('assigned_at', models.DateTimeField(auto_now_add=True)),
                ('done_at', models.DateTimeField(blank=True, null=True)),
                ('assigned_by', models.ForeignKey(
                    blank=True,
                    null=True,
                    on_delete=django.db.models.deletion.SET_NULL,
                    related_name='mesa_queue_items_assigned',
                    to=settings.AUTH_USER_MODEL
                )),
                ('done_by', models.ForeignKey(
                    blank=True,
                    null=True,
                    on_delete=django.db.models.deletion.SET_NULL,
                    related_name='mesa_queue_items_done',
                    to=settings.AUTH_USER_MODEL
                )),
                ('imagen', models.ForeignKey(
                    on_delete=django.db.models.deletion.PROTECT,
                    related_name='mesa_queue_items',
                    to='api.imagen'
                )),
                ('mesa', models.ForeignKey(
                    on_delete=django.db.models.deletion.CASCADE,
                    related_name='queue_items',
                    to='api.mesa'
                )),
                ('modulo', models.ForeignKey(
                    on_delete=django.db.models.deletion.CASCADE,
                    related_name='mesa_queue_items',
                    to='api.modulo'
                )),
            ],
            options={
                'db_table': 'api_mesa_queue_item',
                'ordering': ['position'],
            },
        ),

        # =====================================================================
        # STEP 8: Add constraints and indexes
        # =====================================================================
        # Imagen constraints
        migrations.AddConstraint(
            model_name='imagen',
            constraint=models.UniqueConstraint(
                fields=['modulo', 'fase', 'orden', 'version'],
                name='unique_imagen_modulo_fase_orden_version'
            ),
        ),
        migrations.AddConstraint(
            model_name='imagen',
            constraint=models.CheckConstraint(
                check=models.Q(fase__in=['INFERIOR', 'SUPERIOR']),
                name='check_imagen_fase_valid'
            ),
        ),
        migrations.AddIndex(
            model_name='imagen',
            index=models.Index(fields=['modulo'], name='api_imagen_modulo__idx'),
        ),
        migrations.AddIndex(
            model_name='imagen',
            index=models.Index(fields=['modulo', 'fase'], name='api_imagen_modulo__fase_idx'),
        ),
        migrations.AddIndex(
            model_name='imagen',
            index=models.Index(fields=['modulo', 'fase', 'orden'], name='api_imagen_modulo__fase_orden_idx'),
        ),

        # ModuloQueueItem constraints
        migrations.AddConstraint(
            model_name='moduloqueueitem',
            constraint=models.UniqueConstraint(
                fields=['queue', 'modulo'],
                name='unique_modulo_in_queue'
            ),
        ),
        migrations.AddIndex(
            model_name='moduloqueueitem',
            index=models.Index(fields=['queue', 'position'], name='api_mqi_queue_pos_idx'),
        ),
        migrations.AddIndex(
            model_name='moduloqueueitem',
            index=models.Index(fields=['modulo'], name='api_mqi_modulo_idx'),
        ),

        # MesaQueueItem constraints
        migrations.AddConstraint(
            model_name='mesaqueueitem',
            constraint=models.CheckConstraint(
                check=models.Q(fase__in=['INFERIOR', 'SUPERIOR']),
                name='check_mesa_queue_item_fase_valid'
            ),
        ),
        migrations.AddConstraint(
            model_name='mesaqueueitem',
            constraint=models.CheckConstraint(
                check=models.Q(status__in=['EN_COLA', 'MOSTRANDO', 'HECHO']),
                name='check_mesa_queue_item_status_valid'
            ),
        ),
        migrations.AddIndex(
            model_name='mesaqueueitem',
            index=models.Index(fields=['mesa', 'position'], name='api_mesa_qi_pos_idx'),
        ),
        migrations.AddIndex(
            model_name='mesaqueueitem',
            index=models.Index(fields=['mesa', 'status'], name='api_mesa_qi_status_idx'),
        ),
        migrations.AddIndex(
            model_name='mesaqueueitem',
            index=models.Index(fields=['modulo', 'fase'], name='api_mesa_qi_mod_fase_idx'),
        ),
    ]
