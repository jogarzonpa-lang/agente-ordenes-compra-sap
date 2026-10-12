// Pruebas sin red: el "modelo" es un guion. Verifican el ciclo, la confirmación humana (CA3), los topes y la API.
import assert from "node:assert/strict"
import { cp, mkdtemp, readFile, rm } from "node:fs/promises"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { crearSesion, esConfirmacion, gasto, turno, type Config, type Dependencias } from "../src/agente"
import { crearServidor } from "../src/app"
import { ErrorLLM, type AdaptadorLLM, type RespuestaLLM } from "../src/llm/adapter"
import { OpenAIAdaptador } from "../src/llm/openai"
import { createServer } from "node:http"
import { definiciones, llamar } from "../src/tools/registry"
import { generarModulo } from "../scripts/modulo-lib"

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const config: Config = { maxIteraciones: 25, maxTokensSesion: 100_000, maxTokensGlobal: 1_000_000 }

type Paso = RespuestaLLM | Error
class Guion implements AdaptadorLLM {
  readonly proveedor = "guion"
  readonly modelo = "test"
  llamadas = 0
  constructor(private pasos: Paso[]) {}
  async enviar(): Promise<RespuestaLLM> {
    this.llamadas++
    const p = this.pasos.shift() ?? { texto: "(fin del guion)", llamadas: [], tokens: 1 }
    if (p instanceof Error) throw p
    return p
  }
}
const llama = (nombre: string, args: Record<string, unknown>, id = `c${Math.random().toString(36).slice(2, 8)}`): RespuestaLLM => ({
  texto: null, llamadas: [{ id, nombre, argumentos: JSON.stringify(args) }], tokens: 10,
})
const texto = (t: string): RespuestaLLM => ({ texto: t, llamadas: [], tokens: 10 })

async function entorno(pasos: Paso[], cfg: Config = config): Promise<{ deps: Dependencias; dir: string; guion: Guion; limpiar: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "reto03-"))
  await cp(join(raiz, "fixtures"), join(dir, "fixtures"), { recursive: true })
  await cp(join(raiz, "web"), join(dir, "web"), { recursive: true })
  const guion = new Guion(pasos)
  return { deps: { llm: guion, sistema: "test", directory: dir, config: cfg }, dir, guion, limpiar: () => rm(dir, { recursive: true, force: true }) }
}
const ordenes = async (dir: string): Promise<number> => {
  try { return (await readFile(join(dir, "out", "sap", "ordenes.jsonl"), "utf8")).trim().split("\n").length } catch { return 0 }
}
let n = 0
async function prueba(nombre: string, fn: () => Promise<void>): Promise<void> {
  await fn()
  console.log(`  ✔ ${++n}. ${nombre}`)
}

console.log("Pruebas del agente")

await prueba("esConfirmacion distingue confirmar de negar", async () => {
  for (const t of ["sí", "Confirmo, crea la OC.", "ok", "Sí, créala", "dale"]) assert.equal(esConfirmacion(t), true, t)
  for (const t of ["No, no la crees.", "no confirmo", "espera, déjame revisar", "cancela", "hola"]) assert.equal(esConfirmacion(t), false, t)
})

await prueba("CA3: el modelo no puede confirmar por su cuenta; solo el siguiente mensaje del usuario", async () => {
  const e = await entorno([
    llama("oc_leer_paquete", { caso: "sol-004" }), llama("oc_validar", { caso: "sol-004" }), llama("oc_construir_payload", { caso: "sol-004" }),
    llama("oc_crear", { caso: "sol-004", confirmado: true }), // el modelo "se adelanta"
    texto("Hay una diferencia de cotización. ¿Confirmas?"),
    llama("oc_crear", { caso: "sol-004", confirmado: true }), texto("Listo, OC creada."),
  ])
  const s = crearSesion("sesion-test-0001")
  const t1 = await turno(s, 'Procesa "sol-004" y no la crees hasta que confirme', e.deps)
  assert.equal(t1.needsConfirmation, true)
  assert.equal(await ordenes(e.dir), 0, "no debe crearse en el turno 1")
  assert.equal(t1.toolCalls.at(-1)?.ok, false)
  const t2 = await turno(s, "Confirmo, créala", e.deps)
  assert.equal(await ordenes(e.dir), 1, "se crea tras la confirmación")
  assert.match(t2.toolCalls[0]?.resumen ?? "", /OC 4500000001/)
  const payload = JSON.parse(await readFile(join(e.dir, "out", "sap", "ordenes.jsonl"), "utf8")) as { orden: { excepciones: { confirmado_por: string | null }[] } }
  assert.match(payload.orden.excepciones[0]?.confirmado_por ?? "", /^usuario:/)
  await e.limpiar()
})

