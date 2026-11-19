import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { HojaIncidencias } from '../services/api.service';
import { HojasIncidenciasComponent } from './hojas-incidencias.component';

const hoja = (id: number, extra: Partial<HojaIncidencias> = {}): HojaIncidencias => ({
  id, nombre: `Hojas ${id}.pdf`, tamano: 2_400_000, url: `/media/incidencias/7/hojas_${id}.pdf`,
  subido_at: '2026-11-18T16:05:00', subido_por: 'sancho_amorebieta', de_moden: false, puede_borrar: true, ...extra,
});

describe('Hojas de incidencias', () => {
  let fixture: ComponentFixture<HojasIncidenciasComponent>;
  let http: HttpTestingController;
  const url = '/api/proyectos/7/hojas-incidencias/';
  const text = (selector: string) => Array.from(fixture.nativeElement.querySelectorAll(selector))
    .map(el => (el as HTMLElement).textContent!.replace(/\s+/g, ' ').trim());

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [HojasIncidenciasComponent],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(HojasIncidenciasComponent);
    fixture.componentRef.setInput('proyectoId', 7);
    fixture.detectChanges();
  });

  afterEach(() => http.verify());

  it('lists the sheets, shows the newest and lets you download it', () => {
    const cambios: number[] = [];
    fixture.componentInstance.cambio.subscribe(hojas => cambios.push(hojas.length));
    http.expectOne(url).flush([hoja(2), hoja(1, { de_moden: true, subido_por: 'oficina', puede_borrar: false, tamano: 300_000 })]);
    fixture.detectChanges();

    expect(text('.hojas-nombre')).toEqual(['Hojas 2.pdf', 'Hojas 1.pdf']);
    expect(text('.hojas-texto .hojas-meta')[0]).toBe('18/11/2026 16:05 · sancho_amorebieta · 2,3 MB');
    expect(text('.hojas-texto .hojas-meta')[1]).toBe('18/11/2026 16:05 · Moden · 293 KB');
    // La de Moden no la puede borrar la ferralla.
    expect(fixture.nativeElement.querySelectorAll('.hojas-borrar').length).toBe(1);
    const descarga = fixture.nativeElement.querySelector('a.hojas-accion') as HTMLAnchorElement;
    expect(descarga.getAttribute('href')).toBe('/media/incidencias/7/hojas_2.pdf');
    expect(descarga.getAttribute('download')).toBe('Hojas 2.pdf');
    const visor = () => (fixture.nativeElement.querySelector('.hojas-visor iframe') as HTMLIFrameElement).getAttribute('src');
    expect(visor()).toBe('/media/incidencias/7/hojas_2.pdf');

    (fixture.nativeElement.querySelectorAll('.hojas-abrir')[1] as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(visor()).toBe('/media/incidencias/7/hojas_1.pdf');
    expect(cambios).toEqual([2]);
  });

  it('uploads several PDFs at once and refuses anything else', () => {
    http.expectOne(url).flush([]);
    fixture.detectChanges();
    expect(text('.hojas-vacio')).toEqual(['Aún no hay hojas.']);
    const input = fixture.nativeElement.querySelector('.hojas-subir input') as HTMLInputElement;
    const elegir = (...nombres: string[]) => {
      Object.defineProperty(input, 'files', { configurable: true, value: nombres.map(n => new File(['%PDF'], n)) });
      input.dispatchEvent(new Event('change'));
      fixture.detectChanges();
    };

    elegir('hoja.pdf', 'foto.jpg');
    expect(text('.hojas-error')).toEqual(['Solo se pueden subir PDF: foto.jpg.']);
    http.expectNone(url);

    elegir('Mesa 1.pdf', 'Mesa 2.PDF');
    const subida = http.expectOne(r => r.url === url && r.method === 'POST');
    expect((subida.request.body as FormData).getAll('archivos').map(f => (f as File).name)).toEqual(['Mesa 1.pdf', 'Mesa 2.PDF']);
    subida.flush([hoja(4), hoja(3)]);
    fixture.detectChanges();
    expect(text('.hojas-nombre')).toEqual(['Hojas 4.pdf', 'Hojas 3.pdf']);
    expect(text('.hojas-error')).toEqual([]);
  });

  it('deletes after confirming and shows the next one', () => {
    http.expectOne(url).flush([hoja(2), hoja(1)]);
    fixture.detectChanges();
    const confirmar = vi.spyOn(window, 'confirm').mockReturnValue(true);
    (fixture.nativeElement.querySelector('.hojas-borrar') as HTMLButtonElement).click();
    expect(confirmar.mock.calls[0][0]).toContain('¿Borrar «Hojas 2.pdf»?');
    const borrado = http.expectOne(r => r.url === `${url}2/` && r.method === 'DELETE');
    borrado.flush([hoja(1)]);
    fixture.detectChanges();
    expect(text('.hojas-nombre')).toEqual(['Hojas 1.pdf']);
    expect((fixture.nativeElement.querySelector('.hojas-visor iframe') as HTMLIFrameElement).getAttribute('src'))
      .toBe('/media/incidencias/7/hojas_1.pdf');
    confirmar.mockRestore();
  });

  it('without a viewer opens the PDF in another tab and an archived project takes no more', () => {
    fixture.componentRef.setInput('conVisor', false);
    fixture.componentRef.setInput('archivado', true);
    http.expectOne(url).flush([hoja(1)]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.hojas-subir')).toBeNull();
    expect(fixture.nativeElement.querySelector('.hojas-visor')).toBeNull();
    const abrir = vi.spyOn(window, 'open').mockReturnValue(null);
    (fixture.nativeElement.querySelector('.hojas-abrir') as HTMLButtonElement).click();
    expect(abrir).toHaveBeenCalledWith('/media/incidencias/7/hojas_1.pdf', '_blank', 'noopener');
    abrir.mockRestore();
  });
});
