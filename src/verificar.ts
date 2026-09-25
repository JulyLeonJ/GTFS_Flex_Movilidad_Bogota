import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

delete process.env.OPENCODE_API_KEY;
process.env.SESIONES_JSON = join(mkdtempSync(join(tmpdir(), "ses-")), "s.json");

import { cortarShape, areaMvp, enArea, detectGtfsSource } from "./gtfs.js";
import { variantesLugar } from "./geocode.js";
import { IncidentesService, ZONAS_OFICIALES } from "./incidentes.js";
import { InformalService } from "./informal.js";
import { calcularCongestion, aGeoJson, circulo } from "./congestion.js";
import { CongestionAgent } from "./agents/congestion.js";
import { TransitAgent } from "./agents/transit.js";
import { NluAgent } from "./agents/nlu.js";
import { FatalAgentError, Orchestrator, type Agent, type AgentContext } from "./agent.js";
import { fueraDeArea } from "./agents/geocoder.js";
import { ingestarReporte } from "./ingesta-reportes.js";
import { SesionesService } from "./sesiones.js";
import { ConfianzaTemporal, lambdaDesdeVidaMedia } from "./confianza.js";
import type { ConsultaNormalizada, OpcionRuta } from "./types.js";

function ctx(state: Record<string, unknown>): AgentContext {
  return { state, log: () => {} };
}

// 1. cortarShape
{
  const shape: number[] = [];
  for (let i = 0; i < 10; i++) shape.push(-74.1 + i * 0.001, 4.5);
  const punto = (i: number) => ({ lat: shape[i * 2 + 1], lon: shape[i * 2] });

  const r = cortarShape(shape, punto(2), punto(7));
  assert.ok(r);
  assert.equal(r.length, 8);
  assert.deepEqual(r[0], [punto(2).lon, punto(2).lat]);
  assert.deepEqual(r[r.length - 1], [punto(7).lon, punto(7).lat]);

  const lejos = cortarShape(shape, { lat: 4.5, lon: -74.5 }, punto(7));
  assert.equal(lejos, null);

  const idaVuelta: number[] = [];
  for (let i = 0; i < 10; i++) idaVuelta.push(-74.1 + i * 0.001, 4.5);
  for (let i = 8; i >= 0; i--) idaVuelta.push(-74.1 + i * 0.001, 4.5);
  const p0 = { lat: 4.5, lon: -74.1 };
  const p9 = { lat: 4.5, lon: -74.1 + 9 * 0.001 };
  const vuelta = cortarShape(idaVuelta, p9, p0);
  assert.ok(vuelta);
  assert.ok(vuelta.length > 2);
}

// 2. Noisy-OR
{
  const incidentes = new IncidentesService();
  const informal = new InformalService("data/sample_flex");
  const ahora = Date.now();

  incidentes.registrarDeReporte("accidente en Casalinda", "telegram", ahora);
  let z = calcularCongestion(incidentes, informal, ahora).find((z) => z.id === "av-villavicencio");
  assert.ok(z && Math.abs(z.nivel - 0.2) < 0.01);

  incidentes.registrarDeReporte("accidente en Casalinda", "telegram", ahora);
  incidentes.registrarDeReporte("accidente en Casalinda", "telegram", ahora);
  z = calcularCongestion(incidentes, informal, ahora).find((z) => z.id === "av-villavicencio");
  assert.ok(z && Math.abs(z.nivel - 0.49) < 0.01);

  incidentes.registrarDeReporte("accidente en Casalinda", "telegram", ahora);
  incidentes.registrarDeReporte("accidente en Casalinda", "telegram", ahora);
  z = calcularCongestion(incidentes, informal, ahora).find((z) => z.id === "av-villavicencio");
  assert.ok(z && Math.abs(z.nivel - 0.67) < 0.01);

  const zonasFuturas = calcularCongestion(incidentes, informal, ahora + 3 * 3_600_000);
  assert.ok(!zonasFuturas.some((z) => z.id === "av-villavicencio"));
}

