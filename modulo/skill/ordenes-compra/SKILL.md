---
name: ordenes-compra
description: Conocimiento del proceso de órdenes de compra (controles RC1-RC10, bloqueo vs confirmación, OC retroactiva, glosario de IVA y condiciones de pago). Úsalo al procesar solicitudes de compra.
---

# Conocimiento del proceso: Órdenes de Compra (Compras, Periferia IT Group)

## Qué es una OC y cuándo se crea
Una orden de compra (OC) es el compromiso formal con un proveedor. Debe existir **antes** de recibir el bien o servicio y de radicar la factura. El proceso manual: la analista recibe un correo con la solicitud (Excel), la cotización del proveedor y la aprobación del líder, valida a mano y digita la OC en SAP.

## El paquete de un caso
- `solicitud`: quién pide, proveedor, descripción, centro de costo, subárea, cantidad, valor unitario y total, moneda, indicador de IVA y condiciones de pago (estos dos últimos pueden venir vacíos).
- `cotizacion`: texto del proveedor con referencia, NIT, total y validez.
- `aprobacion`: correo del líder; debe decir "Aprobado" y venir de un aprobador del centro de costo.
- `factura` (solo en algunos casos): si existe y es anterior a la solicitud, la OC es **retroactiva**.

## Controles (RC1–RC10)
| Código | Control | Resultado si falla |
|---|---|---|
| RC1 | El proveedor existe en el maestro (por NIT; si no hay NIT, por nombre) y está activo | Bloquea |
| RC2 | Hay aprobación, dice "Aprobado" y quien aprueba es aprobador del centro de costo | Bloquea |
| RC3 | El valor total no supera el tope de ese aprobador | Bloquea |
| RC4 | El centro de costo existe y la subárea le pertenece | Bloquea |
| RC5 | La cotización coincide con la solicitud (tolerancia 2 %) o existe | Pide confirmación |
| RC6 | Indicador de IVA informado y válido; si falta se propone el default del proveedor | Pide confirmación (falta) / Bloquea (inválido) |
| RC7 | Condiciones de pago informadas y válidas; si faltan se usa el default del proveedor | Informa (falta) / Bloquea (inválida) |
| RC8 | La factura no es anterior a la solicitud | Pide confirmación y marca retroactiva |
| RC9 | La aprobación no es anterior a la solicitud | Pide confirmación |
| RC10 | cantidad × valor unitario = valor total (±1) y montos positivos | Bloquea |

## Bloqueo vs confirmación
- **Bloqueo**: no se puede crear la OC; se explica el motivo y qué debe corregir el solicitante o Compras.
- **Confirmación**: la OC es posible, pero una persona debe aceptar la excepción de forma explícita; queda registrada en la OC (`excepciones`) y en el log de control.

## Glosario
- **Indicador de IVA**: C0 excluido/no gravado (0 %), C1 IVA 19 %, C2 IVA 5 %.
- **Condiciones de pago**: Z000 inmediato, Z015 a 15 días, Z030 a 30 días, Z060 a 60 días, contados desde la fecha de la factura.
- **Tope de aprobación**: valor máximo que un líder puede aprobar en su centro de costo.
- **Idempotencia**: pedir dos veces la misma solicitud devuelve la misma OC; no se duplica.
- **OC retroactiva**: creada después de que ya existe la factura; indica que la compra se comprometió sin pasar por el control previo.
