import type { CentroCosto, Maestros, Paquete, Proveedor } from "./types"
import { formatoMonto, normalizarNit, normalizarNombre, sinAcentos, soloFecha } from "./util"

export type Hallazgo = { codigo: string; detalle: string; accion: string }
export type Derivado = { valor: string; fuente: string }
export type Derivados = { indicador_iva?: Derivado; condiciones_pago?: Derivado }
export type Validacion = {
  apta: boolean
  bloqueos: Hallazgo[]
  confirmaciones: Hallazgo[]
  derivados: Derivados
  retroactiva: boolean
}

/** "Mariana <MLopez@x.com>" -> "mlopez@x.com" */
export function emailDe(de: string): string {
  return (de.match(/<([^>]+)>/)?.[1] ?? de).trim().toLowerCase()
}

/** RC1: por NIT; si no hay NIT (ni en la solicitud ni en la cotización), por nombre normalizado. */
export function buscarProveedor(p: Paquete, m: Maestros): Proveedor | undefined {
  const nit = p.solicitud.proveedor_nit ?? p.cotizacion?.nit ?? null
  if (nit) return m.proveedores.find((x) => normalizarNit(x.nit) === normalizarNit(nit))
  const nombre = normalizarNombre(p.solicitud.proveedor_nombre)
  return m.proveedores.find((x) => normalizarNombre(x.nombre) === nombre)
}

const mismaSubarea = (a: string, b: string): boolean =>
  sinAcentos(a).trim().toLowerCase() === sinAcentos(b).trim().toLowerCase()

