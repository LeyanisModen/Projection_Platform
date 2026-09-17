import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { ListaControlComponent } from './lista-control.component';

describe('ListaControlComponent', () => {
    let fixture: ComponentFixture<ListaControlComponent>;
    let http: HttpTestingController;

    beforeEach(async () => {
        await TestBed.configureTestingModule({
            imports: [ListaControlComponent],
            providers: [provideHttpClient(), provideHttpClientTesting()],
        }).compileComponents();
        http = TestBed.inject(HttpTestingController);
        fixture = TestBed.createComponent(ListaControlComponent);
        fixture.detectChanges();
        http.expectOne('/api/check-definiciones/').flush([
            { id: 1, titulo: 'Planos entregados', orden: 1 },
            { id: 2, titulo: 'Aprobación equivalencias', orden: 2 },
        ]);
        fixture.detectChanges();
    });

    afterEach(() => http.verify());

    it('lista los pasos numerados en orden', () => {
        const element: HTMLElement = fixture.nativeElement;
        const rows = Array.from(element.querySelectorAll('.step'));
        expect(rows.map(r => r.querySelector('.position')?.textContent?.trim())).toEqual(['1', '2']);
        expect(rows.map(r => r.querySelector('.title')?.textContent?.trim())).toEqual(['Planos entregados', 'Aprobación equivalencias']);
    });

    it('añade un paso al final y limpia el campo', () => {
        fixture.componentInstance.newTitle.set(' Acta de inicio ');
        fixture.componentInstance.add();
        const request = http.expectOne('/api/check-definiciones/');
        expect(request.request.method).toBe('POST');
        expect(request.request.body).toEqual({ titulo: 'Acta de inicio' });
        request.flush({ id: 3, titulo: 'Acta de inicio', orden: 3 });
        expect(fixture.componentInstance.steps().map(s => s.id)).toEqual([1, 2, 3]);
        expect(fixture.componentInstance.newTitle()).toBe('');
    });

    it('reordena enviando la lista completa de ids', () => {
        fixture.componentInstance.move(1, -1);
        const request = http.expectOne('/api/check-definiciones/reorder/');
        expect(request.request.body).toEqual({ ids: [2, 1] });
        request.flush([{ id: 2, titulo: 'Aprobación equivalencias', orden: 1 }, { id: 1, titulo: 'Planos entregados', orden: 2 }]);
        expect(fixture.componentInstance.steps().map(s => s.id)).toEqual([2, 1]);
    });

    it('no intenta mover fuera de los límites', () => {
        fixture.componentInstance.move(0, -1);
        http.expectNone('/api/check-definiciones/reorder/');
    });

    it('elimina tras confirmar y avisa de que los proyectos ya sembrados lo conservan', () => {
        const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
        fixture.componentInstance.remove(fixture.componentInstance.steps()[0]);
        expect(confirmSpy.mock.calls[0][0]).toContain('conservan');
        const request = http.expectOne('/api/check-definiciones/1/');
        expect(request.request.method).toBe('DELETE');
        request.flush(null);
        expect(fixture.componentInstance.steps().map(s => s.id)).toEqual([2]);
        confirmSpy.mockRestore();
    });

    it('edita el título en línea y guarda con PATCH', () => {
        const step = fixture.componentInstance.steps()[1];
        fixture.componentInstance.startEdit(step);
        fixture.componentInstance.editTitle.set('Aprobación de planos de equivalencia');
        fixture.componentInstance.saveEdit(step);
        const request = http.expectOne('/api/check-definiciones/2/');
        expect(request.request.method).toBe('PATCH');
        request.flush({ id: 2, titulo: 'Aprobación de planos de equivalencia', orden: 2 });
        expect(fixture.componentInstance.editingId()).toBeNull();
        expect(fixture.componentInstance.steps()[1].titulo).toBe('Aprobación de planos de equivalencia');
    });
});
