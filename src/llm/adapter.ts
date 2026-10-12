// Interfaz propia del proveedor LLM (PRD 6.1): el ciclo del agente solo conoce estos tipos.
// Cambiar de proveedor = escribir otra clase que implemente AdaptadorLLM; agente.ts no se toca.

export type LlamadaHerramienta = { id: string; nombre: string; argumentos: string }

export type Mensaje =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; llamadas?: LlamadaHerramienta[] }
  | { role: "tool"; llamadaId: string; content: string }

export type JsonSchemaObjeto = {
  type: "object"
  properties: Record<string, { type: "string" | "boolean"; description?: string }>
  required: string[]
  additionalProperties: false
}
export type DefinicionHerramienta = { nombre: string; descripcion: string; parametros: JsonSchemaObjeto }

export type RespuestaLLM = { texto: string | null; llamadas: LlamadaHerramienta[]; tokens: number }

export interface AdaptadorLLM {
  readonly proveedor: string
  readonly modelo: string
  enviar(mensajes: Mensaje[], herramientas: DefinicionHerramienta[]): Promise<RespuestaLLM>
}

/** Error del proveedor con mensaje apto para mostrar al usuario (nunca incluye la clave). */
export class ErrorLLM extends Error {}
