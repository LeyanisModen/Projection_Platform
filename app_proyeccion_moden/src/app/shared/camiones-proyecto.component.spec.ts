import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { CamionesProyecto } from '../services/api.service';
import { CamionesProyectoComponent, diaCorto } from './camiones-proyecto.component';

const porDefecto = (): CamionesProyecto => ({
  bastidores: 10, bastidores_estimados: false, salida: '2026-11-27', por_defecto: true, sobran: 0,
  camiones: [
    { orden: 1, fecha: '2026-11-27', bastidores: 4, enviado: false, por_defecto: true },
    { orden: 2, fecha: '2026-11-27', bastidores: 4, enviado: false, por_defecto: true },
    { orden: 3, fecha: '2026-11-27', bastidores: 2, enviado: false, por_defecto: true },
  ],
});

describe('Camiones de un forjado', () => {
  let fixture: ComponentFixture<CamionesProyectoComponent>;
  let http: HttpTestingController;
  const url = '/api/proyectos/7/camiones/';
  const texto = (selector: string) => Array.from(fixture.nativeElement.querySelectorAll(selector))
    .map(el => (el as HTMLElement).textContent!.replace(/\s+/g, ' ').trim());

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [CamionesProyectoComponent],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(CamionesProyectoComponent);
    fixture.componentRef.setInput('proyectoId', 7);
    fixture.detectChanges();
    http.expectOne(url).flush(porDefecto());
    fixture.detectChanges();
  });

  afterEach(() => http.verify());

  it('shows the default trucks, four by four the day before the mounting', () => {
    expect(diaCorto('2026-11-27')).toBe('vie 27/11');
    expect(texto('.cam-resumen')).toEqual(['10 bastidores · por defecto salen el vie 27/11, el día antes del montaje']);
    expect(texto('.cam-nombre')).toEqual(['Camión 1', 'Camión 2', 'Camión 3']);
    expect(fixture.nativeElement.querySelectorAll('li.cam-defecto').length).toBe(3);
    // Sin cambios no hay nada que guardar.
    expect(fixture.nativeElement.querySelector('.btn-primary')).toBeNull();
  });

  it('moves the first truck earlier, warns of what is left and saves them all', () => {
    const componente = fixture.componentInstance;
    componente.cambiar(componente.filas[0], 'fecha', '2026-11-20');
    componente.quitar(2);
    fixture.detectChanges();
    expect(texto('.cam-aviso')).toEqual(['Llevan 8 de 10 bastidores: los 2 que faltan salen el vie 27/11.']);
    (fixture.nativeElement.querySelector('.btn-primary') as HTMLButtonElement).click();
    const guardar = http.expectOne(r => r.url === url && r.method === 'PUT');
    expect(guardar.request.body).toEqual({ camiones: [
      { fecha: '2026-11-20', bastidores: 4, enviado: false }, { fecha: '2026-11-27', bastidores: 4, enviado: false },
    ] });
    guardar.flush({ ...porDefecto(), por_defecto: false, camiones: [
      { orden: 1, fecha: '2026-11-20', bastidores: 4, enviado: false, por_defecto: false },
      { orden: 2, fecha: '2026-11-27', bastidores: 4, enviado: false, por_defecto: false },
      { orden: 3, fecha: '2026-11-27', bastidores: 2, enviado: false, por_defecto: true },
    ] });
    fixture.detectChanges();
    expect(componente.cambiado).toBe(false);
    expect(texto('.cam-aviso')).toEqual([]);

    // Volver a los de por defecto.
    const botones = Array.from(fixture.nativeElement.querySelectorAll('.cam-acciones button')) as HTMLButtonElement[];
    botones.find(b => b.textContent!.includes('Por defecto'))!.click();
    http.expectOne(r => r.url === url && r.method === 'DELETE').flush(porDefecto());
    fixture.detectChanges();
    expect(componente.datos!.por_defecto).toBe(true);
  });

  it('says when the saved trucks carry more than the slab has', () => {
    const componente = fixture.componentInstance;
    componente.anadir();
    fixture.detectChanges();
    expect(texto('.cam-aviso')).toEqual(['Llevan 14 bastidores y el forjado tiene 10: sobran 4.']);
  });
});
