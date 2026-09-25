import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { cargarDotenv } from "./dotenv.js";
import { Recomendador } from "./recomendador.js";
import { SesionesService, type Sesion, type SesionPublica } from "./sesiones.js";
import { areaMvp } from "./gtfs.js";
import { calcularCongestion, aGeoJson } from "./congestion.js";
import { iniciarTelegram } from "./telegram.js";
import { iniciarConsola } from "./consola.js";
import type { Deps } from "./conversacion.js";

// Servidor: un solo proceso con la API HTTP para el mapa (solo lectura), el bot
// de Telegram y la consola interactiva. Comparten el Recomendador (incidentes y
// confianza C(t) en memoria) y las sesiones; por eso no pueden ser procesos
// separados.

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function sse(
  req: IncomingMessage,
  res: ServerResponse,
  s: Sesion,
  deps: Deps,
  congestion: () => unknown,
): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const enviar = (evento: string, data: unknown) =>
    res.write(`event: ${evento}\ndata: ${JSON.stringify(data)}\n\n`);
  const onSesion = (p: SesionPublica) => enviar("sesion", p);
  // ponytail: cada pestaña recalcula la congestión; cachear por emisión si hay muchas.
  const onCongestion = () => enviar("congestion", congestion());

  enviar("sesion", deps.sesiones.publica(s));
  onCongestion();
  deps.sesiones.eventos.on(`sesion:${s.id}`, onSesion);
  deps.sesiones.eventos.on("congestion", onCongestion);
  const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
  req.on("close", () => {
    clearInterval(ping);
    deps.sesiones.eventos.off(`sesion:${s.id}`, onSesion);
    deps.sesiones.eventos.off("congestion", onCongestion);
  });
}

function atender(
  req: IncomingMessage,
  res: ServerResponse,
  deps: Deps,
  congestion: () => unknown,
): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method !== "GET") return json(res, 405, { error: "método no permitido" });
  if (url.pathname === "/api/salud") return json(res, 200, { ok: true });
  if (url.pathname === "/api/area") {
    const a = areaMvp();
    return json(
      res,
      200,
      a
        ? { nombre: a.nombre, bbox: [a.bbox.oeste, a.bbox.sur, a.bbox.este, a.bbox.norte] }
        : { nombre: null, bbox: null },
    );
  }
  if (url.pathname === "/api/congestion") return json(res, 200, congestion());
  const m = url.pathname.match(/^\/api\/sesiones\/([0-9a-f-]{36})(\/eventos)?$/i);
  if (m) {
    const s = deps.sesiones.obtener(m[1]);
    if (!s) return json(res, 404, { error: "sesión no encontrada" });
    return m[2] ? sse(req, res, s, deps, congestion) : json(res, 200, deps.sesiones.publica(s));
  }
  return json(res, 404, { error: "no encontrado" });
}

async function main(): Promise<void> {
  cargarDotenv();
  const logger = (m: string) => console.log(`  ${m}`);
  const recomendador = new Recomendador();
  const sesiones = new SesionesService();
  const deps: Deps = { recomendador, sesiones, logger };
  await recomendador.rehidratar(logger);

  const congestion = () =>
    aGeoJson(calcularCongestion(recomendador.incidentes, recomendador.informal));
  const server = createServer((req, res) => {
    try {
      atender(req, res, deps, congestion);
    } catch (err) {
      logger(`[api] ${(err as Error).message}`);
      if (!res.headersSent) json(res, 500, { error: "error interno" });
    }
  });
  const port = Number(process.env.API_PORT) || 8787;
  server.listen(port, "127.0.0.1", () => console.log(`[api] http://127.0.0.1:${port}`));

  // El decaimiento temporal cambia los niveles aunque no lleguen reportes.
  setInterval(() => sesiones.eventos.emit("congestion"), 60_000).unref();

  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (token) iniciarTelegram(deps, token);
  else console.log("[telegram] TELEGRAM_BOT_TOKEN vacío: bot desactivado");
  if (process.stdin.isTTY) iniciarConsola(deps);

  process.on("SIGINT", () => {
    recomendador.detener();
    server.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Error fatal:", err);
  process.exit(1);
});
