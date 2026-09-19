import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MonitorComponent } from './monitor.component';

const TOKEN_URL = 'http://127.0.0.1:5555/device_token';
const state = (index: number, extra = {}) => ({
    id: 28, nombre: 'Mesa 2', image_url: null, current_image_index: index,
    blackout: false, locked: false, check_overlay: 'none', ...extra,
});
const item = {
    id: 5, modulo_nombre: 'M-101', fase: 'INFERIOR',
    images: [{url: '/media/imagenes/1/a.jpg'}, {url: '/media/imagenes/1/b.jpg'}],
};

describe('MonitorComponent', () => {
    let fixture: ComponentFixture<MonitorComponent>;
    let http: HttpTestingController;

    beforeEach(() => {
        vi.useFakeTimers();
        TestBed.configureTestingModule({
            imports: [MonitorComponent],
            providers: [provideHttpClient(), provideHttpClientTesting()],
        });
        http = TestBed.inject(HttpTestingController);
        fixture = TestBed.createComponent(MonitorComponent);
        fixture.detectChanges();
    });

    afterEach(() => {
        fixture.destroy();
        vi.useRealTimers();
        TestBed.resetTestingModule();
    });

    function pair(token = 'tok-1'): void {
        http.expectOne(TOKEN_URL).flush({device_token: token});
    }

    it('waits for the player token and retries without touching the backend', () => {
        http.expectOne(TOKEN_URL).flush({device_token: ''});
        fixture.detectChanges();
        expect(fixture.nativeElement.textContent).toContain('Esperando al player');
        http.expectNone('/api/device/state/');

        vi.advanceTimersByTime(5000);
        http.expectOne(TOKEN_URL).error(new ProgressEvent('error'));
        http.expectNone('/api/device/state/');
        http.verify();
    });

    it('mirrors the step the player is projecting, read-only', () => {
        pair();
        const stateRequest = http.expectOne('/api/device/state/');
        expect(stateRequest.request.method).toBe('GET');
        expect(stateRequest.request.headers.get('Authorization')).toBe('Bearer tok-1');
        stateRequest.flush(state(1));
        http.expectOne('/api/device/current_item/').flush(item);
        fixture.detectChanges();

        const element: HTMLElement = fixture.nativeElement;
        expect(element.querySelector('img')?.getAttribute('src')).toBe('/media/imagenes/1/b.jpg');
        expect(element.textContent).toContain('Mesa 2');
        expect(element.textContent).toContain('M-101');
        expect(element.textContent).toContain('2 / 2');

        vi.advanceTimersByTime(2000);
        http.expectOne('/api/device/state/').flush(state(0, {check_overlay: 'error'}));
        fixture.detectChanges();
        expect(element.querySelector('img')?.getAttribute('src')).toBe('/media/imagenes/1/a.jpg');
        expect(element.textContent).toContain('Check fallido');
        http.verify();
    });

    it('shows a note instead of an image during projector adjustment or without work', () => {
        pair();
        http.expectOne('/api/device/state/').flush(state(-1));
        http.expectOne('/api/device/current_item/').flush(item);
        fixture.detectChanges();
        expect(fixture.nativeElement.querySelector('img')).toBeNull();
        expect(fixture.nativeElement.textContent).toContain('Ajuste del proyector');

        vi.advanceTimersByTime(5000);
        http.match('/api/device/state/').forEach(request => request.flush(state(0)));
        http.expectOne('/api/device/current_item/').flush(null);
        fixture.detectChanges();
        expect(fixture.nativeElement.textContent).toContain('Sin trabajo en curso');
    });

    it('keeps the last picture on network errors and re-reads the token on 401', () => {
        pair();
        http.expectOne('/api/device/state/').flush(state(0));
        http.expectOne('/api/device/current_item/').flush(item);
        fixture.detectChanges();

        vi.advanceTimersByTime(2000);
        http.expectOne('/api/device/state/').error(new ProgressEvent('error'));
        fixture.detectChanges();
        expect(fixture.nativeElement.querySelector('img')?.getAttribute('src')).toBe('/media/imagenes/1/a.jpg');

        vi.advanceTimersByTime(2000);
        http.expectOne('/api/device/state/').flush({detail: 'Unauthorized'}, {status: 401, statusText: 'Unauthorized'});
        fixture.detectChanges();
        expect(fixture.nativeElement.textContent).toContain('Esperando al player');
        http.expectOne(TOKEN_URL).flush({device_token: 'tok-2'});
        expect(http.expectOne('/api/device/state/').request.headers.get('Authorization')).toBe('Bearer tok-2');
        http.expectOne('/api/device/current_item/').flush(item);
        http.verify();
    });
});