// 3. GeoJSON
{
  const anillo = circulo({ lat: 4.5, lon: -74.1 }, 100);
  assert.equal(anillo.length, 49);
  assert.deepEqual(anillo[0], anillo[48]);

  const incidentes = new IncidentesService();
  const informal = new InformalService("data/sample_flex");
  incidentes.registrarDeReporte("accidente en Casalinda", "telegram");
  const geo = aGeoJson(calcularCongestion(incidentes, informal));
  for (const f of geo.features) {
    assert.ok(!("centro" in f.properties));
    assert.ok(!("radioM" in f.properties));
    assert.ok(!("segmento" in f.properties));
  }
}

// 4. Geometría oficial
{
  process.env.GTFS_PATH = "data/sample_gtfs";
  const consulta: ConsultaNormalizada = {
    origenTexto: "Portal Tunal",
    destinoTexto: "Mirador del Paraiso",
    tiempoMin: 30,
    origenPunto: { lat: 4.56917, lon: -74.13968 },
    destinoPunto: { lat: 4.55009985, lon: -74.1588974 },
  };
  const c = ctx({ consulta });
  await new TransitAgent().run(c);
  const opciones = c.state.opciones as OpcionRuta[];
  assert.ok(opciones.length > 0);
  const oficial = opciones[0].tramos?.find((t) => t.modo === "oficial");
  assert.ok(oficial && oficial.coords.length >= 2);
  assert.equal(oficial?.geometria, "paradas");
  assert.ok(opciones.some((o) => o.tramos?.some((t) => t.subsistema === "cable")));
}

// 5. Geometría informal
{
  const informal = new InformalService("data/sample_flex");
  const quibaBajo = informal.segmentos().find((s) => s.id === "zona-quiba-bajo")!;
  const mochueloAlto = informal.segmentos().find((s) => s.id === "zona-mochuelo-alto")!;
  const opciones = informal.opciones(quibaBajo.centroide, mochueloAlto.centroide);
  assert.ok(opciones.some((o) => o.tramos?.some((t) => t.modo === "informal" && t.geometria === "flex")));
}

// 6. CongestionAgent
{
  const incidentes = new IncidentesService();
  const informal = new InformalService("data/sample_flex");
  const base: Omit<OpcionRuta, "resumen" | "tramos"> = {
    tipo: "directa",
    paradaOrigen: "a",
    paradaDestino: "b",
    pasos: [],
    rutasUsadas: [],
    tiempoEstimadoMin: 20,
    caminataMts: 0,
    puntaje: 50,
  };
  const cerca: OpcionRuta = {
    ...base,
    resumen: "cerca",
    tramos: [{ modo: "oficial", etiqueta: "x", geometria: "paradas", coords: [[-74.1437, 4.5696], [-74.14, 4.57]] }],
  };
  const lejos: OpcionRuta = {
    ...base,
    resumen: "lejos",
    tramos: [{ modo: "oficial", etiqueta: "x", geometria: "paradas", coords: [[-74.19, 4.4], [-74.19, 4.41]] }],
  };

  for (let i = 0; i < 5; i++) incidentes.registrarDeReporte("accidente en Casalinda", "telegram");

  const c1 = ctx({ opciones: [cerca, lejos], motivos: [] });
  await new CongestionAgent(incidentes, informal).run(c1);
  assert.equal((c1.state.opciones as OpcionRuta[]).length, 1);
  assert.equal((c1.state.opciones as OpcionRuta[])[0].resumen, "lejos");
  assert.ok((c1.state.motivos as string[]).length > 0);

  const lejos2: OpcionRuta = {
    ...base,
    resumen: "lejos2",
    puntaje: 30,
    tramos: [{ modo: "oficial", etiqueta: "x", geometria: "paradas", coords: [[-74.1437, 4.5696], [-74.15, 4.58]] }],
  };
  const c2 = ctx({ opciones: [cerca, lejos2], motivos: [] });
  await new CongestionAgent(incidentes, informal).run(c2);
  assert.equal((c2.state.opciones as OpcionRuta[]).length, 2);
  assert.ok((c2.state.motivos as string[]).some((m) => m.includes("todas las rutas")));
}

