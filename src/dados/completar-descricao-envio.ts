import { descricaoDoItemPreenchida, validar, type Lancamento, type Venda } from '../dominio/ficha.ts'
import { conteudoDoEfeito } from '../dominio/regras-estoque.ts'
import type { BancoLocal, ItemDaFila } from './banco.ts'

/** Retrato local para a conferência humana; nunca integra o relato de suporte (D-078). */
export type VendaSemDescricao = {
  readonly fila: ItemDaFila
  readonly venda: Venda
  readonly cliente: string
}

function vendaElegivel(registro: Lancamento | undefined, fila: ItemDaFila): registro is Venda {
  if (fila.tabela !== 'lancamentos' || fila.problema?.codigo !== '23514' || fila.problema.constraint !== 'lancamentos_sem_itens' || registro?.tipo !== 'venda') return false
  if (!Array.isArray(registro.itens) || registro.itens.length === 0 || typeof registro.desconto !== 'bigint') return false
  if (registro.itens.some((item) => typeof item !== 'object' || item === null || typeof item.descricao !== 'string' || typeof item.preco !== 'bigint' ||
    item.id !== undefined || item.produtoId !== undefined || item.quantidade !== undefined || item.precoUnitario !== undefined)) return false
  if (!registro.itens.some((item) => !descricaoDoItemPreenchida(item.descricao))) return false
  if (registro.pagamento === 'fiado') {
    if (!Array.isArray(registro.parcelas) || registro.parcelas.some((p) => typeof p !== 'object' || p === null || typeof p.id !== 'string' || typeof p.vencimento !== 'string' || typeof p.valor !== 'bigint')) return false
  } else if (registro.pagamento !== 'avista' || !['pix', 'dinheiro', 'outro'].includes(registro.forma)) return false
  // Confere o restante sem inventar um nome persistido: só a pessoa preencherá o texto real.
  return validar([{ ...registro, itens: registro.itens.map((item) => ({ ...item, descricao: 'conferência' })) }]).ok
}

/** Exceção D-078: completa só descrições F1 recusadas, com conferência atômica da tentativa. */
export function criarCorrecaoDescricaoEnvio(banco: BancoLocal, aoEnfileirar: () => void = () => {}) {
  async function ler(): Promise<readonly VendaSemDescricao[]> {
    return banco.transaction('r', banco.fila, banco.lancamentos, banco.operacoes, banco.clientes, async () => {
      const grupos = await banco.operacoes.toArray()
      const vendas: VendaSemDescricao[] = []
      for (const fila of await banco.fila.orderBy('ordem').toArray()) {
        if (fila.tabela !== 'lancamentos') continue
        const venda = await banco.lancamentos.get(fila.registroId)
        if (!vendaElegivel(venda, fila) || grupos.some((g) => g.lancamentos.some((l) => l.id === venda.id))) continue
        const cliente = await banco.clientes.get(venda.clienteId)
        if (cliente) vendas.push({ fila, venda, cliente: cliente.nome })
      }
      return vendas
    })
  }
  async function completar(retrato: VendaSemDescricao, descricoes: Readonly<Record<number, string>>): Promise<{ readonly ok: true } | { readonly ok: false; readonly motivo: 'mudou' | 'falta-descricao' }> {
    const resultado = await banco.transaction('rw', banco.fila, banco.lancamentos, banco.operacoes, async () => {
      const fila = await banco.fila.get(retrato.fila.ordem)
      const venda = await banco.lancamentos.get(retrato.venda.id)
      if (!fila || !vendaElegivel(venda, fila) || fila.registroId !== venda.id ||
        conteudoDoEfeito(fila) !== conteudoDoEfeito(retrato.fila) || conteudoDoEfeito(venda) !== conteudoDoEfeito(retrato.venda) ||
        (await banco.operacoes.toArray()).some((g) => g.lancamentos.some((l) => l.id === venda.id))) return { ok: false as const, motivo: 'mudou' as const }
      const itens = venda.itens.map((item, posicao) => descricaoDoItemPreenchida(item.descricao) ? item : { ...item, descricao: (descricoes[posicao] ?? '').trim() })
      if (itens.some((item) => !descricaoDoItemPreenchida(item.descricao))) return { ok: false as const, motivo: 'falta-descricao' as const }
      await banco.lancamentos.put({ ...venda, itens })
      await banco.fila.put({ ...fila, versao: (fila.versao ?? 0) + 1, problema: undefined })
      return { ok: true as const }
    })
    if (resultado.ok) aoEnfileirar()
    return resultado
  }
  return { ler, completar }
}
