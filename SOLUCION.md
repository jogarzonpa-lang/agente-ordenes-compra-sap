# SOLUCION.md — Reto 03: Agente de Órdenes de Compra SAP

## 1. Problema en una frase

La analista de Compras digita a mano en SAP cada orden de compra a partir de un correo con tres adjuntos (solicitud, cotización, aprobación), validando controles de memoria: es lento, propenso a error y deja pasar excepciones (como las compras ya facturadas) sin medirlas.

## 2. Arquitectura

```
Navegador (web/index.html)
   │  POST /api/chat · GET /api/sessions/:id · GET /api/health
   ▼
src/app.ts (HTTP, validación de entrada, clave de acceso opcional)
   ▼
src/agente.ts ── ciclo: modelo ⇄ herramientas, topes, confirmación humana
   │                  │
   │                  ▼
   │           src/tools/registry.ts (valida args con zod, registra en out/log.jsonl)
   │                  ▼
   │           src/tools/oc.ts → src/rules.ts   (RC1–RC10, puros)
   │                             src/paquete.ts (lectura y normalización)
   │                             src/orden.ts   (payload, evidencia, trazabilidad)
   │                             src/sap/mock.ts (SapAdapter → out/sap/ordenes.jsonl)
   ▼
src/llm/adapter.ts ← src/llm/openai.ts (único proveedor; intercambiable)
```

- **Comportamiento**: `agent/prompt.md`. **Conocimiento**: `src/knowledge/ordenes-compra.md`. **Ejecución**: `src/tools/oc.ts`. Un cambio de reglas de negocio toca `rules.ts` y el conocimiento, no el servidor.
- **Salidas** en `out/`: `control.csv`, `log.jsonl`, `sap/ordenes.jsonl` y, por caso, `payload.json`, `trazabilidad.json`, `aprobacion.txt` y `aprobacion.pdf`.

## 3. Ciclo del agente

1. El usuario escribe; el backend arma `system prompt + conocimiento + historial` y llama al modelo con las 5 herramientas.
2. Si el modelo pide herramientas, se ejecutan (argumentos validados con zod) y sus resultados vuelven al modelo; se repite hasta que responde con texto.
3. **Tope de iteraciones (CA1)**: `MAX_ITERACIONES` (25). Al alcanzarlo, el agente responde con lo que logró y lo que falta.
4. **Confirmación humana (CA3)**. La garantía vive en el backend, no en el prompt: `oc_crear` solo recibe `confirmado=true` si (a) el agente dejó una confirmación pendiente sobre ese mismo caso en un turno **anterior** y (b) el mensaje actual del usuario es afirmativo y sin negaciones. Si el modelo "se adelanta" o el usuario dice "no", el backend degrada `confirmado` a `false` y la herramienta responde que falta confirmación. Hay pruebas automáticas para estos escenarios.
5. **CA2**: las herramientas releen el caso desde las fixtures e ignoran el `paquete` o los `derivados` que mande el modelo; `oc_crear` además compara el payload enviado contra el recalculado. El modelo no puede alterar un monto.
6. **CA4**: cada llamada queda en el historial visible (el front la muestra desplegable) y en `out/log.jsonl`. **CA5**: los errores de herramienta o de OpenAI (401, 429, timeout de 60 s, red) se muestran en lenguaje claro y la sesión sigue viva.
7. **Costo**: tope de tokens por sesión (`MAX_TOKENS_SESION`) y global (`MAX_TOKENS_GLOBAL`), más `ACCESS_KEY` opcional para el enlace público.

## 4. Elección del modelo

