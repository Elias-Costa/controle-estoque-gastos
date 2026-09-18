import type { Id } from '../dominio/ficha.ts'
import { CARIMBO_DE_BUILD } from '../plataforma/versao.ts'
import { Botao } from './Botao.tsx'
import { IndicadorDeEnvio } from './IndicadorDeEnvio.tsx'
import { Instalacao } from './Instalacao.tsx'
import { ListaDeFichas } from './ListaDeFichas.tsx'
import { PALAVRAS_DA_COBRANCA } from './palavras-da-cobranca.ts'
import { PALAVRAS } from './palavras-da-ficha.ts'
import { PALAVRAS_DA_VENDA } from './palavras-da-venda.ts'
import { BotaoEntrar } from './TelaEntrar.tsx'

/**
 * A tela inicial (E-09): a lista de fichinhas com busca — quem deve e quanto (RF-01, RF-10 em
 * versão de lista; a lista de devedores com ordem e filtro é "Quem está devendo", E-12, a um
 * toque do cabeçalho). É por onde todo caminho cronometrado começa (RNF-02), então o primeiro
 * toque é uma linha da lista: 60 px de altura.
 *
 * Fiel ao protótipo validado em 2026-09-08, com as divergências de D-044: o rodapé tem "Nova
 * venda" (principal, E-10) sobre "+ Nova fichinha" (secundário; era "+ É uma cliente nova" até
 * a visita de E-15, D-050 item 2), o indicador de RF-25 fica sob o título e o carimbo de RF-23
 * no pé da lista. Sem total agregado: "a receber na rua" é RF-19, F4. E-13 (D-048) pôs a linha
 * "Entrar ›" sob o indicador (só sem sessão guardada) e a instrução de instalação sob a lista
 * (só no celular, antes de instalar): as duas custam zero toques no caminho cronometrado. É a
 * única tela que lista as fichinhas desativadas, a um toque no fim da lista (D-050, item 6).
 */
export function TelaInicial({
  busca,
  aoBuscar,
  aoAbrirFicha,
  aoCadastrar,
  aoVender,
  aoVerDevedoras,
  aoEntrar,
}: {
  busca: string
  aoBuscar: (texto: string) => void
  aoAbrirFicha: (clienteId: Id) => void
  aoCadastrar: (nomeSugerido: string) => void
  aoVender: () => void
  aoVerDevedoras: () => void
  aoEntrar: () => void
}) {
  return (
    <main className="tela">
      <header className="mb-3">
        <div className="flex items-center justify-between gap-3">
          <h1 className="m-0 text-2xl leading-tight">{PALAVRAS.titulo}</h1>
          {/* A lista de devedores (RF-10, E-12) mora numa tela própria, aberta daqui: zero altura, o caminho cronometrado não muda (D-047). */}
          <button type="button" className="min-h-11 flex-none border-0 bg-transparent px-1 py-0 text-[1rem] font-semibold text-acento" onClick={aoVerDevedoras}>
            {PALAVRAS_DA_COBRANCA.quemEstaDevendo} <span aria-hidden="true">&rsaquo;</span>
          </button>
        </div>
        <IndicadorDeEnvio />
        <BotaoEntrar aoTocar={aoEntrar} />
      </header>

      <ListaDeFichas busca={busca} aoBuscar={aoBuscar} aoAbrir={aoAbrirFicha} chave="inicio" comDesativadas />

      <Instalacao />

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
