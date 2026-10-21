import { CaptureDay, HorarioDia, TurnoConfig } from '../services/api.service';

/** Dias de la semana en el orden de la ferralla. */
export const DIAS: ReadonlyArray<{ code: CaptureDay; label: string; abrev: string; nombre: string }> = [
  { code: 'MON', label: 'L', abrev: 'Lun', nombre: 'lunes' },
  { code: 'TUE', label: 'M', abrev: 'Mar', nombre: 'martes' },
  { code: 'WED', label: 'X', abrev: 'Mié', nombre: 'miércoles' },
  { code: 'THU', label: 'J', abrev: 'Jue', nombre: 'jueves' },
  { code: 'FRI', label: 'V', abrev: 'Vie', nombre: 'viernes' },
  { code: 'SAT', label: 'S', abrev: 'Sáb', nombre: 'sábado' },
  { code: 'SUN', label: 'D', abrev: 'Dom', nombre: 'domingo' },
];

const orden = (day: CaptureDay) => DIAS.findIndex(d => d.code === day);

/** Copia editable de los turnos (el editor los cambia en el sitio). */
export function copiarTurnos(turnos: TurnoConfig[] | null | undefined): TurnoConfig[] {
  return (turnos || []).map(turno => ({
    nombre: turno.nombre,
    activo: turno.activo,
    horario: turno.horario.map(dia => ({ ...dia })),
    ...(turno.personas != null ? { personas: turno.personas } : {}),
  }));
}

/** Acaba al dia siguiente (19:00 a 05:00). */
export function cruzaMedianoche(dia: HorarioDia): boolean {
  return !!dia.start_time && !!dia.end_time && dia.end_time <= dia.start_time;
}

/** "Lun–Jue, Dom 19:00–05:00": dias seguidos con la misma jornada juntos. */
export function jornadaLabel(horario: HorarioDia[]): string {
  const porDia = new Map(horario.map(dia => [dia.day, `${dia.start_time}–${dia.end_time}`]));
  const tramos: Array<{ desde: number; hasta: number; horas: string }> = [];
  DIAS.forEach(({ code }, index) => {
    const horas = porDia.get(code);
    if (!horas) return;
    const ultimo = tramos[tramos.length - 1];
    if (ultimo && ultimo.hasta === index - 1 && ultimo.horas === horas) ultimo.hasta = index;
    else tramos.push({ desde: index, hasta: index, horas });
  });
  const dias = (t: { desde: number; hasta: number }) => t.hasta === t.desde ? DIAS[t.desde].abrev
    : t.hasta === t.desde + 1 ? `${DIAS[t.desde].abrev}, ${DIAS[t.hasta].abrev}`
    : `${DIAS[t.desde].abrev}–${DIAS[t.hasta].abrev}`;
  // Tramos sueltos con las mismas horas, en un solo grupo.
  const porHoras = new Map<string, string[]>();
  tramos.forEach(t => porHoras.set(t.horas, [...(porHoras.get(t.horas) || []), dias(t)]));
  return [...porHoras.entries()].map(([horas, grupos]) => `${grupos.join(', ')} ${horas}`).join(' · ');
}

/** "Mañana Lun–Vie 06:00–16:00 · Noche Lun–Jue, Dom 19:00–05:00" (solo los activos). */
export function turnosLabel(turnos: TurnoConfig[] | null | undefined): string {
  const activos = (turnos || []).filter(turno => turno.activo && turno.horario.length);
  if (!activos.length) return 'Sin turnos de trabajo';
  if (activos.length === 1) return jornadaLabel(activos[0].horario);
  return activos.map(turno => `${turno.nombre} ${jornadaLabel(turno.horario)}`).join(' · ');
}

/** Por que no se pueden guardar los turnos, o null si estan bien. */
export function turnosError(turnos: TurnoConfig[]): string | null {
  if (!turnos.length) return 'Añade al menos un turno.';
  if (turnos.some(turno => !turno.nombre.trim())) return 'Pon nombre a todos los turnos.';
  const nombres = turnos.map(turno => turno.nombre.trim().toLowerCase());
  if (new Set(nombres).size !== nombres.length) return 'Hay dos turnos con el mismo nombre.';
  if (!turnos.some(turno => turno.activo)) return 'Deja al menos un turno activo.';
  for (const turno of turnos) {
    if (turno.activo && !turno.horario.length) return `${turno.nombre}: elige al menos un día.`;
    const malo = turno.horario.find(dia => !dia.start_time || !dia.end_time || dia.start_time === dia.end_time);
    if (malo) return `${turno.nombre}, ${DIAS[orden(malo.day)].nombre}: pon horas distintas de inicio y fin.`;
  }
  return null;
}

/** Turno nuevo: los mismos dias que el primero, para cambiarle las horas. */
export function nuevoTurno(turnos: TurnoConfig[]): TurnoConfig {
  let n = turnos.length + 1;
  while (turnos.some(turno => turno.nombre.trim().toLowerCase() === `turno ${n}`)) n++;
  const dias = turnos[0]?.horario.map(dia => dia.day) ?? DIAS.slice(0, 5).map(d => d.code);
  return { nombre: `Turno ${n}`, activo: true, horario: dias.map(day => ({ day, start_time: '14:00', end_time: '22:00' })) };
}

export function ordenarHorario(horario: HorarioDia[]): HorarioDia[] {
  return [...horario].sort((a, b) => orden(a.day) - orden(b.day));
}
