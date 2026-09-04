import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { CalendarEvent, OfficeWorker } from '../../services/api.service';
import { CalendarioComponent } from './calendario.component';

describe('CalendarioComponent', () => {
    let fixture: ComponentFixture<CalendarioComponent>;
    let http: HttpTestingController;
    const workers: OfficeWorker[] = [
        {id: 1, nombre: 'Ana', activo: true, color: '#be185d'},
        {id: 2, nombre: 'Luis', activo: true, color: '#0f766e'},
    ];
    const events: CalendarEvent[] = [
        {id: 1, titulo: 'Vacaciones Ana', tipo: 'VACACIONES', inicio: '2026-09-07', fin: '2026-09-16', trabajadores: [1], proyecto: null, notas: ''},
        {id: 2, titulo: 'Trabajo conjunto', tipo: 'EVENTO', inicio: '2026-09-15', fin: '2026-09-17', trabajadores: [1,2], proyecto: null, notas: ''},
    ];
    beforeEach(async () => {
        await TestBed.configureTestingModule({imports: [CalendarioComponent], providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()]}).compileComponents();
        http = TestBed.inject(HttpTestingController);
        fixture = TestBed.createComponent(CalendarioComponent);
        fixture.componentInstance.month.set(new Date(2026, 8, 1));
        http.expectOne(r => r.url === '/api/eventos/').flush(events);
        http.expectOne('/api/proyectos/').flush({results: [], next: null, count: 0});
        http.expectOne('/api/trabajadores/').flush(workers);
        fixture.detectChanges();
    });
    afterEach(() => http.verify());

    it('renders weekly bars instead of daily copies, with all participants colors', () => {
        const bars: NodeListOf<HTMLElement> = fixture.nativeElement.querySelectorAll('.event-bar');
        expect(bars.length).toBe(3);
        expect(bars[0].style.gridColumn).toContain('span 7');
        const shared = Array.from(bars).find(b => b.textContent?.includes('Trabajo conjunto'))!;
        expect(shared.querySelectorAll('.color-strip span').length).toBe(2);
        expect(shared.getAttribute('aria-label')).toContain('Ana, Luis');
    });
    it('selects the bar date to show the daily agenda', () => {
        const bar: HTMLButtonElement = fixture.nativeElement.querySelector('.event-bar');
        bar.click(); fixture.detectChanges();
        expect(fixture.componentInstance.selected()).toBe('2026-09-07');
        expect(fixture.nativeElement.querySelector('.day-agenda').textContent).toContain('Vacaciones Ana');
    });
    it('filters without losing the colors of the shared event', () => {
        fixture.componentInstance.workerFilter.set(2); fixture.detectChanges();
        expect(fixture.nativeElement.querySelectorAll('.event-bar').length).toBe(1);
        expect(fixture.nativeElement.querySelectorAll('.event-bar .color-strip span').length).toBe(2);
    });
    it('persists a new color and recolors existing bars without altering events', () => {
        const component = fixture.componentInstance;
        component.editWorker(workers[0]); component.workerDraftColor = '#2563eb'; component.saveWorker();
        const request = http.expectOne('/api/trabajadores/1/');
        expect(request.request.method).toBe('PATCH');
        expect(request.request.body).toEqual({id: 1, nombre: 'Ana', color: '#2563eb'});
        request.flush({...workers[0], color: '#2563eb'}); fixture.detectChanges();
        const bar: HTMLElement = fixture.nativeElement.querySelector('.event-bar');
        expect(bar.style.getPropertyValue('--event-color')).toBe('#2563eb');
        expect(component.events()).toEqual(events);
        expect(component.workerId).toBeNull();
    });
    it('offers a color selector when adding a person', () => {
        fixture.componentInstance.openTeam(); fixture.detectChanges();
        expect(fixture.nativeElement.querySelector('input[type=color]')).not.toBeNull();
        expect(fixture.nativeElement.querySelectorAll('.color-palette button').length).toBe(8);
    });
});
