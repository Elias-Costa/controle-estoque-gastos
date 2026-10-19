import type { EntradaMovimentoLocal } from '../dados/operacoes-estoque.ts'
import { emReais, lerDinheiro, multiplicar } from '../dominio/dinheiro.ts'
import type { CompraEstoque, ContagemEstoque } from '../dominio/estoque.ts'
import { diaValido, quantidadeValida, type ResultadoEstoque } from '../dominio/regras-estoque.ts'

/** Compras e contagem inicial têm significados distintos; nenhuma contagem fabrica uma compra. */
export type EntradaDeEstoque = CompraEstoque | ContagemEstoque

/** Texto do formulário, incluindo custo vazio distinto de zero explícito (D-018/051). */
export type RascunhoDaEntrada = {
  readonly produtoId: string; readonly quantidadeTexto: string; readonly custoTexto: string; readonly data: string
}

/** Preserva o que foi anotado ao abrir uma correção; entrada nova começa sem custo presumido. */
export function rascunhoDaEntrada(produtoId: string, hoje: string, original?: EntradaDeEstoque): RascunhoDaEntrada {
  return { produtoId: original?.produtoId ?? produtoId, data: original?.data ?? hoje,
    quantidadeTexto: original ? String(original.tipo === 'compra' ? original.quantidade : original.totalContado) : '',
    custoTexto: original?.tipo === 'compra' && original.custoUnitario !== undefined ? emReais(original.custoUnitario).slice(3) : '' }
}

/** Confere quantidade inteira, data do fato e custo opcional; total é exclusivamente bigint. */
export function conferirEntrada(rascunho: RascunhoDaEntrada, tipo: 'compra' | 'estoque-inicial', hoje: string):
  ResultadoEstoque<{ readonly entrada: EntradaMovimentoLocal; readonly total?: bigint }> {
  if (!rascunho.produtoId) return { ok: false, motivo: 'produto-inexistente' }
  const quantidade = /^\d+$/.test(rascunho.quantidadeTexto) ? Number(rascunho.quantidadeTexto) : NaN
  if (!quantidadeValida(quantidade, tipo === 'compra' ? 1 : 0)) return { ok: false, motivo: 'quantidade-invalida' }
  if (!diaValido(rascunho.data) || rascunho.data > hoje) return { ok: false, motivo: 'data-invalida' }
  const [ano, mes, dia] = rascunho.data.split('-').map(Number)
  const calendario = new Date(`${rascunho.data}T12:00:00`)
  if (calendario.getFullYear() !== ano || calendario.getMonth() + 1 !== mes || calendario.getDate() !== dia) return { ok: false, motivo: 'data-invalida' }
  const base = { produtoId: rascunho.produtoId, data: rascunho.data }
  if (tipo === 'estoque-inicial') return { ok: true, valor: { entrada: { ...base, tipo: 'contagem', totalContado: quantidade, motivo: 'estoque-inicial' } } }
  const custo = rascunho.custoTexto === '' ? undefined : lerDinheiro(rascunho.custoTexto)
  if (custo === null || (custo !== undefined && custo < 0n)) return { ok: false, motivo: 'custo-invalido' }
  return { ok: true, valor: { entrada: { ...base, tipo: 'compra', quantidade, custoUnitario: custo },
    total: custo === undefined ? undefined : multiplicar(custo, quantidade) } }
}
