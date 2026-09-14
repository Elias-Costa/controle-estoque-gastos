import { useCallback, useState } from 'react'
import type { Centavos } from '../dominio/dinheiro.ts'
import type { Id } from '../dominio/ficha.ts'
import { TelaCadastro } from './TelaCadastro.tsx'
import { TelaDevedoras } from './TelaDevedoras.tsx'
import { TelaEntrar } from './TelaEntrar.tsx'
import { TelaFicha } from './TelaFicha.tsx'
import { TelaInicial } from './TelaInicial.tsx'
import { TelaLancamento } from './TelaLancamento.tsx'
import { TelaParaQuem } from './TelaParaQuem.tsx'
import { TelaRecebido } from './TelaRecebido.tsx'
import { TelaRecebimento } from './TelaRecebimento.tsx'
import { TelaVenda } from './TelaVenda.tsx'
import { TelaVendido } from './TelaVendido.tsx'

/**
 * Onde ela está. Sem roteador e sem URL: uma mão, o "‹" do topo (como o protótipo). A venda
 * tem três portas — "Para quem?", a ficha e a anotação (correção) — e `origem` diz para onde
 * o "‹" volta; o recebimento tem duas — a ficha e a anotação. O cadastro tem dois destinos
 * (D-045): a ficha nova, ou a venda para ela. A confirmação do recebimento carrega o `troco`,
 * que não é lançamento e a base não tem (D-016, D-046). A ficha sabe se veio da lista de
 * devedores (E-12, D-047), para o "‹" devolver ela ao mesmo lugar. O login (E-13, D-048) é uma
 * tela como as outras, aberta pela linha "Entrar ›" da inicial — nunca a primeira tela.
 */
type Rota =
  | { readonly tela: 'inicio' }
  | { readonly tela: 'entrar' }
  | { readonly tela: 'devedoras' }
  | { readonly tela: 'ficha'; readonly clienteId: Id; readonly origem?: 'devedoras' }
  | { readonly tela: 'cadastro'; readonly nome: string; readonly destino: 'ficha' | 'venda' }
  | { readonly tela: 'para-quem' }
  | { readonly tela: 'venda'; readonly clienteId: Id; readonly origem: 'para-quem' | 'ficha' | 'lancamento'; readonly corrigirId?: Id }
  | { readonly tela: 'vendido'; readonly clienteId: Id; readonly vendaId: Id }
  | { readonly tela: 'recebimento'; readonly clienteId: Id; readonly origem: 'ficha' | 'lancamento'; readonly corrigirId?: Id }
  | { readonly tela: 'recebido'; readonly clienteId: Id; readonly recebimentoId: Id; readonly troco: Centavos }
  | { readonly tela: 'lancamento'; readonly clienteId: Id; readonly lancamentoId: Id }

/**
 * O aplicativo (E-09 a E-12): a tela inicial, a lista de devedores, a ficha, o cadastro, as
 * quatro telas da venda e as duas do recebimento. Estado de navegação em memória — recarregar
 * volta ao início, e está bem: nenhuma tela guarda nada que a base não tenha.
 *
 * A busca vive aqui, e não na tela inicial, para sobreviver à ida e volta da ficha: era assim
 * no protótipo (as seções eram escondidas, não destruídas) e é o que ela viu na sessão.
 */
