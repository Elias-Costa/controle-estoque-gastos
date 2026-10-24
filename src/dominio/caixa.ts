import type { Centavos } from './dinheiro.ts'
import { totalDaVenda, type Lancamento } from './ficha.ts'
import { validarFatosCaixa, type FatoCaixa, type ResultadoCaixa } from './gastos.ts'

/** Valores derivados em centavos, sem saldo inicial nem transporte entre meses (D-066). */
export type TotaisCaixa = { readonly entrou: Centavos; readonly saiu: Centavos; readonly diferenca: Centavos }

/** Movimento anotado no mês e seus cortes; não declara completude do histórico (D-066). */
export type CaixaMensal = {
  readonly mes: string
  readonly tudo: TotaisCaixa
  readonly negocio: TotaisCaixa
  readonly pessoal: TotaisCaixa
}

function totais(entrou: Centavos, saiu: Centavos): TotaisCaixa {
  return { entrou, saiu, diferenca: entrou - saiu }
}

/**
 * Lê fatos correntes e todo o financeiro válido da mesma conta, inclusive fichas desativadas.
 * O chamador fornece lançamentos F1/F2 já validados, uma vez por id; estornos de qualquer mês
 * retiram o alvo no mês original. Dinheiro realmente devolvido exige fato próprio (D-066/069).
 */
export function projetarCaixa(
  fatos: readonly FatoCaixa[], lancamentos: readonly Lancamento[], mes: string,
): ResultadoCaixa<CaixaMensal> {
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(mes)) return { ok: false, motivo: 'mes-invalido' }
  const validacao = validarFatosCaixa(fatos)
  if (!validacao.ok) return validacao
  let entrouNegocio = 0n
  let saiuNegocio = 0n
  let entrouPessoal = 0n
  let saiuPessoal = 0n
  // Resolver estornos antes do filtro mensal evita contar o erro quando corrigido noutro mês.
  const estornadosCaixa = new Set(fatos.filter((fato) => fato.tipo === 'estorno').map((fato) => fato.alvo.id))
  const estornadosFicha = new Set(lancamentos.filter((lancamento) => lancamento.tipo === 'estorno').map((lancamento) => lancamento.estornaId))
  for (const fato of fatos) {
    if (fato.tipo === 'estorno' || estornadosCaixa.has(fato.id) || fato.data.slice(0, 7) !== mes) continue
    if (fato.tipo === 'receita-avulsa') {
      if (fato.classificacao === 'negocio') entrouNegocio += fato.valor
      else entrouPessoal += fato.valor
    } else {
      if (fato.classificacao === 'negocio') saiuNegocio += fato.valor
      else saiuPessoal += fato.valor
    }
  }
  for (const lancamento of lancamentos) {
    if (estornadosFicha.has(lancamento.id) || lancamento.data.slice(0, 7) !== mes) continue
    if (lancamento.tipo === 'recebimento') entrouNegocio += lancamento.valor
    // RN-04/D-039: venda à vista já representa o dinheiro; não gerar outro recebimento.
    if (lancamento.tipo === 'venda' && lancamento.pagamento === 'avista') entrouNegocio += totalDaVenda(lancamento)
  }
  return { ok: true, valor: {
    mes,
    tudo: totais(entrouNegocio + entrouPessoal, saiuNegocio + saiuPessoal),
    negocio: totais(entrouNegocio, saiuNegocio),
    pessoal: totais(entrouPessoal, saiuPessoal),
  } }
}
