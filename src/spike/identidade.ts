/**
 * Geração de UUIDv7 no dispositivo, exigida por D-029.
 *
 * O id nasce no aparelho, antes de qualquer rede — é o que torna possível criar
 * uma venda offline e já referenciar seus itens e parcelas (RI-04). A escolha do
 * v7 sobre o v4 é deliberada: os primeiros 48 bits são o instante de criação em
 * milissegundos, então a ordenação lexicográfica dos ids é a ordem cronológica.
 *
 * Existe aqui, e não numa biblioteca, porque `Bun.randomUUIDv7()` é do runtime do
 * servidor e este código roda no Safari do iPhone. Parte do que E-00 verifica é
 * justamente que o navegador tem tudo o que precisamos sem dependência extra.
 */
export function uuidv7(): string {
  const instante = Date.now()
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)

  // 48 bits de timestamp, big-endian, nos bytes 0..5.
  bytes[0] = (instante / 2 ** 40) & 0xff
  bytes[1] = (instante / 2 ** 32) & 0xff
  bytes[2] = (instante / 2 ** 24) & 0xff
  bytes[3] = (instante / 2 ** 16) & 0xff
  bytes[4] = (instante / 2 ** 8) & 0xff
  bytes[5] = instante & 0xff

  bytes[6] = (bytes[6]! & 0x0f) | 0x70 // versão 7
  bytes[8] = (bytes[8]! & 0x3f) | 0x80 // variante RFC 4122

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
