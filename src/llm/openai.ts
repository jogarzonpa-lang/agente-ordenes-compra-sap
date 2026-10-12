import { z } from "zod"
import { ErrorLLM, type AdaptadorLLM, type DefinicionHerramienta, type Mensaje, type RespuestaLLM } from "./adapter"

const RespuestaSchema = z.object({
  choices: z.array(
    z.object({
      message: z.object({
        content: z.string().nullable().optional(),
        tool_calls: z
          .array(z.object({ id: z.string(), function: z.object({ name: z.string(), arguments: z.string() }) }))
          .optional(),
      }),
    }),
  ).min(1),
  usage: z.object({ total_tokens: z.number() }).optional(),
})

function aOpenAI(m: Mensaje): Record<string, unknown> {
  if (m.role === "tool") return { role: "tool", tool_call_id: m.llamadaId, content: m.content }
  if (m.role === "assistant") {
    return {
      role: "assistant",
      content: m.content,
      ...(m.llamadas?.length
        ? { tool_calls: m.llamadas.map((l) => ({ id: l.id, type: "function", function: { name: l.nombre, arguments: l.argumentos } })) }
        : {}),
    }
  }
  return { role: m.role, content: m.content }
}

function errorHttp(status: number, modelo: string): ErrorLLM {
  if (status === 401) return new ErrorLLM("OpenAI rechazó la clave del servidor (401). Revisa OPENAI_API_KEY.")
  if (status === 429) return new ErrorLLM("OpenAI respondió 429: límite de uso o cuota agotada. Intenta más tarde.")
  if (status === 404) return new ErrorLLM(`El modelo "${modelo}" no está disponible para esta clave (404). Revisa OPENAI_MODEL.`)
  return new ErrorLLM(`OpenAI respondió con error HTTP ${status}.`)
}

export class OpenAIAdaptador implements AdaptadorLLM {
  readonly proveedor = "openai"

  constructor(
    private readonly apiKey: string | undefined,
    readonly modelo: string,
    private readonly timeoutMs = 60_000,
    private readonly baseUrl = "https://api.openai.com/v1",
  ) {}

  async enviar(mensajes: Mensaje[], herramientas: DefinicionHerramienta[]): Promise<RespuestaLLM> {
    if (!this.apiKey) throw new ErrorLLM("Falta la variable de entorno OPENAI_API_KEY en el servidor.")
    const cuerpo: Record<string, unknown> = { model: this.modelo, messages: mensajes.map(aOpenAI) }
    if (herramientas.length > 0) {
      cuerpo.tools = herramientas.map((h) => ({ type: "function", function: { name: h.nombre, description: h.descripcion, parameters: h.parametros } }))
    }
    const esfuerzo = process.env.OPENAI_REASONING_EFFORT
    if (esfuerzo) cuerpo.reasoning_effort = esfuerzo

    const control = new AbortController()
    const temporizador = setTimeout(() => control.abort(), this.timeoutMs)
    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(cuerpo),
        signal: control.signal,
      })
      if (!res.ok) throw errorHttp(res.status, this.modelo)
      const parsed = RespuestaSchema.safeParse(await res.json())
      if (!parsed.success) throw new ErrorLLM("OpenAI devolvió una respuesta con formato inesperado.")
      const msg = parsed.data.choices[0]?.message
      return {
        texto: msg?.content ?? null,
        llamadas: (msg?.tool_calls ?? []).map((t) => ({ id: t.id, nombre: t.function.name, argumentos: t.function.arguments })),
        tokens: parsed.data.usage?.total_tokens ?? 0,
      }
    } catch (e) {
      if (e instanceof ErrorLLM) throw e
      if (control.signal.aborted) throw new ErrorLLM(`El modelo tardó más de ${Math.round(this.timeoutMs / 1000)} s en responder (timeout).`)
      throw new ErrorLLM("No pude conectar con OpenAI (red o DNS).")
    } finally {
      clearTimeout(temporizador)
    }
  }
}
