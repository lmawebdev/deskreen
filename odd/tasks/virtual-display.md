# Pantalla extendida (monitor virtual por dispositivo) — Deskreen CE

Branch: `feat/virtual-display` (basada en `feat/multi-viewer-3`) · Delivery: `ask-on-risk` · Test runner: **none** (typecheck/build + prueba nativa manual).

## Specs

- **S1** — Se agrega una **tercera opción** de compartición, “Extender pantalla”, junto a “Toda la pantalla” y “Ventana de aplicación”. Los dos modos existentes no cambian.
- **S2** — En modo extendido, al conectar un viewer se crea un **display virtual de macOS** con la resolución del dispositivo, ubicado a la derecha del escritorio. El viewer recibe ese display como stream.
- **S3** — El mouse/teclado físico del host controla el display virtual: el cursor cruza al display, se pueden arrastrar ventanas y abrir apps ahí. El dispositivo es un monitor, no un control remoto; no se inyecta input remoto.
- **S4** — Cada viewer adicional obtiene su **propio** display virtual y su propio stream, acomodado a la derecha del anterior. No se comparte un único stream entre viewers en este modo.
- **S5** — Al desconectar un viewer se destruye su display virtual y se libera su stream; los demás siguen funcionando. Al salir el último, la sesión se cierra y la app vuelve a la sala de espera como hoy.
- **S6** — Esta primera implementación es **macOS only** y se degrada con un error claro en otros SO. Los modos existentes siguen funcionando en macOS/Linux.
- **S7** — El helper nativo se compila y empaqueta con la app; si falla, la app no crashea y muestra un error.
- **S8** — El flujo multi-viewer, la aprobación por viewer y los dos modos actuales se mantienen intactos.

## Tasks

- **T1** — Helper nativo macOS: crear `CGVirtualDisplay`, esperar que esté activo, acomodarlo a la derecha, imprimir JSON y quedar vivo hasta SIGTERM. (S2, S3, S5)
- **T2** — Build/empaquetado del helper (script + `extraResources`). (S7)
- **T3** — Servicio en main: spawn/kill por dispositivo, refrescar `desktopCapturer`, resolver `sourceID` por `display_id`. (S2, S4, S5)
- **T4** — Integración de sesión/helper: modo extendido, stream por partner, creación de display al aprobar cada viewer. (S2, S4)
- **T5** — UI: tercera tarjeta “Extender pantalla”, IPC de modo, traducciones. (S1)
- **T6** — Viewer en modo display: fullscreen, sin controles, cursor local oculto y overlay de cursor si la captura no lo incluye. (S3)
- **T7** — Verificación: helper nativo, `desktopCapturer` lista el display, typecheck/build, prueba manual con 1 y 2 dispositivos. (S1-S8)
- **T8** — Documentación/CHANGELOG. (S1-S8)

## Log

- **L1** — `pues adelante quiero que funcione lo que te pida... añade una tercera [opción]. Implementalo`
- **L2** — Se elige `CGVirtualDisplay` (API privada de CoreGraphics) para macOS. Referencia técnica: `go-macos/virtualdisplay` (BSD-3-Clause) documenta los selectores y el ciclo de vida; se reimplementa un helper propio en Objective-C, sin copiar código.
- **L3** — El control es del host: no hace falta inyección de input. El cursor cruza porque el OS mueve el puntero al monitor virtual; el dispositivo solo muestra el framebuffer.
- **L4** — El display se acomoda con `CGConfigureDisplayOrigin` (API pública de CGDisplayConfiguration) a la derecha del display más a la derecha. Cambiar la configuración “pinea” el display hasta que el proceso sale; por eso el helper vive mientras el viewer está conectado y se mata para removerlo.
- **L5** — Primera entrega acotada a macOS para validar la pieza de mayor riesgo. Linux X11/Wayland queda como fase posterior.
