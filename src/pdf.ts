import { PDFDocument, StandardFonts, rgb } from "pdf-lib"

// La fuente estándar solo codifica Latin-1: lo demás se reemplaza para no romper la generación.
const limpiar = (s: string): string => s.replace(/\t/g, "  ").replace(/[^\x20-\x7E\u00A0-\u00FF]/g, "?")

function envolver(linea: string, max: number): string[] {
  if (linea.length <= max) return [linea]
  const salida: string[] = []
  let actual = ""
  for (const palabra of linea.split(" ")) {
    let resto = palabra
    while (resto.length > max) {
      if (actual) { salida.push(actual); actual = "" }
      salida.push(resto.slice(0, max))
      resto = resto.slice(max)
    }
    if (!actual) actual = resto
    else if (actual.length + 1 + resto.length <= max) actual += ` ${resto}`
    else { salida.push(actual); actual = resto }
  }
  if (actual) salida.push(actual)
  return salida
}

/** Convierte texto plano a un PDF A4 sencillo (fuente monoespaciada, con paginación). */
export async function textoAPdf(titulo: string, cuerpo: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const fuente = await doc.embedFont(StandardFonts.Courier)
  const [ancho, alto, margen, tam, interlineado] = [595, 842, 50, 10, 14] as const
  const maxCar = Math.floor((ancho - 2 * margen) / fuente.widthOfTextAtSize("M", tam))
  const lineas = [titulo, "", ...cuerpo.split("\n")].flatMap((l) => envolver(limpiar(l), maxCar))
  let pagina = doc.addPage([ancho, alto])
  let y = alto - margen
  for (const l of lineas) {
    if (y < margen) { pagina = doc.addPage([ancho, alto]); y = alto - margen }
    pagina.drawText(l, { x: margen, y, size: tam, font: fuente, color: rgb(0, 0, 0) })
    y -= interlineado
  }
  return doc.save()
}
