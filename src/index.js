// Cliente fino de la API v1 de Comprobia (https://comprobia.stackealabs.com/docs).
//
//   import { Comprobia } from '@stackealabs/comprobia';
//   const comprobia = new Comprobia({ clave: process.env.COMPROBIA_CLAVE, ruc: '20123456789' });
//   const r = await comprobia.emitir({ ... });   // 202: número, XML firmado, consulta_publica
//
// Lo que hace por ti:
// - Idempotencia: cada emisión y anulación lleva una Idempotency-Key. Si no
//   pasas una, la genera; si la red se corta, reintenta con LA MISMA, así que
//   un comprobante nunca sale dos veces.
// - Reintentos: hasta 3 intentos ante un corte de red, un 5xx o un 429 (con su
//   Retry-After), pero SÓLO donde repetir no puede duplicar nada: lecturas
//   (GET) y peticiones con Idempotency-Key. Un POST sin clave (crear un
//   webhook, rotar su secreto, pedir una exportación) no se reintenta ante un
//   corte o un 5xx: el servidor pudo haberlo hecho. El 429 sí, siempre: no se
//   procesó. Un 4xx que no es 429 no se reintenta: hay que corregir.
// - Errores: lo que no es 2xx lanza ErrorDeComprobia con el `code` estable,
//   el `request_id` y el detalle por campo.
//
// Todo devuelve el JSON de la API tal cual: los importes son TEXTO ("118.00")
// y conviene dejarlos así (un Number pierde céntimos).

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export const VERSION = '0.2.0';
export const BASE = 'https://comprobia.stackealabs.com';
const INTENTOS = 3;

export class ErrorDeComprobia extends Error {
  /**
   * @param {number} estado
   * @param {string} codigo
   * @param {string} mensaje
   * @param {string|null} requestId
   * @param {Array<Record<string, unknown>>} errores
   */
  constructor(estado, codigo, mensaje, requestId = null, errores = []) {
    super(mensaje);
    this.name = 'ErrorDeComprobia';
    this.estado = estado;
    this.codigo = codigo;
    this.requestId = requestId;
    this.errores = errores;
  }
}

export class ErrorDeConexion extends Error {
  /** @param {string} mensaje @param {string|null} claveIdempotencia */
  constructor(mensaje, claveIdempotencia = null) {
    super(mensaje);
    this.name = 'ErrorDeConexion';
    // Si pasó al emitir, reintenta con ESTA clave: no se emitirá otro.
    this.claveIdempotencia = claveIdempotencia;
  }
}

export class Comprobia {
  /**
   * @param {{ clave: string, ruc: string, base?: string, fetch?: typeof fetch, esperar?: (ms: number) => Promise<void>, tiempoMaximo?: number }} opciones
   */
  constructor({ clave, ruc, base = BASE, fetch: f = globalThis.fetch, esperar, tiempoMaximo = 60_000 }) {
    if (!clave || !ruc) {
      throw new TypeError('Comprobia necesita la clave de API y el RUC del emisor.');
    }
    this.#clave = clave;
    this.ruc = ruc;
    this.base = base.replace(/\/+$/, '');
    this.#fetch = f;
    this.#esperar = esperar ?? esperaReal;
    this.#tiempoMaximo = tiempoMaximo;
  }

  #clave;
  #fetch;
  #esperar;
  #tiempoMaximo;

  // ── Comprobantes ────────────────────────────────────────────────────────

  /** POST /comprobantes → 202. Factura, boleta o nota. */
  emitir(comprobante, claveIdempotencia) {
    return this.#conIdempotencia('POST', '/comprobantes', comprobante, claveIdempotencia);
  }

  /** POST /comprobantes/lote → hasta 50, con idempotencia por comprobante. */
  emitirLote(comprobantes, claveIdempotencia) {
    return this.#conIdempotencia('POST', '/comprobantes/lote', { comprobantes }, claveIdempotencia);
  }

  /** El PDF tal como saldría, sin gastar número. No cambia nada: se reintenta. */
  async vistaPrevia(comprobante) {
    return (await this.solicitar('POST', '/comprobantes/vista-previa', comprobante, {}, { reintentable: true })).bytes();
  }

  comprobante(id) {
    return this.json('GET', `/comprobantes/${encodeURIComponent(id)}`);
  }

  /**
   * Una página. Filtros: tipo_documento, serie, estado, desde, hasta,
   * external_id, numero (F001-123), cliente_documento, actualizado_desde,
   * por_pagina, cursor.
   */
  comprobantes(filtros = {}) {
    return this.json('GET', `/comprobantes${query(filtros)}`);
  }

