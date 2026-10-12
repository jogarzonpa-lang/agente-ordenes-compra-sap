// Ciclo del agente: prompt -> modelo -> llamadas a herramientas -> respuesta.
// Reglas del PRD: CA1 tope de iteraciones, CA2 valores solo de herramientas, CA3 confirmación humana,
// CA4 historial visible, CA5 errores en lenguaje claro sin matar la sesión.
import type { AdaptadorLLM, Mensaje, RespuestaLLM } from "./llm/adapter"
import { definiciones, llamar } from "./tools/registry"
import { fail, mensajeError } from "./util"

export type EventoHerramienta = { nombre: string; args: unknown; ok: boolean; resumen: string; resultado: string }
export type EntradaHistorial = { rol: "usuario" | "agente"; texto: string; herramientas?: EventoHerramienta[]; necesitaConfirmacion?: boolean; ts: string }
export type Sesion = {
  id: string
  mensajes: Mensaje[]
  historial: EntradaHistorial[]
  turno: number
  tokens: number
  /** Caso cuya creación espera una confirmación humana (se fija en un turno y se honra en uno posterior). */
  pendiente: { caso: string; turno: number } | null
  ocupada: boolean
}
export type Config = { maxIteraciones: number; maxTokensSesion: number; maxTokensGlobal: number }
export type Dependencias = { llm: AdaptadorLLM; sistema: string; directory: string; config: Config }
export type SalidaTurno = { reply: string; toolCalls: EventoHerramienta[]; needsConfirmation: boolean }

/** Contador global de tokens: evita que abrir sesiones nuevas esquive el tope de costo. */
export const gasto = { global: 0 }

export const crearSesion = (id: string): Sesion => ({ id, mensajes: [], historial: [], turno: 0, tokens: 0, pendiente: null, ocupada: false })

// "sí / confirmo / adelante ..." sin negaciones. Lookarounds con \p{L} porque \b falla con tildes.
const palabras = (alt: string): RegExp => new RegExp(`(?<![\\p{L}])(${alt})(?![\\p{L}])`, "iu")
const AFIRMATIVO = palabras("sí|si|confirmo|confirmado|confirmada|adelante|procede|proceda|dale|ok|okay|de acuerdo|hazlo|créala|creala|crea|listo")
const NEGATIVO = palabras("no|cancela|cancelar|cancelo|espera|detente|detén|rechazo|aborta")
export const esConfirmacion = (texto: string): boolean => AFIRMATIVO.test(texto) && !NEGATIVO.test(texto)

type Resultado = { ok: boolean; necesita_confirmacion?: boolean; data?: { apta?: boolean; confirmaciones?: unknown[]; numero_oc?: string } }
function leerResultado(salida: string): Resultado {
  try {
    return JSON.parse(salida) as Resultado
  } catch {
    return { ok: false }
  }
}

function resumir(nombre: string, salida: string): string {
  const r = leerResultado(salida)
  const e = (JSON.parse(salida) as { error?: string; bloqueos?: { codigo: string }[] })
  if (!r.ok) return `✖ ${e.error ?? "error"}${e.bloqueos?.length ? ` [${e.bloqueos.map((b) => b.codigo).join(", ")}]` : ""}`
  const d = (JSON.parse(salida) as { data: Record<string, unknown> }).data
  switch (nombre) {
    case "oc_leer_paquete": return `Paquete leído (${String((d.solicitud as { solicitud_id?: string } | undefined)?.solicitud_id ?? "?")}); faltantes: ${JSON.stringify(d.faltantes ?? [])}`
    case "oc_validar": {
      const cods = (xs: unknown): string => (Array.isArray(xs) ? xs.map((x) => (x as { codigo: string }).codigo).join(", ") || "—" : "—")
      return `apta=${String(d.apta)} · bloqueos: ${cods(d.bloqueos)} · confirmaciones: ${cods(d.confirmaciones)} · retroactiva=${String(d.retroactiva)}`
    }
    case "oc_construir_payload": return `Payload construido y validado. Trazabilidad: ${String(d.trazabilidad_ruta)}`
    case "oc_generar_evidencia": return `Evidencia: ${String(d.ruta)} (sha256 ${String(d.sha256).slice(0, 12)}…)`
    case "oc_crear": return `OC ${String(d.numero_oc)}${d.idempotente ? " (ya existía: idempotente)" : " creada"}`
    default: return "ok"
  }
}

function confirmacionPermitida(s: Sesion, caso: unknown, textoUsuario: string): boolean {
  return s.pendiente !== null && s.pendiente.caso === caso && s.pendiente.turno < s.turno && esConfirmacion(textoUsuario)
}