export function Aplicativo() {
  const [rota, setRota] = useState<Rota>({ tela: 'inicio' })
  const [busca, setBusca] = useState('')
  const irParaInicio = useCallback(() => setRota({ tela: 'inicio' }), [])
  const irParaDevedoras = useCallback(() => setRota({ tela: 'devedoras' }), [])
  const irParaFicha = useCallback((clienteId: Id) => setRota({ tela: 'ficha', clienteId }), [])

  switch (rota.tela) {
    case 'inicio':
      return (
        <TelaInicial
          busca={busca}
          aoBuscar={setBusca}
          aoAbrirFicha={irParaFicha}
          aoCadastrar={(nome) => setRota({ tela: 'cadastro', nome, destino: 'ficha' })}
          aoVender={() => setRota({ tela: 'para-quem' })}
          aoVerDevedoras={() => setRota({ tela: 'devedoras' })}
          aoEntrar={() => setRota({ tela: 'entrar' })}
        />
      )
    case 'entrar':
      return <TelaEntrar aoVoltar={irParaInicio} aoEntrar={irParaInicio} />
    case 'devedoras':
      return <TelaDevedoras aoVoltar={irParaInicio} aoAbrirFicha={(clienteId) => setRota({ tela: 'ficha', clienteId, origem: 'devedoras' })} />
    case 'ficha':
      return (
        <TelaFicha
          clienteId={rota.clienteId}
          aoVoltar={rota.origem === 'devedoras' ? irParaDevedoras : irParaInicio}
          aoReceber={() => setRota({ tela: 'recebimento', clienteId: rota.clienteId, origem: 'ficha' })}
          aoVender={() => setRota({ tela: 'venda', clienteId: rota.clienteId, origem: 'ficha' })}
          aoAbrirLancamento={(lancamentoId) => setRota({ tela: 'lancamento', clienteId: rota.clienteId, lancamentoId })}
        />
      )
    case 'cadastro':
      return (
        <TelaCadastro
          nomeInicial={rota.nome}
          aoVoltar={() => setRota(rota.destino === 'venda' ? { tela: 'para-quem' } : { tela: 'inicio' })}
          aoCadastrar={(clienteId) => {
            // A cliente nova já está na lista: a busca que não a achava sairia vazia ao voltar.
            setBusca('')
            setRota(rota.destino === 'venda' ? { tela: 'venda', clienteId, origem: 'para-quem' } : { tela: 'ficha', clienteId })
          }}
        />
      )
    case 'para-quem':
      return (
        <TelaParaQuem
          aoVoltar={irParaInicio}
          aoEscolher={(clienteId) => setRota({ tela: 'venda', clienteId, origem: 'para-quem' })}
          aoCadastrar={(nome) => setRota({ tela: 'cadastro', nome, destino: 'venda' })}
        />
      )
    case 'venda': {
      const { clienteId, origem, corrigirId } = rota
      const voltar = (): void => {
        if (origem === 'lancamento' && corrigirId !== undefined) setRota({ tela: 'lancamento', clienteId, lancamentoId: corrigirId })
        else if (origem === 'ficha') setRota({ tela: 'ficha', clienteId })
        else setRota({ tela: 'para-quem' })
      }
      return (
        <TelaVenda
          clienteId={clienteId}
          corrigirId={corrigirId}
          aoVoltar={voltar}
          aoVender={(vendaId) => setRota({ tela: 'vendido', clienteId, vendaId })}
          aoCorrigir={() => irParaFicha(clienteId)}
        />
      )
    }
    case 'vendido':
      return <TelaVendido clienteId={rota.clienteId} vendaId={rota.vendaId} aoVerFicha={() => irParaFicha(rota.clienteId)} aoVoltarAoInicio={irParaInicio} />
    case 'recebimento': {
      const { clienteId, origem, corrigirId } = rota
      const voltar = (): void => {
        if (origem === 'lancamento' && corrigirId !== undefined) setRota({ tela: 'lancamento', clienteId, lancamentoId: corrigirId })
        else setRota({ tela: 'ficha', clienteId })
      }
      return (
        <TelaRecebimento
          clienteId={clienteId}
          corrigirId={corrigirId}
          aoVoltar={voltar}
          aoReceber={(recebimentoId, troco) => setRota({ tela: 'recebido', clienteId, recebimentoId, troco })}
          aoCorrigir={() => irParaFicha(clienteId)}
        />
      )
    }
    case 'recebido':
      return (
        <TelaRecebido
          clienteId={rota.clienteId}
          recebimentoId={rota.recebimentoId}
          troco={rota.troco}
          aoVerFicha={() => irParaFicha(rota.clienteId)}
          aoVoltarAoInicio={irParaInicio}
        />
      )
    case 'lancamento':
      return (
        <TelaLancamento
          clienteId={rota.clienteId}
          lancamentoId={rota.lancamentoId}
          aoVoltar={() => irParaFicha(rota.clienteId)}
          aoCorrigir={(tipo) => setRota({ tela: tipo === 'venda' ? 'venda' : 'recebimento', clienteId: rota.clienteId, origem: 'lancamento', corrigirId: rota.lancamentoId })}
        />
      )
  }
}
