import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// Carga variables de entorno desde `.env` (solo si no están ya definidas).
// Nota: `.env.example` es solo la plantilla; los valores reales van en `.env`.
export function cargarDotenv(): void {
  const p = resolve(process.cwd(), ".env");
  if (!existsSync(p)) return;
  for (const linea of readFileSync(p, "utf-8").split("\n")) {
    const m = linea.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const clave = m[1];
    const valor = m[2].replace(/^["']|["']$/g, "");
    if (!process.env[clave]) process.env[clave] = valor;
  }
}
