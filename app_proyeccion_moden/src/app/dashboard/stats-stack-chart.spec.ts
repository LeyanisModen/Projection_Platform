import { ComponentFixture, TestBed } from '@angular/core/testing';

import { StatsStackChart } from './stats-stack-chart';

describe('StatsStackChart', () => {
  let fixture: ComponentFixture<StatsStackChart>;
  let chart: StatsStackChart;
  const el = (): HTMLElement => fixture.nativeElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [StatsStackChart] }).compileComponents();
    fixture = TestBed.createComponent(StatsStackChart);
    chart = fixture.componentInstance;
    fixture.componentRef.setInput('title', 'Horas de trabajo y tiempo muerto');
    fixture.componentRef.setInput('unit', 'h');
    fixture.componentRef.setInput('decimals', 1);
    fixture.componentRef.setInput('shareLabel', 'trabajado');
    fixture.componentRef.setInput('labels', ['Lun 14', 'Mar 15', 'Mié 16']);
    fixture.componentRef.setInput('series', [
      { name: 'Trabajo', color: '#2a78d6', values: [6, 0, null] },
      { name: 'Tiempo muerto', color: '#c08400', values: [4, 10, null] },
    ]);
    fixture.detectChanges();
  });

  it('stacks the work under the dead time, one bar per period with data', () => {
    const barras = Array.from(el().querySelectorAll('g.sc-bar'));
    // El miercoles no tiene datos: sin barra. El martes solo tiene tiempo muerto.
    expect(barras.map(b => b.querySelectorAll('path').length)).toEqual([2, 1]);
    expect(Array.from(barras[0].querySelectorAll('path')).map(p => p.getAttribute('fill'))).toEqual(['#2a78d6', '#c08400']);
    expect(Array.from(el().querySelectorAll('.sc-legend li')).map(li => li.textContent?.trim())).toEqual(['Trabajo', 'Tiempo muerto']);
    // El eje llega al total de la columna mas alta (10 h).
    expect(Array.from(el().querySelectorAll('.sc-tick')).map(t => t.textContent).at(-1)).toBe('10');
  });

  it('reads each bar: both parts and the share of work', () => {
    chart.active.set(0);
    fixture.detectChanges();
    const tip = el().querySelector('.sc-tooltip') as HTMLElement;
    expect(tip.querySelector('.sc-tooltip-label')?.textContent).toBe('Lun 14');
    expect(Array.from(tip.querySelectorAll('.sc-tooltip-row')).map(r => [r.querySelector('strong')?.textContent, r.querySelector('span:last-child')?.textContent]))
      .toEqual([['6 h', 'Trabajo'], ['4 h', 'Tiempo muerto']]);
    expect(tip.querySelector('.sc-tooltip-share')?.textContent).toBe('60 % trabajado');
    chart.active.set(1);
    fixture.detectChanges();
    expect(el().querySelector('.sc-tooltip-share')?.textContent).toBe('0 % trabajado');
    // Las demas barras se apagan mientras se lee una.
    expect(el().querySelectorAll('g.sc-dim').length).toBe(1);
  });

  it('says so when nothing was recorded', () => {
    fixture.componentRef.setInput('series', [{ name: 'Trabajo', color: '#2a78d6', values: [null, 0, null] }]);
    fixture.detectChanges();
    expect(el().querySelector('.sc-empty')?.textContent).toBe('Sin datos en el periodo.');
  });
});
