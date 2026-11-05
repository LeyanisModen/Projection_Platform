import { SimpleChange } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideRouter } from '@angular/router';

import { Mapper, esquinasDeOrigen, margenDeImagen } from './mapper';

describe('Mapper', () => {
  let component: Mapper;
  let fixture: ComponentFixture<Mapper>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Mapper],
      providers: [provideHttpClient(), provideRouter([])]
    })
    .compileComponents();

    fixture = TestBed.createComponent(Mapper);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('shows the image flat in plain view and warps it again when calibrating', () => {
    fixture.detectChanges();
    const main: HTMLElement = fixture.nativeElement.querySelector('main');
    const surface: HTMLElement = fixture.nativeElement.querySelector('#sourceIframe');

    component.plainView = true;
    component.ngOnChanges({ plainView: new SimpleChange(false, true, false) });
    component.calibrationJson = { corners: [10, 10, 800, 0, 0, 600, 790, 610] };
    expect(main.classList.contains('plain-view')).toBe(true);
    expect(surface.style.transform).toBe('none');

    component.plainView = false;
    component.ngOnChanges({ plainView: new SimpleChange(true, false, false) });
    expect(main.classList.contains('plain-view')).toBe(false);
    expect(surface.style.transform.startsWith('matrix3d(')).toBe(true);
  });

  it('shows the corners and the white outline only while calibrating', () => {
    fixture.detectChanges();
    const guias = (): string[] => Array.from(fixture.nativeElement.querySelectorAll('.corner, .line'))
      .map(el => (el as HTMLElement).style.visibility);
    expect(guias().length).toBe(8);
    expect(guias().every(v => v === 'hidden')).toBe(true);

    component.ngOnChanges({ isCalibrationActive: new SimpleChange(false, true, false) });
    expect(guias().every(v => v === 'visible')).toBe(true);

    component.ngOnChanges({ isCalibrationActive: new SimpleChange(true, false, false) });
    expect(guias().every(v => v === 'hidden')).toBe(true);
  });

  it('recognises images with a margin by their size', () => {
    expect(margenDeImagen(1760, 800)).toBe(16);
    expect(margenDeImagen(1728, 768)).toBe(0);
    expect(margenDeImagen(1920, 1080)).toBe(0);
    expect(esquinasDeOrigen(1366, 641)).toEqual([0, 0, 1366, 0, 0, 641, 1366, 641]);
    expect(esquinasDeOrigen(1760, 800, 16, 1760, 800)).toEqual([16, 16, 1744, 16, 16, 784, 1744, 784]);
  });

  it('fits the inside of a margin image to the calibrated corners and leaves the margin outside', () => {
    fixture.detectChanges();
    const surface: HTMLElement = fixture.nativeElement.querySelector('#sourceIframe');
    const img: HTMLImageElement = fixture.nativeElement.querySelector('#correctedVideo');
    component.calibrationJson = { corners: [100, 50, 900, 40, 90, 500, 910, 520] };
    const llega = (ancho: number, alto: number) => {
      Object.defineProperty(img, 'naturalWidth', { value: ancho, configurable: true });
      Object.defineProperty(img, 'naturalHeight', { value: alto, configurable: true });
      component.notifyImageReady();
    };
    // Donde cae en pantalla un punto de la superficie (matrix3d por columnas).
    const proyecta = (x: number, y: number) => {
      const m = surface.style.transform.slice('matrix3d('.length, -1).split(',').map(Number);
      const w = m[3] * x + m[7] * y + m[15];
      return [(m[0] * x + m[4] * y + m[12]) / w, (m[1] * x + m[5] * y + m[13]) / w];
    };
    const cerca = ([x, y]: number[], [ex, ey]: number[]) => {
      expect(x).toBeCloseTo(ex, 0);
      expect(y).toBeCloseTo(ey, 0);
    };
    const w = surface.offsetWidth || window.innerWidth;
    const h = surface.offsetHeight || window.innerHeight;

    // Las imagenes de siempre: enteras en las esquinas, como hasta ahora.
    llega(1728, 768);
    cerca(proyecta(0, 0), [100, 50]);
    cerca(proyecta(w, h), [910, 520]);

    // Con margen: lo de dentro en las esquinas y el borde por fuera.
    llega(1760, 800);
    const [mx, my] = esquinasDeOrigen(w, h, 16, 1760, 800);
    cerca(proyecta(mx, my), [100, 50]);
    cerca(proyecta(w - mx, my), [900, 40]);
    cerca(proyecta(mx, h - my), [90, 500]);
    cerca(proyecta(w - mx, h - my), [910, 520]);
    const [x0, y0] = proyecta(0, 0);
    expect(x0).toBeLessThan(100);
    expect(y0).toBeLessThan(50);

    // Al volver a una imagen sin margen, otra vez entera.
    llega(1728, 768);
    cerca(proyecta(0, 0), [100, 50]);
  });
});
