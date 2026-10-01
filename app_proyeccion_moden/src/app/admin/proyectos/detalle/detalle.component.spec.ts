import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { provideRouter } from '@angular/router';
import { Modulo, Proyecto } from '../../../services/api.service';
import { ProyectoDetailComponent } from './detalle.component';

describe('Project detail rack order switch', () => {
    let fixture: ComponentFixture<ProyectoDetailComponent>;
    let http: HttpTestingController;

    beforeEach(async () => {
        await TestBed.configureTestingModule({
            imports: [ProyectoDetailComponent],
            providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
        }).compileComponents();
        http = TestBed.inject(HttpTestingController);
        fixture = TestBed.createComponent(ProyectoDetailComponent);
        fixture.componentInstance.proyecto = {
            id: 7, nombre: 'Test', usuario: null, estrategia_bastidor: 'SECUENCIAL',
        } as Proyecto;
        fixture.componentInstance.modulos = [1, 2, 3].map(id => ({
            id, nombre: `A0${id}`, estado: 'PENDIENTE',
        } as Modulo));
        fixture.componentInstance.grupos = [{
            id: 1, proyecto: 7, indice: 1, nombre: 'Group 1', created_at: '2026-09-05',
            modulos: fixture.componentInstance.modulos.map(modulo => ({...modulo, tiene_sd: false})),
            longitud_total_cm: 90, capacidad_cm: 114, peso_total_kg: 300,
            capacidad_peso_kg: null, peso_desconocido: false,
            overflow_longitud: false, overflow_peso: false, overflow: false,
        }];
        fixture.detectChanges();
        http.expectOne('/api/proyecto-checklist/7/').flush([]);
        fixture.detectChanges();
    });

    afterEach(() => http.verify());

    function buttons(): HTMLButtonElement[] {
        return Array.from(fixture.nativeElement.querySelectorAll('.rack-view-toggle button'));
    }

    function visibleNames(): string[] {
        return Array.from(fixture.nativeElement.querySelectorAll('.grupo-modulo-nombre-texto'))
            .map(element => (element as HTMLElement).textContent!.trim());
    }

    it('lists the loose elements Excel among the project files and uploads it', () => {
        const component = fixture.componentInstance;
        const fila = () => (fixture.nativeElement.querySelector('.archivo-elementos') as HTMLElement).textContent!.replace(/\s+/g, '').trim();
        expect(fila()).toBe('Elementossueltos:sincargar');
        // El plano ya no se sube desde el admin: se generara desde la base de datos.
        expect(fixture.nativeElement.querySelector('.archivo-proyecto-list')?.textContent).not.toContain('Plano');

        component.proyectoId = 7;
        // Un PDF no vale: se avisa y no se sube nada.
        const alerta = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
        const input = (name: string) => ({ target: { files: [new File(['x'], name)] } } as unknown as Event);
        component.onProjectFileSelected(input('plano.pdf'), 'elementos');
        expect(alerta).toHaveBeenCalledWith('Los elementos sueltos deben estar en un Excel (.xlsx).');
        http.expectNone('/api/proyectos/7/');

        component.onProjectFileSelected(input('obra.xlsx'), 'elementos');
        const request = http.expectOne('/api/proyectos/7/');
        expect(request.request.method).toBe('PATCH');
        expect((request.request.body as FormData).get('elementos_sueltos_archivo')).toBeInstanceOf(File);
        request.flush({...component.proyecto, elementos_sueltos_archivo: '/media/elementos_sueltos/obra.xlsx'});
        fixture.detectChanges();
        expect(fila()).toBe('Elementossueltos:cargado');
        expect(component.getProjectFileUrl('elementos')).toContain('/media/elementos_sueltos/obra.xlsx');
        // El proyecto actualizado hace que la lista de control se recargue.
        http.match('/api/proyecto-checklist/7/').forEach(pendiente => pendiente.flush([]));
        alerta.mockRestore();
    });

    it('defaults to fabrication order with an accessible selected option', () => {
        expect(fixture.nativeElement.querySelector('.rack-view-toggle .segmented').getAttribute('role')).toBe('group');
        expect(buttons().map(button => button.getAttribute('aria-pressed'))).toEqual(['true', 'false']);
        expect(buttons()[0].classList.contains('active')).toBe(true);
        expect(visibleNames()).toEqual(['A03', 'A02', 'A01']);
    });

    it('switches both ways without changing canonical order, grouping or backend data', () => {
        const component = fixture.componentInstance;
        const canonical = component.grupos[0].modulos;
        buttons()[1].click();
        fixture.detectChanges();
        expect(component.rackViewOrder).toBe('transporte');
        expect(buttons().map(button => button.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
        expect(buttons()[1].classList.contains('active')).toBe(true);
        expect(visibleNames()).toEqual(['A01', 'A02', 'A03']);

        buttons()[0].click();
        fixture.detectChanges();
        expect(visibleNames()).toEqual(['A03', 'A02', 'A01']);
        expect(component.grupos[0].modulos).toBe(canonical);
        expect(canonical.map(modulo => modulo.nombre)).toEqual(['A01', 'A02', 'A03']);
        expect(component.proyecto!.estrategia_bastidor).toBe('SECUENCIAL');
        http.expectNone(() => true);
    });

    for (const busyFlag of ['isDraggingModulo', 'isDraggingBastidor', 'movingModulo'] as const) {
        it(`blocks the switch during ${busyFlag} and enables it afterwards`, () => {
            fixture.componentInstance[busyFlag] = true;
            fixture.changeDetectorRef.markForCheck();
            fixture.detectChanges();
            expect(buttons().every(button => button.disabled)).toBe(true);
            buttons()[1].click();
            fixture.detectChanges();
            expect(fixture.componentInstance.rackViewOrder).toBe('produccion');

            fixture.componentInstance[busyFlag] = false;
            fixture.changeDetectorRef.markForCheck();
            fixture.detectChanges();
            expect(buttons().every(button => !button.disabled)).toBe(true);
            buttons()[1].click();
            fixture.detectChanges();
            expect(fixture.componentInstance.rackViewOrder).toBe('transporte');
        });
    }
});
