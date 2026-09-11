/**
 * Geração de UUIDv7 no dispositivo (D-029, RI-04, RN-14).
 *
 * O id nasce no aparelho, antes de qualquer rede — é o que torna possível criar uma venda
 * offline já referenciando suas parcelas, e é a **chave de idempotência** da sincronização
 * (RI-05, EL-04): enviar duas vezes o mesmo registro é um `upsert` sobre a mesma linha.
 * A escolha do v7 sobre o v4 é deliberada: os primeiros 48 bits são o instante de criação
 * em milissegundos, então a ordem lexicográfica dos ids é a ordem cronológica — o histórico
 * da ficha ordena sem depender de relógio bem ajustado, e o índice no Postgres fica local.
 *
 * Escrito aqui, e não numa biblioteca, porque `Bun.randomUUIDv7()` é do runtime do servidor
 * e este código roda no Safari do iPhone; `crypto.getRandomValues` existe nos dois.
 *
 * **Limitação registrada (E-00, `ARCHITECTURE.md`):** ordena entre milissegundos, não dentro
 * do mesmo — não há contador monotônico. Suficiente para a ficha; é por isso que a fila de
 * sincronização usa autoincremento, e não este id, para a ordem de envio (D-040).
 */

/** O formato de um UUIDv7: nibble de versão `7`, variante `8`–`b`. Serve à validação e aos testes. */
export const FORMATO_UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** Maior instante que cabe nos 48 bits: ano 10889. Acima disso o id mentiria sobre a ordem. */
const LIMITE_DO_INSTANTE = 1n << 48n

/**
 * Um id novo. `instante` é o relógio do aparelho em milissegundos e só é parâmetro para o
 * teste de ordenação poder fixá-lo; em produção ninguém passa nada.
 */
export function uuidv7(instante: number = Date.now()): string {
  // `BigInt` recusa não inteiro, NaN e Infinity com RangeError — a validação vem de graça.
  const carimbo = BigInt(instante)
  if (carimbo < 0n || carimbo >= LIMITE_DO_INSTANTE) {
    throw new RangeError(`instante fora dos 48 bits do UUIDv7: ${instante}`)
  }

  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  const vista = new DataView(bytes.buffer)

  // 48 bits do instante, big-endian, nos bytes 0..5: 16 bits altos e 32 bits baixos.
  vista.setUint16(0, Number(carimbo >> 32n))
  vista.setUint32(2, Number(carimbo & 0xffff_ffffn))
  // Versão 7 no nibble alto do byte 6; variante RFC 9562 (`10xx`) nos dois bits altos do byte 8.
  vista.setUint8(6, (vista.getUint8(6) & 0x0f) | 0x70)
  vista.setUint8(8, (vista.getUint8(8) & 0x3f) | 0x80)

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
