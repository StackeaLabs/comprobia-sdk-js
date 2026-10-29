import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Comprobia, ErrorDeComprobia, ErrorDeConexion, Partner } from '../src/index.js';

/** Un fetch de mentira: contesta lo que se le encola (null = corte de red) y anota. */
function fetchDePrueba(respuestas) {
  const peticiones = [];
  const f = async (url, init) => {
    peticiones.push({ url, ...init });
    const siguiente = respuestas.shift();
    if (siguiente === null) {
      throw new TypeError('fetch failed');
    }
    return siguiente;
  };
  f.peticiones = peticiones;
  return f;
}

const json = (estado, cuerpo, cabeceras = {}) =>
  new Response(JSON.stringify(cuerpo), { status: estado, headers: { 'content-type': 'application/json', ...cabeceras } });

function cliente(f, esperas = []) {
  return new Comprobia({
    clave: 'cmp_beta_x',
    ruc: '20123456789',
    base: 'https://comprobia.test/',
    fetch: f,
    esperar: async (ms) => { esperas.push(ms); },
  });
}

test('emitir manda la clave, la URL y una Idempotency-Key', async () => {
  const f = fetchDePrueba([json(202, { numero_completo: 'F001-1' })]);

  const r = await cliente(f).emitir({ tipo_documento: '01', serie: 'F001' });

  const p = f.peticiones[0];
  assert.equal(r.numero_completo, 'F001-1');
  assert.equal(p.method, 'POST');
  assert.equal(p.url, 'https://comprobia.test/api/v1/20123456789/comprobantes');
  assert.equal(p.headers.Authorization, 'Bearer cmp_beta_x');
  assert.match(p.headers['Idempotency-Key'], /^[0-9a-f-]{36}$/);
  assert.equal(p.body, '{"tipo_documento":"01","serie":"F001"}');
});

test('un corte de red y un 503 se reintentan con la misma Idempotency-Key', async () => {
  const esperas = [];
  const f = fetchDePrueba([null, json(503, { code: 'INTERNAL_ERROR', message: 'x' }), json(202, { id: 'a' })]);

  await cliente(f, esperas).emitir({ serie: 'F001' }, 'venta-123');

  assert.deepEqual(f.peticiones.map((p) => p.headers['Idempotency-Key']), ['venta-123', 'venta-123', 'venta-123']);
  assert.deepEqual(esperas, [1000, 2000]);
});

test('el 429 respeta Retry-After', async () => {
  const esperas = [];
  const f = fetchDePrueba([json(429, { code: 'RATE_LIMITED', message: 'x' }, { 'retry-after': '7' }), json(200, { data: [] })]);

  await cliente(f, esperas).comprobantes();

  assert.deepEqual(esperas, [7000]);
});

test('un 4xx no se reintenta y trae el código, el request_id y el detalle', async () => {
  const f = fetchDePrueba([json(422, {
    code: 'VALIDATION_ERROR',
    message: 'Hay errores.',
    request_id: 'req-1',
    errors: [{ field: 'items.0.cantidad', rule: 'RN-C1', message: 'Positiva.' }],
  })]);

  await assert.rejects(cliente(f).emitir({}), (e) => {
    assert.ok(e instanceof ErrorDeComprobia);
    assert.equal(e.estado, 422);
    assert.equal(e.codigo, 'VALIDATION_ERROR');
    assert.equal(e.requestId, 'req-1');
    assert.equal(e.errores[0].field, 'items.0.cantidad');
    return true;
  });
  assert.equal(f.peticiones.length, 1);
});

test('si la red no vuelve, el error dice qué clave reusar', async () => {
  const f = fetchDePrueba([null, null, null]);

  await assert.rejects(cliente(f).emitir({}, 'venta-9'), (e) => {
    assert.ok(e instanceof ErrorDeConexion);
    assert.equal(e.claveIdempotencia, 'venta-9');
    return true;
  });
  assert.equal(f.peticiones.length, 3);
});

test('recorrer sigue el cursor hasta el final', async () => {
  const f = fetchDePrueba([
    json(200, { data: [{ id: '1' }, { id: '2' }], siguiente_cursor: 'abc' }),
    json(200, { data: [{ id: '3' }], siguiente_cursor: null }),
  ]);

  const ids = [];
  for await (const c of cliente(f).recorrerComprobantes({ estado: 'ACEPTADO' })) {
    ids.push(c.id);
  }

  assert.deepEqual(ids, ['1', '2', '3']);
  assert.ok(f.peticiones[0].url.endsWith('/comprobantes?estado=ACEPTADO'));
  assert.ok(f.peticiones[1].url.endsWith('/comprobantes?estado=ACEPTADO&cursor=abc'));
});

