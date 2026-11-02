> **Spanish edition (Tier-2 overview)** — machine-assisted translation, unified by the i18n PM. **The Chinese original governs.**
> Source baseline: 2026-10-15 · Glossary: [../GLOSSARY.md](../GLOSSARY.md) · Governance: [../README.md](../README.md)

# YuanBingKe (ybkk-AIOS) — gestión de recursos de IA para la empresa

**Posicionamiento:** una plataforma de gestión de recursos de IA para la empresa, construida sobre
la arquitectura dsh "Everything is a plugin" (todo es un plugin).

YuanBingKe (nombre de marca original en chino: 元冰可, código de producto ybkk-AIOS) es una plataforma
empresarial autoalojada (self-hosted) para la gestión centralizada de recursos de IA. Se apoya en la
arquitectura de dsh (DeepSeek Harness). Seis tipos de activos se administran bajo una única identidad
(IAM/OIDC SSO), un único sistema de permisos, una única medición de uso y una única auditoría.

## El problema y la solución

En muchas organizaciones la IA crece por islas: servicios MCP, skills, agentes y aplicaciones de IA
operan en silos, con cuentas dispersas, permisos difusos, costes de modelos opacos y sin una
trazabilidad de auditoría utilizable. Ni TI ni cumplimiento pueden responder con certeza quién usa
qué recurso de IA, cuánto cuesta internamente y qué riesgos arrastra.

YuanBingKe responde con un plano de control unificado: una identidad, un modelo de permisos, una medición
de uso transparente y una traza de auditoría continua para todos los activos de IA. Cada cambio sigue
etapas definidas de revisión y aprobación (borrador → validación → canary → despliegue general), y
cada acción queda registrada de forma verificable. Al ser autoalojada, la plataforma permanece dentro
del perímetro informático de la empresa.

## Seis tipos de activos, una base común

- **Servicios MCP** — despliegue versionado con canary, releases inmutables y pasarela de tokens con granularidad por herramienta.
- **Skills** — capacidades validadas del mercado de skills, publicadas por versión tras análisis estático y aprobación en dos niveles.
- **Agentes** — agentes registrados con credenciales de máquina, rol organizativo y niveles de autonomía definidos.
- **Aplicaciones de IA** — apps internas y externas con SSO, métricas (PV/UV/DAU) y visibilidad de costos.
- **Rutas de modelos** — acceso a modelos a través de la pasarela dedicada, con gobernanza de canales.
- **Almacenamiento NAS** — ficheros como clase de activo gestionada, con permisos de datos y descargas firmadas.

## Capacidades destacadas

- **IAM unificado**: árbol organizativo multinivel, roles y grupos de usuarios, matriz de permisos;
  proveedor OIDC (RS256/JWKS/PKCE) como SSO para las aplicaciones de IA conectadas, con compuerta de
  puesta en producción (go-live gate).
- **Despliegue MCP con controles**: flujo draft → validate → canary → full rollout, versiones
  inmutables, rollback en un clic, pasarela de tokens con grupos de permisos, granularidad por
  herramienta y restricción de solo lectura, circuit breaking y supervisión P95.
- **Mercado de skills con cadena de control**: envío → análisis estático (rechazo automático de
  código malicioso y filtraciones de secretos) → aprobación en dos niveles → publicación versionada;
  verificación de contratos mediante firma Ed25519.
- **Agentes con autonomía gobernada**: credenciales de máquina, cadena de tokens on-behalf-of,
  topología de orquestación visible de un vistazo; niveles de autonomía A0–A3 e invocaciones
  nombradas A2A entre agentes.
- **Orquestación de flujos de trabajo (flow-core)**: orquestación TF con máquina de estados por paso,
  biblioteca de plantillas y contextPack, seguimiento de SLA y avance, línea de tiempo Gantt.
- **Pasarela de acceso a modelos (modelgw)**: reenvío real compatible con OpenAI (nunca respuestas
  inventadas), gobernanza de canales con enrutado por niveles, cadenas de respaldo (fallback) y
  disyuntor de presupuesto (budget circuit breaker).
- **Medición transparente del uso + informe FinOps**: pipeline de medición idempotente, instantánea
  de precio cero, traslado interno de costos por departamento × modelo (cost pass-through), costo por
  DAU, exportación CSV en un clic (UTF-8 BOM, compatible con Excel).
- **Hub de ejecución y trabajadores digitales (dominio workforce)**: árboles de objetivos con
  alineación de metas, bucle de latido de 30 s, bloqueos de ejecución (CAS), programación de rutinas
  por intervalo/cron/webhook, permisos de trabajo temporales (permits) y bucle de entrega con
  aceptación humana, incluida la reactivación sujeta a aprobación L4.
- **NAS con permisos de datos**: conexión vía pasarela de ficheros MCP (sin acceso directo a las API
  privadas de DSM), RBAC basado en ubicación organizativa y jerarquía de roles con denegación por
  defecto, URL de descarga firmadas y seguimiento de propiedad de ficheros.
