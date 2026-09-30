import { ComponentFixture, TestBed } from '@angular/core/testing';

import { StatsLineChart, niceScale } from './stats-line-chart';

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
    expect(el().querySelector('.lc-target-label')?.textContent).toBe('Objetivo 2 al día');
    expect(Array.from(el().querySelectorAll('.lc-legend li')).map(li => li.textContent?.trim()))
      .toEqual(['Llega al objetivo', 'Por debajo', 'Objetivo 2 al día']);
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
