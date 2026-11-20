import { projetarAReceber } from './a-receber.ts'
import { conferirPeriodo } from './calendario-resumo.ts'
import { projetarEstoqueDoResumo } from './estoque-no-resumo.ts'
import type { MovimentoEstoque } from './estoque.ts'
import type { Cliente, Dia, Lancamento } from './ficha.ts'
import { validarFatosCaixa, type FatoCaixa } from './gastos.ts'
import { reconstruirVendas } from './historico-de-vendas.ts'
import { projetarLucro } from './lucro-do-mes.ts'
import type { Produto } from './produtos.ts'
import { quantidadeValida } from './regras-estoque.ts'
import { projetarCompromissos, type OperacaoEstoque } from './vendas-estoque.ts'
import { projetarVendasPorPeriodo } from './vendas-por-periodo.ts'

/** Fontes correntes de uma conta, lidas juntas. Movimentos podem conter revisões causais. */
export type DadosIndicadores = {
  readonly clientes: readonly Cliente[]
  readonly lancamentos: readonly Lancamento[]
  readonly produtos: readonly Produto[]
  readonly movimentos: readonly MovimentoEstoque[]
  readonly operacoes: readonly OperacaoEstoque[]
  readonly fatosCaixa: readonly FatoCaixa[]
}

/** Prazo usado até haver uma escolha da conta (D-089). */
export const PRAZO_DE_ENCALHE_PADRAO = 90

/** RF-19–22: calcula o Resumo local com data de referência explícita e sem gravar totais. */
export function projetarIndicadores(dados: DadosIndicadores, hoje: Dia, mes = hoje.slice(0, 7), prazo = PRAZO_DE_ENCALHE_PADRAO) {
  conferirPeriodo(hoje, mes)
  if (!quantidadeValida(prazo)) throw new RangeError('Prazo inválido')
  const caixa = validarFatosCaixa(dados.fatosCaixa)
  if (!caixa.ok) throw new Error(`Caixa inválido: ${caixa.motivo}`)
  const estados = projetarCompromissos(dados.lancamentos, dados.movimentos, dados.produtos.map((p) => p.id))
  if (!estados.ok) throw new Error(`Estoque inválido: ${estados.motivo}`)
  const movimentosVigentes = [...estados.valor.values()].flatMap(({ estoque }) => estoque.movimentosVigentes)
  const partes = reconstruirVendas(dados.lancamentos, dados.operacoes)
  return {
    aReceber: projetarAReceber(dados.clientes, dados.lancamentos, hoje),
    lucro: projetarLucro(partes, movimentosVigentes, caixa.valor, dados.lancamentos, hoje, mes),
    vendas: projetarVendasPorPeriodo(partes, hoje, mes),
    estoque: projetarEstoqueDoResumo(dados.produtos, estados.valor, partes, hoje, prazo),
  }
}
