from django.db import models
from django.contrib.auth.models import User
import uuid

class Proyecto(models.Model):
    id = models.AutoField(primary_key=True)
    nombre = models.CharField(max_length=200)
    usuario_id = models.ForeignKey(User, on_delete=models.CASCADE, null=True, blank=True) # Optional link to user owner
    def __str__(self):
        return self.nombre

class Planta(models.Model):
    id = models.AutoField(primary_key=True)
    nombre = models.CharField(max_length=200)
    proyecto = models.ForeignKey(Proyecto, on_delete=models.CASCADE, related_name='plantas')
    def __str__(self):
        return f"{self.proyecto.nombre} - {self.nombre}"

class Modulo(models.Model):
    id = models.AutoField(primary_key=True)
    nombre = models.CharField(max_length=200)
    # Changed from CharField to ForeignKey to Planta
    planta = models.ForeignKey(Planta, on_delete=models.CASCADE, related_name='modulos') 
    tipo = models.CharField(max_length=50, choices=[('INF', 'Inferior'), ('SUP', 'Superior')], default='INF')
    def __str__(self):
        return f"{self.planta.nombre} - {self.nombre}"

class Imagen(models.Model):
    id = models.AutoField(primary_key=True)
    # Storing just the path/filename relative to media root
    archivo = models.ImageField(upload_to='ferralla_images/', max_length=500) 
    modulo = models.ForeignKey(Modulo, on_delete=models.CASCADE, related_name='imagenes')
    orden = models.IntegerField(default=0)
    
    class Meta:
        ordering = ['orden']

    def __str__(self):
        return f"{self.modulo.nombre} - {self.orden} - {self.archivo.name}"
    
class Mesa(models.Model):
    id = models.AutoField(primary_key=True)
    nombre = models.CharField(max_length=200)
    # Token for authentication (UUID)
    token = models.UUIDField(default=uuid.uuid4, editable=True, unique=True)
    usuario_id = models.ForeignKey(User, on_delete=models.SET_NULL, null=True, blank=True)
    imagen_actual = models.ForeignKey(Imagen, on_delete=models.SET_NULL, null=True, blank=True, related_name='mesas_activas')
    ultima_actualizacion = models.DateTimeField(auto_now=True)

    def __str__(self):
        return f"{self.nombre} ({self.token})"