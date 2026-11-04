import { pausaHastaLabel } from './pausa';

describe('pausaHastaLabel', () => {
  const ahora = new Date(2026, 10, 5, 9, 30);

  it('dice la hora si acaba hoy, el dia si acaba otro y nada sin fin', () => {
    expect(pausaHastaLabel(new Date(2026, 10, 5, 16, 0).toISOString(), ahora)).toBe('Hasta las 16:00');
    expect(pausaHastaLabel(new Date(2026, 10, 6, 2, 5).toISOString(), ahora)).toBe('Hasta el 06/11 a las 02:05');
    expect(pausaHastaLabel(null, ahora)).toBe('');
  });
});
