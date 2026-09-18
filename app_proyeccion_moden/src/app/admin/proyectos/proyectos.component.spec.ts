import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it, beforeEach } from 'vitest';

import { ProyectosComponent } from './proyectos.component';

describe('ProyectosComponent — creación de proyecto vacío', () => {
  let fixture: ComponentFixture<ProyectosComponent>;
  let component: ProyectosComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ProyectosComponent],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    }).compileComponents();
    fixture = TestBed.createComponent(ProyectosComponent);
    component = fixture.componentInstance;
  });

  it('permite crear sin carpeta seleccionada', () => {
    expect(component.selectedFolder).toBeNull();
    expect(component.canCreateSelectedProject).toBe(true);
  });

  it('bloquea el envío si hay carpeta sin módulos válidos', () => {
    component.selectedFolder = {} as FileSystemDirectoryHandle;
    component.folderScan = { candidates: [], rootIssues: [] } as any;
    expect(component.canCreateSelectedProject).toBe(false);
  });

  it('quitar carpeta devuelve el formulario al alta vacía', () => {
    component.selectedFolder = {} as FileSystemDirectoryHandle;
    component.folderName = 'MOD-CARPETA';
    component.folderScan = { candidates: [], rootIssues: [] } as any;
    component.error = 'No se encontraron carpetas de modulos en la carpeta seleccionada.';

    component.clearSelectedFolder();

    expect(component.selectedFolder).toBeNull();
    expect(component.folderName).toBe('');
    expect(component.folderScan).toBeNull();
    expect(component.error).toBe('');
    // Sin carpeta el envío vuelve a estar permitido.
    expect(component.canCreateSelectedProject).toBe(true);
  });
});