  /** Todos los comprobantes que cumplen los filtros, página a página. */
  recorrerComprobantes(filtros = {}) {
    return this.#recorrer('/comprobantes', filtros);
  }

  /** El comprobante cuyo external_id es el tuyo, o null. */
  async comprobantePorExternalId(externalId) {
    const pagina = await this.comprobantes({ external_id: externalId });
    return pagina.data?.[0] ?? null;
  }

  /** Factura por baja, boleta por resumen: lo decide Comprobia. Vale cuando SUNAT acepta. */
  anular(id, motivo, claveIdempotencia) {
    return this.#conIdempotencia('POST', `/comprobantes/${encodeURIComponent(id)}/anular`, { motivo }, claveIdempotencia);
  }

  /** Reenviar los mismos bytes: repetirlo no hace otro comprobante, así que se reintenta. */
  reenviar(id) {
    return this.json('POST', `/comprobantes/${encodeURIComponent(id)}/reenviar`, undefined, {}, { reintentable: true });
  }

  /** @param {'a4'|'a5'|'ticket'|'ticket58'|'ticket50'} formato @returns {Promise<Uint8Array>} */
  async pdf(id, formato = 'a4') {
    return (await this.solicitar('GET', `/comprobantes/${encodeURIComponent(id)}/pdf?formato=${formato}`)).bytes();
  }

  async xml(id) {
    return (await this.solicitar('GET', `/comprobantes/${encodeURIComponent(id)}/xml`)).texto();
  }

  async cdr(id) {
    return (await this.solicitar('GET', `/comprobantes/${encodeURIComponent(id)}/cdr`)).texto();
  }

  // ── Notas de venta (sin valor fiscal) ───────────────────────────────────

  /** 201 con la nota ya terminada: no va a SUNAT. */
  emitirNotaVenta(nota, claveIdempotencia) {
    return this.#conIdempotencia('POST', '/notas-venta', nota, claveIdempotencia);
  }

  notaVenta(id) {
    return this.json('GET', `/notas-venta/${encodeURIComponent(id)}`);
  }

  notasVenta(filtros = {}) {
    return this.json('GET', `/notas-venta${query(filtros)}`);
  }

  /**
   * La boleta o factura que la sustituye. Sin Idempotency-Key: la fija la nota,
   * así que reintentar devuelve el mismo comprobante.
   *
   * @param {{tipo_documento: '01'|'03', serie: string, fecha_emision?: string, cliente?: object}} datos
   */
  convertirNotaVenta(id, datos) {
    return this.json('POST', `/notas-venta/${encodeURIComponent(id)}/convertir`, datos, {}, { reintentable: true });
  }

  anularNotaVenta(id, motivo) {
    return this.json('POST', `/notas-venta/${encodeURIComponent(id)}/anular`, { motivo });
  }

  /** @param {'a4'|'ticket'} formato @returns {Promise<Uint8Array>} */
  async pdfNotaVenta(id, formato = 'a4') {
    return (await this.solicitar('GET', `/notas-venta/${encodeURIComponent(id)}/pdf?formato=${formato}`)).bytes();
  }

  // ── Guías, clientes, consumo ────────────────────────────────────────────

  emitirGuia(guia, claveIdempotencia) {
    return this.#conIdempotencia('POST', '/guias', guia, claveIdempotencia);
  }

  guia(id) {
    return this.json('GET', `/guias/${encodeURIComponent(id)}`);
  }

  /**
   * El documento va en el cuerpo, no en la URL: un DNI no queda en ningún
   * registro de acceso. Es una lectura, así que se reintenta.
   *
   * @param {'ruc'|'dni'} tipo
   */
  buscarCliente(tipo, numero) {
    return this.json('POST', '/clientes/buscar', { tipo, numero: String(numero) }, {}, { reintentable: true });
  }

  consumo(periodo) {
    return this.json('GET', `/consumo${query(periodo ? { periodo } : {})}`);
  }

  // ── Lo demás ────────────────────────────────────────────────────────────

  /** Cualquier otra ruta de la v1, relativa a /api/v1/{ruc} (p. ej. '/webhooks'). */
  async json(metodo, ruta, cuerpo, cabeceras = {}, opciones = {}) {
    return (await this.solicitar(metodo, ruta, cuerpo, cabeceras, opciones)).json();
  }

