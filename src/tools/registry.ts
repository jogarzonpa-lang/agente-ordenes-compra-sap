import { appendFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import type { DefinicionHerramienta, JsonSchemaObjeto } from "../llm/adapter"
import type { Ctx } from "../types"
import { fail, mensajeError } from "../util"
import * as oc from "./oc"

type Herramienta = { description: string; args: z.ZodRawShape; execute: (args: never, ctx: Ctx) => Promise<string> }

/** Cada export de oc.ts queda disponible como `oc_<export>`. */
export const herramientas: Record<string, Herramienta> = Object.fromEntries(
  Object.entries(oc).map(([nombre, h]) => [`oc_${nombre}`, h]),
)

async function registrarLog(ctx: Ctx, nombre: string, args: unknown, salida: string): Promise<void> {
  try {
    await mkdir(join(ctx.directory, "out"), { recursive: true })
    const linea = { ts: new Date().toISOString(), sessionId: ctx.sessionId, tool: nombre, args, resultado: salida.slice(0, 600) }
    await appendFile(join(ctx.directory, "out", "log.jsonl"), `${JSON.stringify(linea)}\n`, "utf8")
  } catch {
    // El log nunca debe tumbar una herramienta.
  }
}

/** Punto único de entrada: valida args con zod, ejecuta, registra en out/log.jsonl y nunca lanza (CA4). */
export async function llamar(nombre: string, args: unknown, ctx: Ctx): Promise<string> {
  const h = herramientas[nombre]
  let salida: string
  if (!h) {
    salida = fail(`Herramienta desconocida: ${nombre}. Disponibles: ${Object.keys(herramientas).join(", ")}.`)
  } else {
    const r = z.object(h.args).safeParse(args)
    if (!r.success) {
      salida = fail(`Argumentos inválidos para ${nombre}: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`)
    } else {
      try {
        salida = await h.execute(r.data as never, ctx)
      } catch (e) {
        salida = fail(`Error inesperado en ${nombre}: ${mensajeError(e)}`)
      }
    }
  }
  await registrarLog(ctx, nombre, args, salida)
  return salida
}

/** Esquema mínimo que ve el modelo: solo args simples (caso, confirmado). El resto lo valida/recalcula el backend. */
function aJsonSchema(args: z.ZodRawShape): JsonSchemaObjeto {
  const properties: JsonSchemaObjeto["properties"] = {}
  const required: string[] = []
  for (const [llave, schema] of Object.entries(args)) {
    const opcional = schema instanceof z.ZodOptional
    const interno: z.ZodTypeAny = opcional ? schema.unwrap() : schema
    const tipo = interno instanceof z.ZodString ? "string" : interno instanceof z.ZodBoolean ? "boolean" : null
    if (!tipo) continue // paquete / derivados / payload: el backend los ignora o verifica, no se le piden al modelo
    properties[llave] = { type: tipo, description: schema.description ?? interno.description }
    if (!opcional) required.push(llave)
  }
  return { type: "object", properties, required, additionalProperties: false }
}

export function definiciones(): DefinicionHerramienta[] {
  return Object.entries(herramientas).map(([nombre, h]) => ({ nombre, descripcion: h.description, parametros: aJsonSchema(h.args) }))
}
