import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { leerWebhook, verificarWebhook } from '../src/index.js';

const AHORA = 1_790_000_000;
const firma = (secreto, cuerpo, ts) => 'sha256=' + createHmac('sha256', secreto).update(`${ts}.${cuerpo}`).digest('hex');

test('una firma buena vale y otra no', () => {
  const cuerpo = '{"id":"e1","event":"comprobante.aceptado","emisor":{"ruc":"20123456789"},"data":{}}';
  const f = firma('whsec_a', cuerpo, AHORA);

  assert.equal(verificarWebhook({ secreto: 'whsec_a', cuerpo, firma: f, timestamp: AHORA, ahora: AHORA }), true);
  assert.equal(verificarWebhook({ secreto: 'whsec_otro', cuerpo, firma: f, timestamp: AHORA, ahora: AHORA }), false);
  assert.equal(verificarWebhook({ secreto: 'whsec_a', cuerpo: cuerpo + ' ', firma: f, timestamp: AHORA, ahora: AHORA }), false);
});

test('durante la rotación vale cualquiera de las dos firmas', () => {
  const cuerpo = '{"id":"e2"}';
  const cabecera = `${firma('whsec_nuevo', cuerpo, AHORA)},${firma('whsec_viejo', cuerpo, AHORA)}`;

  assert.equal(verificarWebhook({ secreto: 'whsec_nuevo', cuerpo, firma: cabecera, timestamp: AHORA, ahora: AHORA }), true);
  assert.equal(verificarWebhook({ secreto: 'whsec_viejo', cuerpo, firma: cabecera, timestamp: AHORA, ahora: AHORA }), true);
});

test('un aviso viejo, un timestamp raro o sin firma no valen', () => {
  const cuerpo = '{"id":"e3"}';
  const viejo = AHORA - 301;

  assert.equal(verificarWebhook({ secreto: 'whsec_a', cuerpo, firma: firma('whsec_a', cuerpo, viejo), timestamp: viejo, ahora: AHORA }), false);
  assert.equal(verificarWebhook({ secreto: 'whsec_a', cuerpo, firma: firma('whsec_a', cuerpo, AHORA), timestamp: 'x', ahora: AHORA }), false);
  assert.equal(verificarWebhook({ secreto: 'whsec_a', cuerpo, firma: undefined, timestamp: AHORA, ahora: AHORA }), false);
});

test('leer devuelve el aviso, acepta bytes, o lanza', () => {
  const cuerpo = '{"id":"e4","event":"ping","emisor":{"ruc":"20123456789"},"data":{"mensaje":"hola"}}';
  const f = firma('whsec_a', cuerpo, AHORA);

  const aviso = leerWebhook({ secreto: 'whsec_a', cuerpo: new TextEncoder().encode(cuerpo), firma: f, timestamp: String(AHORA), ahora: AHORA });

  assert.equal(aviso.event, 'ping');
  assert.equal(aviso.emisor.ruc, '20123456789');
  assert.throws(() => leerWebhook({ secreto: 'whsec_otro', cuerpo, firma: f, timestamp: AHORA, ahora: AHORA }));
});
