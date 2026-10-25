import { modeloValido, type SituacaoMensagem } from '../dados/modelos-whatsapp.ts'
import { emReais, type Centavos } from '../dominio/dinheiro.ts'
import { diaCurto } from './datas.ts'

/** Dados relidos da ficha; ausência só é problema se o texto pedir aquele trecho (D-072). */
export type DadosDaMensagem = { readonly nome?: string; readonly valor?: Centavos; readonly saldo?: Centavos; readonly vencimento?: string }
/** Primeiro nome e tratamento preservados de D-047/050. */
export function comoChamar(nome: string): string {
  const palavras = nome.trim().split(/\s+/), primeira = palavras[0] ?? nome
  return /^(dona|seu)\.?$/i.test(primeira) && palavras.length > 1 ? `${primeira} ${palavras[1]}` : primeira
}
/** Substituição única em texto puro; não executa HTML, código ou o conteúdo de um dado inserido. */
export function renderizarModelo(texto: string, situacao: SituacaoMensagem, dados: DadosDaMensagem):
  { readonly ok: true; readonly texto: string } | { readonly ok: false; readonly motivo: 'modelo' | 'dado' } {
  if (!modeloValido(texto, situacao)) return { ok: false, motivo: 'modelo' }
  let faltou = false
  const resultado = texto.replace(/\{([^{}]*)\}/g, (_marcador, trecho: string) => {
    if (trecho === 'nome' && typeof dados.nome === 'string' && dados.nome.trim()) return comoChamar(dados.nome)
    const dinheiro = trecho === 'valor' ? dados.valor : trecho === 'saldo' ? dados.saldo : undefined
    // RN-01: conservar o saldo relido, inclusive seu sinal, sem impor outra regra financeira.
    if (typeof dinheiro === 'bigint') return emReais(dinheiro)
    if (trecho === 'vencimento' && dados.vencimento && /^\d{4}-\d{2}-\d{2}$/.test(dados.vencimento)) {
      const dia = new Date(`${dados.vencimento}T12:00:00Z`)
      if (!Number.isNaN(dia.getTime()) && dia.toISOString().slice(0, 10) === dados.vencimento) return diaCurto(dados.vencimento)
    }
    faltou = true
    return ''
  })
  return faltou ? { ok: false, motivo: 'dado' } : { ok: true, texto: resultado }
}
