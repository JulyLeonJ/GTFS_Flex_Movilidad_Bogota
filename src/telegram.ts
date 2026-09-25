import { Bot } from "grammy";
import { cargarDotenv } from "./dotenv.js";
import { Recomendador } from "./recomendador.js";
import { transcribirAudio } from "./stt.js";
import { registrarReporte } from "./reporte-log.js";
import { ingestarReporte } from "./ingesta-reportes.js";

// Bot de Telegram: recibe mensajes por texto o nota de voz y los clasifica:
//
//   - Consulta de ruta  → responde con la recomendación (ctx.reply).
//   - Reporte           → ingesta al subsistema informal/oficial y persiste en
//     CSV (data/reportes.csv) con fiabilidad baja (canal no verificado).
//
// Regla de clasificación (ver manejarTexto):
//   1. Incidente grave (bloqueo/accidente/derrumbe/…) → reporte.
//   2. Estructura de ruta ("de X a Y") → consulta.
//   3. Señal de estado (demora, lento, fluido, todo bien, …) → reporte.
//   4. En otro caso → se intenta como consulta (el NLU fallará con mensaje
//      claro si no es una ruta válida).

cargarDotenv();

const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
if (!token) {
  console.error(
    "TELEGRAM_BOT_TOKEN no está definida. Copia el token de @BotFather en .env (ver .env.example).",
  );
  process.exit(1);
}

const bot = new Bot(token);
const recomendador = new Recomendador();

const logger = (m: string) => console.log(`  [telegram] ${m}`);

async function responder(texto: string): Promise<string> {
  try {
    const rec = await recomendador.recomendarTexto(texto, logger);
    return rec.resultado.explicacion;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `No pude procesar tu consulta: ${msg}`;
  }
}

function esRuta(texto: string): boolean {
  return /\bde\s+.+\s+a\s+.+/i.test(texto.trim());
}

async function procesarReporte(texto: string): Promise<string> {
  const res = await ingestarReporte(
    texto,
    "telegram",
    recomendador.informal,
    recomendador.incidentes,
    Date.now(),
    logger,
  );

  // Siempre persistir: aun sin mapear el lugar, el reporte alimenta la base
  // de conocimiento (para análisis o futuras zonas/tramos).
  registrarReporte({
    timestamp: new Date().toISOString(),
    canal: "telegram",
    fuente: "telegram",
    nivel: "informal",
    fiabilidad: res.fiabilidad,
    segmento: res.segmento,
    valor: res.valor,
    lat: res.lat,
    lon: res.lon,
    texto,
  });

  if (res.segmento.startsWith("punto:")) {
    return (
      `Incidente geolocalizado en ${res.segmento.replace(/^punto:/, "")} ` +
      `(fiabilidad ${(res.fiabilidad * 100).toFixed(0)}%). Gracias, alimenta la base de conocimiento.`
    );
  }
  if (res.mapeado) {
    return (
      `Reporte registrado en ${res.segmento} ` +
      `(fiabilidad ${(res.fiabilidad * 100).toFixed(0)}%). Gracias, alimenta la base de conocimiento.`
    );
  }
  return (
    "Gracias, registré tu reporte. Aún no tengo mapeado ese lugar, " +
    "pero quedó guardado en la base de conocimiento."
  );
}

async function manejarTexto(texto: string): Promise<string> {
  const t = texto.trim();
  // Incidente grave gana sobre la estructura de ruta.
  if (recomendador.informal.esIncidenteFuerte(t)) return procesarReporte(t);
  if (esRuta(t)) return responder(t);
  if (recomendador.informal.esReporte(t)) return procesarReporte(t);
  return responder(t);
}

bot.command("start", async (ctx) => {
  await ctx.reply(
    "¡Hola! Soy el orquestador de movilidad de Bogotá.\n" +
      'Pídeme una ruta con "de Quiba Bajo a Mochuelo Alto en 30 min" ' +
      "o envíame una nota de voz.\n" +
      'Para reportar el estado de una vía informal, escribe algo como ' +
      '"bloqueo en Quiba Bajo" (o usa /reporte <descripción>).',
  );
});

bot.command("reporte", async (ctx) => {
  const texto = (ctx.match ?? "").trim();
  if (!texto) {
    await ctx.reply(
      "Uso: /reporte <descripción del estado de la vía>. Ej.: /reporte bloqueo en Quiba Bajo",
    );
    return;
  }
  await ctx.reply(await procesarReporte(texto));
});

bot.on("message:text", async (ctx) => {
  const texto = ctx.message.text.trim();
  if (!texto || texto.startsWith("/")) return;
  await ctx.replyWithChatAction("typing");
  await ctx.reply(await manejarTexto(texto));
});

bot.on("message:voice", async (ctx) => {
  await ctx.replyWithChatAction("typing");
  try {
    const file = await ctx.getFile();
    const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
    const res = await fetch(url);
    if (!res.ok) {
      await ctx.reply("No pude descargar la nota de voz.");
      return;
    }
    const data = Buffer.from(await res.arrayBuffer());
    const texto = await transcribirAudio({
      tipo: "base64",
      mimeType: "audio/ogg",
      data: data.toString("base64"),
    });
    if (!texto) {
      await ctx.reply(
        "No pude transcribir la nota de voz (¿falta GROQ_API_KEY en .env?).",
      );
      return;
    }
    await ctx.reply(await manejarTexto(texto));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await ctx.reply(`No pude procesar la nota de voz: ${msg}`);
  }
});

bot.catch((err) => {
  console.error(`[telegram] error: ${(err as Error).message}`);
});

// Rehidrata la base de conocimiento de reportes antes de escuchar, para que los
// reportes recientes sigan afectando el enrutamiento tras un reinicio.
recomendador
  .rehidratar(logger)
  .catch((err) => console.error("[telegram] rehidratación:", err))
  .finally(() => {
    bot.start({
      onStart: (info) =>
        console.log(`[telegram] bot @${info.username} escuchando…`),
    });
  });
