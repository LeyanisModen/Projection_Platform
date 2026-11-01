from django.contrib import admin
from .models import Proyecto, Modulo, Imagen, Mesa, GrupoMesas, DetalleModuloFase, LogMiniPC

admin.site.register(Proyecto)
admin.site.register(Modulo)
admin.site.register(Imagen)
admin.site.register(Mesa)
admin.site.register(GrupoMesas)
admin.site.register(DetalleModuloFase)


@admin.register(LogMiniPC)
class LogMiniPCAdmin(admin.ModelAdmin):
    """Solo lectura: lo escribe el mini-PC."""
    list_display = ('recibido_at', 'mesa', 'fichero', 'lineas')
    list_filter = ('fichero', 'mesa__usuario', 'mesa')
    search_fields = ('contenido',)
    readonly_fields = ('mesa', 'fichero', 'recibido_at', 'contenido')

    def lineas(self, obj):
        return obj.contenido.count('\n')

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False