// 7. NLU seguimiento
{
  const previa: ConsultaNormalizada = {
    origenTexto: "Quiba Bajo",
    destinoTexto: "Mochuelo Alto",
    tiempoMin: 30,
  };

  const c1 = ctx({ textoLibre: "mejor en 45 min", consultaPrevia: previa });
  await new NluAgent().run(c1);
  let cons = c1.state.consulta as ConsultaNormalizada;
  assert.equal(cons.tiempoMin, 45);
  assert.equal(cons.origenTexto, "Quiba Bajo");
  assert.equal(cons.destinoTexto, "Mochuelo Alto");

  const c2 = ctx({ textoLibre: "y desde el Portal Tunal", consultaPrevia: previa });
  await new NluAgent().run(c2);
  cons = c2.state.consulta as ConsultaNormalizada;
  assert.equal(cons.origenTexto, "Portal Tunal");
  assert.equal(cons.destinoTexto, "Mochuelo Alto");

  const c3 = ctx({ textoLibre: "salgo a las 18:30", consultaPrevia: previa });
  await new NluAgent().run(c3);
  cons = c3.state.consulta as ConsultaNormalizada;
  assert.equal(cons.origenTexto, "Quiba Bajo");
  assert.equal(cons.destinoTexto, "Mochuelo Alto");
  assert.equal(cons.salidaSeg, 66600);

  const c4 = ctx({
    textoLibre: "de Portal Tunal a Mirador del Paraiso a las 18:30",
    consultaPrevia: previa,
  });
  await new NluAgent().run(c4);
  cons = c4.state.consulta as ConsultaNormalizada;
  assert.equal(cons.origenTexto, "Portal Tunal");
  assert.equal(cons.destinoTexto, "Mirador del Paraiso");

  await assert.rejects(
    new NluAgent().run(ctx({ textoLibre: "hola", consultaPrevia: previa })),
    FatalAgentError,
  );
}

// 8. Área del MVP
{
  assert.equal(enArea({ lat: 4.5501, lon: -74.1589 }), true);
  assert.equal(enArea({ lat: 4.6486, lon: -74.0628 }), false);

  const fuera = fueraDeArea({
    origenTexto: "Portal Tunal",
    destinoTexto: "Chapinero",
    tiempoMin: 30,
    origenPunto: { lat: 4.56917, lon: -74.13968 },
    destinoPunto: { lat: 4.6486, lon: -74.0628 },
  });
  assert.ok(fuera && fuera.includes("Chapinero") && fuera.includes("Ciudad Bolívar"));
  assert.equal(
    fueraDeArea({
      origenTexto: "Portal Tunal",
      destinoTexto: "Mirador del Paraiso",
      tiempoMin: 30,
      origenPunto: { lat: 4.56917, lon: -74.13968 },
      destinoPunto: { lat: 4.5501, lon: -74.1589 },
    }),
    null,
  );

  const incidentes8 = new IncidentesService();
  const informal8 = new InformalService("data/sample_flex");
  const before = incidentes8.activos().length;
  const res = await ingestarReporte(
    "accidente en la calle 100",
    "telegram",
    informal8,
    incidentes8,
    Date.now(),
    () => {},
    { lat: 4.6868, lon: -74.0487, nombre: "Calle 100" },
  );
  assert.equal(res.fueraDeArea, true);
  assert.equal(incidentes8.activos().length, before);

  assert.ok(ZONAS_OFICIALES.every((z) => enArea({ lat: z.lat, lon: z.lon })));
  assert.ok(informal8.segmentos().every((s) => enArea(s.centroide)));

  const prevBbox = process.env.GTFS_BBOX;
  process.env.GTFS_BBOX = "none";
  assert.equal(areaMvp(), undefined);
  assert.equal(
    fueraDeArea({ origenTexto: "a", destinoTexto: "b", tiempoMin: 30 }),
    null,
  );
  if (prevBbox === undefined) delete process.env.GTFS_BBOX;
  else process.env.GTFS_BBOX = prevBbox;
}