- **OpenAI `gpt-5-mini`** (configurable con `OPENAI_MODEL`; alternativa `gpt-5.4-mini` si se necesita más precisión con herramientas). Razón: el trabajo del modelo es orquestar y redactar; las reglas son código determinista, así que un modelo pequeño con *function calling* basta y es barato. Precios de lista según la documentación de OpenAI: gpt-5-mini US$0,25 / US$2 por millón de tokens (entrada / salida); gpt-5.4-mini US$0,75 / US$4,5.
- **Costo estimado por caso**: un caso típico son unas 5–6 llamadas al modelo y del orden de 15–30 mil tokens de entrada acumulados, es decir, **centavos de dólar por caso** con gpt-5-mini. Es una estimación: el consumo real queda en `tokens` de `GET /api/sessions/:id` y debe medirse con la clave real antes de proyectar.
- La petición no envía temperatura ni `max_tokens`, para ser compatible con modelos de razonamiento.

## 5. Matriz de controles

| Código | Implementación (`src/rules.ts`) | Efecto |
|---|---|---|
| RC1 | Proveedor por NIT normalizado (sin puntos ni dígito de verificación); si no hay NIT, por nombre normalizado (sin tildes ni sufijos legales); debe estar activo | Bloquea |
| RC2 | Hay aprobación, contiene "Aprobado" (con guardas de negación) y el remitente es aprobador del centro | Bloquea |
| RC3 | `valor_total` ≤ tope del aprobador; la acción sugerida lista quién sí cubre el monto | Bloquea |
| RC4 | El centro existe y la subárea le pertenece (sin distinguir tildes ni mayúsculas) | Bloquea |
| RC5 | Cotización ausente o ilegible, de otra moneda o con diferencia > 2 % | Confirmación (muestra ambos valores) |
| RC6 | Indicador de IVA ausente → default del proveedor; presente pero inexistente en el maestro | Confirmación / Bloquea |
| RC7 | Condiciones de pago ausentes → default del proveedor; inexistentes en el maestro | Informa (derivado) / Bloquea |
| RC8 | Fecha de factura < fecha de solicitud → `retroactiva = true` | Confirmación + marca en `control.csv` |
| RC9 | Fecha de aprobación < fecha de solicitud | Confirmación |
| RC10 | cantidad × valor unitario ≠ valor total (±1) o montos no positivos | Bloquea |

**La más difícil**: RC5 y RC8, porque dependen de texto libre (cotización y factura) con montos en formato colombiano (`11.400.000`), NIT con puntos y dígito de verificación, y referencias con formatos distintos (`COT-TS-2026-0451` frente a `PC-5520`). Se resolvió con parsers tolerantes y, si la factura existe pero no se entiende, **falla en vez de ignorarla**, porque ignorarla ocultaría una OC retroactiva. Que RC6 y RC7 inválidos bloqueen es una adición mía a los controles del PRD.

## 6. Diseño del adaptador SAP real

- **Opción elegida**: OData `API_PURCHASEORDER_PROCESS_SRV` (S/4HANA) expuesta a través de **SAP Integration Suite / API Management**. Razón: contrato estable y versionado, autenticación gestionada, auditoría y *deep insert* (cabecera + posiciones) atómico en una sola llamada. Si la instalación fuera ECC, la alternativa es `BAPI_PO_CREATE1` por RFC o Cloud Connector, con `BAPI_TRANSACTION_COMMIT` explícito. La viabilidad no está confirmada: se valida con el equipo SAP antes de comprometer fechas.
- **Mapeo del payload (7.4)**: `sociedad` → `CompanyCode`; `organizacion_compras` → `PurchasingOrganization`; `proveedor.codigo_sap` → `Supplier`; `moneda` → `DocumentCurrency`; `condiciones_pago` → `PaymentTerms`; cada posición → `to_PurchaseOrderItem` (`descripcion` → `PurchaseOrderItemText`, `cantidad` → `OrderQuantity`, `unidad` → `PurchaseOrderQuantityUnit`, `precio_unitario` → `NetPriceAmount`, `indicador_iva` → `TaxCode`) y `centro_costo` en `to_AccountAssignment.CostCenter`. **Pendientes de definir con SAP**: grupo de compras (obligatorio en SAP y ausente en el payload), tipo de documento, cuenta de mayor y el uso de la `subarea`.
- **Autenticación**: OAuth2 *client credentials* (o usuario técnico con el rol mínimo para crear OC) contra Integration Suite. Las credenciales viven en un gestor de secretos del entorno; nunca en el agente, el prompt ni el repositorio. El modelo jamás ve ni maneja credenciales: solo el adaptador.
- **Idempotencia**: el `solicitud_id` viaja como referencia externa de la OC (un campo de referencia del encabezado, por ejemplo `CorrespncExternalReference`, a confirmar con SAP). Antes de crear se busca por esa referencia (`buscarOrdenPorReferencia`), igual que hace el mock.
- **Error parcial o timeout**: el *deep insert* es atómico, así que o se crea todo o nada. Ante un timeout o un 5xx **no se reintenta a ciegas**: primero se consulta por referencia externa; si existe, se devuelve esa OC; si no, se reintenta con *backoff*. Un error de negocio de SAP (4xx) se devuelve tal cual al chat y se registra como `error` en `control.csv`. Con BAPI, un `RETURN` de tipo E o A obliga a hacer `ROLLBACK`.
- **Plan B**: si no hay conexión viable, el agente igual ahorra el trabajo de validación: genera la OC lista para pegar (ME21N) o un archivo de carga masiva (CSV/LSMW) con el payload validado, la evidencia y la lista de excepciones aprobadas.

