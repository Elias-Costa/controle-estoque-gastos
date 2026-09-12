import { repositorio } from '../dados/instancia.ts'
import type { Id } from '../dominio/ficha.ts'
import { CLASSES_DE_CAMPO } from './Campo.tsx'
import { hoje } from './datas.ts'
import { filtrarEOrdenar, resumir, type ResumoDaFicha } from './leitura-da-ficha.ts'
import { avisoDeAtraso, PALAVRAS, quantoDeve } from './palavras-da-ficha.ts'
import { useLeitura } from './useLeitura.ts'

/**
 * A busca e a lista de fichinhas — a mesma na tela inicial e em "Para quem?" da venda
 * (E-10, D-045): o que ela viu uma vez vale nas duas. Cada linha tem 60 px porque é o
 * primeiro toque de todo caminho cronometrado (RNF-02). `chave` distingue as duas leituras
 * para `useLeitura`; quem chama guarda a busca, porque cada tela decide se ela sobrevive.
 */
export function ListaDeFichas({
  busca,
  aoBuscar,
  aoAbrir,
  chave,
}: {
  busca: string
  aoBuscar: (texto: string) => void
  aoAbrir: (clienteId: Id) => void
  chave: string
}) {
  // Todas as clientes cabem em memória (RNF-05): uma leitura por ficha é o suficiente em F1.
  const leitura = useLeitura(async () => {
    const dia = hoje()
    const clientes = await repositorio.listarClientes()
    return Promise.all(clientes.map(async (cliente) => resumir(cliente, await repositorio.lerFicha(cliente.id), dia)))
  }, chave)

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

      {leitura.estado === 'lido' && <Lista resumos={filtrarEOrdenar(leitura.valor, busca)} haFichas={leitura.valor.length > 0} aoAbrir={aoAbrir} />}
      {leitura.estado === 'falhou' && <p className="mt-3 text-atraso">{PALAVRAS.naoDeuParaAbrir}</p>}
    </>
  )
}

/** A lista tocável: nome e apelido à esquerda; "em dia" ou quanto deve à direita, em vermelho se atrasada. */
function Lista({ resumos, haFichas, aoAbrir }: { resumos: ResumoDaFicha[]; haFichas: boolean; aoAbrir: (clienteId: Id) => void }) {
  if (resumos.length === 0) {
    return <p className="mt-3 text-suave">{haFichas ? PALAVRAS.ninguemComEsseNome : PALAVRAS.nenhumaFicha}</p>
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
