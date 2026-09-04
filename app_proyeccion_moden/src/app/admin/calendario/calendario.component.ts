import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { A11yModule } from '@angular/cdk/a11y';
import { forkJoin } from 'rxjs';
import { ApiService, CalendarEvent, OfficeWorker, Proyecto } from '../../services/api.service';

function localDate(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}

@Component({
    selector: 'app-calendario',
    imports: [CommonModule, FormsModule, RouterLink, A11yModule],
    templateUrl: './calendario.component.html',
    styleUrl: './calendario.component.css',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CalendarioComponent {
    private readonly api = inject(ApiService);
    readonly month = signal(new Date(new Date().getFullYear(), new Date().getMonth(), 1));
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

    readonly title = computed(() => this.month().toLocaleDateString('es-ES', {month:'long',year:'numeric'}));
    readonly days = computed(() => {
        const first = this.month();
        const start = new Date(first.getFullYear(), first.getMonth(), 1 - ((first.getDay()+6)%7));
        return Array.from({length:42}, (_, i) => {
            const date = new Date(start.getFullYear(), start.getMonth(), start.getDate()+i);
            return {key:localDate(date), number:date.getDate(), current:date.getMonth()===first.getMonth()};
        });
    });
    readonly filteredEvents = computed(() => this.events().filter(e =>
        (this.projectFilter() === null || e.proyecto === this.projectFilter()) &&
        (this.workerFilter() === null || e.trabajadores.includes(this.workerFilter()!)),
    ));
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
        this.loading.set(true); this.error.set('');
        const days = this.days();
        forkJoin({events:this.api.getEvents(days[0].key, days[41].key), projects:this.api.getProyectos(), workers:this.api.getWorkers()}).subscribe({
            next: data => { this.events.set(data.events); this.projects.set(data.projects); this.workers.set(data.workers); this.loading.set(false); },
            error: () => { this.error.set('No se pudo cargar el calendario. Pulsa actualizar para reintentar.'); this.loading.set(false); },
        });
    }
    changeMonth(offset: number): void {
        if (this.loading()) return;
        const current = this.month();
        const next = new Date(current.getFullYear(), current.getMonth()+offset, 1);
        this.month.set(next); this.selected.set(localDate(next)); this.load();
    }
    goToday(): void {
        this.month.set(new Date(new Date().getFullYear(),new Date().getMonth(),1));
        this.selected.set(this.today); this.load();
    }
    eventsOn(day: string): CalendarEvent[] { return this.filteredEvents().filter(e => e.inicio <= day && e.fin >= day); }
    mountsOn(day: string): Proyecto[] {
        return this.projects().filter(p => p.fecha_montaje === day && (this.projectFilter() === null || this.projectFilter()===p.id) && this.workerFilter()===null);
    }
    projectName(id: number | null): string { return this.projects().find(p => p.id===id)?.nombre || ''; }
    workerNames(ids: number[]): string { return this.workers().filter(w => ids.includes(w.id)).map(w => w.nombre).join(', '); }
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
        this.api.saveWorker({...(this.workerId ? {id:this.workerId} : {}),nombre:this.workerName.trim()}).subscribe({
            next: () => { this.workerName=''; this.workerId=null; this.busy.set(false); this.load(); },
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