## 7. Lectura del proceso: OC retroactivas

En `sol-005` la OC se pide **después** de que llegó la factura (factura del 10 de agosto, solicitud del 27) y la propia aprobación lo dice: "Ya llegó la factura, por favor crear la OC para poder radicarla".

Para la dirección: la OC está funcionando como un trámite de radicación y no como un control previo. Si el compromiso ya ocurrió, nadie validó precio, proveedor ni presupuesto antes de comprometer; quien aprueba firma un hecho cumplido; y se pierde el cruce natural pedido–recepción–factura. Un solo caso no mide la dimensión del problema, por eso el agente registra `retroactiva` en cada intento y `control.csv` permite medir el porcentaje y el rezago en días por área y proveedor.

**Cambio de proceso propuesto**:
1. Medir antes de castigar: reportar mensualmente la tasa de OC retroactivas.
2. Política "sin OC no hay pago", con una vía de excepción explícita (motivo, aprobador de nivel superior y registro) en lugar de tolerar la práctica en silencio.
3. Para compras recurrentes como esta (papelería trimestral), acuerdos marco u OC abiertas, de modo que no exista la urgencia de regularizar.
4. Alertar a quien aprueba cuando la factura precede a la solicitud.

La decisión de tolerar con marca o rechazar le corresponde a la dirección; el agente la hace visible y medible.

## 8. Decisiones y trade-offs

1. **Confirmación humana forzada en el backend, no en el prompt.** Alternativa descartada: confiar en que el modelo obedezca la instrucción. Un prompt se puede ignorar o manipular; el backend no entrega `confirmado=true` sin una pregunta previa y una respuesta afirmativa. Costo: una heurística sencilla de afirmación y negación (por eso el front ofrece botones explícitos).
2. **Las herramientas son la fuente de verdad: releen el caso e ignoran el `paquete` del modelo.** Alternativa descartada: aceptar el paquete que devuelve el modelo (más fiel al contrato literal). Es el riesgo explícito del PRD ("el modelo arregla un monto") y recalcular lo elimina.
3. **Esquema mínimo visible para el modelo** (`caso`, `confirmado`) con validación completa en el backend. Alternativa descartada: exponer el `payload` entero para que el modelo lo reenvíe. Ahorra tokens, evita errores de transcripción y el backend lo verifica de todos modos.
4. **`node:http` sin framework** (frente a Express o Hono). Cuatro rutas no justifican una dependencia y corre igual en Bun y Node.
5. **Persistencia en archivos (`out/`) en vez de SQLite.** Lo pide el reto y simplifica la verificación; una cola en memoria serializa las escrituras. No escala a varios procesos (ver riesgos).
6. **Dependencias**: `zod` (obligatorio; validación y tipos) y `pdf-lib` (evidencia en PDF, sin binarios nativos). Todo lo demás son módulos de Node.

