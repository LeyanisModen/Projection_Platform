import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ProjectCheck, Proyecto } from '../../../services/api.service';
import { ProjectControlsComponent } from './project-controls.component';

const check = (id: number, titulo: string, completado = false, origen: ProjectCheck['origen'] = 'PLANTILLA'): ProjectCheck => ({
    id, titulo, orden: id, origen, completado,
    completado_at: completado ? '2026-09-17T10:00:00Z' : null,
    completado_por: completado ? 'moden' : null,
    creado_at: '2026-09-01T00:00:00Z',
});

describe('ProjectControlsComponent factory schedule', () => {
    let fixture: ComponentFixture<ProjectControlsComponent>;
    let http: HttpTestingController;
    const project = {
        id: 7, nombre: 'Test', fecha_montaje: '2026-10-01',
        planificacion: {
            estado: 'PLANIFICADO', dias_produccion: ['SAT', 'SUN'],
            modulos_por_dia: 3, modulos_pendientes: 6, dias_disponibles: 2,
            fecha_calculo: '2026-09-25',
        },
    } as Proyecto;

    beforeEach(async () => {
        await TestBed.configureTestingModule({
            imports: [ProjectControlsComponent],
            providers: [provideHttpClient(), provideHttpClientTesting()],
        }).compileComponents();
        http = TestBed.inject(HttpTestingController);
        fixture = TestBed.createComponent(ProjectControlsComponent);
        fixture.componentRef.setInput('project', project);
        fixture.detectChanges();
        http.expectOne('/api/proyecto-checklist/7/').flush([]);
        fixture.detectChanges();
    });

    afterEach(() => http.verify());

    it('shows inherited days as information, not editable project controls', () => {
        const element: HTMLElement = fixture.nativeElement;
        expect(element.querySelector('.factory-schedule')?.textContent).toContain('sábado, domingo');
        expect(element.querySelector('.factory-schedule button')).toBeNull();
        expect(element.querySelector('.days')).toBeNull();
    });

    it('sends only the mounting date without changing the factory schedule', () => {
        fixture.componentInstance.date.set('2026-10-04');
        fixture.componentInstance.saveDeadline();
        const request = http.expectOne('/api/proyectos/7/');
        expect(request.request.method).toBe('PATCH');
        expect(request.request.body).toEqual({fecha_montaje: '2026-10-04'});
        request.flush({...project, fecha_montaje: '2026-10-04'});
    });

    it('updates inherited days when the project is reassigned', () => {
        fixture.componentRef.setInput('project', {
            ...project, planificacion: {...project.planificacion, dias_produccion: ['MON', 'WED']},
        });
        fixture.detectChanges();
        http.expectOne('/api/proyecto-checklist/7/').flush([]);
        expect(fixture.componentInstance.workingDaysLabel()).toBe('lunes, miércoles');
    });
});

describe('ProjectControlsComponent lista de control', () => {
    let fixture: ComponentFixture<ProjectControlsComponent>;
    let http: HttpTestingController;
    const project = { id: 7, nombre: 'Valdebebas', fecha_montaje: null } as unknown as Proyecto;

    beforeEach(async () => {
        await TestBed.configureTestingModule({
            imports: [ProjectControlsComponent],
            providers: [provideHttpClient(), provideHttpClientTesting()],
        }).compileComponents();
        http = TestBed.inject(HttpTestingController);
        fixture = TestBed.createComponent(ProjectControlsComponent);
        fixture.componentRef.setInput('project', project);
        fixture.detectChanges();
        http.expectOne('/api/proyecto-checklist/7/').flush([
            check(1, 'Planos entregados', true),
            check(2, 'Aprobación equivalencias'),
            check(3, 'Acta de inicio', false, 'MANUAL'),
        ]);
        fixture.detectChanges();
    });

    afterEach(() => http.verify());

    it('muestra la barra de progreso y el siguiente paso pendiente sin abrir la lista', () => {
        const element: HTMLElement = fixture.nativeElement;
        expect(fixture.componentInstance.percent()).toBe(33);
        expect(element.querySelector('.progress-label')?.textContent?.trim()).toBe('1 / 3');
        expect(element.querySelector('.next-step')?.textContent).toContain('Aprobación equivalencias');
        expect(element.querySelector('.modal')).toBeNull();
    });

    it('abre la lista en un modal con los pasos y su origen', () => {
        fixture.componentInstance.openList();
        fixture.detectChanges();
        const element: HTMLElement = fixture.nativeElement;
        expect(element.querySelectorAll('.check-row').length).toBe(3);
        expect(element.querySelectorAll('.origin').length).toBe(1);
        expect(element.querySelector('.check-row.is-done small')?.textContent).toContain('moden');
    });

    it('marcar un paso envía el PATCH y sustituye la lista con la respuesta', () => {
        fixture.componentInstance.openList();
        fixture.detectChanges();
        const target = fixture.nativeElement.querySelector('#check-2') as HTMLInputElement;
        target.click();
        const request = http.expectOne('/api/proyecto-checklist/7/checks/2/');
        expect(request.request.method).toBe('PATCH');
        expect(request.request.body).toEqual({ completado: true });
        request.flush([check(1, 'Planos entregados', true), check(2, 'Aprobación equivalencias', true), check(3, 'Acta de inicio', false, 'MANUAL')]);
        expect(fixture.componentInstance.completed()).toBe(2);
        expect(fixture.componentInstance.percent()).toBe(67);
    });

    it('añade un paso propio del proyecto y vacía el campo', () => {
        fixture.componentInstance.openList();
        fixture.componentInstance.newTitle.set('  Grúa contratada ');
        fixture.componentInstance.addCheck();
        const request = http.expectOne('/api/proyecto-checklist/7/checks/');
        expect(request.request.method).toBe('POST');
        expect(request.request.body).toEqual({ titulo: 'Grúa contratada' });
        request.flush([check(1, 'Planos entregados', true), check(4, 'Grúa contratada', false, 'MANUAL')]);
        expect(fixture.componentInstance.newTitle()).toBe('');
        expect(fixture.componentInstance.checks().length).toBe(2);
    });

    it('trae los pasos que faltan de la lista maestra e informa de cuántos', () => {
        fixture.componentInstance.openList();
        fixture.componentInstance.seedFromMaster();
        const request = http.expectOne('/api/proyecto-checklist/7/sembrar/');
        expect(request.request.method).toBe('POST');
        request.flush({ creados: 2, checks: [check(1, 'A'), check(2, 'B'), check(5, 'C'), check(6, 'D')] });
        expect(fixture.componentInstance.seedMessage()).toContain('2');
        expect(fixture.componentInstance.checks().length).toBe(4);
    });
});
