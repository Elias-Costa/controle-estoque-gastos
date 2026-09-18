import { describe, expect, test } from 'bun:test'
import { lerDinheiro } from '../src/dominio/dinheiro.ts'
import { aplicarMascara } from '../src/interface/mascara-de-dinheiro.ts'
import { textoDeCentavos } from '../src/interface/rascunho-da-venda.ts'

/**
 * A máscara pela direita (D-051): o campo formata a cada tecla, e o domínio lê o que o campo
 * mostra. O erro de 100× de D-034 continua possível — mas fica na cara dela, a cada tecla.
 */
describe('aplicarMascara — os dígitos entram pela direita, como na maquininha (D-051)', () => {
  test('a sequência que ela pediu: 5 → 0,05; 52 → 0,52; 527 → 5,27; 5270 → 52,70', () => {
    expect(aplicarMascara('5')).toBe('0,05')
    expect(aplicarMascara('0,05' + '2')).toBe('0,52')
    expect(aplicarMascara('0,52' + '7')).toBe('5,27')
    expect(aplicarMascara('5,27' + '0')).toBe('52,70')
  })

  test('apagar a última tecla sobre o texto formatado tira o último dígito: 52,70 → 52,7 → 5,27', () => {
    expect(aplicarMascara('52,7')).toBe('5,27')
    expect(aplicarMascara('5,2')).toBe('0,52')
    expect(aplicarMascara('0,5')).toBe('0,05')
    expect(aplicarMascara('0,0')).toBe('')
  })

  test('sem dígito é vazio, não R$ 0,00: nada digitado não é um valor', () => {
    expect(aplicarMascara('')).toBe('')
    expect(aplicarMascara('0')).toBe('')
    expect(aplicarMascara('000')).toBe('')
    expect(aplicarMascara('abc')).toBe('')
    expect(aplicarMascara('R$ ,.')).toBe('')
    expect(lerDinheiro('')).toBeNull()
  })

  test('zeros à esquerda somem; letras e sinais são ignorados; milhar ganha ponto', () => {
    expect(aplicarMascara('0052')).toBe('0,52')
    expect(aplicarMascara('12a3-4')).toBe('12,34')
    expect(aplicarMascara('123456')).toBe('1.234,56')
    expect(aplicarMascara('1.234,56')).toBe('1.234,56')
    expect(aplicarMascara('123456789')).toBe('1.234.567,89')
  })

  test('o domínio lê o que a máscara mostra, e dá exatamente os dígitos em centavos', () => {
    for (const digitos of ['5', '52', '527', '5270', '3990', '125000', '123456789']) {
      expect(lerDinheiro(aplicarMascara(digitos))).toBe(BigInt(digitos))
    }
  })

  test('a correção pré-preenche no formato da máscara: textoDeCentavos é idempotente sob ela', () => {
    for (const centavos of [0n, 25n, 3990n, 125000n, 123456789n]) {
      expect(aplicarMascara(textoDeCentavos(centavos))).toBe(centavos === 0n ? '' : textoDeCentavos(centavos))
    }
  })
})
