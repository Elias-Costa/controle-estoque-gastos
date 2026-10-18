import type { CompraEstoque, ContagemEstoque, MovimentoEstoque } from '../src/dominio/estoque.ts'
import { novaContagem } from '../src/dominio/estoque.ts'
import type { ResultadoEstoque } from '../src/dominio/regras-estoque.ts'
import type { Produto } from '../src/dominio/produtos.ts'
import { criarItemVendido, type IdentidadeOperacao, type ItemVendido, type VendaEstoque } from '../src/dominio/vendas-estoque.ts'

/** Falha com o motivo real, sem coerções que escondam erros de tipagem dos testes. */
export function ok<T>(resultado: ResultadoEstoque<T>): T {
  if (!resultado.ok) throw new Error(resultado.motivo)
  return resultado.valor
}
/** Produto fictício; somente campos autorizados para cadastro mínimo. */
export const produto: Produto = { id: 'perfume', nome: 'Perfume', categoriaId: 'perfumaria', custoManual: 2500n, precoVenda: 5000n }
/** Operação gerada localmente, ainda sem dependências de transporte. */
export function operacao(id: string, revisao = 1): IdentidadeOperacao { return { id, revisao, dependencias: [] } }
/** Compra fictícia, com a data do fato separada da ordem lógica. */
export function compra(id = 'compra', quantidade = 10, custoUnitario: bigint | undefined = 3000n): CompraEstoque {
  return { tipo: 'compra', id, revisao: 1, operacaoId: `op-${id}`, produtoId: produto.id,
    quantidade, custoUnitario, data: '2026-10-01', ordemCadastro: 1n, conhecidos: [] }
}
/** Contagem construída pela mesma regra que calcula sua base automaticamente. */
export function contagem(historico: readonly MovimentoEstoque[], id: string, totalContado: number): ContagemEstoque {
  return ok(novaContagem(historico, { id, operacaoId: `op-${id}`, revisao: 1, produtoId: produto.id,
    data: '2026-10-02', totalContado, motivo: 'conferencia' }))
}
/** Item com identidade própria; preço legado recebe o total da linha. */
export function item(id = 'item', quantidade = 3, precoUnitario = 5000n): ItemVendido {
  return ok(criarItemVendido({ id, descricao: 'Perfume', quantidade, precoUnitario, produto }))
}
/** Venda fiado com soma de parcelas igual ao valor dos itens. */
export function venda(id = 'venda', itens: readonly ItemVendido[] = [item()]): VendaEstoque {
  return { tipo: 'venda', pagamento: 'fiado', id, clienteId: 'cliente', data: '2026-10-02', itens, desconto: 0n,
    parcelas: [{ id: `parcela-${id}`, vencimento: '2026-11-01', valor: itens.reduce((total, entrada) => total + entrada.preco, 0n) }] }
}
