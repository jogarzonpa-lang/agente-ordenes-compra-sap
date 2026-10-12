// Cada export es una herramienta; el modelo la ve como `oc_<export>`.
// Contrato: { description, args (zod), execute(args, ctx) -> string JSON }. Nunca lanzan.
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { registrarControl } from "../control"
import { construirOrden, escribirEvidencia, rutaOutCaso } from "../orden"
import { cargarMaestros, cargarPaquete } from "../paquete"
import { validar as validarReglas } from "../rules"
import { MockSap } from "../sap/mock"
import { OrdenCompraSchema, type Ctx, type OrdenCompra, type Paquete } from "../types"
import { CASO_RE, canonico, fail, ok, protegido } from "../util"

const caso = z
  .string()
  .regex(CASO_RE, "Solo letras, números, guion y guion bajo")
  .describe("Nombre de la carpeta del caso en fixtures/reto-03/solicitudes/, por ejemplo sol-001")

const ignorado = (que: string) =>
  z.unknown().optional().describe(`Opcional. Se ignora: el backend recalcula ${que} desde las fixtures para que el modelo no pueda alterar valores.`)

/** Compara payloads ignorando quién confirmó (ese dato se agrega al crear). */
const sinConfirmador = (o: OrdenCompra): OrdenCompra => ({
  ...o,
  excepciones: o.excepciones.map((e) => ({ ...e, confirmado_por: null })),
})

export const leer_paquete = {
  description: "Lee el correo, la solicitud, la cotización, la aprobación y la factura (si existe) de un caso y devuelve el paquete normalizado.",
  args: { caso },
  async execute(args: { caso: string }, ctx: Ctx): Promise<string> {
    return protegido(async () => {
      const { paquete, faltantes } = await cargarPaquete(ctx, args.caso)
      return ok({ ...paquete, faltantes })
    })
  },
}

export const validar = {
  description: "Valida un caso contra los maestros y las reglas RC1-RC10; devuelve apta, bloqueos, confirmaciones, derivados y retroactiva.",
  args: { caso, paquete: ignorado("el paquete") },
  async execute(args: { caso: string; paquete?: unknown }, ctx: Ctx): Promise<string> {
    return protegido(async () => {
      const { paquete } = await cargarPaquete(ctx, args.caso)
      return ok(validarReglas(paquete, await cargarMaestros(ctx)))
    })
  },
}

export const construir_payload = {
  description: "Construye la OC tal como quedaría en SAP (validada con zod) y guarda su trazabilidad; falla si el caso tiene bloqueos.",
  args: { caso, paquete: ignorado("el paquete"), derivados: ignorado("los derivados") },
  async execute(args: { caso: string; paquete?: unknown; derivados?: unknown }, ctx: Ctx): Promise<string> {
    return protegido(async () => {
      const { paquete } = await cargarPaquete(ctx, args.caso)
      const m = await cargarMaestros(ctx)
      const v = validarReglas(paquete, m)
      if (!v.apta) return fail("No se puede construir la OC: el caso tiene bloqueos.", { bloqueos: v.bloqueos })
      const { orden, traza } = construirOrden(paquete, m, v)
      const dir = rutaOutCaso(ctx, args.caso)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, "payload.json"), JSON.stringify(orden, null, 2), "utf8")
      await writeFile(join(dir, "trazabilidad.json"), JSON.stringify(traza, null, 2), "utf8")
      return ok({ payload: orden, trazabilidad_ruta: `out/${args.caso}/trazabilidad.json`, confirmaciones: v.confirmaciones })
    })
  },
}

export const generar_evidencia = {
  description: "Genera la evidencia de aprobación (txt con sha256 y PDF) a partir del correo de aprobación del caso.",
  args: { caso },
  async execute(args: { caso: string }, ctx: Ctx): Promise<string> {
    return protegido(async () => {
      const { paquete } = await cargarPaquete(ctx, args.caso)
      if (!paquete.aprobacion) return fail("No hay correo de aprobación para generar la evidencia.")
      return ok(await escribirEvidencia(ctx, args.caso, paquete.aprobacion))
    })
  },
}

export const crear = {
  description: "Crea la OC en SAP simulado solo si no hay bloqueos y (no hay confirmaciones o el usuario confirmó); es idempotente por solicitud.",
  args: {
    caso,
    payload: OrdenCompraSchema.optional().describe("Opcional. La OC devuelta por oc_construir_payload; si se envía debe coincidir con la validada."),
    confirmado: z.boolean().optional().describe("true SOLO si el usuario confirmó explícitamente en su último mensaje."),
  },
  async execute(args: { caso: string; payload?: OrdenCompra; confirmado?: boolean }, ctx: Ctx): Promise<string> {
    return protegido(async () => {
      let paquete: Paquete
      try {
        paquete = (await cargarPaquete(ctx, args.caso)).paquete
      } catch (e) {
        await registrarControl(ctx, { solicitud_id: args.caso, resultado: "error", numero_oc: "", retroactiva: false, bloqueos: [], confirmaciones: [] })
        throw e
      }
      const m = await cargarMaestros(ctx)
      const v = validarReglas(paquete, m)
      const solicitud_id = paquete.solicitud.solicitud_id
      const fila = (resultado: "creada" | "idempotente" | "bloqueada" | "pendiente", numero_oc = ""): Promise<void> =>
        registrarControl(ctx, {
          solicitud_id,
          resultado,
          numero_oc,
          retroactiva: v.retroactiva,
          bloqueos: v.bloqueos.map((b) => b.codigo),
          confirmaciones: v.confirmaciones.map((c) => c.codigo),
        })

      const sap = new MockSap(ctx.directory)
      const existente = await sap.buscarOrdenPorReferencia(solicitud_id)
      if (existente) {
        await fila("idempotente", existente.numero_oc)
        return ok({ numero_oc: existente.numero_oc, fecha: existente.fecha ?? null, idempotente: true, evidencia: `out/${args.caso}/aprobacion.txt` })
      }
      if (!v.apta) {
        await fila("bloqueada")
        return fail("La OC no se puede crear: el caso tiene bloqueos.", { bloqueos: v.bloqueos })
      }
      const confirmado = args.confirmado === true
      if (v.confirmaciones.length > 0 && !confirmado) {
        await fila("pendiente")
        return fail("Requiere confirmación humana antes de crear la OC. Pregunta al usuario y vuelve a llamar con confirmado=true solo si confirma.", {
          necesita_confirmacion: true,
          confirmaciones: v.confirmaciones,
        })
      }

      const { orden } = construirOrden(paquete, m, v)
      if (args.payload && canonico(sinConfirmador(args.payload)) !== canonico(sinConfirmador(orden))) {
        return fail("El payload enviado no coincide con el validado por el sistema. Vuelve a llamar a oc_construir_payload y usa su resultado.")
      }
      const definitiva: OrdenCompra = confirmado
        ? { ...orden, excepciones: orden.excepciones.map((e) => ({ ...e, confirmado_por: `usuario:${ctx.sessionId}` })) }
        : orden
      if (!paquete.aprobacion) return fail("Falta la aprobación.") // inalcanzable si apta; satisface al compilador
      const evidencia = await escribirEvidencia(ctx, args.caso, paquete.aprobacion)
      const res = await sap.crearOrden(definitiva)
      await fila("creada", res.numero_oc)
      return ok({ numero_oc: res.numero_oc, fecha: res.fecha, idempotente: false, evidencia: evidencia.ruta, evidencia_pdf: evidencia.ruta_pdf })
    })
  },
}
