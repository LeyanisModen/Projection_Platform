import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Proyecto } from '../../../services/api.service';
import { ProjectControlsComponent } from './project-controls.component';

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
