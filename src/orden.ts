import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { textoAPdf } from "./pdf"
import { buscarProveedor, emailDe, type Validacion } from "./rules"
import { OrdenCompraSchema, type Aprobacion, type Ctx, type Maestros, type OrdenCompra, type Paquete } from "./types"
import { ErrorLegible, mensajeError, recortarDescripcion, sha256 } from "./util"

export type Traza = Record<string, { fuente: string; detalle?: string }>

export const rutaOutCaso = (ctx: Ctx, caso: string): string => join(ctx.directory, "out", caso)

// ---- Evidencia de aprobación (HU-4) ----
export function contenidoEvidencia(a: Aprobacion): string {
  return `De: ${a.de}\nPara: ${a.para}\nFecha: ${a.fecha}\nAsunto: ${a.asunto}\n\n${a.texto}`
}
export const shaEvidencia = (a: Aprobacion): string => sha256(contenidoEvidencia(a))

export async function escribirEvidencia(
  ctx: Ctx,
  caso: string,
  a: Aprobacion,
): Promise<{ ruta: string; ruta_pdf: string | null; sha256: string }> {
  const contenido = contenidoEvidencia(a)
  const sha = sha256(contenido)
  const dir = rutaOutCaso(ctx, caso)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, "aprobacion.txt"), `${contenido}\n\n--\nsha256: ${sha}\n`, "utf8")
  let ruta_pdf: string | null = null
  try {
    const pdf = await textoAPdf(`Evidencia de aprobacion - ${caso}`, `${contenido}\n\n--\nsha256: ${sha}`)
    await writeFile(join(dir, "aprobacion.pdf"), pdf)
    ruta_pdf = `out/${caso}/aprobacion.pdf`
  } catch (e) {
    // El PDF es P1: si falla, el txt (P0) ya quedó escrito.
    console.error(`[evidencia] no se pudo generar el PDF: ${mensajeError(e)}`)
  }
  return { ruta: `out/${caso}/aprobacion.txt`, ruta_pdf, sha256: sha }
}

// ---- Payload (HU-3) ----
export function construirOrden(p: Paquete, m: Maestros, v: Validacion): { orden: OrdenCompra; traza: Traza } {
  const s = p.solicitud
  const proveedor = buscarProveedor(p, m)
  if (!proveedor) throw new ErrorLegible("No se puede construir el payload: el proveedor no existe en el maestro.")
  if (!p.aprobacion) throw new ErrorLegible("No se puede construir el payload: falta la aprobación.")

  const condiciones = s.condiciones_pago ?? v.derivados.condiciones_pago?.valor
  const indicador = s.indicador_iva ?? v.derivados.indicador_iva?.valor
  if (!condiciones || !indicador) throw new ErrorLegible("No se pudo determinar el indicador de IVA o las condiciones de pago.")

  const descripcion = recortarDescripcion(s.descripcion, 40)
  const candidata: OrdenCompra = {
    referencia: { solicitud_id: s.solicitud_id, correo_id: p.correo.id, cotizacion_ref: p.cotizacion?.referencia ?? null },
    sociedad: "1000",
    organizacion_compras: "1000",
    proveedor: { codigo_sap: proveedor.codigo_sap, nit: proveedor.nit, nombre: proveedor.nombre },
    moneda: s.moneda as OrdenCompra["moneda"],
    condiciones_pago: condiciones,
    aprobador: { email: emailDe(p.aprobacion.de), fecha_aprobacion: p.aprobacion.fecha, evidencia_sha256: shaEvidencia(p.aprobacion) },
    posiciones: [
      {
        numero: 10,
        descripcion,
        cantidad: s.cantidad,
        unidad: "UN",
        precio_unitario: s.valor_unitario,
        centro_costo: s.centro_costo,
        subarea: s.subarea,
        indicador_iva: indicador,
      },
    ],
    excepciones: v.confirmaciones.map((c) => ({ codigo: c.codigo, detalle: c.detalle, confirmado_por: null })),
  }
  const r = OrdenCompraSchema.safeParse(candidata)
  if (!r.success) {
    const d = r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
    throw new ErrorLegible(`El payload no cumple el esquema de la OC -> ${d}`)
  }

  const deSolicitud = (detalle?: string) => ({ fuente: "solicitud", ...(detalle ? { detalle } : {}) })
  const traza: Traza = {
    "referencia.solicitud_id": deSolicitud(),
    "referencia.correo_id": { fuente: "correo" },
    "referencia.cotizacion_ref": p.cotizacion?.referencia ? { fuente: "cotizacion" } : { fuente: "derivado", detalle: "sin cotización: null" },
    sociedad: { fuente: "derivado", detalle: "constante del PRD 7.4" },
    organizacion_compras: { fuente: "derivado", detalle: "constante del PRD 7.4" },
    "proveedor.codigo_sap": { fuente: "maestro.proveedores" },
    "proveedor.nit": { fuente: "maestro.proveedores" },
    "proveedor.nombre": { fuente: "maestro.proveedores" },
    moneda: deSolicitud(),
    condiciones_pago: s.condiciones_pago ? deSolicitud() : { fuente: "derivado", detalle: v.derivados.condiciones_pago?.fuente ?? "" },
    "aprobador.email": { fuente: "aprobacion" },
    "aprobador.fecha_aprobacion": { fuente: "aprobacion" },
    "aprobador.evidencia_sha256": { fuente: "derivado", detalle: "sha256 del contenido del correo de aprobación" },
    "posiciones[0].numero": { fuente: "derivado", detalle: "consecutivo de 10 en 10" },
    "posiciones[0].descripcion": deSolicitud(descripcion !== s.descripcion.trim() ? "truncada a 40 caracteres (límite SAP)" : undefined),
    "posiciones[0].cantidad": deSolicitud(),
    "posiciones[0].unidad": { fuente: "derivado", detalle: "UN por defecto (la solicitud no informa unidad)" },
    "posiciones[0].precio_unitario": deSolicitud("valor_unitario tal cual en la solicitud (IVA incluido en la cotización)"),
    "posiciones[0].centro_costo": deSolicitud(),
    "posiciones[0].subarea": deSolicitud(),
    "posiciones[0].indicador_iva": s.indicador_iva ? deSolicitud() : { fuente: "derivado", detalle: v.derivados.indicador_iva?.fuente ?? "" },
    excepciones: { fuente: "derivado", detalle: "confirmaciones de oc_validar" },
  }
  return { orden: r.data, traza }
}
