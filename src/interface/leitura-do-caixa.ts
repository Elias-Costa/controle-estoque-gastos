import type { EstadoLocalCaixa } from '../dados/repositorio-caixa.ts'
import type { Centavos } from '../dominio/dinheiro.ts'
import { totalDaVenda } from '../dominio/ficha.ts'
import type { ClassificacaoCaixa, Despesa, ReceitaAvulsa } from '../dominio/gastos.ts'
import { PALAVRAS_DO_CAIXA as P } from './palavras-do-caixa.ts'

/** Corte mensal; a natureza vem do fato, nunca da grafia da categoria (D-065). */
export type CorteCaixa = 'tudo' | ClassificacaoCaixa

/** Linha vigente de consulta; somente fatos próprios podem ser corrigidos nesta tela. */
export type LinhaDoCaixa = {
  readonly id: string; readonly data: string; readonly titulo: string; readonly detalhe: string
  readonly valor: Centavos; readonly direcao: 'entrada' | 'saida'; readonly classificacao: ClassificacaoCaixa
  readonly fato?: Despesa | ReceitaAvulsa
}

/** Fontes aprovadas, uma vez por id, com os estornos resolvidos antes de separar o mês. */
export function linhasDoCaixa(estado: EstadoLocalCaixa, mes: string, corte: CorteCaixa): readonly LinhaDoCaixa[] {
  const linhas: LinhaDoCaixa[] = []
  const estornados = new Set(estado.fatos.filter((f) => f.tipo === 'estorno').map((f) => f.alvo.id))
  const desfeitos = new Set(estado.lancamentos.filter((l) => l.tipo === 'estorno').map((l) => l.estornaId))
  for (const f of estado.fatos) {
    if (f.tipo === 'estorno' || estornados.has(f.id)) continue
    linhas.push({ id: f.id, data: f.data, titulo: f.categoria, detalhe: f.tipo === 'receita-avulsa' ? P.entrada : f.mercadoria ? P.compra : P.gasto,
      valor: f.valor, direcao: f.tipo === 'despesa' ? 'saida' : 'entrada', classificacao: f.classificacao, fato: f })
  }
  const nomes = new Map(estado.clientes.map((c) => [c.id, c.nome]))
  for (const l of estado.lancamentos) {
    if (desfeitos.has(l.id)) continue
    if (l.tipo !== 'recebimento' && !(l.tipo === 'venda' && l.pagamento === 'avista')) continue
    linhas.push({ id: l.id, data: l.data, titulo: l.tipo === 'recebimento' ? P.recebimento : P.venda,
      detalhe: nomes.get(l.clienteId) ?? '', valor: l.tipo === 'recebimento' ? l.valor : totalDaVenda(l), direcao: 'entrada', classificacao: 'negocio' })
  }
  return linhas.filter((l) => l.data.slice(0, 7) === mes && (corte === 'tudo' || l.classificacao === corte))
    .sort((a, b) => b.data.localeCompare(a.data) || a.id.localeCompare(b.id))
}
