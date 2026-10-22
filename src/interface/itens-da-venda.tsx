import { useState } from 'react'
import type { CatalogoProdutos, EstadoLocalEstoque } from '../dados/repositorio-estoque.ts'
import { emReais } from '../dominio/dinheiro.ts'
import { Botao } from './Botao.tsx'
import { CLASSES_DE_CAMPO, CLASSES_DE_CAMPO_COMPACTO } from './Campo.tsx'
import { EntradaDeDinheiro } from './CampoDeDinheiro.tsx'
import { lerProdutos, rotuloDaCategoria } from './leitura-de-produtos.ts'
import { MiniaturaProduto } from './miniatura-produto.tsx'
import { conferirVendaComEstoque, disponibilidade, selecionarProduto, type ItemComEstoque, type RascunhoComEstoque } from './venda-com-estoque.ts'

/** Itens livres ou do catálogo; a escolha não exige cadastro nem rede (RF-03/04/25). */
export function ItensDaVenda({ rascunho, estado, catalogo, aoMudar, correcao = false, legada = false }: {
  rascunho: RascunhoComEstoque; estado: EstadoLocalEstoque; catalogo: CatalogoProdutos
  aoMudar: (itens: readonly ItemComEstoque[]) => void; correcao?: boolean; legada?: boolean
}) {
  const [escolhendo, setEscolhendo] = useState<number | null>(null)
  const [busca, setBusca] = useState('')
  const conferencia = conferirVendaComEstoque(rascunho, estado, rascunho.data)
  function mudar(posicao: number, mudanca: Partial<ItemComEstoque>) {
    aoMudar(rascunho.itens.map((item, i) => i === posicao ? { ...item, ...mudanca } : item))
  }
  const produtos = escolhendo === null ? [] : lerProdutos(catalogo).filter(({ produto, categoria }) =>
    [produto.nome, produto.marca, produto.codigoCatalogo, categoria.nome].some((s) => s?.toLocaleLowerCase('pt-BR').includes(busca.trim().toLocaleLowerCase('pt-BR'))))
  return <>
    <ul className="m-0 mt-2 list-none p-0" aria-label="Itens da venda">
      {rascunho.itens.map((item, i) => <li key={i} className="mb-4 border-b border-borda pb-3" data-item-venda={i}>
        <div className="flex flex-wrap gap-2">
          <input className={`${CLASSES_DE_CAMPO} min-w-0 flex-1 basis-36`} type="text" autoComplete="off" placeholder="O que levou" aria-label={`Item ${i + 1}`} autoFocus={!correcao && i === 0}
            value={item.descricao} onChange={(e) => mudar(i, { descricao: e.target.value })} />
          <EntradaDeDinheiro className={`${CLASSES_DE_CAMPO_COMPACTO} w-[6.5rem] flex-none text-right tabular-nums`}
            texto={item.precoTexto} aoMudar={(precoTexto) => mudar(i, { precoTexto })} exemplo="0,00" rotuloAcessivel={`Preço unitário ${i + 1}`} permitirZero />
        </div>
        {!legada && <button type="button" className="min-h-11 border-0 bg-transparent px-0 text-left text-acento underline"
          onClick={() => { setEscolhendo(i); setBusca('') }}>{item.produtoId ? 'Mudar produto' : 'Escolher produto'}</button>}
        {item.produtoId && <button type="button" className="ml-3 min-h-11 border-0 bg-transparent px-0 text-acento underline"
          onClick={() => mudar(i, { produtoId: undefined, entregueTexto: undefined })}>É avulso</button>}
        {!legada && (item.produtoId || correcao) && <div className="flex flex-wrap gap-3">
          <label className="min-w-0 flex-1">Quantidade<input aria-label={`Quantidade ${i + 1}`} className={CLASSES_DE_CAMPO} inputMode="numeric"
            value={item.quantidadeTexto ?? '1'} onChange={(e) => mudar(i, { quantidadeTexto: e.target.value })} /></label>
          {item.produtoId && !correcao && <label className="min-w-0 flex-1">Entregue agora<input aria-label={`Entregue agora ${i + 1}`} className={CLASSES_DE_CAMPO} inputMode="numeric"
            value={item.entregueTexto ?? String(conferencia.linhas[i]?.entregue ?? 0)} onChange={(e) => mudar(i, { entregueTexto: e.target.value })} /></label>}
        </div>}
        {item.produtoId && <p className="my-1 text-sm text-suave">Disponível: {disponibilidade(estado, item.produtoId).disponivel}
          {!correcao && ` · A entregar: ${conferencia.linhas[i]?.pendente ?? 0}`}</p>}
      </li>)}
    </ul>
    {(!correcao || legada) && <Botao tipo="secundario" aoTocar={() => aoMudar([...rascunho.itens, { descricao: '', precoTexto: '' }])}>+ Mais um</Botao>}
    {escolhendo !== null && <section aria-label="Escolher produto" className="my-4 rounded-xl border border-borda bg-papel p-3">
      <h2 className="mt-0">Escolher produto</h2>
      <input className={CLASSES_DE_CAMPO} aria-label="Buscar produto" placeholder="Nome, marca, código ou categoria" value={busca} onChange={(e) => setBusca(e.target.value)} autoFocus />
      <Botao tipo="secundario" className="mt-2" aoTocar={() => setEscolhendo(null)}>Voltar aos itens</Botao>
      {produtos.length === 0 && <p>Nenhum produto encontrado. Pode anotar como avulso.</p>}
      <ul className="max-h-96 list-none overflow-y-auto p-0">
        {produtos.map(({ produto, categoria, miniatura }) => <li key={produto.id}><button type="button" data-escolher-produto={produto.id}
          className="flex min-h-24 w-full items-center gap-3 border-0 border-b border-borda bg-transparent py-3 text-left"
          onClick={() => { aoMudar(rascunho.itens.map((item, i) => i === escolhendo ? selecionarProduto(item, produto) : item)); setEscolhendo(null) }}>
          <MiniaturaProduto nome={produto.nome} binario={miniatura} temFoto={!!produto.fotoId} />
          <span className="min-w-0 break-words"><strong className="block">{produto.nome}</strong>
            <span className="block text-sm">{[rotuloDaCategoria(categoria, catalogo.categorias), produto.marca, produto.codigoCatalogo].filter(Boolean).join(' · ')}</span>
            <span>{produto.precoVenda === undefined ? 'Preço a informar' : emReais(produto.precoVenda)}</span></span>
        </button></li>)}
      </ul>
    </section>}
  </>
}
