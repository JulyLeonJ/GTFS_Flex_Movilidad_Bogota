import { fileURLToPath } from "node:url";
import { parseFlex, calcularVecinos } from "./flex.js";
import { SegmentBus, SegmentAgent } from "./segmentos.js";
import { IngestionAgent } from "./agents/ingesta.js";
import { TranscripcionAgent } from "./agents/transcripcion.js";
import { QueryAgent } from "./agents/consulta-otp.js";
import { transcribirAudio, hayStt, type AudioInput } from "./stt.js";
import { cargarDotenv } from "./dotenv.js";

cargarDotenv();

// Demo del subsistema de transporte informal (GTFS-Flex + decaimiento temporal):
// 1. Carga paradas continuas y grupos espaciales desde data/sample_flex.
// 2. Instancia un Agente de Tramo por segmento (dueño de su C(t)).
// 3. Ingiere reportes simulados de WhatsApp.
// 4. Muestra el decaimiento temporal (bloqueo → recuperación) y la propagación
//    espacial del impacto.
// 5. El Agente Orquestador consolida la confianza y arma la petición a OTP2.

function fmt(n: number): string {
  return n.toFixed(3);
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
      out[k] = v;
    }
  }
  return out;
}

async function main(): Promise<void> {
  const dir =
    process.env.FLEX_PATH ??
    fileURLToPath(new URL("../data/sample_flex", import.meta.url));

  const segmentos = parseFlex(dir);
  const vecinos = calcularVecinos(segmentos);

  const bus = new SegmentBus();
  const agentes: SegmentAgent[] = segmentos.map((s) => {
    const a = new SegmentAgent(s, bus);
    a.setVecinos(vecinos.get(s.id) ?? []);
    bus.registrar(a);
    return a;
  });

  const log = (m: string) => console.log(`  ${m}`);
  bus.suscribir((ev) => {
    if (ev.tipo === "reporte") {
      log(
        `[reporte] tramo=${ev.reporte.segmento} v=${ev.reporte.valor} w=${ev.reporte.peso.toFixed(2)}` +
          (ev.reporte.profundidad !== undefined && ev.reporte.profundidad < 1
            ? " (propagado)"
            : ""),
      );
    }
  });

  console.log("=== Segmentos informales cargados (GTFS-Flex) ===");
  for (const a of agentes) {
    const v = vecinos.get(a.segmento.id) ?? [];
    console.log(
      `  • ${a.segmento.id} [${a.segmento.tipo}] c_base=${a.segmento.cBase} ` +
        `vidaMedia=${a.segmento.vidaMediaSeg / 60}min vecinos=[${v.map((x) => x.id).join(", ")}]`,
    );
  }

  const ingesta = new IngestionAgent(
    bus,
    segmentos.map((s) => ({ id: s.id, nombre: s.nombre })),
  );

  const ahora = Date.now();
  const MIN = 60_000;
  console.log("\n=== Ingesta de reportes (WhatsApp) ===");
  const reportes = [
    ingesta.procesarMensaje(
      "Hay un bloqueo total en Quiba Mochuelo",
      "conductor_red",
      ahora - 30 * MIN,
    ),
    ingesta.procesarMensaje(
      "Todo bien en Quiba Bajo",
      "usuario_frecuente",
      ahora - 8 * MIN,
    ),
    ingesta.procesarMensaje(
      "El colectivo paso hace 5 minutos por Quiba Mochuelo",
      "whatsapp_anonimo",
      ahora - 3 * MIN,
    ),
  ];
  for (const r of reportes) {
    if (r) {
      const mins = Math.round((ahora - r.timestamp) / MIN);
      console.log(
        `  → "${r.texto}" => tramo=${r.segmento} V=${r.valor} w=${r.peso} (hace ${mins} min)`,
      );
    }
  }

  // Nota de voz: agente intermediario que transcribe y entrega a la ingesta.
  // Con --audio <ruta.ogg> transcribe el archivo real (Groq/Whisper); sin él, simula.
  const audioArg = parseArgs(process.argv.slice(2)).audio;
  const transcripcion = new TranscripcionAgent(
    ingesta,
    audioArg ? transcribirAudio : async () => "Hay un bloqueo total en Mochuelo Alto",
  );

  console.log("\n=== Nota de voz (WhatsApp) → transcripción → ingesta ===");
  console.log(
    `  STT Groq: ${hayStt() ? "disponible" : "no disponible (sin GROQ_API_KEY en .env)"}` +
      (audioArg ? ` · audio: ${audioArg}` : " · sin --audio → transcripción simulada"),
  );
  const audioInput: AudioInput = audioArg
    ? { tipo: "archivo", ruta: audioArg }
    : { tipo: "base64", mimeType: "audio/ogg", data: "<audio base64 simulado>" };
  const notaVoz = await transcripcion.recibirNotaDeVoz(
    audioInput,
    "usuario_frecuente",
    ahora - 12 * MIN,
  );
  if (notaVoz) {
    console.log(`  🔊 nota de voz transcrita: "${notaVoz.texto}"`);
    console.log(
      `  → tramo=${notaVoz.segmento} V=${notaVoz.valor} w=${notaVoz.peso} (hace ${Math.round((ahora - notaVoz.timestamp) / MIN)} min)`,
    );
  } else {
    console.log(
      `  (transcripción no disponible${audioArg ? `: revisa GROQ_API_KEY en .env o el archivo ${audioArg}` : " (sin --audio y sin GROQ_API_KEY)"})`,
    );
  }

  // El bus entrega los reportes de forma asíncrona (mensajes por microtarea);
  // esperamos a que la cascada de reportes + propagación espacial se procese.
  await new Promise((r) => setTimeout(r, 0));

  const ids = segmentos.map((s) => s.id);
  const query = new QueryAgent(agentes);

  console.log("\n=== Decaimiento temporal (C(t) conforme pasa el tiempo) ===");
  console.log(
    "  (reporte de bloqueo hace 30 min → la ruta 'sana' paulatinamente)",
  );
  for (const offsetMin of [0, 5, 10, 20, 40, 60, 90]) {
    const t = ahora + offsetMin * MIN;
    const c = query.consolidar(ids, t);
    const porSeg = c.porSegmento
      .map((s) => `${s.id}=${fmt(s.c)}`)
      .join("  ");
    console.log(
      `  t+${String(offsetMin).padStart(2)}min  min=${fmt(c.minima)}  media=${fmt(c.media)}  [${c.estado}]  (${porSeg})`,
    );
  }

  console.log("\n=== Consolidación y petición a OpenTripPlanner 2 ===");
  const consolidado = query.consolidar(ids, ahora);
  console.log(`  estado de la ruta: ${consolidado.estado} (min=${fmt(consolidado.minima)})`);
  console.log("  reluctance por tramo:");
  for (const s of consolidado.porSegmento) {
    console.log(`    ${s.id.padEnd(24)} C=${fmt(s.c)}  reluctance=${s.reluctance.toFixed(2)}`);
  }
  console.log();
  console.log(query.construirPlanOtp(
    { lat: 4.55, lon: -74.159 },
    { lat: 4.531, lon: -74.18 },
    consolidado,
  ));

  for (const a of agentes) a.detener();
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