  /**
   * Relativa a /api/v1/{ruc}.
   *
   * @param {{ reintentable?: boolean }} [opciones] `reintentable: true` en un POST que no cambia nada (una búsqueda).
   * @returns {Promise<{ estado: number, cabeceras: Headers, json: () => Promise<any>, texto: () => Promise<string>, bytes: () => Promise<Uint8Array> }>}
   */
  solicitar(metodo, ruta, cuerpo, cabeceras = {}, opciones = {}) {
    return this.peticion(metodo, `/api/v1/${this.ruc}${ruta}`, cuerpo, cabeceras, opciones);
  }

  /**
   * Cualquier ruta del servicio, desde la raíz: '/api/v1/catalogos/03',
   * '/api/v1/health'. Devuelve lo mismo que `solicitar`.
   */
  peticion(metodo, rutaAbsoluta, cuerpo, cabeceras = {}, opciones = {}) {
    return pedir({
      fetch: this.#fetch,
      esperar: this.#esperar,
      tiempoMaximo: this.#tiempoMaximo,
      clave: this.#clave,
      url: `${this.base}${rutaAbsoluta}`,
      metodo,
      cuerpo,
      cabeceras,
      reintentable: opciones.reintentable === true,
    });
  }

  #conIdempotencia(metodo, ruta, cuerpo, clave) {
    return this.json(metodo, ruta, cuerpo, { 'Idempotency-Key': clave ?? randomUUID() });
  }

  async *#recorrer(ruta, filtros) {
    let cursor = null;

    do {
      const pagina = await this.json('GET', `${ruta}${query({ ...filtros, ...(cursor ? { cursor } : {}) })}`);
      for (const fila of pagina.data ?? []) {
        yield fila;
      }
      cursor = pagina.siguiente_cursor ?? null;
    } while (cursor);
  }
}

// ── Partners ──────────────────────────────────────────────────────────────

/**
 * La API de partners (/api/partner/v1), para quien opera los RUC de sus
 * clientes con una sola clave (`cmpp_…`). Para emitir por uno de ellos,
 * `partner.emisor(ruc)` devuelve un cliente `Comprobia` con la misma clave.
 */
export class Partner {
  /**
   * @param {{ clave: string, base?: string, fetch?: typeof fetch, esperar?: (ms: number) => Promise<void>, tiempoMaximo?: number }} opciones
   */
  constructor({ clave, base = BASE, fetch: f = globalThis.fetch, esperar, tiempoMaximo = 60_000 }) {
    if (!clave) {
      throw new TypeError('Partner necesita la clave de API del partner.');
    }
    this.#opciones = { clave, base: base.replace(/\/+$/, ''), fetch: f, esperar: esperar ?? esperaReal, tiempoMaximo };
  }

  #opciones;