// 9. Sesiones
{
  const s1 = new SesionesService();
  const a = s1.deCanal("telegram", "1");
  const b = s1.deCanal("telegram", "1");
  assert.equal(a.id, b.id);

  let emitido: unknown;
  s1.eventos.once(`sesion:${a.id}`, (p) => (emitido = p));
  s1.actualizar(a.id, {
    consulta: { origenTexto: "x", destinoTexto: "y", tiempoMin: 30 },
    opciones: [],
    datasets: [],
    explicacion: "e",
  });
  assert.equal(s1.obtener(a.id)!.version, 1);
  assert.ok(emitido);

  const s2 = new SesionesService();
  const recuperada = s2.obtener(a.id);
  assert.ok(recuperada);
  const pub = s2.publica(recuperada!);
  assert.ok(!("clave" in pub));
  assert.ok(!("canal" in pub));
}

// 10. Orchestrator: un error fatal en una etapa paralela aborta el pipeline
// (Promise.allSettled no debe tragarse el FatalAgentError).
{
  const agente = (nombre: string, fn: () => void): Agent => ({
    name: nombre,
    run: async () => fn(),
  });
  const orden: string[] = [];

  const orch = new Orchestrator();
  orch.stage(
    agente("ok", () => orden.push("ok")),
    agente("fatal", () => {
      throw new FatalAgentError("fuera de área");
    }),
  );
  orch.stage(agente("nunca", () => orden.push("nunca")));

  await assert.rejects(orch.run({}, () => {}), FatalAgentError);
  assert.ok(orden.includes("ok"));
  assert.ok(!orden.includes("nunca"));
}

// 11. GTFS: stop_times sin agrupar por viaje se reordena por stop_sequence.
{
  const dir = mkdtempSync(join(tmpdir(), "gtfs-desorden-"));
  cpSync("data/sample_gtfs", dir, { recursive: true });
  const [cab, ...filas] = readFileSync(join(dir, "stop_times.txt"), "utf-8").trim().split(/\r?\n/);
  writeFileSync(join(dir, "stop_times.txt"), [cab, ...filas.reverse()].join("\n"));
  const ordenado = await detectGtfsSource("data/sample_gtfs");
  const revuelto = await detectGtfsSource(dir);
  const viajes = (g: typeof ordenado) =>
    Array.from({ length: g.tripsCount }, (_, t) =>
      g.seqStop.slice(g.tripStart[t], g.tripStart[t + 1]).map((s, i) => `${s}@${g.seqArr[g.tripStart[t] + i]}`).join(" "),
    ).sort();
  assert.deepEqual(viajes(revuelto), viajes(ordenado));
}

// 12. Variantes de lugar para textos descriptivos.
{
  const v = variantesLugar(
    "Centro Médico de Candelaria La Nueva, el que queda al frente del Centro Comercial El Enseño",
  );
  assert.ok(v.includes("Centro Médico de Candelaria La Nueva"));
  assert.ok(v.includes("Candelaria La Nueva"));
  assert.ok(v.includes("Centro Comercial El Enseño"));
  assert.deepEqual(variantesLugar("Parque Quintas del Sur"), ["Parque Quintas del Sur", "Quintas del Sur"]);
  assert.deepEqual(variantesLugar("Portal Tunal"), ["Portal Tunal"]);
}

// 13. Reportes con más de 2 h desde el evento dejan de contar.
{
  const ahora = Date.now();
  const inc13 = new IncidentesService();
  const inf13 = new InformalService("data/sample_flex");
  for (const [edadMin, texto] of [[119, "accidente en Casalinda"], [121, "bloqueo en la Boyacá"]] as const) {
    await ingestarReporte(texto, "validador_comunitario", inf13, inc13, ahora - edadMin * 60_000, () => {});
  }
  assert.deepEqual(inc13.activos(ahora).map((i) => i.zonaId), ["av-villavicencio"]);

  const c13 = new ConfianzaTemporal(0.8, lambdaDesdeVidaMedia(4 * 3600), () => ahora);
  c13.registrar({ segmento: "s", fuente: "f", valor: -2, peso: 1, timestamp: ahora - 121 * 60_000 });
  assert.equal(c13.activos().length, 0);
  assert.equal(c13.c(), 0.8);
}

console.log("✔ verificación OK");
