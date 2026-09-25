// Motor de inferencia estadística para transporte informal (GTFS-Flex).
//
// Confianza de un tramo en el instante t:
//
//   C(t) = clamp( C_base + Σ_i w_i · V_i · e^(-λ (t - t_i)), 0, 1 )
//
// - C_base : confiabilidad estructural a priori.
// - V_i    : polaridad del reporte (+1 fluido, -1.5 demora, -2 bloqueo).
// - w_i    : peso/reputación de la fuente.
// - λ      : constante de decaimiento; vida media = ln(2)/λ.
// - t_i    : marca de tiempo del reporte.
//
// El término exponencial disipa la influencia de un reporte conforme envejece,
// de modo que el tramo "sana" progresivamente en ausencia de nuevos eventos.

export interface Reporte {
  segmento: string;
  fuente: string;
  valor: number; // V_i (polaridad)
  peso: number; // w_i (reputación ya resuelta de la fuente)
  timestamp: number; // ms desde epoch
  texto?: string;
  profundidad?: number; // saltos de propagación espacial restantes
}

// Corte duro: un reporte más viejo que esto deja de contar, aunque su
// decaimiento exponencial aún no lo haya llevado a cero.
export function edadMaxReporteMs(): number {
  const h = Number(process.env.REPORTES_TTL_HORAS);
  return (Number.isFinite(h) && h > 0 ? h : 2) * 3_600_000;
}

export function vigente(timestamp: number, ahora: number): boolean {
  return ahora - timestamp <= edadMaxReporteMs();
}

export function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

export function lambdaDesdeVidaMedia(vidaMediaSeg: number): number {
  return Math.LN2 / vidaMediaSeg;
}

// Decaimiento espacial: atenúa el impacto de un reporte sobre tramos
// topológicamente adyacentes (efecto dominó de la congestión).
export function decaimientoEspacial(distanciaMts: number, beta: number): number {
  return Math.exp(-beta * distanciaMts);
}

export class ConfianzaTemporal {
  private reportes: Reporte[] = [];

  constructor(
    readonly cBase: number,
    readonly lambda: number,
    private clock: () => number = Date.now,
  ) {}

  get vidaMediaSeg(): number {
    return Math.LN2 / this.lambda;
  }

  registrar(r: Reporte): void {
    this.reportes.push(r);
  }

  totalReportes(): number {
    return this.reportes.length;
  }

  // Reportes aún vigentes (solo lectura), para agregarlos por zona en el mapa.
  activos(t: number = this.clock()): readonly Reporte[] {
    return this.reportes.filter((r) => vigente(r.timestamp, t));
  }

  // Confianza en el instante t (por defecto, "ahora" según el reloj inyectado).
  c(t: number = this.clock()): number {
    return clamp01(this.cBase + this.contribucion(t));
  }

  // Contribución neta de los reportes activos (sin C_base), para diagnóstico.
  contribucion(t: number = this.clock()): number {
    return this.activos(t).reduce((acc, r) => {
      const dtSeg = (t - r.timestamp) / 1000;
      return acc + r.peso * r.valor * Math.exp(-this.lambda * dtSeg);
    }, 0);
  }

  // Reloj interno: purga reportes vencidos o cuya influencia ya cayó bajo un
  // umbral. Devuelve cuántos reportes expiraron.
  purgar(t: number = this.clock(), umbral = 0.005): number {
    const antes = this.reportes.length;
    this.reportes = this.reportes.filter((r) => {
      const dtSeg = (t - r.timestamp) / 1000;
      return vigente(r.timestamp, t) && Math.abs(r.peso * r.valor) * Math.exp(-this.lambda * dtSeg) >= umbral;
    });
    return antes - this.reportes.length;
  }
}
