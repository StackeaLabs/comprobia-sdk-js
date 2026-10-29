# Changelog

## 0.2.0 — 2026-10-28

- **Notas de venta**: emitir, consultar, convertir, anular y su PDF.
- **Reintentos sólo donde no duplican nada**: un `POST` sin `Idempotency-Key`
  ya no se reintenta ante un corte de red o un 5xx (podía crear dos webhooks,
  dos exportaciones o rotar el secreto dos veces). El 429 se sigue
  reintentando siempre.
- **`buscarCliente` manda el documento en el cuerpo** (`POST /clientes/buscar`):
  un DNI ya no queda en la URL.
- **`peticion(metodo, rutaAbsoluta)`** para las rutas fuera de `/api/v1/{ruc}`
  (catálogos, health), y **`Partner`** para la API de partners.

## 0.1.0 — 2026-10-18

- Primera versión: comprobantes, PDF/XML/CDR, guías, clientes, consumo y
  verificación de webhooks.
