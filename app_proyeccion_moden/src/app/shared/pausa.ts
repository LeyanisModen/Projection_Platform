/** Pausa de una mesa que pone Moden desde el admin (api/pausas.py). */
export interface PausaActiva {
  id?: number;
  motivo: string;
  /** Cuando acaba (ISO); null: hasta que Moden la reanude. */
  hasta: string | null;
}

const dos = (n: number): string => String(n).padStart(2, '0');

/** "Hasta las 16:00" o, si acaba otro dia, "Hasta el 06/11 a las 02:00"; '' sin fin. */
export function pausaHastaLabel(hasta: string | null | undefined, ahora: Date = new Date()): string {
  if (!hasta) return '';
  const fin = new Date(hasta);
  const hora = `${dos(fin.getHours())}:${dos(fin.getMinutes())}`;
  if (fin.toDateString() === ahora.toDateString()) return `Hasta las ${hora}`;
  return `Hasta el ${dos(fin.getDate())}/${dos(fin.getMonth() + 1)} a las ${hora}`;
}
