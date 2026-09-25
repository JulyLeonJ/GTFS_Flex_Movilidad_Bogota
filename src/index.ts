import { Recomendador, formatearResultado } from "./recomendador.js";
import { cargarDotenv } from "./dotenv.js";
import { transcribirAudio } from "./stt.js";

cargarDotenv();

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
  const args = parseArgs(process.argv.slice(2));
  if (args.gtfs) process.env.GTFS_PATH = args.gtfs;

  const logger = (m: string) => console.log(`  ${m}`);

  const initial: Record<string, unknown> = {};
  if (args.hora) initial.rawHora = args.hora;
  if (args.origen || args.destino) {
    initial.rawOrigen = args.origen ?? "";
    initial.rawDestino = args.destino ?? "";
    initial.rawTiempo = args.tiempo ?? "";
  } else if (args.texto) {
    initial.textoLibre = args.texto;
  } else {
    initial.rawOrigen = "Portal El Dorado";
    initial.rawDestino = "Museo Nacional";
    initial.rawTiempo = "60";
  }

  // Subsistema informal (GTFS-Flex): vive en el Recomendador (confianza C(t)
  // con decaimiento) y se comparte con la ingesta de reportes de voz.
  const recomendador = new Recomendador();

  // Motivos de desvío (reportes negativos) para comunicar al usuario.
  const motivos: string[] = [];
  const ahoraMs = Date.now();

  // Nota de voz opcional (--audio <ruta>): transcripción (Groq) → ingesta dual:
  // (a) reporte a tramos informales (flex) y (b) incidente a zonas oficiales.
  if (args.audio) {
    const texto = await transcribirAudio({ tipo: "archivo", ruta: args.audio });
    if (texto) {
      logger(`nota de voz → "${texto}"`);
      const reporte = recomendador.informal.ingestaDeTexto(texto, "usuario_frecuente", ahoraMs);
      if (reporte) {
        logger(`[flex] tramo=${reporte.segmento} V=${reporte.valor} w=${reporte.peso}`);
        if (reporte.valor < 0) motivos.push(`transporte informal: ${reporte.texto}`);
      }
      const inc = recomendador.incidentes.registrarDeReporte(texto, "usuario_frecuente", ahoraMs);
      if (inc) {
        logger(
          `[incidente oficial] zona=${inc.zonaId} severidad=${inc.severidad} peso=${inc.peso.toFixed(2)}`,
        );
        motivos.push(inc.motivo);
      }
    } else {
      logger("nota de voz: transcripción no disponible");
    }
  }

  initial.motivos = motivos;

  await new Promise((r) => setTimeout(r, 0)); // flushear entrega asíncrona

  const rec = await recomendador.ejecutar(initial, logger);
  recomendador.detener();

  console.log(formatearResultado(rec.resultado, rec.gtfsFuente, rec.geocode));
  console.log(`\n[base de conocimiento] consulta guardada en ${rec.csvRuta}`);
}

main().catch((err) => {
  console.error("Error fatal:", err);
  process.exit(1);
});