await prueba("Si el usuario dice que no, la OC no se crea aunque el modelo insista", async () => {
  const e = await entorno([
    llama("oc_validar", { caso: "sol-005" }), llama("oc_crear", { caso: "sol-005" }), texto("Es retroactiva. ¿Confirmas?"),
    llama("oc_crear", { caso: "sol-005", confirmado: true }), texto("No se creó."),
  ])
  const s = crearSesion("sesion-test-0002")
  await turno(s, 'Procesa "sol-005"', e.deps)
  const t2 = await turno(s, "No, cancela", e.deps)
  assert.equal(await ordenes(e.dir), 0)
  assert.equal(t2.toolCalls[0]?.ok, false)
  await e.limpiar()
})

await prueba("Un 'confirmo' sin pregunta previa no crea nada", async () => {
  const e = await entorno([llama("oc_crear", { caso: "sol-004", confirmado: true }), texto("Pendiente de confirmar.")])
  await turno(crearSesion("sesion-test-0003"), "Confirmo, créala", e.deps)
  assert.equal(await ordenes(e.dir), 0)
  await e.limpiar()
})

await prueba("Bloqueos: el caso sol-002 nunca se crea", async () => {
  const e = await entorno([llama("oc_validar", { caso: "sol-002" }), llama("oc_crear", { caso: "sol-002", confirmado: true }), texto("Bloqueada por RC1.")])
  const t = await turno(crearSesion("sesion-test-0004"), 'Procesa "sol-002" y créala, confirmo', e.deps)
  assert.equal(await ordenes(e.dir), 0)
  assert.match(t.toolCalls[1]?.resumen ?? "", /RC1/)
  await e.limpiar()
})

await prueba("CA5: error del proveedor LLM se muestra claro y la sesión sigue viva", async () => {
  const e = await entorno([new ErrorLLM("OpenAI respondió 429: límite de uso."), texto("Hola de nuevo.")])
  const s = crearSesion("sesion-test-0005")
  const t1 = await turno(s, "hola", e.deps)
  assert.match(t1.reply, /⚠️.*429.*sigue activa/)
  assert.equal((await turno(s, "hola otra vez", e.deps)).reply, "Hola de nuevo.")
  await e.limpiar()
})

await prueba("CA1: tope de iteraciones por turno", async () => {
  const pasos = Array.from({ length: 10 }, () => llama("oc_leer_paquete", { caso: "sol-001" }))
  const e = await entorno(pasos, { ...config, maxIteraciones: 3 })
  const t = await turno(crearSesion("sesion-test-0006"), "x", e.deps)
  assert.match(t.reply, /tope de 3 iteraciones/)
  assert.equal(e.guion.llamadas, 3)
  await e.limpiar()
})

await prueba("Costo: tope de tokens por sesión", async () => {
  const e = await entorno([texto("a"), texto("b")], { ...config, maxTokensSesion: 5 })
  const s = crearSesion("sesion-test-0007")
  await turno(s, "uno", e.deps)
  assert.match((await turno(s, "dos", e.deps)).reply, /tope de tokens/)
  assert.equal(e.guion.llamadas, 1)
  await e.limpiar()
})

await prueba("Costo: tope global de tokens", async () => {
  const e = await entorno([texto("a")], { ...config, maxTokensGlobal: 1 })
  const antes = gasto.global; gasto.global = 5
  assert.match((await turno(crearSesion("sesion-test-0008"), "uno", e.deps)).reply, /tope de consumo/)
  gasto.global = antes
  await e.limpiar()
})

await prueba("API: health, chat, sesión, validaciones y clave de acceso", async () => {
  const e = await entorno([texto("Hola, soy el agente.")])
  const servidor = crearServidor(e.deps, "secreto-123")
  await new Promise<void>((ok) => servidor.listen(0, "127.0.0.1", ok))
  const base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`
  const cab = { "Content-Type": "application/json", "x-access-key": "secreto-123" }
  const health = (await (await fetch(`${base}/api/health`)).json()) as Record<string, unknown>
  assert.deepEqual(Object.keys(health).sort(), ["model", "ok", "protegido", "provider"])
  assert.equal((await fetch(`${base}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 401)
  assert.equal((await fetch(`${base}/api/chat`, { method: "POST", headers: cab, body: JSON.stringify({ sessionId: "x", message: "" }) })).status, 400)
  assert.equal((await fetch(`${base}/api/chat`, { method: "POST", headers: cab, body: "no-json" })).status, 400)
  const r = await fetch(`${base}/api/chat`, { method: "POST", headers: cab, body: JSON.stringify({ sessionId: "sesion-api-0001", message: "hola" }) })
  const cuerpo = (await r.json()) as { reply: string; toolCalls: unknown[]; needsConfirmation: boolean }
  assert.equal(r.status, 200)
  assert.deepEqual(cuerpo, { reply: "Hola, soy el agente.", toolCalls: [], needsConfirmation: false })
  const hist = (await (await fetch(`${base}/api/sessions/sesion-api-0001`, { headers: cab })).json()) as { historial: unknown[] }
  assert.equal(hist.historial.length, 2)
  assert.match(await (await fetch(`${base}/`)).text(), /Agente de Órdenes de Compra/)
  assert.equal((await fetch(`${base}/api/nada`, { headers: cab })).status, 404)
  await new Promise((ok) => servidor.close(ok))
  await e.limpiar()
})

