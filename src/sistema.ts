import { readFile } from "node:fs/promises"
import { join } from "node:path"

/** Prompt (comportamiento) + conocimiento del proceso, cargados desde archivos: cambiarlos no toca el servidor. */
export async function cargarSistema(directory: string): Promise<string> {
  const prompt = await readFile(join(directory, "agent", "prompt.md"), "utf8")
  const conocimiento = await readFile(join(directory, "src", "knowledge", "ordenes-compra.md"), "utf8")
  return `${prompt.trim()}\n\n---\n\n${conocimiento.trim()}\n`
}
