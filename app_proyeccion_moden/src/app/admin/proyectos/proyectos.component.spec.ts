import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router, provideRouter } from '@angular/router';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

import { ProyectosComponent } from './proyectos.component';

describe('ProyectosComponent — alta de proyecto', () => {
  let fixture: ComponentFixture<ProyectosComponent>;
  let component: ProyectosComponent;
  let http: HttpTestingController;
  let navigate: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ProyectosComponent],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true) as any;
    fixture = TestBed.createComponent(ProyectosComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    http.expectOne('/api/users/').flush({results: [{id: 9, url: '/api/users/9/', username: 'europapl5', first_name: 'Europa'}], next: null, count: 1});
    http.expectOne('/api/proyectos/').flush({results: [], next: null, count: 0});
    fixture.detectChanges();
  });

  afterEach(() => http.verify());

  it('lista solo las ferrallas con proyectos, los sin ferralla primero', () => {
    component.users = [
      { id: 9, url: '/api/users/9/', username: 'europapl5', first_name: 'Europa' } as any,
      { id: 3, url: '/api/users/3/', username: 'vacia', first_name: 'Sin nada' } as any,
    ];
    component.projects = [
      { id: 1, nombre: 'Con ferralla', usuario: '/api/users/9/' } as any,
      { id: 2, nombre: 'Suelto', usuario: null } as any,
    ];
    component.groupProjects();
    expect(component.groupedProjects.map(g => [g.username, g.projects.length])).toEqual([['Sin ferralla', 1], ['Europa', 1]]);
  });

  it('enseña la lista de control de cada proyecto en su fila, alineada con la lista maestra', () => {
    const paso = (id: number, definicion: number | null, titulo: string, orden: number, extra: Record<string, unknown> = {}) =>
      ({ id, definicion, titulo, orden, completado: false, fecha_limite: null, completado_at: null, ...extra });
    component.users = [{ id: 9, url: '/api/users/9/', username: 'europapl5', first_name: 'Europa' } as any];
    component.projects = [
      { id: 1, nombre: 'P1', usuario: '/api/users/9/', checks_total: 3, checks_completados: 1, checks_resumen: [
        paso(11, 100, 'Planos', 1, { completado: true, completado_at: '2026-10-12T09:00:00+02:00' }),
        paso(12, 200, 'Geometría', 2, { fecha_limite: '2020-01-10' }),
        paso(13, null, 'Revisar vigas', 5),
      ] } as any,
      // Sin la copia de Planos: su casilla queda vacia para no descolocar las columnas.
      { id: 2, nombre: 'P2', usuario: '/api/users/9/', checks_total: 1, checks_completados: 0, checks_resumen: [
        paso(21, 200, 'Geometría', 2, { fecha_limite: '2099-01-10' }),
      ] } as any,
    ];
    component.groupProjects();
    fixture.componentRef.changeDetectorRef.markForCheck();
    fixture.detectChanges();
    const filas = Array.from(fixture.nativeElement.querySelectorAll('.project-row')) as HTMLElement[];
    const cajas = (fila: HTMLElement) => Array.from(fila.querySelectorAll('.check-box')) as HTMLElement[];
    expect(cajas(filas[0]).map(c => c.getAttribute('title'))).toEqual([
      'Planos · hecho el 12/10/2026', 'Geometría · vencido el 10/01/2020', 'Revisar vigas · pendiente',
    ]);
    expect(cajas(filas[0]).map(c => [c.classList.contains('is-done'), c.classList.contains('is-late')]))
      .toEqual([[true, false], [false, true], [false, false]]);
    expect(cajas(filas[1]).map(c => c.classList.contains('is-none'))).toEqual([true, false]);
    expect(cajas(filas[1])[1].getAttribute('title')).toBe('Geometría · antes del 10/01/2099');
    expect(filas[0].querySelector('.project-checks')?.getAttribute('aria-label')).toBe('Lista de control: 1 de 3 hechos');
  });

  it('pide solo nombre y ferralla', () => {
    component.toggleForm();
    fixture.detectChanges();
    const form: HTMLElement = fixture.nativeElement.querySelector('.new-project');
    expect(form.querySelectorAll('input, select').length).toBe(2);
    expect((form.querySelector('button[type=submit]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('crea con el nombre y salta al detalle del proyecto nuevo', () => {
    component.toggleForm();
    component.newProject = { nombre: '  Torre Norte ', usuario: '/api/users/9/' };
    component.createProyecto();

    const request = http.expectOne('/api/proyectos/');
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({ nombre: 'Torre Norte', usuario: '/api/users/9/' });
    request.flush({ id: 42, nombre: 'Torre Norte', usuario: '/api/users/9/' });

    expect(navigate).toHaveBeenCalledWith(['/admin-dashboard/proyectos', 42]);
    expect(component.loading).toBe(false);
  });

  it('sin ferralla envía usuario nulo y no crea con el nombre vacío', () => {
    component.toggleForm();
    component.newProject = { nombre: '   ', usuario: null };
    component.createProyecto();
    http.expectNone('/api/proyectos/');

    component.newProject = { nombre: 'Solo nombre', usuario: null };
    component.createProyecto();
    const request = http.expectOne('/api/proyectos/');
    expect(request.request.body).toEqual({ nombre: 'Solo nombre', usuario: null });
    request.flush({ id: 43, nombre: 'Solo nombre', usuario: null });
    expect(navigate).toHaveBeenCalledWith(['/admin-dashboard/proyectos', 43]);
  });

  it('muestra el error de la API y se queda en el formulario', () => {
    component.toggleForm();
    component.newProject = { nombre: 'Repetido', usuario: null };
    component.createProyecto();
    http.expectOne('/api/proyectos/').flush({ nombre: ['Ya existe un proyecto con este nombre.'] }, { status: 400, statusText: 'Bad Request' });
    expect(component.error).toContain('Ya existe');
    expect(component.showForm).toBe(true);
    expect(navigate).not.toHaveBeenCalled();
  });
});
