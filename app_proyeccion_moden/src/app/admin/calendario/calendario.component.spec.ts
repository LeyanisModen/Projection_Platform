import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { CalendarEvent, OfficeWorker, CheckDeadline} from '../../services/api.service';
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
        http.expectOne(r => r.url === '/api/proyecto-checklist/vencimientos/').flush([]);
        fixture.detectChanges();
    });
    afterEach(() => http.verify());

    function openEditor(event?: CalendarEvent): void {
        fixture.componentInstance.editEvent(event);
        http.expectOne(r => r.url === '/api/eventos/' && r.method === 'GET').flush(events);
    }

    function finishLoad(start: string, end: string, data = events, deadlines: CheckDeadline[] = []): void {
        const request = http.expectOne(r => r.url === '/api/eventos/');
        expect(request.request.params.get('desde')).toBe(start);
        expect(request.request.params.get('hasta')).toBe(end);
        request.flush(data);
        http.expectOne('/api/proyectos/').flush({results: [], next: null, count: 0});
        http.expectOne('/api/trabajadores/').flush(workers);
        const deadlinesRequest = http.expectOne(r => r.url === '/api/proyecto-checklist/vencimientos/');
        expect(deadlinesRequest.request.params.get('desde')).toBe(start);
        expect(deadlinesRequest.request.params.get('hasta')).toBe(end);
        deadlinesRequest.flush(deadlines);
        fixture.detectChanges();
    }

    it('reserves weekly bars for events, with all participants colors', () => {
        const bars: NodeListOf<HTMLElement> = fixture.nativeElement.querySelectorAll('.event-bar');
        expect(bars.length).toBe(1);
        expect(bars[0].style.gridColumn).toContain('span 3');
        const shared = Array.from(bars).find(b => b.textContent?.includes('Trabajo conjunto'))!;
        expect(shared.querySelectorAll('.color-strip span').length).toBe(2);
        expect(shared.getAttribute('aria-label')).toContain('Ana, Luis');
    });
    it('selects the bar date to show the daily agenda', () => {
        fixture.componentInstance.selected.set('2026-09-01');
        const bar: HTMLButtonElement = fixture.nativeElement.querySelector('.event-bar');
        bar.click(); fixture.detectChanges();
        expect(fixture.componentInstance.selected()).toBe('2026-09-15');
        expect(fixture.nativeElement.querySelector('.day-agenda').textContent).toContain('Trabajo conjunto');
        expect(fixture.nativeElement.querySelector('.day-agenda').textContent).toContain('Vacaciones de Ana');
    });
    it('filters without losing the colors of the shared event', () => {
        fixture.componentInstance.workerFilter.set(2); fixture.detectChanges();
        expect(fixture.nativeElement.querySelectorAll('.event-bar').length).toBe(1);
        expect(fixture.nativeElement.querySelectorAll('.event-bar .color-strip span').length).toBe(2);
    });
    it('persists a new color and recolors shading and events without altering their data', () => {
        const component = fixture.componentInstance;
        component.editWorker(workers[0]); component.workerDraftColor = '#2563eb'; component.saveWorker();
        const request = http.expectOne('/api/trabajadores/1/');
        expect(request.request.method).toBe('PATCH');
        expect(request.request.body).toEqual({id: 1, nombre: 'Ana', color: '#2563eb'});
        request.flush({...workers[0], color: '#2563eb'}); fixture.detectChanges();
        const stripe: HTMLElement = fixture.nativeElement.querySelector('.event-bar .color-strip span');
        const shade: HTMLElement = fixture.nativeElement.querySelector('.vacation-shading span');
        expect(stripe.style.backgroundColor).toBe('rgb(37, 99, 235)');
        expect(shade.style.backgroundColor).toBe('rgb(37, 99, 235)');
        expect(component.events()).toEqual(events);
        expect(component.workerId).toBeNull();
    });

    it('shades every inclusive vacation day without consuming event lanes', () => {
        const days: NodeListOf<HTMLElement> = fixture.nativeElement.querySelectorAll('button.day.has-vacations');
        expect(days).toHaveLength(10);
        expect(days[0].getAttribute('aria-label')).toContain('07/09/2026, Vacaciones de Ana, 0 eventos');
        expect(days[9].getAttribute('aria-label')).toContain('16/09/2026, Vacaciones de Ana, 1 eventos');
        expect(days[0].querySelector('.vacation-shading')?.getAttribute('aria-hidden')).toBe('true');
        expect(fixture.componentInstance.calendars()[0].weeks[1].lanes).toBe(0);
        expect(fixture.componentInstance.calendarItems().some(item => item.key === 'event-1')).toBe(false);
    });

    it('shows each overlapping vacation worker once and keeps the shared event above them', () => {
        const component = fixture.componentInstance;
        component.events.set([...events,
            {...events[0], id: 3, trabajadores: [2], inicio: '2026-09-15'},
            {...events[0], id: 4, inicio: '2026-09-15'},
        ]);
        fixture.detectChanges();
        const day: HTMLElement = fixture.nativeElement.querySelector('button.day[aria-label^="15/09/2026"]');
        expect(day.querySelectorAll('.vacation-shading span')).toHaveLength(2);
        expect(day.title).toBe('Vacaciones de Ana, Luis');
        expect(day.getAttribute('aria-label')).toContain('1 eventos');
        expect(fixture.nativeElement.querySelectorAll('.event-bar')).toHaveLength(1);
        component.workerFilter.set(2); fixture.detectChanges();
        expect(day.querySelectorAll('.vacation-shading span')).toHaveLength(1);
        expect(day.title).toBe('Vacaciones de Luis');
        expect(fixture.nativeElement.querySelectorAll('.event-bar .color-strip span')).toHaveLength(2);
    });

    it('opens vacation details and editing from a shaded day', () => {
        const component = fixture.componentInstance;
        const day: HTMLButtonElement = fixture.nativeElement.querySelector('button.day[aria-label^="07/09/2026"]');
        day.click(); fixture.detectChanges();
        expect(component.selected()).toBe('2026-09-07');
        expect(fixture.nativeElement.querySelector('.day-agenda').textContent).toContain('Vacaciones de Ana');
        fixture.nativeElement.querySelector('.agenda-event button').click();
        http.expectOne(r => r.url === '/api/eventos/' && r.method === 'GET').flush(events);
        expect(component.editorOpen()).toBe(true);
        expect(component.draft.tipo).toBe('VACACIONES');
        expect(component.draft.id).toBe(1);
    });

    it('keeps project filters on calendar content without changing actual availability', () => {
        const component = fixture.componentInstance;
        component.events.set([events[0], {...events[1], proyecto: 7}]);
        component.selected.set('2026-09-15');
        component.projectFilter.set(7); fixture.detectChanges();
        expect(fixture.nativeElement.querySelectorAll('.vacation-shading')).toHaveLength(0);
        expect(fixture.nativeElement.querySelectorAll('.event-bar')).toHaveLength(1);
        expect(component.availability()[0].holiday).toBe(true);
        component.projectFilter.set(null); fixture.detectChanges();
        expect(fixture.nativeElement.querySelectorAll('.vacation-shading')).toHaveLength(10);
    });

    it('shades neighboring dates in month view but only actual month cells in compact views', () => {
        const component = fixture.componentInstance;
        const boundary = [{...events[0], inicio: '2026-08-31', fin: '2026-09-02'}];
        component.events.set(boundary); fixture.detectChanges();
        expect(fixture.nativeElement.querySelectorAll('.vacation-shading')).toHaveLength(3);
        expect(fixture.nativeElement.querySelector('.day.outside .vacation-shading')).not.toBeNull();
        component.setView('quarter'); finishLoad('2026-09-01', '2026-11-30', boundary);
        expect(fixture.nativeElement.querySelectorAll('.vacation-shading')).toHaveLength(2);
        expect(fixture.nativeElement.querySelector('.empty-day .vacation-shading')).toBeNull();
    });
    it('offers a color selector when adding a person', () => {
        fixture.componentInstance.openTeam(); fixture.detectChanges();
        expect(fixture.nativeElement.querySelector('input[type=color]')).not.toBeNull();
        expect(fixture.nativeElement.querySelectorAll('.color-palette button').length).toBe(8);
    });

    it('loads the entire rolling quarter in one request and moves one month at a time', () => {
        const component = fixture.componentInstance;
        component.setView('quarter');
        finishLoad('2026-09-01', '2026-11-30');
        expect(fixture.nativeElement.querySelectorAll('.month-grid').length).toBe(3);
        expect(component.calendars().map(c => c.key)).toEqual(['2026-09-01','2026-10-01','2026-11-01']);
        expect(fixture.nativeElement.querySelectorAll('button.day.outside').length).toBe(0);
        component.changeMonth(1);
        finishLoad('2026-10-01', '2026-12-31');
        component.changeMonth(1);
        finishLoad('2026-11-01', '2027-01-31');
    });

    it('renders all months in annual view and navigates by year', () => {
        const component = fixture.componentInstance;
        component.setView('year');
        finishLoad('2026-01-01', '2026-12-31');
        expect(fixture.nativeElement.querySelectorAll('.month-grid').length).toBe(12);
        expect(fixture.nativeElement.querySelectorAll('button.day').length).toBe(365);
        component.changeMonth(1);
        finishLoad('2027-01-01', '2027-12-31');
        expect(component.title()).toBe('2027');
        component.changeMonth(-1);
        finishLoad('2026-01-01', '2026-12-31');
    });

    it('preserves filters and selected dates when opening a month from annual view', () => {
        const component = fixture.componentInstance;
        component.workerFilter.set(1);
        component.setView('year');
        finishLoad('2026-01-01', '2026-12-31');
        component.selected.set('2026-10-12');
        component.openMonth(new Date(2026, 9, 1));
        finishLoad('2026-09-28', '2026-11-08');
        expect(component.view()).toBe('month');
        expect(component.selected()).toBe('2026-10-12');
        expect(component.workerFilter()).toBe(1);
        expect(fixture.nativeElement.querySelectorAll('.month-grid').length).toBe(1);
    });

    it('shows availability in later months of a quarter', () => {
        const component = fixture.componentInstance;
        component.setView('quarter');
        finishLoad('2026-09-01', '2026-11-30', [{...events[0], inicio: '2026-11-10', fin: '2026-11-20'}]);
        component.selected.set('2026-11-15'); fixture.detectChanges();
        expect(component.availability().find(w => w.id === 1)?.holiday).toBe(true);
        expect(component.selectedEvents()).toHaveLength(1);
    });

    it('returns to today without leaving the chosen view', () => {
        const component = fixture.componentInstance;
        component.setView('quarter'); finishLoad('2026-09-01', '2026-11-30');
        component.month.set(new Date(2030, 0, 1));
        component.goToday();
        finishLoad(component.range().start, component.range().end);
        expect(component.view()).toBe('quarter');
        expect(component.selected()).toBe(component.today);
        expect(component.month().getFullYear()).toBe(new Date().getFullYear());
    });

    it('muestra las fechas límite de la lista de control en la rejilla y en la agenda del día', () => {
        const component = fixture.componentInstance;
        component.load();
        finishLoad('2026-08-31', '2026-10-11', events, [
            {id: 5, proyecto: 3, proyecto_nombre: 'Valdebebas', titulo: 'Aprobación equivalencias', fecha_limite: '2026-09-10', completado: false},
            {id: 6, proyecto: 3, proyecto_nombre: 'Valdebebas', titulo: 'Planos entregados', fecha_limite: '2026-09-10', completado: true},
        ]);
        const bars = Array.from(fixture.nativeElement.querySelectorAll('.event-bar.control')) as HTMLElement[];
        expect(bars.map(b => b.querySelector('.event-label')?.textContent?.trim())).toEqual([
            'Control · Valdebebas · Aprobación equivalencias', '✓ Control · Valdebebas · Planos entregados',
        ]);
        expect(bars[1].classList.contains('done')).toBe(true);

        const day: HTMLButtonElement = fixture.nativeElement.querySelector('button.day[aria-label^="10/09/2026"]');
        day.click(); fixture.detectChanges();
        const agenda = fixture.nativeElement.querySelector('.day-agenda').textContent;
        expect(agenda).toContain('Fecha límite · Aprobación equivalencias');
        expect(agenda).toContain('Completado · Planos entregados');
        expect(fixture.nativeElement.querySelector('.agenda-event.control a').getAttribute('href')).toBe('/admin-dashboard/proyectos/3');

        component.projectFilter.set(99); fixture.detectChanges();
        expect(fixture.nativeElement.querySelectorAll('.event-bar.control').length).toBe(0);
    });

    it('cancels older loads so stale responses cannot overwrite the current range', () => {
        const component = fixture.componentInstance;
        component.setView('year');
        const oldEvents = http.expectOne(r => r.url === '/api/eventos/');
        const oldProjects = http.expectOne('/api/proyectos/');
        const oldWorkers = http.expectOne('/api/trabajadores/');
        const oldDeadlines = http.expectOne(r => r.url === '/api/proyecto-checklist/vencimientos/');
        component.load();
        expect(oldEvents.cancelled && oldProjects.cancelled && oldWorkers.cancelled && oldDeadlines.cancelled).toBe(true);
        finishLoad('2026-01-01', '2026-12-31');
    });

    it('separates event and vacation fields with keyboard-accessible tabs', () => {
        const component = fixture.componentInstance;
        openEditor(); fixture.detectChanges();
        expect(fixture.nativeElement.querySelector('input[name=title]')).not.toBeNull();
        expect(fixture.nativeElement.querySelector('select[name=project]')).not.toBeNull();
        const tab: HTMLButtonElement = fixture.nativeElement.querySelector('#event-tab');
        tab.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowRight', bubbles: true}));
        fixture.detectChanges();
        expect(component.draft.tipo).toBe('VACACIONES');
        expect(fixture.nativeElement.querySelector('#holiday-tab').getAttribute('aria-selected')).toBe('true');
        expect(fixture.nativeElement.querySelector('input[name=title]')).toBeNull();
        expect(fixture.nativeElement.querySelector('select[name=project]')).toBeNull();
        const person: HTMLInputElement = fixture.nativeElement.querySelector('.person-check input');
        person.checked = true; person.dispatchEvent(new Event('change', {bubbles: true})); fixture.detectChanges();
        expect(fixture.nativeElement.querySelector('.holiday-preview').textContent).toContain('Vacaciones de Ana');
    });

    it('saves vacations without a manual title, removes project association and preserves notes and people', () => {
        const component = fixture.componentInstance;
        openEditor(); component.setEventType('VACACIONES');
        component.draft.inicio = '2026-09-10'; component.draft.fin = '2026-09-11';
        component.draft.proyecto = 20; component.draft.notas = 'Notas';
        component.saveEvent();
        expect(component.editorError()).toContain('persona');
        http.expectNone('/api/eventos/');
        component.setWorker(1, true); component.setWorker(2, true); component.saveEvent();
        const request = http.expectOne('/api/eventos/');
        expect(request.request.method).toBe('POST');
        expect(request.request.body).toEqual({tipo: 'VACACIONES', titulo: 'Vacaciones de Ana, Luis',
            inicio: '2026-09-10', fin: '2026-09-11', proyecto: null, trabajadores: [1,2], notas: 'Notas'});
        request.flush({}); finishLoad(component.range().start, component.range().end);
        expect(component.editorOpen()).toBe(false);
    });

    it('keeps the event draft when switching tabs and validates title and dates', () => {
        const component = fixture.componentInstance;
        openEditor(); component.saveEvent();
        expect(component.editorError()).toContain('título');
        component.draft.titulo = 'Visita'; component.draft.proyecto = 30;
        component.setEventType('VACACIONES'); component.setEventType('EVENTO');
        expect(component.draft.titulo).toBe('Visita'); expect(component.draft.proyecto).toBe(30);
        component.draft.inicio = '2026-09-12'; component.draft.fin = '2026-09-11'; component.saveEvent();
        expect(component.editorError()).toContain('fechas');
        http.expectNone('/api/eventos/');
    });

    it('marks assigned events as out of office regardless of calendar filters', () => {
        const component = fixture.componentInstance;
        component.selected.set('2026-09-15'); component.projectFilter.set(99); component.workerFilter.set(1);
        fixture.detectChanges();
        expect(component.availability().find(w => w.id===1)?.holiday).toBe(true);
        expect(component.availability().find(w => w.id===2)?.away).toBe(true);
        expect(fixture.nativeElement.querySelector('.availability').textContent).toContain('Fuera de la oficina');
        component.selected.set('2026-09-17');
        expect(component.availability().every(w => w.away && !w.holiday)).toBe(true);
        component.selected.set('2026-09-18');
        expect(component.availability().every(w => !w.away && !w.holiday)).toBe(true);
        component.events.set([{...events[1], trabajadores: []}]);
        component.selected.set('2026-09-15');
        expect(component.availability().every(w => !w.away)).toBe(true);
    });

    it('adds and selects a person inside the editor without losing its draft or saving the event', () => {
        const component = fixture.componentInstance;
        openEditor(); component.draft.titulo = 'Visita pendiente'; component.setWorker(1, true);
        component.openAddPerson(); component.newPersonName = ' Clara '; component.newPersonColor = '#b45309';
        component.saveEvent(); http.expectNone('/api/eventos/');
        component.addPerson();
        const request = http.expectOne('/api/trabajadores/');
        expect(request.request.body).toEqual({nombre: 'Clara', color: '#b45309'});
        component.closeEditor(); expect(component.editorOpen()).toBe(true);
        request.flush({id: 3, nombre: 'Clara', color: '#b45309', activo: true}); fixture.detectChanges();
        expect(component.draft.titulo).toBe('Visita pendiente');
        expect(component.draft.trabajadores).toEqual([1,3]);
        expect(component.addingPerson()).toBe(false);
        expect(component.editorOpen()).toBe(true);
        expect(component.teamOpen()).toBe(false);
        http.expectNone('/api/eventos/');
    });

    it('keeps the inline person editor and draft on error', () => {
        const component = fixture.componentInstance;
        openEditor(); component.openAddPerson(); component.addPerson();
        expect(component.personError()).toContain('nombre'); http.expectNone('/api/trabajadores/');
        component.newPersonName = 'Clara'; component.addPerson();
        http.expectOne('/api/trabajadores/').flush({}, {status: 500, statusText: 'Error'});
        expect(component.personError()).toContain('reintentar');
        expect(component.addingPerson()).toBe(true); expect(component.busy()).toBe(false);
        expect(component.newPersonName).toBe('Clara');
    });

    it('shows a compact vacation year with overlapping colors, independent of project filters', () => {
        const component = fixture.componentInstance;
        component.projectFilter.set(99); component.setView('holidays');
        finishLoad('2026-01-01', '2026-12-31', [...events, {...events[0], id: 3, trabajadores: [2], inicio: '2026-09-15'}]);
        expect(fixture.nativeElement.querySelectorAll('.month-grid')).toHaveLength(12);
        expect(fixture.nativeElement.querySelectorAll('.event-bar')).toHaveLength(0);
        expect(fixture.nativeElement.querySelectorAll('button.day')).toHaveLength(365);
        const day = component.calendars().flatMap(c => c.weeks).flatMap(w => w.days).find(d => d.key==='2026-09-15' && d.current)!;
        expect(day.vacationWorkers.map(w => w.id)).toEqual([1,2]);
        expect(component.calendarItems().some(item => item.title === 'Trabajo conjunto')).toBe(false);
        component.workerFilter.set(2); fixture.detectChanges();
        expect(component.legendWorkers().map(w => w.id)).toEqual([2]);
        component.changeMonth(1); finishLoad('2027-01-01', '2027-12-31');
        expect(component.title()).toBe('2027');
        component.setView('month'); finishLoad('2027-08-30', '2027-10-10');
        expect(component.projectFilter()).toBe(99);
    });

    it('prints only a loaded calendar with no open editor', () => {
        const print = vi.spyOn(window, 'print').mockImplementation(() => {});
        const component = fixture.componentInstance;
        try {
            component.printCalendar(); expect(print).toHaveBeenCalledTimes(1);
            component.loading.set(true); component.printCalendar();
            component.loading.set(false); component.error.set('Error'); component.printCalendar();
            component.error.set(''); openEditor(); component.printCalendar();
            component.closeEditor(); component.openTeam(); component.printCalendar();
            expect(print).toHaveBeenCalledTimes(1);
        } finally { print.mockRestore(); }
    });

    it('includes historical inactive people, deduplicates overlapping holidays and clips year boundaries', () => {
        const component = fixture.componentInstance;
        component.workers.set([...workers, {id: 3, nombre: 'Clara', activo: false, color: '#2563eb'}]);
        component.view.set('holidays');
        component.events.set([
            {...events[0], trabajadores: [1,3], inicio: '2025-12-29', fin: '2026-01-02'},
            {...events[0], id: 3, inicio: '2026-01-01', fin: '2026-01-02'},
            {...events[1], inicio: '2026-01-03', fin: '2026-01-03'},
        ]);
        const days = component.calendars().flatMap(c => c.weeks).flatMap(w => w.days).filter(d => d.current);
        expect(days.find(d => d.key === '2026-01-01')?.vacationWorkers.map(w => w.id)).toEqual([1,3]);
        expect(days.find(d => d.key === '2026-01-03')?.vacationWorkers).toEqual([]);
        expect(component.legendWorkers().some(w => w.id === 3)).toBe(true);
        expect(days.some(d => d.key.startsWith('2025'))).toBe(false);
    });

    it('warns about vacations and events independently of filters, without disabling selection or save', () => {
        const component = fixture.componentInstance;
        component.selected.set('2026-09-15'); component.projectFilter.set(99); component.workerFilter.set(2);
        openEditor(); fixture.detectChanges();
        expect(component.conflictsByWorker().get(1)?.map(e => e.id)).toEqual([1,2]);
        expect(component.conflictsByWorker().get(2)?.map(e => e.id)).toEqual([2]);
        const checkbox: HTMLInputElement = fixture.nativeElement.querySelector('.person-check input');
        expect(checkbox.disabled).toBe(false);
        const description = fixture.nativeElement.querySelector('#' + checkbox.getAttribute('aria-describedby'));
        expect(description.textContent).toContain('Vacaciones');
        expect(description.textContent).toContain('Otro evento: Trabajo conjunto');
        expect(description.textContent).toContain('16/09/2026');
        checkbox.checked = true; checkbox.dispatchEvent(new Event('change', {bubbles: true}));
        component.draft.titulo = 'Segunda cita'; component.saveEvent();
        const save = http.expectOne(r => r.url === '/api/eventos/' && r.method === 'POST');
        expect(save.request.body.trabajadores).toEqual([1]);
        save.flush({}); finishLoad(component.range().start, component.range().end);
        expect(component.editorOpen()).toBe(false);
    });

    it('queries the complete draft range outside the displayed month and excludes the edited event', () => {
        const component = fixture.componentInstance;
        const editing = {...events[1], inicio: '2026-12-30', fin: '2027-01-03'};
        component.editEvent(editing);
        const query = http.expectOne(r => r.url === '/api/eventos/' && r.method === 'GET');
        expect(query.request.params.keys().sort()).toEqual(['desde','hasta']);
        expect(query.request.params.get('desde')).toBe('2026-12-30');
        expect(query.request.params.get('hasta')).toBe('2027-01-03');
        query.flush([editing,
            {...events[0], inicio: '2026-12-25', fin: '2026-12-30'},
            {...events[1], id: 3, inicio: '2027-01-03', fin: '2027-01-04'},
            {...events[1], id: 4, inicio: '2027-01-04', fin: '2027-01-05'},
        ]);
        expect(component.conflictEvents().map(e => e.id)).toEqual([1,3]);
        expect(component.events()).toEqual(events);
        expect(component.month().getMonth()).toBe(8);
    });

    it('clears stale warnings and cancels checks when dates change or the editor closes', () => {
        const component = fixture.componentInstance;
        component.selected.set('2026-09-15'); openEditor();
        expect(component.conflictEvents()).toHaveLength(2);
        component.setDraftDate('fin', '2026-10-03');
        const old = http.expectOne(r => r.url === '/api/eventos/');
        expect(component.conflictEvents()).toEqual([]); expect(component.checkingConflicts()).toBe(true);
        component.setDraftDate('inicio', '2026-10-01');
        expect(old.cancelled).toBe(true);
        const current = http.expectOne(r => r.url === '/api/eventos/');
        expect(current.request.params.get('desde')).toBe('2026-10-01');
        expect(current.request.params.get('hasta')).toBe('2026-10-03');
        current.flush([]);
        expect(component.conflictEvents()).toEqual([]); expect(component.checkingConflicts()).toBe(false);
        component.checkConflicts(); const closing = http.expectOne(r => r.url === '/api/eventos/');
        component.closeEditor(); expect(closing.cancelled).toBe(true);
        expect(component.checkingConflicts()).toBe(false);
    });

    it('does not query invalid or incomplete dates and retains selected people', () => {
        const component = fixture.componentInstance;
        openEditor(); component.setWorker(1, true);
        component.setDraftDate('fin', '');
        component.setDraftDate('inicio', '2026-02-30');
        component.setDraftDate('fin', '2026-01-01');
        expect(component.conflictDatesValid()).toBe(false);
        expect(component.conflictEvents()).toEqual([]);
        expect(component.draft.trabajadores).toEqual([1]);
        http.expectNone(r => r.url === '/api/eventos/');
    });

    it('shows a failed check as unknown, supports retry and still allows saving', () => {
        const component = fixture.componentInstance;
        component.editEvent();
        http.expectOne(r => r.url === '/api/eventos/').flush({}, {status: 503, statusText: 'Unavailable'});
        fixture.detectChanges();
        expect(fixture.nativeElement.querySelector('.conflict-status').textContent).toContain('guardar igualmente');
        expect(fixture.nativeElement.querySelectorAll('.person-clear')).toHaveLength(0);
        expect(component.busy()).toBe(false);
        component.checkConflicts(); http.expectOne(r => r.url === '/api/eventos/').flush([]);
        fixture.detectChanges();
        expect(component.conflictError()).toBe('');
        expect(fixture.nativeElement.querySelectorAll('.person-clear')).toHaveLength(2);
        component.checkConflicts();
        http.expectOne(r => r.url === '/api/eventos/').flush({}, {status: 503, statusText: 'Unavailable'});
        component.draft.titulo = 'Cita'; component.setWorker(1, true); component.saveEvent();
        http.expectOne(r => r.url === '/api/eventos/' && r.method === 'POST').flush({});
        finishLoad(component.range().start, component.range().end);
        expect(component.editorOpen()).toBe(false);
    });

    it('does not wait for an advisory request to complete before saving', () => {
        const component = fixture.componentInstance;
        component.editEvent(); const pending = http.expectOne(r => r.url === '/api/eventos/');
        component.draft.titulo = 'Cita'; component.setWorker(2, true); component.saveEvent();
        http.expectOne(r => r.url === '/api/eventos/' && r.method === 'POST').flush({});
        expect(pending.cancelled).toBe(true);
        finishLoad(component.range().start, component.range().end);
        expect(component.editorOpen()).toBe(false);
    });
});
