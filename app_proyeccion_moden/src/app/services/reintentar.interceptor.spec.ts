import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { reintentarSiArranca } from './reintentar.interceptor';

describe('Reintentar mientras el servidor arranca', () => {
  let http: HttpClient;
  let backend: HttpTestingController;

  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(withInterceptors([reintentarSiArranca])), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpClient);
    backend = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    backend.verify();
    vi.useRealTimers();
  });

  it('repeats a PUT that got a 502 until the server answers', () => {
    let respuesta: unknown = null;
    http.put('/api/x/', { a: 1 }).subscribe(r => (respuesta = r));
    backend.expectOne('/api/x/').flush('', { status: 502, statusText: 'Bad Gateway' });
    vi.advanceTimersByTime(1000);
    backend.expectOne('/api/x/').flush('', { status: 502, statusText: 'Bad Gateway' });
    vi.advanceTimersByTime(2000);
    backend.expectOne('/api/x/').flush({ ok: true });
    expect(respuesta).toEqual({ ok: true });
  });

  it('does not repeat a POST nor a real error', () => {
    let error: { status?: number } | null = null;
    http.post('/api/x/', {}).subscribe({ error: e => (error = e) });
    backend.expectOne('/api/x/').flush('', { status: 502, statusText: 'Bad Gateway' });
    expect(error!.status).toBe(502);

    error = null;
    http.put('/api/y/', {}).subscribe({ error: e => (error = e) });
    backend.expectOne('/api/y/').flush({ detail: 'mal' }, { status: 400, statusText: 'Bad Request' });
    expect(error!.status).toBe(400);
  });
});
