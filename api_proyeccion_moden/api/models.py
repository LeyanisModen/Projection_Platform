from django.db import models
from django.contrib.auth.models import User

class Proyecto(models.Model):
    id = models.AutoField(primary_key=True)
    nombre = models.CharField(max_length=200)
    usuario_id = models.ForeignKey(User, on_delete=models.CASCADE)
    def __str__(self):
        return self.nombre
    
class Modulo(models.Model):
    id = models.AutoField(primary_key=True)
    nombre = models.CharField(max_length=200)
    planta = models.CharField(max_length=200)
    proyecto_id = models.ForeignKey(Proyecto, on_delete=models.CASCADE)
    def __str__(self):
        return self.nombre + " " + self.planta

class Imagen(models.Model):
    id = models.AutoField(primary_key=True)
    url = models.CharField(max_length=200)
    tipo = models.CharField(max_length=200)
    modulo_id = models.ForeignKey(Modulo, on_delete=models.CASCADE)
    def __str__(self):
        return self.tipo + " " + self.url
    
class Mesa(models.Model):
    id = models.AutoField(primary_key=True)
    nombre = models.CharField(max_length=200)
    usuario_id = models.ForeignKey(User, on_delete=models.CASCADE)
    imagen_id = models.ForeignKey(Imagen, on_delete=models.CASCADE)
    def __str__(self):
        return self.nombre