export function validar(p: Paquete, m: Maestros): Validacion {
  const bloqueos: Hallazgo[] = []
  const confirmaciones: Hallazgo[] = []
  const derivados: Derivados = {}
  const s = p.solicitud
  const bloquear = (codigo: string, detalle: string, accion: string): void => void bloqueos.push({ codigo, detalle, accion })
  const confirmar = (codigo: string, detalle: string, accion: string): void => void confirmaciones.push({ codigo, detalle, accion })

  // RC1 — proveedor existente y activo
  const proveedor = buscarProveedor(p, m)
  const nitMostrado = s.proveedor_nit ?? p.cotizacion?.nit ?? "no informado"
  if (!proveedor) {
    bloquear("RC1", `El proveedor "${s.proveedor_nombre}" (NIT ${nitMostrado}) no existe en el maestro de proveedores.`,
      "Pedir al solicitante que verifique el NIT o que Compras cree el proveedor en SAP antes de reenviar la solicitud.")
  } else if (!proveedor.activo) {
    bloquear("RC1", `El proveedor "${proveedor.nombre}" (${proveedor.codigo_sap}) está inactivo en el maestro.`,
      "Solicitar a Compras la reactivación del proveedor o escoger otro proveedor.")
  }

  // RC4 — centro de costo y subárea
  const centro: CentroCosto | undefined = m.centros.find((c) => c.centro_costo === s.centro_costo)
  if (!centro) {
    bloquear("RC4", `El centro de costo ${s.centro_costo} no existe en el maestro.`, "Pedir al solicitante el centro de costo correcto.")
  } else if (!centro.subareas.some((x) => mismaSubarea(x, s.subarea))) {
    bloquear("RC4", `La subárea "${s.subarea}" no pertenece al centro ${centro.centro_costo}. Válidas: ${centro.subareas.join(", ")}.`,
      "Pedir al solicitante que corrija la subárea.")
  }

  // RC2 / RC3 — aprobación existente, aprobada, de un aprobador del centro y dentro de su tope
  const ap = p.aprobacion
  if (!ap) {
    bloquear("RC2", "No hay correo de aprobación del líder.", "Pedir al solicitante el correo de aprobación.")
  } else {
    if (!ap.aprobado) {
      bloquear("RC2", 'El correo de aprobación no contiene un "Aprobado" claro.', "Pedir al líder que responda con la aprobación explícita.")
    }
    if (centro) {
      const email = emailDe(ap.de)
      const aprobador = centro.aprobadores.find((a) => a.email.toLowerCase() === email)
      if (!aprobador) {
        const validos = centro.aprobadores.map((a) => a.email).join(", ")
        bloquear("RC2", `${email} no figura como aprobador del centro ${centro.centro_costo}.`, `Pedir la aprobación a uno de: ${validos}.`)
      } else if (s.valor_total > aprobador.tope) {
        const mayores = centro.aprobadores.filter((a) => a.tope >= s.valor_total).map((a) => a.email)
        bloquear("RC3", `El valor ${formatoMonto(s.valor_total, s.moneda)} supera el tope de ${aprobador.nombre ?? email} (${formatoMonto(aprobador.tope, s.moneda)}) en ${centro.centro_costo}.`,
          mayores.length > 0 ? `Escalar la aprobación a: ${mayores.join(", ")}.` : "Ningún aprobador del centro cubre este monto: escalar a la dirección.")
      }
    }
  }

  // RC10 — aritmética de la solicitud
  if (s.cantidad <= 0 || s.valor_total <= 0) {
    bloquear("RC10", "La cantidad o el valor total no son positivos.", "Pedir al solicitante que corrija la solicitud.")
  } else if (Math.abs(s.cantidad * s.valor_unitario - s.valor_total) > 1) {
    bloquear("RC10", `cantidad × valor unitario = ${formatoMonto(s.cantidad * s.valor_unitario, s.moneda)} no coincide con el valor total ${formatoMonto(s.valor_total, s.moneda)}.`,
      "Pedir al solicitante que corrija los valores de la solicitud.")
  }

  // RC5 — cotización vs solicitud (tolerancia 2 %)
  const cot = p.cotizacion
  if (!cot) {
    confirmar("RC5", "No hay cotización del proveedor adjunta (o no se pudo leer).", "Confirmar si se crea la OC sin cotización; idealmente pedirla al solicitante.")
  } else if (cot.moneda !== s.moneda) {
    confirmar("RC5", `La moneda de la cotización (${cot.moneda}) difiere de la solicitud (${s.moneda}).`, "Confirmar con el solicitante cuál moneda es la correcta.")
  } else if (s.valor_total > 0) {
    const dif = Math.abs(cot.total - s.valor_total) / s.valor_total
    if (dif > 0.02 + 1e-9) {
      confirmar("RC5", `La cotización (${formatoMonto(cot.total, cot.moneda)}) difiere de la solicitud (${formatoMonto(s.valor_total, s.moneda)}) en ${(dif * 100).toFixed(1)} %, por encima del 2 % tolerado.`,
        "Confirmar qué valor es el correcto antes de crear la OC.")
    }
  }

  // RC6 — indicador de IVA
  if (!s.indicador_iva) {
    if (proveedor) {
      derivados.indicador_iva = { valor: proveedor.indicador_iva_default, fuente: "maestro.proveedores.indicador_iva_default" }
      confirmar("RC6", `La solicitud no informa el indicador de IVA; se propone ${proveedor.indicador_iva_default} (default del proveedor).`,
        "Confirmar el indicador de IVA propuesto.")
    }
  } else if (!m.indicadores.some((i) => i.codigo === s.indicador_iva)) {
    bloquear("RC6", `El indicador de IVA "${s.indicador_iva}" no existe en el maestro.`, "Pedir al solicitante un indicador válido.")
  }

  // RC7 — condiciones de pago (solo se informa)
  if (!s.condiciones_pago) {
    if (proveedor) {
      derivados.condiciones_pago = { valor: proveedor.condiciones_pago_default, fuente: "maestro.proveedores.condiciones_pago_default" }
    }
  } else if (!m.condiciones.some((c) => c.codigo === s.condiciones_pago)) {
    bloquear("RC7", `Las condiciones de pago "${s.condiciones_pago}" no existen en el maestro.`, "Pedir al solicitante una condición válida.")
  }

  // RC8 — OC retroactiva (factura anterior a la solicitud)
  const retroactiva = p.factura !== null && soloFecha(p.factura.fecha) < soloFecha(s.fecha_solicitud)
  if (retroactiva && p.factura) {
    confirmar("RC8", `La factura ${p.factura.numero} (${soloFecha(p.factura.fecha)}) es anterior a la solicitud (${soloFecha(s.fecha_solicitud)}): OC retroactiva.`,
      "Confirmar que se crea la OC de todos modos; quedará marcada como retroactiva en el log de control.")
  }

  // RC9 — la aprobación no puede ser anterior a la solicitud
  if (ap && soloFecha(ap.fecha) < soloFecha(s.fecha_solicitud)) {
    confirmar("RC9", `La aprobación (${soloFecha(ap.fecha)}) es anterior a la solicitud (${soloFecha(s.fecha_solicitud)}).`,
      "Confirmar que esa aprobación aplica a esta solicitud.")
  }

  return { apta: bloqueos.length === 0, bloqueos, confirmaciones, derivados, retroactiva }
}
