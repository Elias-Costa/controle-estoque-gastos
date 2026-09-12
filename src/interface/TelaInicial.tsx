import { repositorio } from '../dados/instancia.ts'
import type { Id } from '../dominio/ficha.ts'
import { CARIMBO_DE_BUILD } from '../plataforma/versao.ts'
import { Botao } from './Botao.tsx'
import { CLASSES_DE_CAMPO } from './Campo.tsx'
import { hoje } from './datas.ts'
import { IndicadorDeEnvio } from './IndicadorDeEnvio.tsx'
import { filtrarEOrdenar, resumir, type ResumoDaFicha } from './leitura-da-ficha.ts'
import { avisoDeAtraso, PALAVRAS, quantoDeve } from './palavras-da-ficha.ts'
import { useLeitura } from './useLeitura.ts'

/**
 * A tela inicial (E-09): a lista de fichinhas com busca — quem deve e quanto (RF-01, RF-10 em
 * versão de lista; a ordenação e o filtro de devedores são E-12). É por onde todo caminho
 * cronometrado começa (RNF-02), então o primeiro toque é uma linha da lista: 60 px de altura.
 *
 * Fiel ao protótipo validado em 2026-09-08, com as divergências de D-044: o rodapé tem
 * "+ É uma cliente nova" (o "Nova venda" nasce em E-10 — botão morto é defeito, não promessa),
 * o indicador de RF-25 fica sob o título e o carimbo de RF-23 no pé da lista. Sem total
 * agregado: "a receber na rua" é RF-19, F4.
 */
export function TelaInicial({
  busca,
  aoBuscar,
  aoAbrirFicha,
  aoCadastrar,
}: {
  busca: string
  aoBuscar: (texto: string) => void
  aoAbrirFicha: (clienteId: Id) => void
  aoCadastrar: (nomeSugerido: string) => void
}) {
  // Todas as clientes cabem em memória (RNF-05): uma leitura por ficha é o suficiente em F1.
  const leitura = useLeitura(async () => {
    const dia = hoje()
    const clientes = await repositorio.listarClientes()
    return Promise.all(clientes.map(async (cliente) => resumir(cliente, await repositorio.lerFicha(cliente.id), dia)))
  }, 'inicio')

  return (
    <main className="tela">
      <header className="mb-3">
        <h1 className="m-0 text-2xl leading-tight">{PALAVRAS.titulo}</h1>
        <IndicadorDeEnvio />
      </header>

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

      {leitura.estado === 'lido' && <Lista resumos={filtrarEOrdenar(leitura.valor, busca)} haFichas={leitura.valor.length > 0} aoAbrir={aoAbrirFicha} />}
      {leitura.estado === 'falhou' && <p className="mt-3 text-atraso">{PALAVRAS.naoDeuParaAbrir}</p>}

      {/* Discreto de propósito: serve ao mantenedor durante o teste, não a ela (RF-23, D-032). */}
      <p className="mt-6 text-[0.8rem] text-suave">versão {CARIMBO_DE_BUILD}</p>

      <div className="rodape-acao">
        <Botao tipo="secundario" aoTocar={() => aoCadastrar(busca.trim())}>
          {PALAVRAS.clienteNova}
        </Botao>
      </div>
    </main>
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
