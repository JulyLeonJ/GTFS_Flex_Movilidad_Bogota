import type { Punto } from "./types.js";

export function haversine(a: Punto, b: Punto): number {
  const R = 6371000; // radio terrestre en metros
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export async function fetchJson<T>(url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { "User-Agent": "orquestador-movilidad-bogota/0.1" },
    ...opts,
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} en ${url}`);
  }
  return (await res.json()) as T;
}

export function minutosATexto(min: number): string {
  const m = Math.round(min);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r === 0 ? `${h} h` : `${h} h ${r} min`;
}

// "HH:MM" (24h) → segundos desde medianoche, o null si es inválido.
export function horaASeg(texto: string): number | null {
  const m = texto.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 3600 + min * 60;
}

// segundos desde medianoche → "HH:MM" (24h).
export function segAHora(seg: number): string {
  const s = ((Math.round(seg) % 86400) + 86400) % 86400;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
