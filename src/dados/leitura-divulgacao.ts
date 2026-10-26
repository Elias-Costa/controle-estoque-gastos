import { liveQuery } from 'dexie'
import type { Cliente, Lancamento } from '../dominio/ficha.ts'
import type { BancoLocal } from './banco.ts'
import type { CatalogoProdutos } from './repositorio-estoque.ts'

/** RF-29: catálogo, compromissos e destinatários conhecidos no mesmo retrato local. */
export type RetratoDivulgacao = CatalogoProdutos & { readonly lancamentos: readonly Lancamento[]; readonly clientes: readonly Cliente[] }

/** Leitura observada entre abas; não grava posição nem consulta rede para preparar o PDF. */
export function criarLeituraDivulgacao(banco: BancoLocal) {
  async function ler(): Promise<RetratoDivulgacao> {
    return banco.transaction('r', [banco.produtos, banco.categorias, banco.movimentos, banco.lancamentos, banco.clientes, banco.fotos], async () => {
      const produtos = await banco.produtos.toArray()
      const miniaturas: CatalogoProdutos['miniaturas'][number][] = []
      // D-025: uma foto por vez; os originais pendentes não são retidos pelo catálogo.
      for (const fotoId of new Set(produtos.flatMap((produto) => produto.fotoId ? [produto.fotoId] : []))) {
        const foto = await banco.fotos.get(fotoId)
        if (foto?.miniatura && !foto.dispensada) miniaturas.push({ fotoId, binario: foto.miniatura })
      }
      return { produtos, miniaturas, categorias: await banco.categorias.toArray(), movimentos: await banco.movimentos.toArray(),
        lancamentos: await banco.lancamentos.toArray(), clientes: await banco.clientes.toArray() }
    })
  }
  return { ler, assinar: (aoLer: (retrato: RetratoDivulgacao) => void, aoFalhar: () => void) => {
    const assinatura = liveQuery(ler).subscribe({ next: aoLer, error: aoFalhar })
    return () => assinatura.unsubscribe()
  } }
}
