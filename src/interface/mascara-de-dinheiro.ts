import { emReais } from '../dominio/dinheiro.ts'

/**
 * A máscara do campo de dinheiro (D-051): o que ela digita entra pela direita, como na
 * maquininha — `5` → `0,05`, `52` → `0,52`, `527` → `5,27`, `5270` → `52,70`. Recebe o texto
 * como está no campo depois da tecla (formatado ou não), fica só com os dígitos e formata de
 * novo em pt-BR, com ponto de milhar. Apagar funciona sozinho: `52,70` → `52,7` → `5,27`.
 *
 * Sem dígito nenhum devolve `''` — e `''` não é R$ 0,00: é "nada digitado" (`lerDinheiro`
 * devolve `null`, a guarda `sem-valor` continua). O `0,00` que ela vê é o placeholder.
 * Zeros à esquerda somem (`0052` → `0,52`). Nada aqui passa por `number` (EL-03).
 * `permitirZero` distingue o zero digitado do vazio no produto (RF-11/D-055).
 */
export function aplicarMascara(texto: string, permitirZero = false): string {
  const digitados = texto.replace(/\D/g, '')
  const digitos = digitados.replace(/^0+/, '')
  // RF-11/D-055: nos campos opcionais do produto, zero digitado é distinto de nada informado.
  if (digitos === '' && (!permitirZero || digitados === '')) return ''
  return emReais(BigInt(digitos || '0')).replace(/^R\$ /, '')
}
