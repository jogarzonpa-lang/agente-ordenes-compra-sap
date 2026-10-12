import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import {
  AprobacionRawSchema,
  CentroCostoSchema,
  CondicionSchema,
  CorreoSchema,
  IndicadorSchema,
  ProveedorSchema,
  SolicitudSchema,
  type Aprobacion,
  type Cotizacion,
  type Ctx,
  type Factura,
  type Maestros,
  type Paquete,
} from "./types"
import { CASO_RE, ErrorLegible, leerJson, leerTexto, parseMonto, sinAcentos, sumarDias } from "./util"

export const rutaFixtures = (ctx: Ctx): string => join(ctx.directory, "fixtures", "reto-03")
export const rutaCasos = (ctx: Ctx): string => join(rutaFixtures(ctx), "solicitudes")

export async function listarCasos(ctx: Ctx): Promise<string[]> {
  try {
    const entradas = await readdir(rutaCasos(ctx), { withFileTypes: true })
    return entradas.filter((e) => e.isDirectory()).map((e) => e.name).sort()
  } catch {
    return []
  }
}

function parsear<S extends z.ZodTypeAny>(schema: S, valor: unknown, nombre: string): z.infer<S> {
  const r = schema.safeParse(valor)
  if (!r.success) {
    const detalle = r.error.issues.map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`).join("; ")
    throw new ErrorLegible(`${nombre} inválido -> ${detalle}. Pedir al solicitante que lo corrija y lo reenvíe.`)
  }
  return r.data
}

/** "Aprobado" sí; "No aprobado" / "desaprobado" no. */
export function esAprobado(texto: string): boolean {
  const t = sinAcentos(texto).toLowerCase()
  if (/\b(no|sin|des)\s*(esta\s+)?aprobad[oa]\b/.test(t)) return false
  return /\baprobad[oa]\b/.test(t)
}

export function parsearCotizacion(texto: string): Cotizacion | null {
  const total = texto.match(/^\s*TOTAL[^:\n]*:\s*(?:([A-Z]{3})\s*)?([\d.,]+)/im)
  if (!total?.[2]) return null
  const monto = parseMonto(total[2])
  if (!Number.isFinite(monto)) return null
  const fecha = texto.match(/^\s*Fecha:\s*(\d{4}-\d{2}-\d{2})/im)?.[1] ?? null
  const dias = texto.match(/Validez[^:\n]*:\s*(\d+)\s*d/i)?.[1]
  return {
    proveedor: texto.match(/^\s*Proveedor:\s*(.+)$/im)?.[1]?.trim() ?? "",
    nit: texto.match(/^\s*NIT:\s*([\d.\-]+)/im)?.[1] ?? null,
    total: monto,
    moneda: total[1] ?? "COP",
    validez_hasta: fecha && dias ? sumarDias(fecha, Number(dias)) : null,
    texto,
    referencia: texto.match(/^\s*COTIZACI[ÓO]N\s+(\S+)/im)?.[1] ?? null,
    fecha,
  }
}

/** Si la factura existe pero no se entiende, se falla (no se ignora): perderíamos la marca "retroactiva". */
export function parsearFactura(texto: string): Factura {
  const fecha = texto.match(/Fecha[^:\n]*:\s*(\d{4}-\d{2}-\d{2})/i)?.[1]
  const total = texto.match(/^\s*TOTAL[^:\n]*:\s*(?:[A-Z]{3}\s*)?([\d.,]+)/im)?.[1]
  const monto = total ? parseMonto(total) : NaN
  if (!fecha || !Number.isFinite(monto)) {
    throw new ErrorLegible("factura.txt existe pero no pude leer su fecha o su total. Revisarla manualmente.")
  }
  return { numero: texto.match(/\b([A-Z]{1,5}-\d[\w-]*)\b/)?.[1] ?? "SIN-NUMERO", fecha, total: monto }
}

export async function cargarPaquete(ctx: Ctx, caso: string): Promise<{ paquete: Paquete; faltantes: string[] }> {
  if (!CASO_RE.test(caso)) throw new ErrorLegible(`Nombre de caso inválido: "${caso}".`)
  const base = join(rutaCasos(ctx), caso)
  const faltantes: string[] = []

  const correoRaw = await leerJson(join(base, "correo.json"), "correo.json")
  if (correoRaw === null) {
    const casos = await listarCasos(ctx)
    throw new ErrorLegible(`No encontré el caso "${caso}" (falta correo.json). Casos disponibles: ${casos.join(", ") || "ninguno"}.`)
  }
  const correo = parsear(CorreoSchema, correoRaw, "correo.json")

  const solRaw = await leerJson(join(base, "solicitud.json"), "solicitud.json")
  if (solRaw === null) {
    throw new ErrorLegible(`Falta solicitud.json (el Excel de solicitud) en el caso "${caso}". Pedir al solicitante que lo reenvíe.`)
  }
  const solicitud = parsear(SolicitudSchema, solRaw, "solicitud.json")

  const cotTexto = await leerTexto(join(base, "cotizacion.txt"))
  let cotizacion: Cotizacion | null = null
  if (cotTexto === null) faltantes.push("cotizacion.txt")
  else {
    cotizacion = parsearCotizacion(cotTexto)
    if (!cotizacion) faltantes.push("cotizacion.txt (ilegible: no encontré el TOTAL)")
  }

  const aprRaw = await leerJson(join(base, "aprobacion.json"), "aprobacion.json")
  let aprobacion: Aprobacion | null = null
  if (aprRaw === null) faltantes.push("aprobacion.json")
  else {
    const a = parsear(AprobacionRawSchema, aprRaw, "aprobacion.json")
    aprobacion = { de: a.de, para: a.para, fecha: a.fecha, asunto: a.asunto, aprobado: esAprobado(a.cuerpo), texto: a.cuerpo }
  }

  const facTexto = await leerTexto(join(base, "factura.txt"))
  const factura = facTexto === null ? null : parsearFactura(facTexto)

  return { paquete: { correo, solicitud, cotizacion, aprobacion, factura }, faltantes }
}

async function maestro<S extends z.ZodTypeAny>(ctx: Ctx, archivo: string, item: S): Promise<z.infer<S>[]> {
  const crudo = await leerJson(join(rutaFixtures(ctx), "maestros", archivo), archivo)
  if (crudo === null) throw new ErrorLegible(`Falta el maestro ${archivo} en fixtures/reto-03/maestros/.`)
  return parsear(z.array(item), crudo, archivo)
}

export async function cargarMaestros(ctx: Ctx): Promise<Maestros> {
  const [proveedores, centros, indicadores, condiciones] = await Promise.all([
    maestro(ctx, "proveedores.json", ProveedorSchema),
    maestro(ctx, "centros-costo.json", CentroCostoSchema),
    maestro(ctx, "indicadores-iva.json", IndicadorSchema),
    maestro(ctx, "condiciones-pago.json", CondicionSchema),
  ])
  return { proveedores, centros, indicadores, condiciones }
}
