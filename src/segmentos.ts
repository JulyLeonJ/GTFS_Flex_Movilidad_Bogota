import { ConfianzaTemporal, decaimientoEspacial, type Reporte } from "./confianza.js";
import { lambdaDelSegmento, type SegmentoInformal, type Vecino } from "./flex.js";

// Orquestación multiagente del transporte informal:
// - SegmentAgent: micro-agente dueño de la confianza C(t) de un tramo, con su
//   propio reloj interno que aplica el decaimiento temporal.
// - SegmentBus: bus de mensajes asíncronos (los agentes se "gritan" reportes).

export type EventoBus =
  | { tipo: "reporte"; reporte: Reporte }
  | { tipo: "decay"; segmento: string; purgados: number };

export type OyenteBus = (ev: EventoBus) => void;

const TICK_MS = 30_000;
const BETA_DEFECTO = 0.002; // decaimiento espacial por metro (más grande = más local)

export class SegmentBus {
  private agentes = new Map<string, SegmentAgent>();
  private oyentes: OyenteBus[] = [];

  registrar(agente: SegmentAgent): void {
    this.agentes.set(agente.segmento.id, agente);
  }

  // "Grita" un reporte al Agente de Tramo afectado (envío asíncrono).
  publicar(reporte: Reporte): void {
    const ag = this.agentes.get(reporte.segmento);
    if (!ag) return;
    queueMicrotask(() => ag.recibir(reporte));
  }

  suscribir(oyente: OyenteBus): void {
    this.oyentes.push(oyente);
  }

  emitir(ev: EventoBus): void {
    for (const o of this.oyentes) o(ev);
  }

  obtener(id: string): SegmentAgent | undefined {
    return this.agentes.get(id);
  }

  agentesActivos(): SegmentAgent[] {
    return [...this.agentes.values()];
  }
}

export class SegmentAgent {
  readonly confianza: ConfianzaTemporal;
  readonly vecinos: Vecino[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    readonly segmento: SegmentoInformal,
    private bus: SegmentBus,
    private beta: number = BETA_DEFECTO,
  ) {
    this.confianza = new ConfianzaTemporal(
      segmento.cBase,
      lambdaDelSegmento(segmento),
    );
  }

  setVecinos(v: Vecino[]): void {
    this.vecinos.splice(0, this.vecinos.length, ...v);
  }

  iniciar(): void {
    if (!this.timer) this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  detener(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // Reloj interno: aplica el decaimiento temporal purgando reportes que ya no
  // aportan señal relevante.
  tick(): void {
    const purgados = this.confianza.purgar();
    if (purgados > 0) {
      this.bus.emitir({ tipo: "decay", segmento: this.segmento.id, purgados });
    }
  }

  c(t: number = Date.now()): number {
    return this.confianza.c(t);
  }

  recibir(r: Reporte): void {
    this.confianza.registrar(r);
    this.bus.emitir({ tipo: "reporte", reporte: r });

    // Decaimiento espacial: propaga el impacto a tramos adyacentes (1 salto).
    const profundidad = r.profundidad ?? 1;
    if (profundidad <= 0) return;
    for (const v of this.vecinos) {
      const pesoAtenuado = r.peso * decaimientoEspacial(v.distanciaMts, this.beta);
      if (pesoAtenuado < 1e-4) continue;
      this.bus.publicar({
        ...r,
        segmento: v.id,
        peso: pesoAtenuado,
        profundidad: profundidad - 1,
      });
    }
  }
}
