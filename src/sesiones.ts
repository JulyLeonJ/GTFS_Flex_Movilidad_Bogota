import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ConsultaNormalizada, OpcionRuta, ResultadoRecomendacion } from "./types.js";

// Une un canal de chat (Telegram/consola) con el mapa en vivo. La `clave`
// (chatId o "local") nunca se expone vía HTTP: solo la versión pública.
export interface Sesion {
  id: string;
  canal: string;
  clave: string;
  creada: string;
  actualizada: string;
  version: number;
  resultado: ResultadoRecomendacion | null;
}

export interface SesionPublica {
  id: string;
  version: number;
  actualizada: string;
  consulta: ConsultaNormalizada | null;
  opciones: OpcionRuta[];
  explicacion: string | null;
  motivos: string[];
}

const TTL_DIAS = 7;
const RUTA_DEFAULT = "data/sesiones.json";

export class SesionesService {
  readonly eventos = new EventEmitter();
  private porId = new Map<string, Sesion>();
  private porCanal = new Map<string, string>();

  constructor(
    private ruta = resolve(process.cwd(), process.env.SESIONES_JSON?.trim() || RUTA_DEFAULT),
  ) {
    this.eventos.setMaxListeners(0);
    this.cargar();
  }

  deCanal(canal: string, clave: string): Sesion {
    const llave = `${canal}:${clave}`;
    const id = this.porCanal.get(llave);
    if (id) {
      const s = this.porId.get(id);
      if (s) return s;
    }
    const ahora = new Date().toISOString();
    const s: Sesion = {
      id: randomUUID(),
      canal,
      clave,
      creada: ahora,
      actualizada: ahora,
      version: 0,
      resultado: null,
    };
    this.porId.set(s.id, s);
    this.porCanal.set(llave, s.id);
    this.guardar();
    return s;
  }

  obtener(id: string): Sesion | undefined {
    return this.porId.get(id);
  }

  actualizar(id: string, resultado: ResultadoRecomendacion): Sesion {
    const s = this.porId.get(id);
    if (!s) throw new Error(`Sesión inexistente: ${id}`);
    s.resultado = resultado;
    s.version++;
    s.actualizada = new Date().toISOString();
    this.guardar();
    this.eventos.emit(`sesion:${id}`, this.publica(s));
    return s;
  }

  publica(s: Sesion): SesionPublica {
    const r = s.resultado;
    return {
      id: s.id,
      version: s.version,
      actualizada: s.actualizada,
      consulta: r?.consulta ?? null,
      opciones: r?.opciones ?? [],
      explicacion: r?.explicacion ?? null,
      motivos: r?.motivos ?? [],
    };
  }

  private cargar(): void {
    if (!existsSync(this.ruta)) return;
    try {
      const datos = JSON.parse(readFileSync(this.ruta, "utf-8")) as Sesion[];
      const limite = Date.now() - TTL_DIAS * 86_400_000;
      for (const s of datos) {
        if (Date.parse(s.actualizada) < limite) continue;
        this.porId.set(s.id, s);
        this.porCanal.set(`${s.canal}:${s.clave}`, s.id);
      }
    } catch (err) {
      console.warn(`sesiones: no se pudo leer ${this.ruta}: ${(err as Error).message}`);
    }
  }

  // ponytail: escritura síncrona del JSON completo en cada actualización; si
  // crece a miles de sesiones, pasar a un archivo por sesión.
  private guardar(): void {
    mkdirSync(dirname(this.ruta), { recursive: true });
    const tmp = `${this.ruta}.tmp`;
    writeFileSync(tmp, JSON.stringify([...this.porId.values()]));
    renameSync(tmp, this.ruta);
  }
}

export function urlSesion(id: string): string {
  const base = (process.env.FRONTEND_URL?.trim() || "http://localhost:5173").replace(/\/+$/, "");
  return `${base}/?s=${id}`;
}
