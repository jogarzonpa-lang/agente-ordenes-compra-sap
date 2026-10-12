import { appendFile, mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { z } from "zod"
import { ProveedorSchema, type OrdenCompra } from "../types"
import { enSerie, leerTexto, normalizarNit } from "../util"
import type { SapAdapter } from "./adapter"

const PRIMER_NUMERO = 4500000001

const RegistroSchema = z.object({
  numero_oc: z.string(),
  fecha: z.string(),
  orden: z.object({ referencia: z.object({ solicitud_id: z.string() }).passthrough() }).passthrough(),
})

/** SAP simulado: persiste en out/sap/ordenes.jsonl (una OC por línea). */
export class MockSap implements SapAdapter {
  private readonly archivo: string

  constructor(private readonly directory: string) {
    this.archivo = join(directory, "out", "sap", "ordenes.jsonl")
  }

  private async leerRegistros(): Promise<z.infer<typeof RegistroSchema>[]> {
    const texto = await leerTexto(this.archivo)
    if (!texto) return []
    return texto
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => RegistroSchema.parse(JSON.parse(l)))
  }

  async consultarProveedor(nit: string): Promise<{ codigo_sap: string; activo: boolean } | null> {
    const texto = await leerTexto(join(this.directory, "fixtures", "reto-03", "maestros", "proveedores.json"))
    if (!texto) return null
    const lista = z.array(ProveedorSchema).parse(JSON.parse(texto))
    const p = lista.find((x) => normalizarNit(x.nit) === normalizarNit(nit))
    return p ? { codigo_sap: p.codigo_sap, activo: p.activo } : null
  }

  async buscarOrdenPorReferencia(solicitud_id: string): Promise<{ numero_oc: string; fecha?: string } | null> {
    const r = (await this.leerRegistros()).find((x) => x.orden.referencia.solicitud_id === solicitud_id)
    return r ? { numero_oc: r.numero_oc, fecha: r.fecha } : null
  }

  /** Serializada y con deduplicación interna: dos llamadas simultáneas no generan dos OC ni números repetidos. */
  async crearOrden(orden: OrdenCompra): Promise<{ numero_oc: string; fecha: string }> {
    return enSerie(async () => {
      const previas = await this.leerRegistros()
      const existente = previas.find((x) => x.orden.referencia.solicitud_id === orden.referencia.solicitud_id)
      if (existente) return { numero_oc: existente.numero_oc, fecha: existente.fecha }
      const numero_oc = String(PRIMER_NUMERO + previas.length)
      const fecha = new Date().toISOString()
      await mkdir(dirname(this.archivo), { recursive: true })
      await appendFile(this.archivo, `${JSON.stringify({ numero_oc, fecha, orden })}\n`, "utf8")
      return { numero_oc, fecha }
    })
  }
}
