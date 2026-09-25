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
