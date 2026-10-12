// API HTTP (node:http: sin framework, corre igual en Bun y en Node).
import { readFile } from "node:fs/promises"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { join } from "node:path"
import { z } from "zod"
import { crearSesion, turno, type Dependencias, type Sesion } from "./agente"
import { mensajeError } from "./util"

class ErrorHttp extends Error {
  constructor(readonly status: number, mensaje: string) {
    super(mensaje)
  }
}

const SESION_RE = /^[A-Za-z0-9-]{8,64}$/
const ChatSchema = z.object({ sessionId: z.string().regex(SESION_RE, "sessionId inválido"), message: z.string().trim().min(1, "Escribe un mensaje").max(2000, "Máximo 2000 caracteres") })
const MAX_SESIONES = 300
const ARCHIVOS_PERMITIDOS: Record<string, string> = {
  "aprobacion.pdf": "application/pdf",
  "aprobacion.txt": "text/plain; charset=utf-8",
  "payload.json": "application/json; charset=utf-8",
  "trazabilidad.json": "application/json; charset=utf-8",
}

function json(res: ServerResponse, status: number, cuerpo: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" })
  res.end(JSON.stringify(cuerpo))
}

async function leerCuerpo(req: IncomingMessage, max = 16_384): Promise<unknown> {
  const trozos: Buffer[] = []
  let total = 0
  for await (const t of req) {
    const b = t as Buffer
    total += b.length
    if (total > max) throw new ErrorHttp(413, "El cuerpo de la petición es demasiado grande.")
    trozos.push(b)
  }
  try {
    return JSON.parse(Buffer.concat(trozos).toString("utf8")) as unknown
  } catch {
    throw new ErrorHttp(400, "El cuerpo no es JSON válido.")
  }
}

export function crearServidor(deps: Dependencias, accessKey?: string): Server {
  const sesiones = new Map<string, Sesion>()

  const obtener = (id: string): Sesion => {
    const existente = sesiones.get(id)
    if (existente) return existente
    if (sesiones.size >= MAX_SESIONES) {
      const masVieja = sesiones.keys().next().value
      if (masVieja !== undefined) sesiones.delete(masVieja)
    }
    const nueva = crearSesion(id)
    sesiones.set(id, nueva)
    return nueva
  }

  const autorizado = (req: IncomingMessage): boolean => !accessKey || req.headers["x-access-key"] === accessKey

  async function manejar(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost")
    const ruta = url.pathname

    if (req.method === "GET" && (ruta === "/" || ruta === "/index.html")) {
      const html = await readFile(join(deps.directory, "web", "index.html"), "utf8")
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'",
        "X-Content-Type-Options": "nosniff",
      })
      res.end(html)
      return
    }
    if (req.method === "GET" && ruta === "/api/health") {
      json(res, 200, { ok: true, provider: deps.llm.proveedor, model: deps.llm.modelo, protegido: Boolean(accessKey) })
      return
    }
    if (ruta.startsWith("/api/") && !autorizado(req)) throw new ErrorHttp(401, "Clave de acceso requerida o incorrecta.")

    if (req.method === "POST" && ruta === "/api/chat") {
      const entrada = ChatSchema.safeParse(await leerCuerpo(req))
      if (!entrada.success) throw new ErrorHttp(400, entrada.error.issues.map((i) => i.message).join("; "))
      const s = obtener(entrada.data.sessionId)
      if (s.ocupada) throw new ErrorHttp(409, "Hay un turno en curso en esta sesión. Espera la respuesta.")
      s.ocupada = true
      try {
        json(res, 200, await turno(s, entrada.data.message, deps))
      } finally {
        s.ocupada = false
      }
      return
    }
    // Descarga de la evidencia y otros artefactos de un caso (lista blanca de nombres: sin rutas arbitrarias).
    const a = ruta.match(/^\/api\/archivos\/([A-Za-z0-9_-]+)\/([a-z.]+)$/)
    if (req.method === "GET" && a?.[1] && a[2]) {
      const tipo = ARCHIVOS_PERMITIDOS[a[2]]
      if (!tipo) throw new ErrorHttp(404, "Archivo no disponible.")
      let contenido: Buffer
      try {
        contenido = await readFile(join(deps.directory, "out", a[1], a[2]))
      } catch {
        throw new ErrorHttp(404, "Ese archivo aún no existe: primero hay que procesar el caso.")
      }
      res.writeHead(200, { "Content-Type": tipo, "Content-Disposition": `attachment; filename="${a[1]}-${a[2]}"`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" })
      res.end(contenido)
      return
    }
    const m = ruta.match(/^\/api\/sessions\/([A-Za-z0-9-]{8,64})$/)
    if (req.method === "GET" && m?.[1]) {
      const s = sesiones.get(m[1])
      json(res, 200, { sessionId: m[1], historial: s?.historial ?? [], tokens: s?.tokens ?? 0 })
      return
    }
    throw new ErrorHttp(404, "Ruta no encontrada.")
  }

  return createServer((req, res) => {
    manejar(req, res).catch((e: unknown) => {
      if (res.headersSent) return res.end()
      if (e instanceof ErrorHttp) return json(res, e.status, { error: e.message })
      console.error("[servidor] error inesperado:", mensajeError(e))
      return json(res, 500, { error: "Error interno del servidor. La sesión sigue disponible." })
    })
  })
}
