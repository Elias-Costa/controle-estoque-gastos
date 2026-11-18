import type { DadosCopia } from './tipos-copia.ts'
import { emReais } from '../dominio/dinheiro.ts'
import { saldo, totalDaVenda, totalDoDebito } from '../dominio/ficha.ts'
import { projetarEstoque } from '../dominio/estoque.ts'
import { prometidoDoProduto, projetarCompromissos } from '../dominio/vendas-estoque.ts'
import { custoDoProduto } from '../dominio/produtos.ts'
import { projetarCaixa } from '../dominio/caixa.ts'

function celula(v: unknown): string {
  const texto = String(v ?? '')
  // Texto livre não vira fórmula ao abrir em planilha; os inteiros continuam exatos em texto.
  const seguro = /^[\s]*[=+\-@\t\r]/.test(texto) ? `'${texto}` : texto
  return `"${seguro.replaceAll('"', '""')}"`
}
function csv(linhas: readonly (readonly unknown[])[]): string { return '\ufeff' + linhas.map((l) => l.map(celula).join(';')).join('\r\n') + '\r\n' }
/** Consultas derivadas do mesmo retrato; nenhuma coluna é fonte da restauração (RF-28). */
export function consultasDaCopia(d: DadosCopia): Readonly<Record<string, string>> {
  const fichas: unknown[][] = [['Cliente', 'Telefone', 'Anotação', 'Data', 'Tipo', 'Valor', 'Saldo da ficha']]
  const porCliente = new Map<string, DadosCopia['lancamentos']>(d.clientes.map((c) => [c.id, []]))
  for (const l of d.lancamentos) porCliente.get(l.clienteId)?.push(l)
  for (const c of d.clientes) {
    const ficha = porCliente.get(c.id) ?? []
    const restante = emReais(saldo(ficha))
    if (!ficha.length) fichas.push([c.nome, c.telefone, '', '', 'Sem anotações', '', restante])
    for (const l of ficha) fichas.push([c.nome, c.telefone, l.id, l.data, l.tipo,
      l.tipo === 'venda' ? emReais(totalDaVenda(l)) : l.tipo === 'saldo-anterior' ? emReais(totalDoDebito(l)) : 'valor' in l ? emReais(l.valor) : `Desfaz ${l.estornaId}`, restante])
  }
  const estoque: unknown[][] = [['Produto', 'Marca', 'Código', 'Categoria', 'Físico', 'Prometido', 'Custo de referência']]
  const categorias = new Map(d.categorias.map((c) => [c.id, c.nome]))
  const compromissos = projetarCompromissos(d.lancamentos, d.movimentos, d.produtos.map((p) => p.id))
  for (const p of d.produtos) {
    const conjunto = compromissos.ok ? compromissos.valor.get(p.id) : undefined
    // BA-04: caminho válido projeta uma vez. Falha conserva o diagnóstico independente de cada coluna/produto.
    const posicao = conjunto ? { ok: true, valor: conjunto.estoque } as const : projetarEstoque(d.movimentos, p.id)
    const promessa = conjunto ? { ok: true, valor: conjunto.prometido } as const : prometidoDoProduto(
      d.lancamentos.filter((l) => l.tipo === 'estorno' || l.tipo === 'venda' && l.itens.some((i) => i.produtoId === p.id)), d.movimentos, p.id)
    const custo = posicao.ok ? custoDoProduto(p, posicao.valor.comprasVigentes) : undefined
    estoque.push([p.nome, p.marca, p.codigoCatalogo, categorias.get(p.categoriaId),
      posicao.ok ? posicao.valor.fisico : 'Conferir contagem', promessa.ok ? promessa.valor : 'Conferir entregas', custo === undefined ? 'Não informado' : emReais(custo)])
  }
  const caixa: unknown[][] = [['Mês', 'Mostrar', 'Entrou', 'Saiu', 'Diferença']]
  const meses = new Set([...d.fatosCaixa, ...d.lancamentos].map((f) => f.data.slice(0, 7)))
  for (const mes of [...meses].sort()) {
    const projecao = projetarCaixa(d.fatosCaixa, d.lancamentos, mes)
    if (!projecao.ok) { caixa.push([mes, 'Conferir anotações', '', '', '']); continue }
    for (const corte of ['tudo', 'negocio', 'pessoal'] as const) {
      const total = projecao.valor[corte]
      caixa.push([mes, corte === 'tudo' ? 'Tudo' : corte === 'negocio' ? 'Negócio' : 'Pessoal', emReais(total.entrou), emReais(total.saiu), emReais(total.diferenca)])
    }
  }
  return { 'consultas/fichas.csv': csv(fichas), 'consultas/estoque.csv': csv(estoque), 'consultas/caixa.csv': csv(caixa) }
}
