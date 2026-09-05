import Dexie, { type EntityTable } from 'dexie'

/**
 * Base local do spike E-00 (D-020).
 *
 * Não é o esquema do produto — o esquema real nasce em E-05. O que existe aqui
 * serve a três verificações e nada mais.
 */

/** Registro usado para provar que `bigint` sobrevive ao IndexedDB do iOS (D-022). */
export interface RegistroSonda {
  id: string
  rotulo: string
  /**
   * NÃO INDEXADO, e isso é obrigatório: `BigInt` não é chave válida em IndexedDB
   * (a especificação aceita número, string, data, binário e array). Guardar pode;
   * indexar não. Colocar este campo no `stores()` faria a gravação falhar.
   */
  valorCentavos: bigint
  criadoEm: string
}

/** Marcador de sobrevivência: escrito uma vez, conferido depois de reiniciar o aparelho (RT-13, EL-05). */
export interface Marcador {
  id: string
  escritoEm: string
}

/** Fila de saída — o esqueleto de D-003, sem regra de negócio nenhuma. */
export interface ItemFila {
  id: string
  tipo: string
  carga: string
  criadoEm: string
  /** 0 = pendente, 1 = enviado. Número porque IndexedDB não indexa booleano. */
  enviado: number
}

export const bancoLocal = new Dexie('spike-e00') as Dexie & {
  sondas: EntityTable<RegistroSonda, 'id'>
  marcadores: EntityTable<Marcador, 'id'>
  fila: EntityTable<ItemFila, 'id'>
}

bancoLocal.version(1).stores({
  sondas: 'id, criadoEm',
  marcadores: 'id',
  fila: 'id, enviado, criadoEm',
})
