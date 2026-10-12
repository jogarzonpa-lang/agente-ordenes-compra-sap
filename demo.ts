// Verificación sin modelo: procesa todos los casos llamando directamente a las herramientas.
// Uso: bun run demo.ts   (o)   npx tsx demo.ts
import { readFile, readdir, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { listarCasos } from "./src/paquete"
import type { Hallazgo, Validacion } from "./src/rules"
import { llamar } from "./src/tools/registry"
import type { Ctx } from "./src/types"

const directory = dirname(fileURLToPath(import.meta.url))
const ctx: Ctx = { directory, sessionId: "demo" }

type Resp = { ok: boolean; data?: Record<string, unknown>; error?: string; bloqueos?: Hallazgo[]; confirmaciones?: Hallazgo[] }
const invocar = async (tool: string, args: Record<string, unknown>): Promise<Resp> => JSON.parse(await llamar(tool, args, ctx)) as Resp
const lista = (hs: Hallazgo[]): string => (hs.length === 0 ? "—" : hs.map((h) => `\n      [${h.codigo}] ${h.detalle}\n          ↳ ${h.accion}`).join(""))

const resumen: { caso: string; resultado: string; oc: string; retro: boolean }[] = []

async function procesar(caso: string): Promise<void> {
  console.log(`\n━━━━━━━━ ${caso} ━━━━━━━━`)
  const leido = await invocar("oc_leer_paquete", { caso })
  if (!leido.ok) {
    console.log(`  ✖ ${leido.error}`)
    resumen.push({ caso, resultado: "error de lectura", oc: "—", retro: false })
    return
  }
  const val = (await invocar("oc_validar", { caso })).data as unknown as Validacion
  console.log(`  apta: ${val.apta} | retroactiva: ${val.retroactiva}`)
  console.log(`  bloqueos:       ${lista(val.bloqueos)}`)
  console.log(`  confirmaciones: ${lista(val.confirmaciones)}`)
  const der = Object.entries(val.derivados).map(([k, d]) => `${k}=${d.valor}`).join(", ")
  if (der) console.log(`  derivados: ${der}`)

  if (!val.apta) {
    await invocar("oc_crear", { caso }) // queda registrada como "bloqueada" en control.csv
    console.log("  ⛔ NO se crea la OC (bloqueada)")
    resumen.push({ caso, resultado: "bloqueada", oc: "—", retro: val.retroactiva })
    return
  }
  const pl = await invocar("oc_construir_payload", { caso })
  await invocar("oc_generar_evidencia", { caso })
  const payload = pl.data?.payload
  let r = await invocar("oc_crear", { caso, payload })
  let resultado = "creada"
  if (!r.ok && (r as { necesita_confirmacion?: boolean }).necesita_confirmacion) {
    console.log("  ⏸  Pendiente: requiere confirmación humana → no se creó")
    r = await invocar("oc_crear", { caso, payload, confirmado: true })
    console.log("  ✔ Confirmado explícitamente (confirmado=true)")
    resultado = "creada tras confirmación"
  }
  if (r.ok) {
    console.log(`  ✅ OC ${String(r.data?.numero_oc)} | evidencia: ${String(r.data?.evidencia)}`)
    resumen.push({ caso, resultado, oc: String(r.data?.numero_oc), retro: val.retroactiva })
  } else {
    console.log(`  ✖ ${r.error}`)
    resumen.push({ caso, resultado: "error", oc: "—", retro: val.retroactiva })
  }
}

await rm(join(directory, "out"), { recursive: true, force: true })
for (const caso of await listarCasos(ctx)) await procesar(caso)

console.log("\n━━━━━━━━ Idempotencia: sol-001 por segunda vez ━━━━━━━━")
const otra = await invocar("oc_crear", { caso: "sol-001" })
console.log(`  numero_oc: ${String(otra.data?.numero_oc)} | idempotente: ${String(otra.data?.idempotente)}`)

console.log("\n━━━━━━━━ Resumen ━━━━━━━━")
console.table(resumen)
console.log("out/control.csv:\n" + (await readFile(join(directory, "out", "control.csv"), "utf8")))
const ordenes = (await readFile(join(directory, "out", "sap", "ordenes.jsonl"), "utf8")).trim().split("\n").length
console.log(`out/sap/ordenes.jsonl: ${ordenes} OC creadas | archivos en out/: ${(await readdir(join(directory, "out"))).join(", ")}`)
