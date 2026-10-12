import { appendFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import type { Ctx } from "./types"
import { enSerie, leerTexto } from "./util"

export type FilaControl = {
  solicitud_id: string
  resultado: "creada" | "idempotente" | "bloqueada" | "pendiente" | "error"
  numero_oc: string
  retroactiva: boolean
  bloqueos: string[]
  confirmaciones: string[]
}

const CABECERA = "solicitud_id,resultado,numero_oc,retroactiva,bloqueos,confirmaciones,ts"
const csv = (v: string): string => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)

/** Una fila por cada intento (HU-5): auditoría puede medir cuántas OC son retroactivas. */
export async function registrarControl(ctx: Ctx, f: FilaControl): Promise<void> {
  const ruta = join(ctx.directory, "out", "control.csv")
  await enSerie(async () => {
    await mkdir(join(ctx.directory, "out"), { recursive: true })
    const existe = (await leerTexto(ruta)) !== null
    const fila = [f.solicitud_id, f.resultado, f.numero_oc, String(f.retroactiva), f.bloqueos.join(";"), f.confirmaciones.join(";"), new Date().toISOString()]
    await appendFile(ruta, `${existe ? "" : `${CABECERA}\n`}${fila.map(csv).join(",")}\n`, "utf8")
  })
}