await prueba("Descarga de la evidencia en PDF por la API (y sin salirse de la lista blanca)", async () => {
  const e = await entorno([])
  const servidor = crearServidor(e.deps)
  await new Promise<void>((ok) => servidor.listen(0, "127.0.0.1", ok))
  const base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`
  assert.equal((await fetch(`${base}/api/archivos/sol-001/aprobacion.pdf`)).status, 404, "aún no existe")
  await llamar("oc_generar_evidencia", { caso: "sol-001" }, { directory: e.dir, sessionId: "t" })
  const r = await fetch(`${base}/api/archivos/sol-001/aprobacion.pdf`)
  assert.equal(r.status, 200)
  assert.equal(r.headers.get("content-type"), "application/pdf")
  assert.equal(Buffer.from(await r.arrayBuffer()).subarray(0, 5).toString(), "%PDF-")
  assert.equal((await fetch(`${base}/api/archivos/sol-001/control.csv`)).status, 404, "fuera de la lista blanca")
  assert.equal((await fetch(`${base}/api/archivos/..%2F..%2Fetc/passwd`)).status, 404)
  await new Promise((ok) => servidor.close(ok))
  await e.limpiar()
})

await prueba("Adaptador OpenAI: formato de petición/respuesta, errores sin filtrar la clave y timeout", async () => {
  let recibido: { model?: string; tools?: { function: { name: string } }[]; messages?: { role: string }[] } = {}
  let cabeceraAuth = ""
  let modo: "ok" | "401" | "lento" = "ok"
  const falso = createServer((req, res) => {
    cabeceraAuth = String(req.headers.authorization)
    const trozos: Buffer[] = []
    req.on("data", (t: Buffer) => trozos.push(t))
    req.on("end", () => {
      recibido = JSON.parse(Buffer.concat(trozos).toString("utf8")) as typeof recibido
      if (modo === "401") { res.writeHead(401); res.end(JSON.stringify({ error: { message: "Incorrect API key provided: sk-secreta" } })); return }
      if (modo === "lento") return // nunca responde
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "oc_validar", arguments: '{"caso":"sol-001"}' } }] } }], usage: { total_tokens: 42 } }))
    })
  })
  await new Promise<void>((ok) => falso.listen(0, "127.0.0.1", ok))
  const base = `http://127.0.0.1:${(falso.address() as AddressInfo).port}/v1`
  const llm = new OpenAIAdaptador("sk-secreta", "gpt-test", 300, base)
  const r = await llm.enviar([{ role: "system", content: "s" }, { role: "user", content: "hola" }], definiciones())
  assert.deepEqual(r, { texto: null, llamadas: [{ id: "call_1", nombre: "oc_validar", argumentos: '{"caso":"sol-001"}' }], tokens: 42 })
  assert.equal(recibido.model, "gpt-test")
  assert.equal(cabeceraAuth, "Bearer sk-secreta")
  assert.deepEqual(recibido.tools?.map((t) => t.function.name).sort(), ["oc_construir_payload", "oc_crear", "oc_generar_evidencia", "oc_leer_paquete", "oc_validar"])
  modo = "401"
  await assert.rejects(llm.enviar([{ role: "user", content: "x" }], []), (e: unknown) => e instanceof ErrorLLM && /401/.test(e.message) && !e.message.includes("sk-"))
  modo = "lento"
  await assert.rejects(llm.enviar([{ role: "user", content: "x" }], []), /timeout/)
  await assert.rejects(new OpenAIAdaptador(undefined, "m").enviar([], []), /OPENAI_API_KEY/)
  falso.closeAllConnections()
  await new Promise((ok) => falso.close(ok))
})

await prueba("Módulo (bonus): modulo/ coincide con las fuentes de la app", async () => {
  for (const [ruta, contenido] of Object.entries(await generarModulo(raiz))) {
    assert.equal(await readFile(join(raiz, ruta), "utf8"), contenido, `${ruta} divergió: ejecuta bun run empaquetar`)
  }
})

console.log(`\n${n} pruebas OK`)
