import type { AdaptadorLLM } from "./adapter"
import { OpenAIAdaptador } from "./openai"

/** Único lugar que sabe qué proveedor se usa. La clave solo se lee aquí, de la variable de entorno. */
export function crearAdaptador(env: NodeJS.ProcessEnv = process.env): AdaptadorLLM {
  const proveedor = env.LLM_PROVIDER ?? "openai"
  if (proveedor === "openai") return new OpenAIAdaptador(env.OPENAI_API_KEY, env.OPENAI_MODEL ?? "gpt-5-mini")
  throw new Error(`Proveedor LLM no soportado: ${proveedor}`)
}
