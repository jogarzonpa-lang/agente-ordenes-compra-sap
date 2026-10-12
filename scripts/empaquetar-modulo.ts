// Regenera modulo/ (bonus 9.4). Uso: bun run scripts/empaquetar-modulo.ts
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { generarModulo } from "./modulo-lib"

const directory = resolve(dirname(fileURLToPath(import.meta.url)), "..")
for (const [ruta, contenido] of Object.entries(await generarModulo(directory))) {
  await mkdir(dirname(join(directory, ruta)), { recursive: true })
  await writeFile(join(directory, ruta), contenido, "utf8")
  console.log(`escrito ${ruta}`)
}