- **Plataforma como servidor MCP**: `POST /mcp` expone más de 40 herramientas de operación a
  cualquier cliente MCP (ZCode, Claude, Cursor, etc.), con token Bearer y puntos de permiso por
  herramienta.

## Modelo comercial

YuanBingKe se ofrece bajo el modelo **"equipo + activos de dominio"**: la fijación de precios depende del
número de equipos activados y de los paquetes de activos de dominio elegidos (paquetes sectoriales,
paquetes de escenarios), y no de una licencia global de plataforma. Para la industria manufacturera
está disponible una **entrega privada on-premises en formato de proyecto**.

La plataforma no incorpora deliberadamente ninguna semántica de facturación ni de liquidación: el
libro de precios funciona como instantánea de precio cero (campo `charge` siempre 0) y muestra
únicamente transparencia de uso y traslado interno de costos (cost pass-through). Monedero, recargas
y reparto de ingresos fueron retirados por completo del producto.

## Despliegue y operación

- **Autoalojado, pila ligera**: Node ≥ 22.6, TypeScript nativo sin paso de compilación; punto de
  acceso por defecto `http://127.0.0.1:7300`.
- **Dos formas de instalación**: como bundle de dsh
  (`dsh plugin --profile web add github:01men/ybkkasi`, 25 entradas de plugins, plano de datos bajo
  el prefijo `/rq`) o como proceso independiente con `npm install && npm start`.
- **Modo demostración para evaluación**: `DEMO_SEED=1 npm start` inyecta datos de demostración.
  Pensado solo para entornos de demostración — mantener desactivado en producción.
- **Autoactualización de la plataforma**: comprobación automática de versiones (por defecto cada
  24 h, desactivable con `DSH_UPDATE_AUTO_CHECK=off`), actualización desde la consola（控制台）con
  dry-run y auditoría; réplicas privadas vía `DSH_UPDATE_API_BASE` / `DSH_UPDATE_RAW_BASE`. Puntos
  de permiso: `platform.update.read`, `platform.update.apply`.
- **Operación y trazabilidad**: CLI `node cli/dshctl.mjs`, eventos de uso retenidos 730 días por
  defecto (`USAGE_RETENTION_DAYS`), cuatro clases de registros de auditoría, exportación CSV de
  informes de uso y FinOps.
- **Compuerta de calidad**: `npm run selftest` ejecuta pruebas de extremo a extremo en una instancia
  aislada (más de 1.380 verificaciones, según la última ejecución).

## Por qué encaja en España y América Latina

- **España: RGPD mediante autoalojamiento**: el self-hosting y la entrega privada on-premises son la
  vía de residencia de datos — la plataforma corre en la infraestructura propia, sin dependencia de
  nube impuesta; un proceso de DPA está en la hoja de ruta.
- **Vía de expansión hacia América Latina**: el árbol organizativo multinivel y el filtrado de listas
  por subárbol organizativo sostienen estructuras de holding y despliegues por país desde una única
  instancia; el modelo "equipo + activos de dominio" crece del primer equipo al despliegue regional.
- **Gobernanza verificable**: aprobaciones en dos niveles, anclas de evidencia de auditoría,
  aprobaciones obligatorias L4 y autorización por escenario con fail-closed respaldan los controles
  internos exigidos por auditorías y grupos corporativos.

> Nota de honestidad: estos puntos describen capacidades técnicas y opciones de entrega, no
> certificaciones — SOC 2 / ISO 27001 no se han obtenido y figuran en la hoja de ruta. Antes de
> entrar en cualquier mercado de España o América Latina se requiere una revisión de cumplimiento
> con asesoría legal local; este documento no constituye asesoramiento jurídico.

## Nota sobre el idioma de la interfaz

Desde la versión del 2026-10-16, la interfaz de ejecución (consola（控制台）, paneles, portal, salidas de
CLI, notificaciones, mensajes de error) incorpora un selector de idioma integrado: chino simplificado
(predeterminado), inglés (EE. UU.) y japonés. El cambio se realiza desde el selector de la barra
superior; la preferencia se guarda en el navegador (`rq_lang`). La CLI sigue `--lang` o
`DSHCTL_LANG`. Cualquier texto aún no cubierto por un diccionario regresa con elegancia al chino.
Los nombres originales en chino entre paréntesis que acompañan a los términos en español en estos
documentos siguen siendo útiles — por ejemplo, para capturas de pantalla, despliegues on-prem
fijados al chino y etiquetas próximas al protocolo; la traducción del navegador también sigue
funcionando.

## Para saber más

- [Edición completa en inglés — panorama del producto](../en/README.md)
- [Guía de inicio rápido (inglés)](../en/getting-started.md)
- [Introducción al producto (inglés)](../en/product-introduction.md)
- [Gobernanza i18n y niveles de idioma](../README.md)

---

*Esta página es un resumen Tier-2 con traducción asistida por máquina. Ante cualquier discrepancia prevalece el original chino; la edición completa en inglés sirve de referencia internacional.*
