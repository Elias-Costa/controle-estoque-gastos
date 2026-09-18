import { describe, expect, test } from 'bun:test'
import { fraseDaListaVazia, mensagemDeCobranca, mensagemDeRecibo } from '../src/interface/palavras-da-cobranca.ts'
import { linkDoWhatsApp, telefoneParaWhatsApp } from '../src/interface/whatsapp.ts'

/**
 * A cobrança e o recibo pelo WhatsApp (E-12, RF-09, D-007, D-047): o telefone vira número só
 * na hora do link (RF-01), o link é um `href` e nada mais, e os dois textos só têm dinheiro
 * por `emReais` (EL-03). O que os textos dizem é hipótese até E-15; o que eles carregam
 * (nome, valor, vencimento, saldo) é RF-09 e está provado aqui.
 */

describe('telefoneParaWhatsApp — como ela digitou vira o número do wa.me', () => {
  test('DDD + celular, com ou sem máscara, ganha o 55', () => {
    expect(telefoneParaWhatsApp('(11) 99999-9999')).toBe('5511999999999')
    expect(telefoneParaWhatsApp('11 3333-4444')).toBe('551133334444')
    expect(telefoneParaWhatsApp('11999999999')).toBe('5511999999999')
  })

  test('já com o país fica como está; o zero de operadora cai', () => {
    expect(telefoneParaWhatsApp('+55 (11) 99999-9999')).toBe('5511999999999')
    expect(telefoneParaWhatsApp('55 11 3333-4444')).toBe('551133334444')
    expect(telefoneParaWhatsApp('011 99999-9999')).toBe('5511999999999')
  })

  test('sem DDD, vazio ou sem telefone: não há número — o link abre sem ele', () => {
    expect(telefoneParaWhatsApp('99999-9999')).toBeNull()
    expect(telefoneParaWhatsApp('')).toBeNull()
    expect(telefoneParaWhatsApp('   ')).toBeNull()
    expect(telefoneParaWhatsApp(undefined)).toBeNull()
    expect(telefoneParaWhatsApp('123')).toBeNull()
  })
})

describe('linkDoWhatsApp — um href, nunca um envio', () => {
  test('com número: wa.me/<número>?text=<texto codificado>', () => {
    expect(linkDoWhatsApp('(11) 99999-9999', 'Oi, Rosa! R$ 30,00 & tudo bem?')).toBe(
      'https://wa.me/5511999999999?text=Oi%2C%20Rosa!%20R%24%2030%2C00%20%26%20tudo%20bem%3F',
    )
  })

  test('sem número legível: wa.me/?text=, e ela escolhe a conversa (D-047)', () => {
    expect(linkDoWhatsApp(undefined, 'Oi')).toBe('https://wa.me/?text=Oi')
    expect(linkDoWhatsApp('9999-9999', 'Oi')).toBe('https://wa.me/?text=Oi')
  })
})

describe('mensagemDeCobranca — o texto dela, ditado na visita de E-15 (RF-09, D-050 item 7)', () => {
  test('parcela atrasada: palavra por palavra, "Fulano(a)" é o primeiro nome', () => {
    expect(mensagemDeCobranca({ nome: 'Cláudia Souza', vencimento: '2026-09-04', vencida: true })).toBe(
      'Oi, Cláudia, tudo bem? Passando para lembrar da parcela que está atrasada. Quando puder, me mande, por favor. Obrigada!',
    )
  })

  test('parcela a vencer: só "que está atrasada" vira "que vence em dd/mm"; o resto é dela', () => {
    expect(mensagemDeCobranca({ nome: 'Dona Rosa', vencimento: '2026-09-17', vencida: false })).toBe(
      'Oi, Dona Rosa, tudo bem? Passando para lembrar da parcela que vence em 17/09. Quando puder, me mande, por favor. Obrigada!',
    )
  })

  test('sem valor e sem total: ela não os ditou', () => {
    expect(mensagemDeCobranca({ nome: 'Ana', vencimento: '2026-09-01', vencida: true })).not.toMatch(/R\$/)
  })
})

describe('mensagemDeRecibo — o que entrou e o que ficou (RF-09)', () => {
  test('ainda deve: "Agora falta R$ Y"', () => {
    expect(mensagemDeRecibo({ nome: 'Maria Silva', valor: 3000n, saldo: 5000n })).toBe(
      'Oi, Maria! Recebi os R$ 30,00, obrigada! Agora falta R$ 50,00 na sua fichinha.',
    )
  })

  test('quitou: "está quitada" — o saldo é o relido depois de "Considerar pago" também', () => {
    expect(mensagemDeRecibo({ nome: 'Seu João', valor: 3000n, saldo: 0n })).toBe('Oi, Seu João! Recebi os R$ 30,00, obrigada! Sua fichinha está quitada!')
  })
})

describe('fraseDaListaVazia — vazia em "Em atraso" é boa notícia', () => {
  test('uma frase por filtro', () => {
    expect(fraseDaListaVazia('em-atraso')).toBe('Ninguém em atraso')
    expect(fraseDaListaVazia('a-vencer')).toBe('Ninguém a vencer')
    expect(fraseDaListaVazia('todas')).toBe('Ninguém devendo')
  })
})
