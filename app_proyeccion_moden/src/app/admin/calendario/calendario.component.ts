import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { A11yModule } from '@angular/cdk/a11y';
import { forkJoin, Subscription } from 'rxjs';
import { ApiService, CalendarEvent, OfficeWorker, Proyecto } from '../../services/api.service';
import { CalendarItem, CalendarSegment, CalendarView, calendarMonths, calendarRange, calendarWeeks, localDate, monthDays, nextWorkerColor, workerColor, WORKER_COLORS } from './calendar-layout';

@Component({
    selector: 'app-calendario',
    imports: [CommonModule, FormsModule, RouterLink, A11yModule],
    templateUrl: './calendario.component.html',
    styleUrl: './calendario.component.css',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CalendarioComponent {
    private readonly api = inject(ApiService);
    private readonly destroyRef = inject(DestroyRef);
    private loadSubscription?: Subscription;
    readonly month = signal(new Date(new Date().getFullYear(), new Date().getMonth(), 1));
    readonly view = signal<CalendarView>('month');
    readonly viewOptions: {value: CalendarView; label: string}[] = [
        {value: 'month', label: 'Mensual'}, {value: 'quarter', label: 'Trimestral'}, {value: 'year', label: 'Anual'},
    ];
    readonly selected = signal(localDate(new Date()));
    readonly today = localDate(new Date());
    readonly events = signal<CalendarEvent[]>([]);
    readonly projects = signal<Proyecto[]>([]);
    readonly workers = signal<OfficeWorker[]>([]);
    readonly loading = signal(false);
    readonly error = signal('');
    readonly busy = signal(false);
    readonly projectFilter = signal<number | null>(null);
    readonly workerFilter = signal<number | null>(null);
    readonly editorOpen = signal(false);
    readonly teamOpen = signal(false);
    readonly editorError = signal('');
    readonly weekLabels = ['Lun','Mar','Mié','Jue','Vie','Sáb','Dom'];
    draft: Omit<CalendarEvent, 'id'> & {id?:number} = this.newDraft();
    workerName = '';
    workerId: number | null = null;
    workerDraftColor = WORKER_COLORS[0];
    readonly palette = WORKER_COLORS;
    readonly colorOf = (worker: OfficeWorker) => workerColor(worker.color, worker.id);
    readonly activeWorkers = computed(() => this.workers().filter(worker => worker.activo));

    readonly visibleMonths = computed(() => calendarMonths(this.month(), this.view()));
    readonly range = computed(() => calendarRange(this.month(), this.view()));
    readonly title = computed(() => {
        const months = this.visibleMonths();
        if (this.view() === 'year') return String(this.month().getFullYear());
        const label = (date: Date) => date.toLocaleDateString('es-ES', {month: 'long', year: 'numeric'});
        return this.view() === 'quarter' ? `${label(months[0])} - ${label(months[2])}` : label(months[0]);
    });
    readonly filteredEvents = computed(() => this.events().filter(e =>
        (this.projectFilter() === null || e.proyecto === this.projectFilter()) &&
        (this.workerFilter() === null || e.trabajadores.includes(this.workerFilter()!)),
    ));
    readonly calendarItems = computed(() => {
        const items: CalendarItem[] = this.filteredEvents().map(event => ({
            key: `event-${event.id}`, title: event.titulo, start: event.inicio, end: event.fin,
            colors: this.eventColors(event), people: this.workerNames(event.trabajadores), mounting: false,
        }));
        if (this.workerFilter() === null) {
            for (const project of this.projects()) {
                if (project.fecha_montaje && (this.projectFilter() === null || project.id === this.projectFilter())) {
                    items.push({key: `mount-${project.id}`, title: `Montaje · ${project.nombre}`,
                        start: project.fecha_montaje, end: project.fecha_montaje,
                        colors: ['#b45309'], people: '', mounting: true});
                }
            }
        }
        return items;
    });
    readonly calendars = computed(() => this.visibleMonths().map(month => ({
        key: localDate(month), month,
        title: month.toLocaleDateString('es-ES', {month: 'long', year: 'numeric'}),
        weeks: calendarWeeks(monthDays(month, this.view() !== 'month'), this.calendarItems(), this.view() !== 'month'),
    })));
    readonly selectedEvents = computed(() => this.eventsOn(this.selected()));
    readonly mountingProjects = computed(() => this.projects().filter(p =>
        p.fecha_montaje === this.selected() && (this.projectFilter() === null || p.id === this.projectFilter()) && this.workerFilter() === null,
    ));
    readonly availability = computed(() => this.workers().filter(w => w.activo).map(worker => ({
        ...worker,
        holiday: this.events().some(e => e.tipo === 'VACACIONES' && e.inicio <= this.selected() && e.fin >= this.selected() && e.trabajadores.includes(worker.id)),
    })));

    constructor() { this.load(); }
    load(): void {
        this.loadSubscription?.unsubscribe();
        this.loading.set(true); this.error.set('');
        this.events.set([]);
        const range = this.range();
        if (this.selected() < range.start || this.selected() > range.end) this.selected.set(localDate(this.month()));
        this.loadSubscription = forkJoin({events:this.api.getEvents(range.start, range.end), projects:this.api.getProyectos(), workers:this.api.getWorkers()})
            .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
            next: data => { this.events.set(data.events); this.projects.set(data.projects); this.workers.set(data.workers); this.loading.set(false); },
            error: () => { this.error.set('No se pudo cargar el calendario. Pulsa actualizar para reintentar.'); this.loading.set(false); },
        });
    }
    changeMonth(offset: number): void {
        if (this.loading()) return;
        const current = this.month();
        const step = this.view() === 'year' ? 12 : 1;
        const next = new Date(current.getFullYear(), current.getMonth()+offset*step, 1);
        this.month.set(next); this.selected.set(localDate(next)); this.load();
    }
    setView(view: CalendarView): void {
        if (this.loading() || view === this.view()) return;
        this.view.set(view); this.load();
    }
    openMonth(month: Date): void {
        if (this.loading()) return;
        this.month.set(month); this.view.set('month');
        if (!this.selected().startsWith(localDate(month).slice(0, 7))) this.selected.set(localDate(month));
        this.load();
    }
    goToday(): void {
        if (this.loading()) return;
        this.month.set(new Date(new Date().getFullYear(),new Date().getMonth(),1));
        this.selected.set(this.today); this.load();
    }
    eventsOn(day: string): CalendarEvent[] { return this.filteredEvents().filter(e => e.inicio <= day && e.fin >= day); }
    mountsOn(day: string): Proyecto[] {
        return this.projects().filter(p => p.fecha_montaje === day && (this.projectFilter() === null || this.projectFilter()===p.id) && this.workerFilter()===null);
    }
    projectName(id: number | null): string { return this.projects().find(p => p.id===id)?.nombre || ''; }
    workerNames(ids: number[]): string { return this.workers().filter(w => ids.includes(w.id)).map(w => w.nombre).join(', '); }
    eventColors(event: CalendarEvent): string[] {
        const colors = this.workers().filter(worker => event.trabajadores.includes(worker.id)).map(this.colorOf);
        return colors.length ? colors : ['#64748b'];
    }
    selectSegment(segment: CalendarSegment): void {
        if (this.selected() < segment.start || this.selected() > segment.end) {
            this.selected.set(segment.start);
        }
    }
    openTeam(): void { this.editWorker(); this.teamOpen.set(true); }
    editWorker(worker?: OfficeWorker): void {
        this.workerId = worker?.id ?? null;
        this.workerName = worker?.nombre ?? '';
        this.workerDraftColor = worker ? this.colorOf(worker) : nextWorkerColor(this.workers().map(this.colorOf));
    }
    private newDraft(): Omit<CalendarEvent,'id'> {
        return {titulo:'', tipo:'EVENTO', inicio:this.selected(), fin:this.selected(), proyecto:null, trabajadores:[], notas:''};
    }
    editEvent(event?: CalendarEvent): void {
        this.draft = event ? {...event, trabajadores:[...event.trabajadores]} : this.newDraft();
        this.editorError.set(''); this.editorOpen.set(true);
    }
    closeEditor(): void { if (!this.busy()) this.editorOpen.set(false); }
    setWorker(id: number, checked: boolean): void {
        this.draft.trabajadores = checked ? [...this.draft.trabajadores,id] : this.draft.trabajadores.filter(v => v!==id);
    }
    saveEvent(): void {
        if (this.busy()) return;
        if (!this.draft.titulo.trim() || !this.draft.inicio || !this.draft.fin || this.draft.fin < this.draft.inicio) {
            this.editorError.set('Indica un título y un intervalo de fechas válido.'); return;
        }
        if (this.draft.tipo === 'VACACIONES' && !this.draft.trabajadores.length) {
            this.editorError.set('Selecciona al menos una persona para las vacaciones.'); return;
        }
        this.busy.set(true);
        this.api.saveEvent({...this.draft, titulo:this.draft.titulo.trim()}).subscribe({
            next: () => { this.busy.set(false); this.editorOpen.set(false); this.load(); },
            error: () => { this.busy.set(false); this.editorError.set('No se pudo guardar el evento. Revisa los datos e inténtalo de nuevo.'); },
        });
    }
    removeEvent(event: CalendarEvent): void {
        if (!confirm(`Eliminar "${event.titulo}" del calendario?`) || this.busy()) return;
        this.busy.set(true);
        this.api.deleteEvent(event.id).subscribe({
            next: () => { this.busy.set(false); this.load(); },
            error: () => { this.busy.set(false); this.error.set('No se pudo eliminar el evento.'); },
        });
    }
    saveWorker(): void {
        if (!this.workerName.trim() || this.busy()) return;
        this.busy.set(true);
        this.api.saveWorker({...(this.workerId ? {id:this.workerId} : {}),nombre:this.workerName.trim(),color:this.workerDraftColor}).subscribe({
            next: worker => {
                this.workers.update(workers => [...workers.filter(w => w.id !== worker.id), worker].sort((a,b) => a.nombre.localeCompare(b.nombre)));
                this.editWorker(); this.busy.set(false);
            },
            error: () => { this.busy.set(false); this.error.set('No se pudo guardar la persona.'); },
        });
    }
    setWorkerActive(worker: OfficeWorker): void {
        if (this.busy() || !confirm(`${worker.activo ? 'Desactivar' : 'Activar'} a ${worker.nombre}? Los eventos anteriores se conservarán.`)) return;
        this.busy.set(true);
        this.api.saveWorker({id:worker.id,activo:!worker.activo}).subscribe({
            next: () => { this.busy.set(false); this.load(); },
            error: () => { this.busy.set(false); this.error.set('No se pudo actualizar la persona.'); },
        });
    }
}