## 9. Supuestos

- `precio_unitario` del payload es el `valor_unitario` de la solicitud, que en las fixtures coincide con el precio **con IVA incluido** de la cotización; el indicador de IVA (C1) viaja aparte. Contablemente puede duplicar el IVA en SAP: la alternativa es enviar la base gravable. Debe aclararse con Contabilidad.
- Unidad de medida `UN` (la solicitud no la informa). La descripción se recorta a 40 caracteres (límite SAP) y queda anotada en la trazabilidad.
- Los topes de aprobación están en la moneda de la solicitud. Sociedad y organización de compras `1000`, según el PRD.
- RC1 usa el NIT de la solicitud; si falta, el de la cotización; si falta, el nombre.
- El formato de `cotizacion.txt` y `factura.txt` se infiere de las fixtures disponibles; el parser falla de forma explícita ante formatos que no entiende.
- El correo de aprobación es evidencia suficiente (se guarda con su `sha256`).

## 10. Cobertura

| Historia | Estado | Qué falta para producción |
|---|---|---|
| HU-1 Leer el paquete | Hecho | Lectura real de adjuntos (xlsx, pdf, eml) y OCR; hoy llegan normalizados |
| HU-2 Validar | Hecho (RC1–RC10) | Maestros en vivo desde SAP, no desde archivos |
| HU-3 Payload | Hecho, con trazabilidad por campo | Datos pendientes de SAP (grupo de compras, cuenta) |
| HU-4 Evidencia | Hecho (txt + PDF con sha256) | Firma digital si auditoría la exige |
| HU-5 Crear en SAP simulado | Hecho (idempotente, `control.csv`) | Adaptador real (sección 6) |
| HU-6 Errores | Hecho (JSON malformado, faltantes, errores del LLM) | Reintentos con *backoff* hacia SAP |
| Front de chat | Hecho (llamadas visibles, confirmación resaltada con botones) | Streaming de respuestas y autenticación real de usuarios |
| Bonus `modulo/` | Hecho (generado de las mismas fuentes; una prueba verifica que no diverge) | — |

## 11. Uso de IA

_(Ajusta esta sección con tu experiencia real: debes poder explicar cada línea que entregas.)_

- **Claude (Anthropic)**: asistente para diseñar la arquitectura, escribir el código TypeScript, las pruebas y este documento, e iterar sobre las fixtures reales. Yo ejecuté y revisé el resultado (demo, pruebas y Kaggle).
- **OpenAI (`gpt-5-mini`)**: modelo en tiempo de ejecución del agente.
- **Descartado de las propuestas**: aceptar el `paquete` del modelo como entrada de las herramientas (riesgo de alteración de montos) y delegar la confirmación humana al prompt.

## 12. Riesgos de producción y mitigación

| Riesgo | Mitigación |
|---|---|
| El modelo alucina o altera un valor | Valores solo desde herramientas; payload recalculado y comparado; pruebas de CA2 y CA3 |
| Confirmación ambigua del usuario | Botones explícitos en el front; heurística conservadora (ante la duda, no crea) |
| Gasto descontrolado de la clave | Topes por sesión, global y de iteraciones; `ACCESS_KEY`; rotación de la clave |
| Estado en archivos y sesiones en memoria | Base de datos y almacén de sesiones externo; por ahora, un solo proceso |
| Formatos de cotización o factura distintos | Lectura estructurada (XML de factura electrónica) y OCR validado; fallar en vez de ignorar |
| SAP no disponible o respuesta parcial | Idempotencia por referencia externa, consulta antes de reintentar, Plan B de archivo de carga |
| Maestros desactualizados | Consulta en vivo a SAP; caché con expiración corta |
| Prompt injection desde correos o adjuntos | Los textos de adjuntos son datos, no instrucciones; herramientas sin shell; confirmación humana para toda excepción |
