import type { Id } from '../dominio/ficha.ts'
import { CARIMBO_DE_BUILD } from '../plataforma/versao.ts'
import { Botao } from './Botao.tsx'
import { IndicadorDeEnvio } from './IndicadorDeEnvio.tsx'
import { ListaDeFichas } from './ListaDeFichas.tsx'
import { PALAVRAS } from './palavras-da-ficha.ts'
import { PALAVRAS_DA_VENDA } from './palavras-da-venda.ts'

/**
 * A tela inicial (E-09): a lista de fichinhas com busca — quem deve e quanto (RF-01, RF-10 em
 * versão de lista; a ordenação e o filtro de devedores são E-12). É por onde todo caminho
 * cronometrado começa (RNF-02), então o primeiro toque é uma linha da lista: 60 px de altura.
 *
 * Fiel ao protótipo validado em 2026-09-08, com as divergências de D-044: o rodapé tem "Nova
 * venda" (principal, E-10) sobre "+ É uma cliente nova" (secundário), o indicador de RF-25 fica
 * sob o título e o carimbo de RF-23 no pé da lista. Sem total agregado: "a receber na rua" é
 * RF-19, F4. "Recebi" nasce em E-11 — botão morto é defeito, não promessa.
 */
export function TelaInicial({
  busca,
  aoBuscar,
  aoAbrirFicha,
  aoCadastrar,
  aoVender,
}: {
  busca: string
  aoBuscar: (texto: string) => void
  aoAbrirFicha: (clienteId: Id) => void
  aoCadastrar: (nomeSugerido: string) => void
  aoVender: () => void
}) {
  return (
    <main className="tela">
      <header className="mb-3">
        <h1 className="m-0 text-2xl leading-tight">{PALAVRAS.titulo}</h1>
        <IndicadorDeEnvio />
      </header>

      <ListaDeFichas busca={busca} aoBuscar={aoBuscar} aoAbrir={aoAbrirFicha} chave="inicio" />

      {/* Discreto de propósito: serve ao mantenedor durante o teste, não a ela (RF-23, D-032). */}
      <p className="mt-6 text-[0.8rem] text-suave">versão {CARIMBO_DE_BUILD}</p>

      <div className="rodape-acao">
        <Botao tipo="principal" aoTocar={aoVender}>
          {PALAVRAS_DA_VENDA.novaVenda}
        </Botao>
        <Botao tipo="secundario" aoTocar={() => aoCadastrar(busca.trim())}>
          {PALAVRAS.clienteNova}
        </Botao>
      </div>
    </main>
  )
}
