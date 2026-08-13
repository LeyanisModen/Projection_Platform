from django.db.models import Exists, OuterRef, Q

from api.models import Imagen


SD_IMAGE_FILTER = (
    Q(url__icontains="_SD_S_")
    | Q(url__icontains="_SD_D_")
    | Q(archivo__icontains="_SD_S_")
    | Q(archivo__icontains="_SD_D_")
)


def annotate_modules_with_sd(queryset):
    """Annotate modules whose imported upper sequence includes an SD part."""
    sd_images = Imagen.objects.filter(modulo_id=OuterRef("pk")).filter(
        SD_IMAGE_FILTER
    )
    return queryset.annotate(tiene_sd=Exists(sd_images))


def module_has_sd(modulo):
    annotated_value = getattr(modulo, "tiene_sd", None)
    if annotated_value is not None:
        return bool(annotated_value)
    return Imagen.objects.filter(modulo_id=modulo.pk).filter(SD_IMAGE_FILTER).exists()
