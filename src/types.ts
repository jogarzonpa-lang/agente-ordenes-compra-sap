import { z } from "zod"
import { parseMonto } from "./util"

export type Ctx = { directory: string; sessionId: string }

// Un monto puede llegar como número o como texto ("11.400.000"). Si no es numérico, falla con mensaje claro.
const monto = z.preprocess((v) => (typeof v === "string" ? parseMonto(v) : v), z.number().finite())
// Campos opcionales: null o "" se tratan como ausentes.
const opcional = z.preprocess((v) => (v === null || v === "" ? undefined : v), z.string().optional())

export const CorreoSchema = z.object({
  id: z.string().min(1),
  de: z.string(),
  asunto: z.string(),
  fecha: z.string(),
})

export const SolicitudSchema = z.object({
  solicitud_id: z.string().min(1),
  solicitante: z.string(),
  proveedor_nombre: z.string(),
  proveedor_nit: opcional,
  descripcion: z.string().min(1),
  centro_costo: z.string().min(1),
  subarea: z.string().min(1),
  cantidad: monto,
  valor_unitario: monto,
  valor_total: monto,
  moneda: z.string().min(1),
  indicador_iva: opcional,
  condiciones_pago: opcional,
  fecha_solicitud: z.string().min(8),
})
export type Solicitud = z.infer<typeof SolicitudSchema>

export const AprobacionRawSchema = z.object({
  de: z.string(),
  para: z.string(),
  fecha: z.string(),
  asunto: z.string(),
  cuerpo: z.string(),
})

export type Cotizacion = {
  proveedor: string
  nit: string | null
  total: number
  moneda: string
  validez_hasta: string | null
  texto: string
  referencia: string | null
  fecha: string | null
}
export type Aprobacion = { de: string; para: string; fecha: string; asunto: string; aprobado: boolean; texto: string }
export type Factura = { numero: string; fecha: string; total: number }
export type Paquete = {
  correo: z.infer<typeof CorreoSchema>
  solicitud: Solicitud
  cotizacion: Cotizacion | null
  aprobacion: Aprobacion | null
  factura: Factura | null
}

// ---- Maestros ----
export const ProveedorSchema = z.object({
  codigo_sap: z.string(),
  nit: z.string(),
  nombre: z.string(),
  condiciones_pago_default: z.string(),
  indicador_iva_default: z.string(),
  activo: z.boolean(),
})
export const CentroCostoSchema = z.object({
  centro_costo: z.string(),
  nombre: z.string().optional(),
  subareas: z.array(z.string()),
  aprobadores: z.array(z.object({ email: z.string(), nombre: z.string().optional(), tope: z.number() })),
})
export const IndicadorSchema = z.object({ codigo: z.string(), descripcion: z.string(), tasa: z.number() })
export const CondicionSchema = z.object({ codigo: z.string(), descripcion: z.string(), dias: z.number() })

export type Proveedor = z.infer<typeof ProveedorSchema>
export type CentroCosto = z.infer<typeof CentroCostoSchema>
export type Maestros = {
  proveedores: Proveedor[]
  centros: CentroCosto[]
  indicadores: z.infer<typeof IndicadorSchema>[]
  condiciones: z.infer<typeof CondicionSchema>[]
}

// ---- Payload de la OC (sección 7.4 del PRD) ----
export const OrdenCompraSchema = z.object({
  referencia: z.object({
    solicitud_id: z.string(),
    correo_id: z.string(),
    cotizacion_ref: z.string().nullable(),
  }),
  sociedad: z.literal("1000"),
  organizacion_compras: z.literal("1000"),
  proveedor: z.object({ codigo_sap: z.string(), nit: z.string(), nombre: z.string() }),
  moneda: z.enum(["COP", "USD"]),
  condiciones_pago: z.string().min(1),
  aprobador: z.object({
    email: z.string().email(),
    fecha_aprobacion: z.string(),
    evidencia_sha256: z.string().length(64),
  }),
  posiciones: z
    .array(
      z.object({
        numero: z.number().int().positive(),
        descripcion: z.string().min(1).max(40),
        cantidad: z.number().positive(),
        unidad: z.enum(["UN", "H", "MES"]),
        precio_unitario: z.number().nonnegative(),
        centro_costo: z.string(),
        subarea: z.string(),
        indicador_iva: z.string(),
      }),
    )
    .min(1),
  excepciones: z.array(z.object({ codigo: z.string(), detalle: z.string(), confirmado_por: z.string().nullable() })),
})
export type OrdenCompra = z.infer<typeof OrdenCompraSchema>