  /** Un cliente de la v1 para un RUC de tu cartera. */
  emisor(ruc) {
    return new Comprobia({ ...this.#opciones, ruc });
  }

  emisores() {
    return this.json('GET', '/emisores');
  }

  consumo(periodo) {
    return this.json('GET', `/consumo${query(periodo ? { periodo } : {})}`);
  }

  /** Cualquier ruta de la API de partners, relativa a /api/partner/v1. */
  async json(metodo, ruta, cuerpo, cabeceras = {}, opciones = {}) {
    const o = this.#opciones;
    const r = await pedir({
      fetch: o.fetch,
      esperar: o.esperar,
      tiempoMaximo: o.tiempoMaximo,
      clave: o.clave,
      url: `${o.base}/api/partner/v1${ruta}`,
      metodo,
      cuerpo,
      cabeceras,
      reintentable: opciones.reintentable === true,
    });

    return r.json();
  }
}

// ── Webhooks ──────────────────────────────────────────────────────────────

export const TOLERANCIA = 300;

/**
 * La firma es `sha256=` + HMAC-SHA256 de `{timestamp}.{cuerpo}`. Tras rotar el
 * secreto llegan DOS, separadas por coma, durante 24 h: vale con una. Un
 * timestamp de hace más de 5 minutos se rechaza.
 *
 * @param {{ secreto: string, cuerpo: string | Uint8Array, firma: string | null | undefined, timestamp: string | number | null | undefined, tolerancia?: number, ahora?: number }} p
 */
export function verificarWebhook({ secreto, cuerpo, firma, timestamp, tolerancia = TOLERANCIA, ahora }) {
  const ts = Number(timestamp);

  if (!firma || !Number.isInteger(ts)) {
    return false;
  }

  const segundos = ahora ?? Math.floor(Date.now() / 1000);

  if (Math.abs(segundos - ts) > tolerancia) {
    return false;
  }

  const crudo = typeof cuerpo === 'string' ? cuerpo : Buffer.from(cuerpo).toString('utf8');
  const esperada = Buffer.from('sha256=' + createHmac('sha256', secreto).update(`${ts}.${crudo}`).digest('hex'));

  return String(firma).split(',').some((f) => {
    const b = Buffer.from(f.trim());
    return b.length === esperada.length && timingSafeEqual(b, esperada);
  });
}

/**
 * Verifica y devuelve el aviso: { id, event, occurred_at, emisor: { ruc }, data }.
 * Lanza si la firma no vale. Descarta los repetidos por `id`.
 */
export function leerWebhook(parametros) {
  if (!verificarWebhook(parametros)) {
    throw new Error('La firma del webhook no es válida o el aviso es demasiado viejo.');
  }

  const crudo = typeof parametros.cuerpo === 'string' ? parametros.cuerpo : Buffer.from(parametros.cuerpo).toString('utf8');

  return JSON.parse(crudo);
}

// ── Internos ──────────────────────────────────────────────────────────────

/** El bucle de una petición con sus reintentos, común a los dos clientes. */
async function pedir({ fetch: f, esperar, tiempoMaximo, clave, url, metodo, cuerpo, cabeceras, reintentable }) {
  const todas = {
    Authorization: `Bearer ${clave}`,
    Accept: 'application/json',
    'User-Agent': `comprobia-js/${VERSION}`,
    ...(cuerpo === undefined ? {} : { 'Content-Type': 'application/json' }),
    ...cabeceras,
  };
  const body = cuerpo === undefined ? undefined : JSON.stringify(cuerpo);
  // Repetir sólo donde no puede duplicar nada.
  const seguro = reintentable || metodo === 'GET' || metodo === 'HEAD' || todas['Idempotency-Key'] !== undefined;

  for (let intento = 1; ; intento++) {
    let respuesta;

    try {
      respuesta = await f(url, {
        method: metodo,
        headers: todas,
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(tiempoMaximo),
      });
    } catch {
      // Sin el mensaje original: puede repetir la URL.
      if (!seguro || intento >= INTENTOS) {
        throw new ErrorDeConexion('No hubo respuesta de Comprobia.', todas['Idempotency-Key'] ?? null);
      }
      await esperar(espera(intento, null));
      continue;
    }

    if (respuesta.status < 400) {
      return envolver(respuesta);
    }

    // El 429 no se procesó: se reintenta siempre. Un 5xx, sólo si es seguro.
    const repetir = respuesta.status === 429 || (respuesta.status >= 500 && seguro);

    if (!repetir || intento >= INTENTOS) {
      throw await errorDesde(respuesta);
    }

    await esperar(espera(intento, respuesta.headers.get('retry-after')));
  }
}

function esperaReal(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function query(filtros) {
  const pares = Object.entries(filtros).filter(([, v]) => v !== undefined && v !== null && v !== '');
  return pares.length === 0 ? '' : '?' + new URLSearchParams(pares.map(([k, v]) => [k, String(v)])).toString();
}

/** 1 s, 2 s… o lo que diga Retry-After, con un techo de 10 s. En milisegundos. */
function espera(intento, retryAfter) {
  if (retryAfter !== null && retryAfter !== undefined && !Number.isNaN(Number(retryAfter))) {
    return Math.min(Number(retryAfter), 10) * 1000;
  }
  return 2 ** (intento - 1) * 1000;
}

function envolver(respuesta) {
  return {
    estado: respuesta.status,
    cabeceras: respuesta.headers,
    json: async () => {
      const texto = await respuesta.text();
      return texto === '' ? {} : JSON.parse(texto);
    },
    texto: () => respuesta.text(),
    bytes: async () => new Uint8Array(await respuesta.arrayBuffer()),
  };
}

async function errorDesde(respuesta) {
  let datos = {};
  try {
    datos = JSON.parse(await respuesta.text());
  } catch {
    // Un error que no es JSON: se queda con el código HTTP.
  }

  return new ErrorDeComprobia(
    respuesta.status,
    typeof datos.code === 'string' ? datos.code : `HTTP_${respuesta.status}`,
    typeof datos.message === 'string' ? datos.message : `La API respondió ${respuesta.status}.`,
    typeof datos.request_id === 'string' ? datos.request_id : respuesta.headers.get('x-request-id'),
    Array.isArray(datos.errors) ? datos.errors : [],
  );
}
