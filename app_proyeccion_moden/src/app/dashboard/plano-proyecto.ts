import { ChangeDetectionStrategy, Component, OnInit, computed, inject, input, signal } from '@angular/core';

import { ApiService, PlanoBastidor, PlanoModulo, PlanoProyectoDatos } from '../services/api.service';

type Relleno = 'pendiente' | 'en-curso' | 'terminado' | 'bastidor-terminado' | 'ajeno';

const ESTADO_LABEL: Record<NonNullable<PlanoModulo['estado']>, string> = {
  pendiente: 'Pendiente',
  en_curso: 'En curso',
  terminado: 'Terminado',
};

/** Texto de un modulo que cabe en su rectangulo (metros). */
export function tamanoTexto(modulo: Pick<PlanoModulo, 'nombre' | 'ancho' | 'alto'>): number {
  return Math.min(0.5, modulo.alto * 0.36, modulo.ancho / Math.max(modulo.nombre.length * 0.62, 1));
}

/**
 * Plano de la planta desde la base tecnica: la losa con sus huecos y pilares y cada
 * modulo en su sitio, pintado por su estado. Un bastidor con todos sus modulos
 * terminados se rellena entero; al pasar por un bastidor de la lista se ven sus modulos.
 */
@Component({
  selector: 'app-plano-proyecto',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './plano-proyecto.html',
  styleUrl: './plano-proyecto.css',
})
export class PlanoProyecto implements OnInit {
  private readonly api = inject(ApiService);

  readonly proyectoId = input.required<number>();
  readonly nombre = input('');

  readonly datos = signal<PlanoProyectoDatos | null>(null);
  readonly cargando = signal(true);
  readonly error = signal('');
  /** Bastidor que se señala, desde la lista o al pasar por uno de sus modulos. */
  readonly resaltado = signal<number | null>(null);
  /** El que se ha fijado con un clic (en tactil no hay "pasar por encima"). */
  readonly fijado = signal<number | null>(null);

  readonly tamanoTexto = tamanoTexto;

  readonly bastidores = computed(() => new Map((this.datos()?.bastidores ?? []).map(b => [b.id, b])));
  readonly bastidorActivo = computed(() => this.resaltado() ?? this.fijado());

  readonly resumen = computed(() => {
    const datos = this.datos();
    const bastidores = datos?.bastidores ?? [];
    return {
      modulos: bastidores.reduce((total, b) => total + b.modulos, 0),
      modulosTerminados: bastidores.reduce((total, b) => total + b.terminados, 0),
      bastidores: bastidores.length,
      bastidoresTerminados: bastidores.filter(b => b.terminado).length,
    };
  });

  ngOnInit(): void {
    this.api.getPlanoProyecto(this.proyectoId()).subscribe({
      next: datos => {
        this.datos.set(datos);
        this.cargando.set(false);
      },
      error: err => {
        this.error.set(err?.error?.detail || 'No se ha podido cargar el plano.');
        this.cargando.set(false);
      },
    });
  }

  puntos(poligono: [number, number][]): string {
    return poligono.map(([x, y]) => `${x},${y}`).join(' ');
  }

  relleno(modulo: PlanoModulo): Relleno {
    if (modulo.estado === null) return 'ajeno';
    if (modulo.bastidor !== null && this.bastidores().get(modulo.bastidor)?.terminado) return 'bastidor-terminado';
    return modulo.estado === 'en_curso' ? 'en-curso' : modulo.estado;
  }

  bastidorDe(modulo: PlanoModulo): PlanoBastidor | undefined {
    return modulo.bastidor === null ? undefined : this.bastidores().get(modulo.bastidor);
  }

  titulo(modulo: PlanoModulo): string {
    if (modulo.estado === null) return `${modulo.nombre} · no es un módulo del proyecto`;
    const partes = [modulo.nombre];
    if (modulo.sd_de) partes.push(`segundo superior de ${modulo.sd_de}`);
    const bastidor = this.bastidorDe(modulo);
    if (bastidor) partes.push(bastidor.terminado ? `${bastidor.etiqueta} terminado` : bastidor.etiqueta);
    if (modulo.estado === 'en_curso' && !modulo.sd_de) {
      partes.push(modulo.inferior_hecho ? 'Inferior hecho' : 'Superior hecho');
    } else {
      partes.push(ESTADO_LABEL[modulo.estado]);
    }
    return partes.join(' · ');
  }

  fijar(bastidor: number): void {
    this.fijado.set(this.fijado() === bastidor ? null : bastidor);
  }
}
