import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { Config } from "./agente"
import { crearServidor } from "./app"
import { crearAdaptador } from "./llm"
import { cargarSistema } from "./sistema"

const directory = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const entero = (v: string | undefined, def: number): number => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : def)

const config: Config = {
  maxIteraciones: entero(process.env.MAX_ITERACIONES, 25),
  maxTokensSesion: entero(process.env.MAX_TOKENS_SESION, 150_000),
  maxTokensGlobal: entero(process.env.MAX_TOKENS_GLOBAL, 1_500_000),
}
const llm = crearAdaptador()
const servidor = crearServidor({ llm, sistema: await cargarSistema(directory), directory, config }, process.env.ACCESS_KEY || undefined)
const puerto = entero(process.env.PORT, 7860)
servidor.listen(puerto, "0.0.0.0", () => {
  console.log(`Agente de OC en http://localhost:${puerto}  (proveedor: ${llm.proveedor}, modelo: ${llm.modelo}, clave de modelo configurada: ${Boolean(process.env.OPENAI_API_KEY)})`)
})
