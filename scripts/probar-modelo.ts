// Prueba real contra el modelo (consume tokens de tu clave). Uso: OPENAI_API_KEY=... bun run scripts/probar-modelo.ts
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { crearSesion, turno, type Config } from "../src/agente"
import { crearAdaptador } from "../src/llm"
import { cargarSistema } from "../src/sistema"

const directory = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const config: Config = { maxIteraciones: 25, maxTokensSesion: 150_000, maxTokensGlobal: 1_500_000 }
const llm = crearAdaptador()
const deps = { llm, sistema: await cargarSistema(directory), directory, config }
const s = crearSesion("prueba-modelo-0001")

async function decir(texto: string): Promise<void> {
  console.log(`\n👤 ${texto}`)
  const r = await turno(s, texto, deps)
  for (const t of r.toolCalls) console.log(`   🔧 ${t.nombre}(${JSON.stringify(t.args)}) -> ${t.resumen}`)
  console.log(`\n🤖 ${r.reply}\n   [needsConfirmation=${r.needsConfirmation} | tokens de sesión: ${s.tokens}]`)
}

console.log(`Modelo: ${llm.proveedor}/${llm.modelo}`)
await decir('Procesa la solicitud "sol-004". Muéstrame la OC como quedaría en SAP, qué validaciones pasó y cuáles no, y no la crees hasta que yo lo confirme.')
await decir("Confirmo, créala.")
await decir('Procesa la solicitud "sol-002".')
