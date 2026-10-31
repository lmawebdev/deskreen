# Multi-viewer (3 dispositivos) — Deskreen CE

Branch: `feat/multi-viewer-3` · Delivery: `ask-on-risk` · Test runner: **none** (solo `npm run typecheck` / `npm run build`; excepción documentada en el Log).

## Specs

- **S1** — Hasta **3 viewers** pueden estar conectados simultáneamente a la misma sesión de compartición, compartiendo un único stream de captura. Un cuarto intento recibe `NOT_ALLOWED` y se desconecta.
- **S2** — El flujo actual de un viewer no cambia: QR → ingreso a la sala → aprobación del host → selección de fuente → confirmación → stream.
- **S3** — Cada viewer adicional (2 y 3) requiere aprobación explícita del host y, al aprobarse, recibe el mismo stream que los demás sin cortar a los ya conectados.
- **S4** — Desconectar un viewer no afecta a los demás. Cuando se desconecta el último, la sesión se cierra como hoy y la app vuelve a esperar conexión con una sala nueva.
- **S5** — El cambio es agnóstico de plataforma: macOS (permiso de Screen Recording existente) y Linux (X11 y Wayland portal existente) usan el mismo código. Verificación automatizada limitada a typecheck/build; prueba manual en ambos SO pendiente.

## Tasks

- **T1** — Capacidad de servidor + servicio de dispositivos + ruteo de aprobación/desconexión en main. (S1, S3, S4) — inline — **completado**
  - `MAX_VIEWERS = 3` en `src/common/maxViewers.ts`; el chequeo del servidor cuenta solo usuarios no-owner.
  - `ConnectedDevicesService` con `Map` de conectados y cola FIFO de pendientes; `disconnectDeviceByID` limpia ambos.
  - `SharingSession` con `firstViewerDeviceID` y `sendUserAllowedToConnect(deviceID)`.
  - `ipcMainHandlers`: aprobación por viewer, `DenyPendingConnectionDevice`, desconexión por dispositivo, cierre de sesión activa y recreación de la sala de espera.
  - Servidor: evento `DISCONNECT_SOCKET_BY_SOCKET_ID`, `ownerUsername` en `USER_ENTER` y reconexión del owner sin duplicar usuarios.
- **T2** — Host WebRTC: N peers sobre un stream compartido, señales por viewer, routing de mensajes, calidad compartida. (S1, S3, S4) — inline — **completado**
  - `PeerConnection` mantiene `partners: Map<username, HostPartnerConnection>`; un `SimplePeer` por viewer y un único `localStream`.
  - Las señales se envían dirigidas con `to`; `CALL_ACCEPTED` se rutea por `payload.username`.
  - Cambios de fuente/calidad reemplazan el track compartido en todos los peers; si un viewer fue aprobado antes de elegir fuente, el stream se agrega cuando existe.
  - `USER_EXIT` limpia solo los partners que salieron; el último dispara el cierre de la sesión.
- **T3** — Client-viewer: identificar al host por `isOwner`, DEVICE_DETAILS una sola vez, mensajes dirigidos con `to`. (S3) — inline — **completado**
  - `ownerUsername` (fallback `isOwner`) para elegir al host.
  - `hasSentDeviceDetails` evita reenviar detalles cuando entra otro viewer.
  - Filtro por `to` y por username del host en los mensajes recibidos.
- **T4** — UI: confirmación de viewers adicionales sin reiniciar el stepper, QR de la sala activa, desconexión por dispositivo. (S2, S3, S4) — inline — **completado**
  - `handleConfirmAlert` solo avanza desde el paso 0 para el primer viewer; los adicionales no reinician el stepper.
  - `handleCancelAlert` deniega el pendiente sin destruir la sesión para viewers adicionales.
  - El QR sigue apuntando a la sala activa (`GetWaitingForConnectionSharingSessionRoomId` con fallback).
  - El drawer desconecta un dispositivo con `DisconnectDeviceById`; el chip del paso 0 también desconecta solo ese dispositivo.
  - `SharingSessionClosed` devuelve el stepper al paso 0 cuando se cierra la última sesión activa.
- **T5** — Verificación (typecheck + build) y documentación (CHANGELOG). (S1-S5) — inline — **completado (manual multi-dispositivo pendiente)**

## Log

- **L1** — `vale, implementa  para 3 viewers`
- **L2** — No existe runner de tests en el repo (`package.json` sin script `test`). Agregar uno implicaría una dependencia nueva (riesgo de entorno) fuera del alcance pedido. Excepción: verificación con `npm run typecheck` y `npm run build`, más prueba manual multi-dispositivo pendiente.
- **L3** — El auto-lock de sala se elimina: el host aprobaba al primer viewer y bloqueaba la sala, impidiendo el ingreso de los siguientes. La aprobación explícita por viewer reemplaza al lock como control de acceso.
- **L4** — Arquitectura elegida: mesh P2P de `SimplePeer` en el host, un peer por viewer y un único `MediaStream` de captura compartido. No se crea un segundo proceso de captura por viewer.
- **L5** — El servidor difunde `MESSAGE` a toda la sala. Para que cada viewer procese solo lo suyo, los mensajes del host llevan `to` (username destino); el host rutea los mensajes entrantes por `payload.username`. El viewer también ignora mensajes cuyo emisor no es el host.
- **L6** — La aprobación del primer viewer no crea el peer de inmediato: el peer se crea al confirmar la fuente (`StartSharing...`). Los viewers adicionales se aprueban con `SetDeviceConnectedStatus` y reciben `callPeer` en ese momento, usando el stream ya capturado.
- **L7** — Cola FIFO de pendientes: solo se notifica a la UI el head de la cola. Al aprobar/denegar se notifica el siguiente. La aprobación del primer viewer conserva el dispositivo en la cola porque `StartSharing...` lo consume después.
- **L8** — Verificación ejecutada: `npm run typecheck` (client-viewer, node, web) y `npm run build` (client-viewer + electron-vite + bytecode) sin errores. El binario de Electron no estaba instalado por `ignore-scripts=true`; se instaló manualmente con `node node_modules/electron/install.js` para completar el build. Prueba manual con 3 dispositivos reales en macOS/Linux pendiente.
- **L9** — `simple-peer` indexa su sender map por el `MediaStream` original pasado a `addStream`, no por el stream actual. Por eso cada partner guarda `stream` (clave original) y `currentTrack` (track vigente); sin eso, el segundo cambio de calidad/fuente lanzaba `Cannot replace track that was never added` y congelaba el video.
