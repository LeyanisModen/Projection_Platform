import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TurnoConfig } from '../services/api.service';
import { TurnosEditorComponent } from './turnos-editor.component';
import { copiarTurnos, nuevoTurno, turnosError, turnosLabel } from './turnos';

const dias = (days: string[], start: string, end: string) =>
  days.map(day => ({ day: day as any, start_time: start, end_time: end }));

describe('turnos', () => {
  it('labels only the active shifts, with the name when there is more than one', () => {
    const manana: TurnoConfig = { nombre: 'Mañana', activo: true, horario: dias(['MON', 'TUE', 'WED', 'THU', 'FRI'], '06:00', '16:00') };
    const noche: TurnoConfig = { nombre: 'Noche', activo: true, horario: dias(['SUN', 'MON', 'TUE', 'WED', 'THU'], '19:00', '05:00') };
    expect(turnosLabel([manana])).toBe('Lun–Vie 06:00–16:00');
    expect(turnosLabel([manana, noche])).toBe('Mañana Lun–Vie 06:00–16:00 · Noche Lun–Jue, Dom 19:00–05:00');
    expect(turnosLabel([manana, { ...noche, activo: false }])).toBe('Lun–Vie 06:00–16:00');
  });

  it('accepts a night shift that ends the next day but not empty or repeated shifts', () => {
    const noche: TurnoConfig = { nombre: 'Noche', activo: true, horario: dias(['MON'], '19:00', '05:00') };
    expect(turnosError([noche])).toBeNull();
    expect(turnosError([])).toBe('Añade al menos un turno.');
    expect(turnosError([noche, { ...noche, nombre: ' noche ' }])).toBe('Hay dos turnos con el mismo nombre.');
    expect(turnosError([{ ...noche, activo: false }])).toBe('Deja al menos un turno activo.');
    expect(turnosError([{ ...noche, horario: [] }])).toBe('Noche: elige al menos un día.');
    expect(turnosError([{ ...noche, horario: dias(['MON'], '19:00', '19:00') }])).toBe('Noche, lunes: pon horas distintas de inicio y fin.');
  });

  it('copies shifts deeply and names new ones without repeating', () => {
    const turnos: TurnoConfig[] = [{ nombre: 'Turno 2', activo: true, horario: dias(['MON', 'FRI'], '06:00', '14:00') }];
    const copia = copiarTurnos(turnos);
    copia[0].horario[0].start_time = '07:00';
    expect(turnos[0].horario[0].start_time).toBe('06:00');
    expect(nuevoTurno(turnos)).toEqual({ nombre: 'Turno 3', activo: true, horario: dias(['MON', 'FRI'], '14:00', '22:00') });
  });
});

describe('TurnosEditorComponent', () => {
  let fixture: ComponentFixture<TurnosEditorComponent>;
  let turnos: TurnoConfig[];
  let cambios: number;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [TurnosEditorComponent] }).compileComponents();
    fixture = TestBed.createComponent(TurnosEditorComponent);
    turnos = [{ nombre: 'Mañana', activo: true, horario: dias(['MON', 'TUE'], '06:00', '16:00') }];
    fixture.componentInstance.turnos = turnos;
    cambios = 0;
    fixture.componentInstance.cambio.subscribe(() => cambios++);
    fixture.detectChanges();
  });

  const el = (): HTMLElement => fixture.nativeElement;

  it('turns days on with the first day hours and copies one day to the rest', () => {
    const editor = fixture.componentInstance;
    (el().querySelector('[aria-label="Mañana: trabajar el miércoles"]') as HTMLButtonElement).click();
    expect(turnos[0].horario.map(d => d.day)).toEqual(['MON', 'TUE', 'WED']);
    expect(turnos[0].horario[2]).toEqual({ day: 'WED', start_time: '06:00', end_time: '16:00' });
    editor.setHora(turnos[0], 'MON', 'end_time', '14:00');
    editor.copiarA(turnos[0], 'MON');
    expect(turnos[0].horario.every(d => d.end_time === '14:00')).toBe(true);
    expect(cambios).toBe(3);
  });

  it('keeps a fixed head count per shift, a whole number or nothing', () => {
    const editor = fixture.componentInstance;
    const personas = el().querySelector('[aria-label="Personas en el turno Mañana"]') as HTMLInputElement;
    expect(personas.value).toBe('');
    editor.setPersonas(turnos[0], '6');
    expect(turnos[0].personas).toBe(6);
    editor.setPersonas(turnos[0], 4.7);
    expect(turnos[0].personas).toBe(4);
    editor.setPersonas(turnos[0], -2);
    expect(turnos[0].personas).toBeUndefined();
    editor.setPersonas(turnos[0], '');
    expect(turnos[0].personas).toBeUndefined();
    expect(cambios).toBe(4);
    expect(copiarTurnos([{ ...turnos[0], personas: 5 }])[0].personas).toBe(5);
    expect('personas' in copiarTurnos(turnos)[0]).toBe(false);
  });

  it('adds and removes shifts and marks the days that end after midnight', () => {
    (el().querySelector('.turno-anadir') as HTMLButtonElement).click();
    expect(turnos.map(t => t.nombre)).toEqual(['Mañana', 'Turno 2']);
    turnos[1].horario[0].start_time = '19:00';
    turnos[1].horario[0].end_time = '05:00';
    fixture.componentRef.changeDetectorRef.markForCheck();
    fixture.detectChanges();
    expect(el().querySelectorAll('.turno')[1].querySelectorAll('.turno-siguiente').length).toBe(1);
    (el().querySelectorAll('.turno-quitar')[1] as HTMLButtonElement).click();
    expect(turnos.map(t => t.nombre)).toEqual(['Mañana']);
    fixture.detectChanges();
    // Con un solo turno no se puede quitar.
    expect(el().querySelector('.turno-quitar')).toBeNull();
  });
});
