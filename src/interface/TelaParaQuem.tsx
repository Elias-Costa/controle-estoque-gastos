import { useState } from 'react'
import type { Id } from '../dominio/ficha.ts'
import { Botao } from './Botao.tsx'
import { ListaDeFichas } from './ListaDeFichas.tsx'
import { PALAVRAS } from './palavras-da-ficha.ts'
import { PALAVRAS_DA_VENDA } from './palavras-da-venda.ts'
import { Topo } from './Topo.tsx'

/**
 * "Para quem?" (E-10): a primeira tela da venda que começa pela tela inicial. Separada da
 * tela de itens de propósito, como no protótipo — escolher a pessoa e listar o que ela levou
 * são dois momentos, e juntá-los encheria a primeira dobra. A busca é local: quem volta daqui
 * volta para o começo, não para uma busca antiga.
 *
 * "+ É uma cliente nova" abre o cadastro de E-09 com o nome já digitado; o cadastro volta
 * **para a venda** da cliente nova (D-045) — é o que o protótipo fazia, e é a razão de o
 * botão existir aqui: a sessão de E-02 mediu se ela procura por ele no meio da venda.
 */
export function TelaParaQuem({
  aoVoltar,
  aoEscolher,
  aoCadastrar,
}: {
  aoVoltar: () => void
  aoEscolher: (clienteId: Id) => void
  aoCadastrar: (nomeSugerido: string) => void
}) {
  const [busca, setBusca] = useState('')
  return (
    <main className="tela">
      <Topo titulo={PALAVRAS_DA_VENDA.paraQuem} aoVoltar={aoVoltar} />
      <ListaDeFichas busca={busca} aoBuscar={setBusca} aoAbrir={aoEscolher} chave="para-quem" />
      <div className="rodape-acao">
        <Botao tipo="secundario" aoTocar={() => aoCadastrar(busca.trim())}>
          {PALAVRAS.clienteNova}
        </Botao>
      </div>
    </main>
  )
}