test('por external_id, el PDF en bytes y la anulación', async () => {
  const f = fetchDePrueba([
    json(200, { data: [{ id: 'x', external_id: 'V-1' }], siguiente_cursor: null }),
    json(200, { data: [], siguiente_cursor: null }),
    new Response(new Uint8Array([37, 80, 68, 70]), { status: 200, headers: { 'content-type': 'application/pdf' } }),
    json(202, { tipo: 'COMUNICACION_BAJA' }),
  ]);
  const c = cliente(f);

  assert.equal((await c.comprobantePorExternalId('V-1')).id, 'x');
  assert.equal(await c.comprobantePorExternalId('V-2'), null);
  assert.deepEqual([...(await c.pdf('x', 'ticket'))], [37, 80, 68, 70]);
  await c.anular('x', 'ERROR EN EL RUC', 'anular-x');

  assert.ok(f.peticiones[2].url.endsWith('/comprobantes/x/pdf?formato=ticket'));
  assert.equal(f.peticiones[3].body, '{"motivo":"ERROR EN EL RUC"}');
  assert.equal(f.peticiones[3].headers['Idempotency-Key'], 'anular-x');
});

test('sin clave o sin RUC no se construye', () => {
  assert.throws(() => new Comprobia({ clave: '', ruc: '20123456789' }), TypeError);
});

test('nota de venta: emitir con clave, convertir sin ella', async () => {
  const f = fetchDePrueba([
    json(201, { id: 'n1', numero: 'NV01-1' }),
    json(202, { nota_venta: { estado: 'CONVERTIDA' }, comprobante: { numero_completo: 'B001-1' } }),
  ]);
  const c = cliente(f);

  const nota = await c.emitirNotaVenta({ items: [] });
  const r = await c.convertirNotaVenta(nota.id, { tipo_documento: '03', serie: 'B001' });

  assert.equal(r.comprobante.numero_completo, 'B001-1');
  assert.equal(f.peticiones[0].url, 'https://comprobia.test/api/v1/20123456789/notas-venta');
  assert.match(f.peticiones[0].headers['Idempotency-Key'], /^[0-9a-f-]{36}$/);
  assert.ok(f.peticiones[1].url.endsWith('/notas-venta/n1/convertir'));
  assert.equal(f.peticiones[1].headers['Idempotency-Key'], undefined);
});

test('un POST sin Idempotency-Key no se reintenta ante un corte ni un 5xx (DX-05)', async () => {
  const corte = fetchDePrueba([null, json(201, { id: 'w' })]);
  await assert.rejects(cliente(corte).json('POST', '/webhooks', { url: 'https://x.pe/h' }), ErrorDeConexion);
  assert.equal(corte.peticiones.length, 1);

  const caido = fetchDePrueba([json(503, { code: 'INTERNAL_ERROR', message: 'x' }), json(201, { id: 'w' })]);
  await assert.rejects(cliente(caido).json('POST', '/exportaciones'), ErrorDeComprobia);
  assert.equal(caido.peticiones.length, 1);
});

test('un POST sin Idempotency-Key sí se reintenta ante un 429: no se procesó', async () => {
  const f = fetchDePrueba([json(429, { code: 'RATE_LIMITED', message: 'x' }), json(201, { id: 'w' })]);

  const r = await cliente(f).json('POST', '/webhooks', { url: 'https://x.pe/h' });

  assert.equal(r.id, 'w');
  assert.equal(f.peticiones.length, 2);
});

test('buscarCliente manda el documento en el cuerpo y se reintenta (LEG-03)', async () => {
  const f = fetchDePrueba([null, json(200, { razon_social: 'ANA' })]);

  const r = await cliente(f).buscarCliente('dni', '45678912');

  assert.equal(r.razon_social, 'ANA');
  assert.equal(f.peticiones[1].url, 'https://comprobia.test/api/v1/20123456789/clientes/buscar');
  assert.equal(f.peticiones[1].body, '{"tipo":"dni","numero":"45678912"}');
});

test('peticion llega a rutas fuera de /api/v1/{ruc} (DX-04)', async () => {
  const f = fetchDePrueba([json(200, { codigo: '03' })]);

  await cliente(f).peticion('GET', '/api/v1/catalogos/03');

  assert.equal(f.peticiones[0].url, 'https://comprobia.test/api/v1/catalogos/03');
});

test('Partner lista su cartera y emite por un RUC con su misma clave (DX-04)', async () => {
  const f = fetchDePrueba([json(200, { data: [] }), json(202, { numero_completo: 'F001-1' })]);
  const partner = new Partner({ clave: 'cmpp_beta_y', base: 'https://comprobia.test', fetch: f, esperar: async () => {} });

  await partner.emisores();
  await partner.emisor('20100066603').emitir({ serie: 'F001' }, 'v-1');

  assert.equal(f.peticiones[0].url, 'https://comprobia.test/api/partner/v1/emisores');
  assert.equal(f.peticiones[1].url, 'https://comprobia.test/api/v1/20100066603/comprobantes');
  assert.equal(f.peticiones[1].headers.Authorization, 'Bearer cmpp_beta_y');
});
