import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { retry, throwError, timer } from 'rxjs';

/** Lo que se puede repetir sin hacerlo dos veces (los POST no). */
const METODOS = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);
/** Lo que responde nginx mientras el servidor no escucha. */
const ARRANCANDO = new Set([502, 503, 504]);
/** Esperas entre intentos: unos 15 s en total, lo que tarda en arrancar. */
export const ESPERAS_MS = [1000, 2000, 3000, 4000, 5000];

/**
 * Staging se duerme a los diez minutos sin uso y la primera peticion llega
 * mientras arranca: nginx responde 502 y la pantalla daba error aunque al
 * momento funcionaba. Se repite sola unas veces antes de dar el error.
 */
export const reintentarSiArranca: HttpInterceptorFn = (req, next) => {
  if (!METODOS.has(req.method)) return next(req);
  return next(req).pipe(retry({
    count: ESPERAS_MS.length,
    delay: (error, intento) => error instanceof HttpErrorResponse && ARRANCANDO.has(error.status)
      ? timer(ESPERAS_MS[intento - 1])
      : throwError(() => error),
  }));
};
