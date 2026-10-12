---
title: Agente Ordenes de Compra SAP
emoji: 🧾
colorFrom: green
colorTo: gray
sdk: docker
app_port: 7860
pinned: false
---

# 🧾 Agente de Órdenes de Compra · SAP simulado

Agente conversacional en TypeScript (Bun) que lee solicitudes de compra, valida los controles RC1–RC10, construye el payload de la OC y la crea en un SAP simulado, pidiendo confirmación humana cuando hay excepciones.

- Código y documentación: https://github.com/jogarzonpa-lang/agente-ordenes-compra-sap
- Informe técnico: https://jogarzonpa-lang.github.io/agente-ordenes-compra-sap/

**Secrets requeridos:** `OPENAI_API_KEY` (y opcional `ACCESS_KEY`).
