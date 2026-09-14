import { describe, expect, test } from 'bun:test'
import { plataformaDeInstalacao } from '../src/plataforma/instalacao.ts'

/**
 * A instrução de instalação (E-13, D-038, D-048): o texto do Safari para o iPhone, o do Chrome
 * para o Android, nenhum no desktop nem no app já instalado. Os `userAgent` são exemplos reais
 * da forma que cada navegador manda; o teste é do critério, não da lista de aparelhos.
 */

const IPHONE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
const IPAD_SAFARI = 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
const ANDROID_CHROME = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36'
const WINDOWS_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const MAC_SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15'

describe('plataformaDeInstalacao', () => {
  test('iPhone e iPad no Safari recebem o texto do Compartilhar', () => {
    expect(plataformaDeInstalacao({ userAgent: IPHONE_SAFARI, instalado: false })).toBe('ios')
    expect(plataformaDeInstalacao({ userAgent: IPAD_SAFARI, instalado: false })).toBe('ios')
  })
  test('Android no Chrome recebe o texto do menu do Chrome', () => {
    expect(plataformaDeInstalacao({ userAgent: ANDROID_CHROME, instalado: false })).toBe('android')
  })
  test('desktop não instala: nada (RF-23)', () => {
    expect(plataformaDeInstalacao({ userAgent: WINDOWS_CHROME, instalado: false })).toBeNull()
    expect(plataformaDeInstalacao({ userAgent: MAC_SAFARI, instalado: false })).toBeNull()
  })
  test('já instalado: nada, em qualquer aparelho', () => {
    expect(plataformaDeInstalacao({ userAgent: IPHONE_SAFARI, instalado: true })).toBeNull()
    expect(plataformaDeInstalacao({ userAgent: ANDROID_CHROME, instalado: true })).toBeNull()
  })
})
