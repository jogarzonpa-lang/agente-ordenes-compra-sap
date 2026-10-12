import { readFile } from "node:fs/promises"
import { join } from "node:path"

/** Genera el contenido de modulo/ a partir de las MISMAS fuentes que usa la app (sin copias a mano que diverjan). */
export async function generarModulo(directory: string): Promise<Record<string, string>> {
  const prompt = (await readFile(join(directory, "agent", "prompt.md"), "utf8")).trim()
  const conocimiento = (await readFile(join(directory, "src", "knowledge", "ordenes-compra.md"), "utf8")).trim()
  return {
    "modulo/agent.md": `---
description: Agente de órdenes de compra SAP de Periferia IT Group. Lee paquetes de solicitud, valida controles RC1-RC10 y crea la OC con confirmación humana.
mode: primary
permission:
  edit: deny
  bash: deny
---

${prompt}
`,
    "modulo/skill/ordenes-compra/SKILL.md": `---
name: ordenes-compra
description: Conocimiento del proceso de órdenes de compra (controles RC1-RC10, bloqueo vs confirmación, OC retroactiva, glosario de IVA y condiciones de pago). Úsalo al procesar solicitudes de compra.
---

${conocimiento}
`,
    "modulo/tools/oc.ts": `// Las mismas herramientas que usa la aplicación: se reexportan, no se copian.
// Importables sin el servidor: cada herramienta es { description, args (zod), execute(args, ctx) }.
export * from "../../src/tools/oc"
`,
  }
}
