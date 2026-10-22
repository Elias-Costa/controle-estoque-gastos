import { repositorioEstoque } from '../dados/instancia.ts'
import { IndicadorDeEnvio } from './IndicadorDeEnvio.tsx'
import { PALAVRAS_DO_ESTOQUE as E } from './palavras-do-estoque.ts'
import { PALAVRAS_DOS_PRODUTOS as P } from './palavras-dos-produtos.ts'
import { lerProdutosNoMinimo } from './produtos-no-minimo.ts'
import { Topo } from './Topo.tsx'
import { useLeitura } from './useLeitura.ts'

/** Lista local de RF-15/25; abrir o estoque permite conferir e voltar à leitura atualizada. */
export function TelaProdutosNoMinimo({ aoVoltar, aoAbrir }: { aoVoltar: () => void; aoAbrir: (id: string) => void }) {
  const leitura = useLeitura(async () => lerProdutosNoMinimo(await repositorioEstoque.lerEstado()), 'produtos-no-minimo')
  return <main className="tela">
    <Topo titulo={P.noMinimo} aoVoltar={aoVoltar} />
    <IndicadorDeEnvio />
    <p>{P.explicacaoDoMinimo}</p>
    {leitura.estado !== 'lido' ? <p role="status">{leitura.estado === 'lendo' ? P.lendo : P.falhaLeitura}</p> : <>
      {leitura.valor.length === 0 && <p>{P.vazioNoMinimo}</p>}
      <ul className="mt-4 list-none p-0" aria-label={P.noMinimo}>
        {leitura.valor.map(({ produto, fisico, prometido, disponivel, falta, contagensAfetadas, divergenciaFisica }) => <li key={produto.id}>
          <button type="button" data-produto-minimo-id={produto.id} className="flex min-h-24 w-full items-center gap-3 border-0 border-b border-solid border-borda bg-transparent py-3 text-left" onClick={() => aoAbrir(produto.id)}>
            <span className="min-w-0 flex-1 break-words">
              <span className="block font-semibold">{produto.nome}</span>
              <span className="block text-sm text-suave">{[produto.marca, produto.codigoCatalogo].filter(Boolean).join(' · ')}</span>
              <span className="block">{P.disponivel}: {disponivel} · {P.minimo}: {produto.estoqueMinimo}</span>
              <span className="block">{E.fisico}: {fisico} · {P.prometido}: {prometido}</span>
              {falta > 0 && <span className="block font-semibold text-atraso">{P.faltam} {falta}</span>}
              {contagensAfetadas && <span className="block font-semibold text-atraso">{E.afetada}</span>}
              {divergenciaFisica && <span className="block font-semibold text-atraso">{E.divergencia}</span>}
            </span>
            <span aria-hidden="true">&rsaquo;</span>
          </button>
        </li>)}
      </ul>
    </>}
  </main>
}
