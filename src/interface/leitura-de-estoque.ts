import type { EstadoLocalEstoque } from '../dados/repositorio-estoque.ts'
import { chaveDoEfeito, projetarEstoque } from '../dominio/estoque.ts'
import { custoDoProduto } from '../dominio/produtos.ts'

/** Posição e histórico de uma leitura consistente; revisões antigas são evidência, nunca outra entrada ativa. */
export function lerEstoque(estado: EstadoLocalEstoque, produtoId: string) {
  const produto = estado.produtos.find((item) => item.id === produtoId)
  const projecao = projetarEstoque(estado.movimentos, produtoId)
  if (!produto || !projecao.ok) throw new Error('Estoque incompleto')
  const atuais = new Map<string, number>()
  for (const movimento of estado.movimentos) atuais.set(movimento.id, Math.max(atuais.get(movimento.id) ?? 0, movimento.revisao))
  const vigentes = new Set(projecao.valor.movimentosVigentes.map(chaveDoEfeito))
  const afetadas = new Set(projecao.valor.contagensAfetadas.map(chaveDoEfeito))
  const historico = estado.movimentos.filter((item) => item.produtoId === produtoId).map((movimento) => {
    const superada = movimento.revisao !== atuais.get(movimento.id)
    const anulada = !superada && !vigentes.has(chaveDoEfeito(movimento)) && !afetadas.has(chaveDoEfeito(movimento)) && movimento.tipo !== 'anulacao'
    const problema = estado.fila.some((item) => item.tabela === 'operacoes' && item.registroId === movimento.operacaoId && item.problema)
    return { movimento, superada, anulada, problema, afetada: afetadas.has(chaveDoEfeito(movimento)),
      corrigivel: !superada && !anulada && !problema && (movimento.tipo === 'compra' || (movimento.tipo === 'contagem' && movimento.motivo === 'estoque-inicial')) }
  }).sort((a, b) => b.movimento.data.localeCompare(a.movimento.data) || b.movimento.id.localeCompare(a.movimento.id) || b.movimento.revisao - a.movimento.revisao)
  return { produto, fisico: projecao.valor.fisico, custo: custoDoProduto(produto, projecao.valor.comprasVigentes),
    contagensAfetadas: afetadas.size > 0, historico }
}
