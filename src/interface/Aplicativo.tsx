import { useCallback, useState } from 'react'
import type { Id } from '../dominio/ficha.ts'
import { TelaCadastro } from './TelaCadastro.tsx'
import { TelaFicha } from './TelaFicha.tsx'
import { TelaInicial } from './TelaInicial.tsx'

/** Onde ela está. Sem roteador e sem URL: três telas, uma mão, o "‹" do topo (como o protótipo). */
type Rota = { readonly tela: 'inicio' } | { readonly tela: 'ficha'; readonly clienteId: Id } | { readonly tela: 'cadastro'; readonly nome: string }

/**
 * O aplicativo (E-09): a tela inicial, a ficha e o cadastro. Estado de navegação em memória —
 * recarregar volta ao início, e está bem: nenhuma tela guarda nada que a base não tenha.
 *
 * A busca vive aqui, e não na tela inicial, para sobreviver à ida e volta da ficha: era assim
 * no protótipo (as seções eram escondidas, não destruídas) e é o que ela viu na sessão.
 */
export function Aplicativo() {
  const [rota, setRota] = useState<Rota>({ tela: 'inicio' })
  const [busca, setBusca] = useState('')
  const irParaInicio = useCallback(() => setRota({ tela: 'inicio' }), [])

  switch (rota.tela) {
    case 'inicio':
      return (
        <TelaInicial
          busca={busca}
          aoBuscar={setBusca}
          aoAbrirFicha={(clienteId) => setRota({ tela: 'ficha', clienteId })}
          aoCadastrar={(nome) => setRota({ tela: 'cadastro', nome })}
        />
      )
    case 'ficha':
      return <TelaFicha clienteId={rota.clienteId} aoVoltar={irParaInicio} />
    case 'cadastro':
      return (
        <TelaCadastro
          nomeInicial={rota.nome}
          aoVoltar={irParaInicio}
          aoCadastrar={(clienteId) => {
            // A cliente nova já está na lista: a busca que não a achava sairia vazia ao voltar.
            setBusca('')
            setRota({ tela: 'ficha', clienteId })
          }}
        />
      )
  }
}
