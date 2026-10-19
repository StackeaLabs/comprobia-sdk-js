export declare const VERSION: string;
export declare const BASE: string;
export declare const TOLERANCIA: number;

/** Un JSON de la API. Los importes llegan como texto ("118.00"): déjalos así. */
export type Json = Record<string, any>;

export interface Pagina<T = Json> {
  data: T[];
  siguiente_cursor: string | null;
}

export interface FiltrosDeComprobantes {
  tipo_documento?: string;
  serie?: string;
  estado?: string;
  desde?: string;
  hasta?: string;
  external_id?: string;
  /** SERIE-CORRELATIVO, por ejemplo F001-123 */
  numero?: string;
  cliente_documento?: string;
  /** YYYY-MM-DD, YYYY-MM-DDTHH:MM:SS o con zona; sin zona, hora de Lima */
  actualizado_desde?: string;
  por_pagina?: number;
  cursor?: string;
}

export interface OpcionesDeComprobia {
  /** La clave de API: cmp_beta_… o cmp_produccion_… */
  clave: string;
  /** El RUC del emisor */
  ruc: string;
  base?: string;
  fetch?: typeof fetch;
  esperar?: (ms: number) => Promise<void>;
  /** En milisegundos; 60 000 por defecto */
  tiempoMaximo?: number;
}

export interface RespuestaCruda {
  estado: number;
  cabeceras: Headers;
  json(): Promise<any>;
  texto(): Promise<string>;
  bytes(): Promise<Uint8Array>;
}

export declare class ErrorDeComprobia extends Error {
  readonly estado: number;
  /** Estable: VALIDATION_ERROR, RATE_LIMITED, YA_ACEPTADO… Decide por esto, no por el mensaje. */
  readonly codigo: string;
  readonly requestId: string | null;
  readonly errores: Array<{ field?: string; rule?: string; message: string; sunat_code?: string }>;
}

export declare class ErrorDeConexion extends Error {
  /** Si pasó al emitir, reintenta con ESTA clave: no se emitirá otro. */
  readonly claveIdempotencia: string | null;
}

export declare class Comprobia {
  constructor(opciones: OpcionesDeComprobia);
  readonly ruc: string;
  readonly base: string;

  emitir(comprobante: Json, claveIdempotencia?: string): Promise<Json>;
  emitirLote(comprobantes: Json[], claveIdempotencia?: string): Promise<Json>;
  vistaPrevia(comprobante: Json): Promise<Uint8Array>;
  comprobante(id: string): Promise<Json>;
  comprobantes(filtros?: FiltrosDeComprobantes): Promise<Pagina>;
  recorrerComprobantes(filtros?: FiltrosDeComprobantes): AsyncGenerator<Json>;
  comprobantePorExternalId(externalId: string): Promise<Json | null>;
  anular(id: string, motivo: string, claveIdempotencia?: string): Promise<Json>;
  reenviar(id: string): Promise<Json>;
  pdf(id: string, formato?: 'a4' | 'a5' | 'ticket' | 'ticket58' | 'ticket50'): Promise<Uint8Array>;
  xml(id: string): Promise<string>;
  cdr(id: string): Promise<string>;

  emitirGuia(guia: Json, claveIdempotencia?: string): Promise<Json>;
  guia(id: string): Promise<Json>;
  buscarCliente(tipo: 'ruc' | 'dni', numero: string): Promise<Json>;
  consumo(periodo?: string): Promise<Json>;

  /** Cualquier otra ruta de la v1, relativa a /api/v1/{ruc} (p. ej. '/webhooks'). */
  json(metodo: string, ruta: string, cuerpo?: unknown, cabeceras?: Record<string, string>): Promise<any>;
  solicitar(metodo: string, ruta: string, cuerpo?: unknown, cabeceras?: Record<string, string>): Promise<RespuestaCruda>;
}

export interface ParametrosDeWebhook {
  /** whsec_…, el de tu webhook */
  secreto: string;
  /** El cuerpo CRUDO, sin decodificar */
  cuerpo: string | Uint8Array;
  /** La cabecera X-Comprobia-Signature */
  firma: string | null | undefined;
  /** La cabecera X-Comprobia-Timestamp */
  timestamp: string | number | null | undefined;
  tolerancia?: number;
  ahora?: number;
}

export interface AvisoWebhook {
  id: string;
  event: string;
  occurred_at: string;
  emisor: { ruc: string };
  data: Json;
}

export declare function verificarWebhook(parametros: ParametrosDeWebhook): boolean;
export declare function leerWebhook(parametros: ParametrosDeWebhook): AvisoWebhook;
