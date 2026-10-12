import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"

/** Error cuyo mensaje es seguro y útil para mostrarlo tal cual al usuario/modelo. */
export class ErrorLegible extends Error {}

/** Nombre de caso permitido: evita rutas como ../../etc. */
export const CASO_RE = /^[A-Za-z0-9_-]+$/

/** Contrato de salida de las herramientas: siempre un string JSON, nunca una excepción. */
export const ok = (data: unknown): string => JSON.stringify({ ok: true, data })
export const fail = (error: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ ok: false, error, ...extra })

export function mensajeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Ejecuta el cuerpo de una herramienta y convierte cualquier excepción en { ok:false, error }. */
export async function protegido(fn: () => Promise<string>): Promise<string> {
  try {
    return await fn()
  } catch (e) {
    return fail(e instanceof ErrorLegible ? e.message : `Error inesperado: ${mensajeError(e)}`)
  }
}

export const sha256 = (texto: string): string => createHash("sha256").update(texto, "utf8").digest("hex")

/** "COP 11.400.000" -> 11400000 ; "1.234,56" -> 1234.56 ; texto no numérico -> NaN */
export function parseMonto(texto: string): number {
  const limpio = texto.replace(/[^\d.,-]/g, "")
  if (!/\d/.test(limpio)) return NaN
  if (limpio.includes(",")) return Number(limpio.replace(/\./g, "").replace(",", "."))
  if (/^-?\d{1,3}(\.\d{3})+$/.test(limpio)) return Number(limpio.replace(/\./g, ""))
  return Number(limpio)
}

/** "900.555.111-2" -> "900555111" (sin puntos ni dígito de verificación). */
export function normalizarNit(raw: string): string {
  const base = raw.split("-")[0] ?? raw
  return base.replace(/\D/g, "")
}

export const sinAcentos = (s: string): string => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "")

const SUFIJOS_LEGALES = new Set(["s", "a", "sas", "sa", "ltda", "ltd", "cia", "e", "u"])
export function normalizarNombre(nombre: string): string {
  return sinAcentos(nombre)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t && !SUFIJOS_LEGALES.has(t))
    .join(" ")
}

export const soloFecha = (iso: string): string => iso.slice(0, 10)

export function sumarDias(fechaISO: string, dias: number): string {
  const d = new Date(`${fechaISO}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + dias)
  return d.toISOString().slice(0, 10)
}

export function formatoMonto(n: number, moneda: string): string {
  return `${moneda} ${new Intl.NumberFormat("es-CO").format(n)}`
}

/** Límite SAP de texto breve: 40 caracteres. Corta en límite de palabra si no pierde demasiado. */
export function recortarDescripcion(texto: string, max = 40): string {
  const t = texto.trim().replace(/\s+/g, " ")
  if (t.length <= max) return t
  const corte = t.slice(0, max)
  const ultimoEspacio = corte.lastIndexOf(" ")
  return (ultimoEspacio >= 25 ? corte.slice(0, ultimoEspacio) : corte).trimEnd()
}

/** JSON con llaves ordenadas: sirve para comparar objetos sin depender del orden. */
export function canonico(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonico).join(",")}]`
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>
    const llaves = Object.keys(o).sort()
    return `{${llaves.map((k) => `${JSON.stringify(k)}:${canonico(o[k])}`).join(",")}}`
  }
  return JSON.stringify(v) ?? "null"
}

function noExiste(e: unknown): boolean {
  return typeof e === "object" && e !== null && "code" in e && (e as { code?: string }).code === "ENOENT"
}

/** Texto del archivo o null si no existe. */
export async function leerTexto(ruta: string): Promise<string | null> {
  try {
    return await readFile(ruta, "utf8")
  } catch (e) {
    if (noExiste(e)) return null
    throw e
  }
}

/** JSON del archivo; null si no existe; ErrorLegible si está mal formado. */
export async function leerJson(ruta: string, nombre: string): Promise<unknown> {
  const texto = await leerTexto(ruta)
  if (texto === null) return null
  try {
    return JSON.parse(texto) as unknown
  } catch {
    throw new ErrorLegible(`${nombre} está mal formado (JSON inválido). Pedir al solicitante que lo reenvíe.`)
  }
}

/** Cola global: serializa escrituras a archivos compartidos (secuencia de OC, control.csv). */
let cola: Promise<unknown> = Promise.resolve()
export function enSerie<T>(fn: () => Promise<T>): Promise<T> {
  const r = cola.then(fn)
  cola = r.catch(() => undefined)
  return r
}
