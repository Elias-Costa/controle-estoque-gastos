import { useState } from 'react'
import type { Id } from '../dominio/ficha.ts'
import { CLASSES_DE_CAMPO } from './Campo.tsx'
import { lerResumos } from './ler-resumos.ts'
import { ativas, desativadas, filtrarEOrdenar, type ResumoDaFicha } from './leitura-da-ficha.ts'
import { avisoDeAtraso, PALAVRAS, quantoDeve, verDesativadas } from './palavras-da-ficha.ts'
import { useLeitura } from './useLeitura.ts'

/**
 * A busca e a lista de fichinhas — a mesma na tela inicial e em "Para quem?" da venda
 * (E-10, D-045): o que ela viu uma vez vale nas duas. Cada linha tem 60 px porque é o
 * primeiro toque de todo caminho cronometrado (RNF-02). `chave` distingue as duas leituras
 * para `useLeitura`; quem chama guarda a busca, porque cada tela decide se ela sobrevive.
 *
 * Só as fichinhas ativas aparecem (D-050, item 6). Com `comDesativadas` — só a tela inicial —,
 * uma linha de texto no fim, "Ver as fichinhas desativadas (N)", troca a lista pelas
 * desativadas naquela abertura (a busca vale nas duas); some com N = 0. "Para quem?" não a
 * tem: não se vende para fichinha desativada sem antes reativá-la.
 */
export function ListaDeFichas({
  busca,
  aoBuscar,
  aoAbrir,
  chave,
  comDesativadas = false,
}: {
  busca: string
  aoBuscar: (texto: string) => void
  aoAbrir: (clienteId: Id) => void
  chave: string
  comDesativadas?: boolean
}) {
  const leitura = useLeitura(lerResumos, chave)
  const [mostrandoDesativadas, setMostrandoDesativadas] = useState(false)

  return (
    <>
      <input
        className={CLASSES_DE_CAMPO}
        type="search"
        inputMode="search"
        autoComplete="off"
        placeholder={PALAVRAS.procurar}
        aria-label={PALAVRAS.procurar}
        value={busca}
        onChange={(evento) => aoBuscar(evento.target.value)}
      />

      {leitura.estado === 'lido' && (
        <ListaLida resumos={leitura.valor} busca={busca} aoAbrir={aoAbrir} mostrandoDesativadas={comDesativadas && mostrandoDesativadas} aoAlternar={comDesativadas ? () => setMostrandoDesativadas((atual) => !atual) : undefined} />
      )}
      {leitura.estado === 'falhou' && <p className="mt-3 text-atraso">{PALAVRAS.naoDeuParaAbrir}</p>}
    </>
  )
}

/** A lista depois de lida: as ativas (ou as desativadas, a um toque) e a linha de alternar. */
function ListaLida({
  resumos,
  busca,
  aoAbrir,
  mostrandoDesativadas,
  aoAlternar,
}: {
  resumos: ResumoDaFicha[]
  busca: string
  aoAbrir: (clienteId: Id) => void
  mostrandoDesativadas: boolean
  aoAlternar: (() => void) | undefined
}) {
  const inativas = desativadas(resumos)
  const visiveis = mostrandoDesativadas ? inativas : ativas(resumos)
  const vazia = visiveis.length > 0 ? PALAVRAS.ninguemComEsseNome : mostrandoDesativadas ? PALAVRAS.nenhumaDesativada : PALAVRAS.nenhumaFicha
  return (
    <>
      <Lista resumos={filtrarEOrdenar(visiveis, busca)} vazia={vazia} aoAbrir={aoAbrir} />
      {aoAlternar !== undefined && (inativas.length > 0 || mostrandoDesativadas) && (
        <button type="button" className="mt-3 block min-h-11 border-0 bg-transparent p-0 text-left text-[1rem] text-acento underline" onClick={aoAlternar}>
          {mostrandoDesativadas ? PALAVRAS.voltarParaAsFichinhas : verDesativadas(inativas.length)}
        </button>
      )}
    </>
  )
}

/**
 * A lista tocável: nome e apelido à esquerda; "em dia" ou quanto deve à direita, em vermelho se
 * em atraso, com "em atraso há N dias" (RF-10). `vazia` é o que dizer quando não há linha — cada
 * tela sabe o motivo. A mesma linha serve à lista de devedores (E-12).
 */
export function Lista({ resumos, vazia, aoAbrir }: { resumos: ResumoDaFicha[]; vazia: string; aoAbrir: (clienteId: Id) => void }) {
  if (resumos.length === 0) {
    return <p className="mt-3 text-suave">{vazia}</p>
  }
  return (
    <ul className="m-0 mt-3 list-none p-0">
      {resumos.map((resumo) => {
        const atrasada = resumo.diasDeAtraso > 0
        return (
          <li key={resumo.cliente.id}>
            <button
              type="button"
              className="mb-2 flex min-h-[60px] w-full items-center justify-between gap-3 rounded-xl border border-borda bg-papel px-3.5 py-3 text-left text-tinta"
              onClick={() => aoAbrir(resumo.cliente.id)}
            >
              <span className="min-w-0 font-semibold">
                {resumo.cliente.nome}
                {resumo.cliente.apelido !== undefined && resumo.cliente.apelido !== '' && (
                  <span className="block truncate text-[0.85rem] font-normal text-suave">{resumo.cliente.apelido}</span>
                )}
              </span>
              <span className={`flex-none text-right whitespace-nowrap tabular-nums ${atrasada ? 'text-atraso' : ''}`}>
                {quantoDeve(resumo.saldo)}
                {atrasada && <span className="block text-[0.8rem]">{avisoDeAtraso(resumo.diasDeAtraso)}</span>}
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
