// Runtime mínimo de agentes con pizarra compartida (blackboard).
// El orquestador organiza el trabajo en "etapas" (stages): los agentes de una
// misma etapa corren en paralelo; las etapas corren en secuencia. Cada agente
// lee/escribe en ctx.state sin conocer a los demás.

export interface AgentContext {
  state: Record<string, unknown>;
  log: (msg: string) => void;
}

export interface Agent {
  readonly name: string;
  run(ctx: AgentContext): Promise<void>;
}

// Error fatal: aborta el pipeline completo. Se usa cuando un agente determina
// que no tiene sentido seguir (p. ej. el NLU no pudo interpretar la consulta):
// en lugar de arrastrar errores en cascada, se detiene con un mensaje claro.
export class FatalAgentError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "FatalAgentError";
  }
}

export class Orchestrator {
  private stages: Agent[][] = [];

  stage(...agents: Agent[]): this {
    if (agents.length > 0) this.stages.push(agents);
    return this;
  }

  add(agent: Agent): this {
    return this.stage(agent);
  }

  async run(
    initial: Record<string, unknown> = {},
    logger: (msg: string) => void = () => {},
  ): Promise<Record<string, unknown>> {
    const ctx: AgentContext = { state: { ...initial }, log: logger };

    for (const stage of this.stages) {
      if (stage.length === 1) {
        await this.ejecutar(stage[0], ctx);
      } else {
        logger(`▸ ejecutando ${stage.length} agentes en paralelo`);
        await Promise.allSettled(stage.map((a) => this.ejecutar(a, ctx)));
      }
    }
    return ctx.state;
  }

  private async ejecutar(agent: Agent, ctx: AgentContext): Promise<void> {
    const t0 = Date.now();
    ctx.log(`▶ [${agent.name}] iniciando…`);
    try {
      await agent.run(ctx);
      ctx.log(`✔ [${agent.name}] ok (${Date.now() - t0} ms)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof FatalAgentError) {
        ctx.log(`✖ [${agent.name}] error fatal: ${msg}`);
        throw err;
      }
      ctx.log(`✖ [${agent.name}] error: ${msg}`);
      ctx.state[`__error_${agent.name}`] = msg;
    }
  }
}
