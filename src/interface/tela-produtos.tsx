import { RodapeDeAcoes } from './rodape-de-acoes.tsx'
import { repositorioEstoque } from '../dados/instancia.ts'
import { emReais } from '../dominio/dinheiro.ts'
import { categoriasComMesmoNome } from '../dominio/produtos.ts'
import { Botao } from './Botao.tsx'
import { IndicadorDeEnvio } from './IndicadorDeEnvio.tsx'
import { lerProdutos, rotuloDaCategoria } from './leitura-de-produtos.ts'
import { MiniaturaProduto } from './miniatura-produto.tsx'
import { PALAVRAS_DOS_PRODUTOS as P } from './palavras-dos-produtos.ts'
import { PALAVRAS_DA_DIVULGACAO } from './palavras-da-divulgacao.ts'
import { Topo } from './Topo.tsx'
import { useLeitura } from './useLeitura.ts'

/** Consulta local de RF-11/25; cada linha abre o cadastro, sem filtro ou manutenção de categorias. */
export function TelaProdutos({ aoVoltar, aoNovo, aoAbrir, aoMinimo, aoDivulgar }: { aoVoltar: () => void; aoNovo: () => void; aoAbrir: (id: string) => void; aoMinimo: () => void; aoDivulgar: () => void }) {
  const leitura = useLeitura(async () => {
    const catalogo = await repositorioEstoque.lerCatalogo()
    return { catalogo, linhas: lerProdutos(catalogo) }
  }, 'produtos')
  return (
    <main className="tela">
      <Topo titulo={P.titulo} aoVoltar={aoVoltar} acao={{ texto: P.noMinimo, aoTocar: aoMinimo }} />
      <IndicadorDeEnvio />
      <Botao tipo="secundario" className="mt-3" aoTocar={aoDivulgar}>{PALAVRAS_DA_DIVULGACAO.abrir}</Botao>
      {leitura.estado !== 'lido' ? <p role="status">{leitura.estado === 'lendo' ? P.lendo : P.falhaLeitura}</p> : <>
        {leitura.valor.catalogo.categorias.some((categoria) => categoriasComMesmoNome(categoria, leitura.valor.catalogo.categorias).length > 0) &&
          <p role="status" className="rounded-xl border border-borda bg-papel p-3">{P.categoriasIguais}</p>}
        {leitura.valor.linhas.length === 0 && <p>{P.vazio}</p>}
        <ul className="mt-4 list-none p-0" aria-label={P.titulo}>
          {leitura.valor.linhas.map(({ produto, categoria, miniatura }) => <li key={produto.id}>
            <button type="button" data-produto-id={produto.id} className="flex min-h-24 w-full items-center gap-3 border-0 border-b border-solid border-borda bg-transparent py-3 text-left" onClick={() => aoAbrir(produto.id)}>
              <MiniaturaProduto binario={miniatura} nome={produto.nome} temFoto={!!produto.fotoId} />
              <span className="min-w-0 flex-1 break-words">
                <span className="block font-semibold">{produto.nome}</span>
                <span className="block text-sm text-suave">{[rotuloDaCategoria(categoria, leitura.valor.catalogo.categorias), produto.marca, produto.codigoCatalogo].filter(Boolean).join(' · ')}</span>
                {produto.precoVenda !== undefined && <span className="block">{emReais(produto.precoVenda)}</span>}
              </span>
              <span aria-hidden="true">&rsaquo;</span>
            </button>
          </li>)}
        </ul>
      </>}
      <RodapeDeAcoes><Botao tipo="principal" aoTocar={aoNovo}>{P.novo}</Botao></RodapeDeAcoes>
    </main>
  )
}
