"""Authenticated serving of /media/ (docs/08_auditoria_2026-09.md, 1.1).

Images are loaded by the browser with <img src> and new Image(), which
cannot send an Authorization header, so besides the header this view also
accepts two same-origin cookies scoped to /media/:

- ``moden_auth``   -> DRF user token (dashboard, admin, supervisor visor)
- ``moden_device`` -> raw mesa token (player kiosk on the mini-PC)

Both cookies are written by MediaCookieMiddleware on any authenticated API
response and by the login endpoint, so no frontend flow has to remember to
set them. The stored URLs (``/media/...``, relative) do not change.

Authorization mirrors the API querysets: staff sees everything, a ferralla
user only its own projects, and a paired mesa reads whatever the planner
assigned to it. MEDIA_REQUIRE_AUTH=False restores the old public behaviour
as an emergency switch.
"""
import hashlib
import posixpath

from django.conf import settings
from django.http import JsonResponse
from django.views.static import serve
from rest_framework.authtoken.models import Token

from api.models import Mesa, Proyecto

USER_COOKIE = 'moden_auth'
DEVICE_COOKIE = 'moden_device'
COOKIE_MAX_AGE = 365 * 24 * 3600

# Top-level media folders whose file name is stored on the project itself.
PROJECT_FILE_FIELDS = {
    'planos': 'plano_archivo',
    'documentos': 'documentos_archivo',
    'datos_tecnicos': 'fichero_datos_tecnicos',
}
# Folders laid out as <folder>/<proyecto_id>/<modulo_id>/<file>.
PROJECT_SCOPED_FOLDERS = ('imagenes', 'fotos')


def cookie_kwargs():
    return {
        'max_age': COOKIE_MAX_AGE,
        'path': settings.MEDIA_URL,
        'secure': settings.HTTPS_ONLY,
        'httponly': False,  # the frontend clears it on logout
        'samesite': 'Lax',
    }


def set_user_cookie(response, key):
    response.set_cookie(USER_COOKIE, key, **cookie_kwargs())


def set_device_cookie(response, raw_token):
    response.set_cookie(DEVICE_COOKIE, raw_token, **cookie_kwargs())


def resolve_principal(request):
    """Return (user, mesa) for the credentials found on the request.

    Header first, then cookies. Either side may be None; both None means
    anonymous.
    """
    auth = request.META.get('HTTP_AUTHORIZATION', '')
    user_key = device_raw = None
    if auth.startswith('Token '):
        user_key = auth[len('Token '):].strip()
    elif auth.startswith('Bearer '):
        device_raw = auth[len('Bearer '):].strip()
    user_key = user_key or request.COOKIES.get(USER_COOKIE)
    device_raw = device_raw or request.COOKIES.get(DEVICE_COOKIE)

    user = None
    if user_key:
        token = Token.objects.select_related('user').filter(key=user_key).first()
        if token is not None and token.user.is_active:
            user = token.user

    mesa = None
    if device_raw:
        token_hash = hashlib.sha256(device_raw.encode()).hexdigest()
        mesa = Mesa.objects.filter(device_token_hash=token_hash).first()

    return user, mesa


def user_may_read(user, rel_path):
    if user.is_staff or user.is_superuser:
        return True
    parts = rel_path.split('/')
    folder = parts[0]
    if folder in PROJECT_SCOPED_FOLDERS:
        if len(parts) < 2 or not parts[1].isdigit():
            return False
        return Proyecto.objects.filter(pk=int(parts[1]), usuario=user).exists()
    field = PROJECT_FILE_FIELDS.get(folder)
    if field:
        return Proyecto.objects.filter(usuario=user, **{field: rel_path}).exists()
    return False


def protected_media(request, path):
    rel_path = posixpath.normpath(path.replace('\\', '/')).lstrip('/')

    if settings.MEDIA_REQUIRE_AUTH:
        user, mesa = resolve_principal(request)
        if user is None and mesa is None:
            return JsonResponse({'detail': 'Authentication required'}, status=401)
        allowed = mesa is not None or (user is not None and user_may_read(user, rel_path))
        if not allowed:
            return JsonResponse({'detail': 'Forbidden'}, status=403)

    response = serve(request, rel_path, document_root=settings.MEDIA_ROOT)
    # Browser cache is fine (Last-Modified/304 keep working); shared caches
    # must not store per-user content.
    response['Cache-Control'] = 'private, max-age=0, must-revalidate'
    return response


class MediaCookieMiddleware:
    """Mirror the credential used on an API call into the /media/ cookies.

    DRF stores the resolved auth on the underlying HttpRequest (request.auth
    is the Token for user calls); DeviceViewSet._authenticate_device sets
    request.moden_device_token for mini-PC calls. Only writes the cookie
    when it is missing or stale, so polling endpoints do not re-send it.
    """

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        response = self.get_response(request)
        if not settings.MEDIA_REQUIRE_AUTH:
            return response

        device_token = getattr(request, 'moden_device_token', None)
        if device_token and request.COOKIES.get(DEVICE_COOKIE) != device_token:
            set_device_cookie(response, device_token)

        user_key = getattr(getattr(request, 'auth', None), 'key', None)
        if user_key and request.COOKIES.get(USER_COOKIE) != user_key:
            set_user_cookie(response, user_key)

        return response