/** Devuelve true si este resultado deja (o mantiene) una confirmación pendiente en el turno actual. */
function actualizarPendiente(s: Sesion, nombre: string, args: Record<string, unknown>, salida: string): boolean {
  const caso = typeof args.caso === "string" ? args.caso : ""
  const r = leerResultado(salida)
  const marcar = (): boolean => {
    if (s.pendiente?.caso !== caso) s.pendiente = { caso, turno: s.turno }
    return true
  }
  if (nombre === "oc_crear") {
    if (r.ok) { if (s.pendiente?.caso === caso) s.pendiente = null; return false }
    return r.necesita_confirmacion ? marcar() : false
  }
  const hayConfirmaciones = (r.data?.confirmaciones?.length ?? 0) > 0
  if (r.ok && hayConfirmaciones && (nombre === "oc_construir_payload" || (nombre === "oc_validar" && r.data?.apta === true))) return marcar()
  return false
}

export async function turno(s: Sesion, texto: string, deps: Dependencias): Promise<SalidaTurno> {
  const { llm, sistema, directory, config } = deps
  s.turno += 1
  s.historial.push({ rol: "usuario", texto, ts: new Date().toISOString() })
  const eventos: EventoHerramienta[] = []
  let pidioConfirmacion = false

  const cerrar = (reply: string): SalidaTurno => {
    const needs = pidioConfirmacion && s.pendiente !== null
    s.historial.push({ rol: "agente", texto: reply, herramientas: eventos, necesitaConfirmacion: needs, ts: new Date().toISOString() })
    return { reply, toolCalls: eventos, needsConfirmation: needs }
  }

  if (s.tokens >= config.maxTokensSesion) return cerrar("Esta sesión alcanzó su tope de tokens. Abre una sesión nueva para seguir.")
  if (gasto.global >= config.maxTokensGlobal) return cerrar("El servicio alcanzó su tope de consumo de modelo. Intenta más tarde.")
  s.mensajes.push({ role: "user", content: texto })

  for (let i = 0; i < config.maxIteraciones; i++) {
    let r: RespuestaLLM
    try {
      r = await llm.enviar([{ role: "system", content: sistema }, ...s.mensajes], definiciones())
    } catch (e) {
      return cerrar(`⚠️ ${mensajeError(e)} La sesión sigue activa: puedes reintentar.`)
    }
    s.tokens += r.tokens
    gasto.global += r.tokens

    if (r.llamadas.length === 0) {
      const respuesta = r.texto?.trim() || "(el modelo no devolvió texto)"
      s.mensajes.push({ role: "assistant", content: respuesta })
      return cerrar(respuesta)
    }

    s.mensajes.push({ role: "assistant", content: r.texto, llamadas: r.llamadas })
    for (const ll of r.llamadas) {
      let parsed: unknown = null
      try { parsed = JSON.parse(ll.argumentos || "{}") } catch { /* args inválidos: se informa abajo */ }
      let salida: string
      let args: Record<string, unknown> = {}
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        salida = fail("Los argumentos de la herramienta no son un objeto JSON válido.")
      } else {
        args = parsed as Record<string, unknown>
        // CA3: el modelo NO decide si hay confirmación. Solo vale si el usuario confirmó en este mensaje
        // y el agente había pedido confirmación sobre ese mismo caso en un turno anterior.
        if (ll.nombre === "oc_crear") args.confirmado = args.confirmado === true && confirmacionPermitida(s, args.caso, texto)
        salida = await llamar(ll.nombre, args, { directory, sessionId: s.id })
        if (actualizarPendiente(s, ll.nombre, args, salida)) pidioConfirmacion = true
      }
      eventos.push({ nombre: ll.nombre, args, ok: leerResultado(salida).ok, resumen: resumir(ll.nombre, salida), resultado: salida })
      s.mensajes.push({ role: "tool", llamadaId: ll.id, content: salida })
    }
    if (s.tokens >= config.maxTokensSesion) return cerrar("Se alcanzó el tope de tokens de la sesión a mitad del turno. Esto es lo que alcancé a hacer; abre una sesión nueva para continuar.")
  }

  const hechas = eventos.map((e) => `${e.nombre}: ${e.resumen}`).join("\n- ")
  return cerrar(`Alcancé el tope de ${config.maxIteraciones} iteraciones en este turno. Lo que tengo hasta ahora:\n- ${hechas}\n\nDime cómo quieres continuar.`)
}
