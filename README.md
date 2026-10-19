# Comprobia para JavaScript

Cliente fino de la API v1 de [Comprobia](https://comprobia.stackealabs.com): facturación electrónica SUNAT por API. Sin dependencias. Node 18 o más (usa `fetch` y `node:crypto`). Trae sus tipos de TypeScript.

La referencia completa de la API está en <https://comprobia.stackealabs.com/docs>.

> **Sólo en el servidor.** La clave de API emite comprobantes con valor fiscal: no la pongas en un navegador ni en una app móvil.

## Instalar

Mientras se publica en npm, desde el repositorio:

```bash
npm install <url-del-repositorio>
```

## Emitir

```js
import { Comprobia, ErrorDeComprobia } from '@stackealabs/comprobia';

const comprobia = new Comprobia({ clave: process.env.COMPROBIA_CLAVE, ruc: '20123456789' });

try {
  const r = await comprobia.emitir({
    tipo_documento: '03',
    serie: 'B001',
    fecha_emision: '2026-10-18',
    moneda: 'PEN',
    cliente: { tipo_documento: '1', numero_documento: '45678912', razon_social: 'MARIA QUISPE' },
    external_id: 'VENTA-1842',
    items: [{
      descripcion: 'Consulta podológica',
      cantidad: '1',
      unidad_medida: 'ZZ',
      precio_unitario: '80.00',
      tipo_afectacion: '10',
    }],
  }, 'VENTA-1842');

  console.log(r.numero_completo);   // B001-1
  console.log(r.consulta_publica);  // el enlace para tu cliente
} catch (e) {
  if (e instanceof ErrorDeComprobia) {
    // e.codigo (estable), e.message, e.errores (por campo), e.requestId
  }
  throw e;
}
```

La fecha de emisión es la de **Lima**, no la UTC de tu servidor: desde las 19:00 de Lima, `new Date().toISOString()` ya da la fecha de mañana, y Comprobia la rechaza.

`emitir` responde con el `202` de la API: el comprobante ya tiene número y XML firmado, y el envío a SUNAT va en cola. El veredicto llega por webhook o consultando `comprobante(id)`.

## Lo que hace por ti

- **Idempotencia.** Cada emisión y anulación lleva una `Idempotency-Key`. Si no pasas una, la genera. Si la red se corta, reintenta con la misma, así que el comprobante no sale dos veces. Para reintentar tú más tarde, usa una tuya, por ejemplo el id de la venta. Si se agotan los intentos, `ErrorDeConexion.claveIdempotencia` dice cuál reusar.
- **Reintentos.** Hasta 3 intentos ante un corte de red, un 5xx o un 429 (respetando `Retry-After`).
- **Importes como texto.** Todo vuelve como el JSON de la API, con los importes en texto (`"118.00"`). Déjalos así: un `Number` pierde céntimos.

## Lo demás

```js
await comprobia.comprobante(id);
await comprobia.comprobantes({ estado: 'ACEPTADO', desde: '2026-10-01' });   // una página
for await (const c of comprobia.recorrerComprobantes({ actualizado_desde: '2026-10-18T00:00:00-05:00' })) { /* … */ }
await comprobia.comprobantePorExternalId('VENTA-1842');
await comprobia.anular(id, 'ERROR EN EL MONTO');
await comprobia.pdf(id, 'ticket');   // Uint8Array: a4, a5, ticket, ticket58, ticket50
await comprobia.xml(id);
await comprobia.emitirLote([/* hasta 50 */]);
await comprobia.emitirGuia({ /* … */ });
await comprobia.buscarCliente('ruc', '20100066603');
await comprobia.consumo('2026-10');

// Nota de venta: sin valor fiscal, no va a SUNAT. Luego, la boleta o factura que la sustituye.
const nota = await comprobia.emitirNotaVenta({ items: [{ descripcion: 'Consulta', cantidad: '1', precio_unitario: '80.00' }] });
await comprobia.convertirNotaVenta(nota.id, { tipo_documento: '03', serie: 'B001' });

// Cualquier otra ruta de la v1:
await comprobia.json('GET', '/webhooks');
```

## Webhooks

Con Express, lee el cuerpo **crudo**: la firma se calcula sobre los bytes que llegaron, no sobre el JSON reconstruido.

```js
import express from 'express';
import { leerWebhook } from '@stackealabs/comprobia';

app.post('/webhooks/comprobia', express.raw({ type: 'application/json' }), (req, res) => {
  let aviso;
  try {
    aviso = leerWebhook({
      secreto: process.env.COMPROBIA_WEBHOOK_SECRETO,
      cuerpo: req.body,
      firma: req.get('X-Comprobia-Signature'),
      timestamp: req.get('X-Comprobia-Timestamp'),
    });
  } catch {
    return res.sendStatus(401);
  }

  // aviso.id (descarta repetidos), aviso.event, aviso.emisor.ruc, aviso.data
  res.sendStatus(200);
});
```

Tras rotar el secreto, durante 24 h llegan dos firmas y vale cualquiera de las dos. Un aviso con más de 5 minutos se rechaza.

## Tests

```bash
npm test
```
