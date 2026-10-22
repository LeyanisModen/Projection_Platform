import { ComponentFixture, TestBed } from '@angular/core/testing';

import { StatsLineChart, niceScale, sqrtScale } from './stats-line-chart';

describe('StatsLineChart', () => {
  let fixture: ComponentFixture<StatsLineChart>;
  let chart: StatsLineChart;
  const el = (): HTMLElement => fixture.nativeElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [StatsLineChart] }).compileComponents();
    fixture = TestBed.createComponent(StatsLineChart);
    chart = fixture.componentInstance;
    fixture.componentRef.setInput('title', 'Módulos fabricados');
    fixture.componentRef.setInput('unit', 'módulos');
    fixture.componentRef.setInput('labels', ['Lun 14', 'Mar 15', 'Mié 16', 'Jue 17']);
  });

  it('splits the height under and over a single line, up to a fixed ceiling', () => {
    fixture.componentRef.setInput('unit', '%');
    fixture.componentRef.setInput('maxValue', 100);
    fixture.componentRef.setInput('split', { below: '#2a78d6', above: '#c08400', belowLabel: 'Trabajo', aboveLabel: 'Tiempo muerto' });
    fixture.componentRef.setInput('series', [{ name: 'Trabajado', color: '#2a78d6', values: [60, 75, 0, 40],
      tooltips: ['60 % · 6 h de trabajo + 4 h muertas', null, null, null] }]);
    fixture.detectChanges();

    // Rellenos degradados como el area de las demas graficas, cada uno con su color.
    const relleno = (clase: string) => {
      const id = el().querySelector(`path.${clase}`)?.getAttribute('fill')?.match(/url\(#(.+)\)/)?.[1];
      return Array.from(el().querySelectorAll(`[id="${id}"] stop`)).map(st => st.getAttribute('stop-color'));
    };
    expect(relleno('lc-split-below')).toEqual(['#2a78d6', '#2a78d6']);
    expect(relleno('lc-split-above')).toEqual(['#c08400', '#c08400']);
    // El eje llega al 100 aunque ningun punto lo toque, sin degradado ni etiqueta del maximo.
    expect(Array.from(el().querySelectorAll('.lc-tick')).map(t => t.textContent).at(-1)).toBe('100');
    expect(el().querySelector('.lc-pico')).toBeNull();
    expect(Array.from(el().querySelectorAll('.lc-legend li')).map(li => li.textContent?.trim())).toEqual(['Trabajo', 'Tiempo muerto']);
    chart.active.set(0);
    fixture.detectChanges();
    expect(el().querySelector('.lc-tooltip-row strong')?.textContent).toBe('60 % · 6 h de trabajo + 4 h muertas');
  });

  it('keeps the area and the peak of the main series when asked, with a second series on the same scale', () => {
    fixture.componentRef.setInput('unit', 'kg');
    fixture.componentRef.setInput('primaryArea', true);
    fixture.componentRef.setInput('series', [
      { name: 'Peso producido', color: '#52606d', values: [120, 380, 110, 421] },
      { name: 'Desperdicio', color: '#f0640f', values: [5, 9, 4, 12] },
    ]);
    fixture.detectChanges();
    expect(Array.from(el().querySelectorAll('.lc-pico')).map(t => t.textContent)).toEqual(['421']);
    expect(Array.from(el().querySelectorAll('.lc-legend li')).map(li => li.textContent?.trim())).toEqual(['Peso producido', 'Desperdicio']);
  });

  it('can use a square-root axis so the small values (the waste next to the weight) are seen, smoothly', () => {
    expect(sqrtScale(421)).toEqual({ max: 500, ticks: [0, 10, 50, 100, 200, 500] });
    expect(sqrtScale(4059)).toEqual({ max: 5000, ticks: [0, 100, 500, 1000, 2000, 5000] });
    expect(sqrtScale(0).ticks[0]).toBe(0);
    fixture.componentRef.setInput('unit', 'kg');
    fixture.componentRef.setInput('sqrtScale', true);
    fixture.componentRef.setInput('series', [
      { name: 'Peso producido', color: '#f0640f', values: [2000, 4059, 0, 3000] },
      { name: 'Desperdicio', color: '#52606d', values: [80, 160, 0, 120] },
    ]);
    fixture.detectChanges();
    expect(Array.from(el().querySelectorAll('.lc-tick')).map(t => t.textContent)).toEqual(['0', '100', '500', '1,000', '2,000', '5,000']);
    // 160 kg de desperdicio sobre 5,000 queda a casi un 18 % del alto (lineal: un 3 %).
    const ys = (serie: number) => Array.from(el().querySelectorAll('svg[role="img"] circle'))
      .slice(serie * 4, serie * 4 + 4).map(c => Number(c.getAttribute('cy')));
    const lineas = Array.from(el().querySelectorAll('.lc-grid')).map(l => Number(l.getAttribute('y1')));
    const [cero, tope] = [lineas[0], lineas[lineas.length - 1]];
    const desperdicio = ys(1);
    expect((cero - desperdicio[1]) / (cero - tope)).toBeCloseTo(Math.sqrt(160 / 5000), 2);
  });

  it('rounds the axis to clean steps', () => {
    expect(niceScale(0, 0)).toEqual({ max: 1, ticks: [0, 1] });
    expect(niceScale(7, 0)).toEqual({ max: 8, ticks: [0, 2, 4, 6, 8] });
    expect(niceScale(3, 0).ticks).toEqual([0, 1, 2, 3]);
    expect(niceScale(6488, 0).max).toBe(8000);
    expect(niceScale(2.6, 1).ticks).toEqual([0, 1, 2, 3]);
  });

  it('marks each point against the target: met, below, or still in progress', () => {
    fixture.componentRef.setInput('series', [{ name: 'Módulos', color: '#f0640f', values: [3, 1, 2, 1] }]);
    fixture.componentRef.setInput('target', [2, 2, 2, 2]);
    fixture.componentRef.setInput('targetLabel', 'Objetivo 2 al día');
    fixture.componentRef.setInput('pending', [false, false, false, true]);
    fixture.detectChanges();

    const puntos = Array.from(el().querySelectorAll('svg[role="img"] circle'));
    expect(puntos.map(p => p.getAttribute('class'))).toEqual([
      'lc-dot-cumple', 'lc-dot-hueco', 'lc-dot-cumple', 'lc-dot-hueco lc-dot-curso',
    ]);
    // Por debajo: hueco con el color de la serie. En curso: hueco gris, sin juzgar.
    expect(puntos[1].getAttribute('stroke')).toBe('#f0640f');
    expect(puntos[3].getAttribute('stroke')).toBeNull();
    expect(el().querySelector('path.lc-target')).not.toBeNull();
    // Solo se etiqueta el maximo; el resto lo dicen el eje y la lectura.
    expect(Array.from(el().querySelectorAll('.lc-pico')).map(t => t.textContent)).toEqual(['3']);
    expect(el().querySelector('.lc-target-label')?.textContent).toBe('Objetivo 2 al día');
    expect(Array.from(el().querySelectorAll('.lc-legend li')).map(li => li.textContent?.trim()))
      .toEqual(['Llega al objetivo', 'Por debajo', 'Objetivo 2 al día']);
  });

  it('moves the target label to the start when the last point sits on the target line', () => {
    fixture.componentRef.setInput('target', [2, 2, 2, 2]);
    fixture.componentRef.setInput('series', [{ name: 'Módulos', color: '#f0640f', values: [0, 8, 8, 8] }]);
    fixture.detectChanges();
    expect(el().querySelector('.lc-target-label')?.getAttribute('text-anchor')).toBe('end');

    fixture.componentRef.setInput('series', [{ name: 'Módulos', color: '#f0640f', values: [0, 8, 8, 2] }]);
    fixture.detectChanges();
    expect(el().querySelector('.lc-target-label')?.getAttribute('text-anchor')).toBe('start');
  });

  it('fades the line towards the previous and next period only where they are known', () => {
    fixture.componentRef.setInput('series', [{ name: 'Módulos', color: '#f0640f', values: [3, 1, 2, 1], prev: 4, next: null }]);
    fixture.detectChanges();
    expect(el().querySelectorAll('line.lc-line').length).toBe(1);

    fixture.componentRef.setInput('series', [{ name: 'Módulos', color: '#f0640f', values: [3, 1, 2, 1], prev: 4, next: 2 }]);
    fixture.detectChanges();
    expect(el().querySelectorAll('line.lc-line').length).toBe(2);

    // Un ultimo periodo aun sin datos no tiene salida desvanecida.
    fixture.componentRef.setInput('series', [{ name: 'Módulos', color: '#f0640f', values: [3, 1, 2, null], prev: null, next: 2 }]);
    fixture.detectChanges();
    expect(el().querySelectorAll('line.lc-line').length).toBe(0);
    expect(el().querySelectorAll('svg[role="img"] circle').length).toBe(3);
  });

  it('reads every series at the hovered column and moves with the arrow keys', () => {
    fixture.componentRef.setInput('series', [
      { name: 'Inferior', color: '#2a78d6', values: [40, 38, null, 45] },
      { name: 'Superior', color: '#f0640f', values: [20, 22, 25, 21] },
    ]);
    fixture.componentRef.setInput('unit', 'min');
    fixture.detectChanges();
    expect(Array.from(el().querySelectorAll('.lc-legend li')).map(li => li.textContent?.trim())).toEqual(['Inferior', 'Superior']);
    expect(el().querySelector('.lc-tooltip')).toBeNull();

    chart.active.set(2);
    fixture.detectChanges();
    const tooltip = el().querySelector('.lc-tooltip') as HTMLElement;
    expect(tooltip.querySelector('.lc-tooltip-label')?.textContent).toBe('Mié 16');
    const filas = Array.from(tooltip.querySelectorAll('.lc-tooltip-row'));
    expect(filas.map(r => r.querySelector('strong')?.textContent)).toEqual(['sin datos', '25 min']);
    expect(filas.map(r => r.querySelector('span:last-child')?.textContent)).toEqual(['Inferior', 'Superior']);

    chart.onKey(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    expect(chart.active()).toBe(3);
    chart.onKey(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    expect(chart.active()).toBe(3);
  });

  it('says there is no data instead of drawing an empty axis', () => {
    fixture.componentRef.setInput('series', [{ name: 'Peso', color: '#52606d', values: [null, null, null, null] }]);
    fixture.detectChanges();
    expect(el().querySelector('svg[role="img"]')).toBeNull();
    expect(el().querySelector('.lc-empty')?.textContent).toBe('Sin datos en el periodo.');
  });
});
