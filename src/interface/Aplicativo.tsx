import { useCallback, useState } from 'react'
import type { Centavos } from '../dominio/dinheiro.ts'
import type { Dia, Id } from '../dominio/ficha.ts'
import type { ReferenciaEfeito } from '../dominio/estoque.ts'
import { TelaCadastro } from './TelaCadastro.tsx'
import { TelaDadosDoCliente } from './TelaDadosDoCliente.tsx'
import { TelaDevedoras } from './TelaDevedoras.tsx'
import { TelaEntrar } from './TelaEntrar.tsx'
import { TelaFicha } from './TelaFicha.tsx'
import { TelaInicial } from './TelaInicial.tsx'
import { TelaLancamento } from './TelaLancamento.tsx'
import { TelaParaQuem } from './TelaParaQuem.tsx'
import { TelaRecebido } from './TelaRecebido.tsx'
import { TelaRecebimento } from './TelaRecebimento.tsx'
import { TelaSaldoAnterior } from './TelaSaldoAnterior.tsx'
import { TelaVenda } from './TelaVenda.tsx'
import { TelaVendido } from './TelaVendido.tsx'
import { TelaProdutos } from './tela-produtos.tsx'
import { TelaProduto } from './tela-produto.tsx'
import { TelaEstoque } from './tela-estoque.tsx'
import { TelaEntrada } from './tela-entrada.tsx'
import { TelaAjuste } from './tela-ajuste.tsx'
import { TelaConferencias } from './tela-conferencias.tsx'
import { TelaProdutosNoMinimo } from './tela-produtos-no-minimo.tsx'
import { TelaCaixa } from './tela-caixa.tsx'
import { TelaMovimentoCaixa } from './tela-movimento-caixa.tsx'
import { TelaCopia } from './tela-copia.tsx'
import { TelaModelos } from './tela-modelos.tsx'
import { hoje } from './datas.ts'
import type { CorteCaixa } from './leitura-do-caixa.ts'
import type { ReferenciaFatoCaixa } from '../dominio/gastos.ts'
import { TelaDivulgacao } from './tela-divulgacao.tsx'

/**
 * Onde ela está. Sem roteador e sem URL: uma mão, o "‹" do topo (como o protótipo). A venda
 * tem três portas — "Para quem?", a ficha e a anotação (correção) — e `origem` diz para onde
 * o "‹" volta; o recebimento tem duas — a ficha e a anotação. O cadastro tem dois destinos
 * (D-045): a ficha nova, ou a venda para ela. A confirmação do recebimento carrega o `troco`,
 * que não é lançamento e a base não tem (D-016, D-046). A ficha sabe se veio da lista de
 * devedores (E-12, D-047), para o "‹" devolver ela ao mesmo lugar. O login (E-13, D-048) é uma
 * tela como as outras, aberta pela linha "Entrar ›" da inicial — nunca a primeira tela. O saldo
 * anterior (E-14, D-049) tem duas portas — a linha no fim da ficha e a anotação (correção).
 * "Mudar dados" (E-16, D-050) abre do cabeçalho de uma ficha ativa; "Pronto" volta à ficha,
 * desativar volta ao início — a ficha sumiu da lista, e é a lista que mostra isso. Reativar
 * é na própria ficha, sem navegar.
 */
type Rota =
  | { readonly tela: 'inicio' }
  | { readonly tela: 'copia' }
  | { readonly tela: 'modelos' }
  | { readonly tela: 'caixa' }
  | { readonly tela: 'movimento-caixa'; readonly tipo: 'despesa' | 'receita-avulsa'; readonly alvo?: ReferenciaFatoCaixa }
  | { readonly tela: 'conferencias' }
  | { readonly tela: 'produtos' }
  | { readonly tela: 'minimo' }
  | { readonly tela: 'divulgacao' }
  | { readonly tela: 'produto'; readonly produtoId?: Id; readonly origem?: 'estoque' }
  | { readonly tela: 'estoque'; readonly produtoId: Id }
  | { readonly tela: 'entrada'; readonly produtoId: Id; readonly tipo: 'compra' | 'estoque-inicial'; readonly alvo?: ReferenciaEfeito }
  | { readonly tela: 'ajuste'; readonly produtoId: Id; readonly alvo?: ReferenciaEfeito; readonly conferir?: boolean }
  | { readonly tela: 'entrar'; readonly origem?: 'copia' }
  | { readonly tela: 'devedoras' }
  | { readonly tela: 'ficha'; readonly clienteId: Id; readonly origem?: 'devedoras' }
  | { readonly tela: 'cadastro'; readonly nome: string; readonly destino: 'ficha' | 'venda' }
  | { readonly tela: 'dados'; readonly clienteId: Id }
  | { readonly tela: 'para-quem' }
  | { readonly tela: 'venda'; readonly clienteId: Id; readonly origem: 'para-quem' | 'ficha' | 'lancamento'; readonly corrigirId?: Id }
  | { readonly tela: 'vendido'; readonly clienteId: Id; readonly vendaId: Id }
  | { readonly tela: 'recebimento'; readonly clienteId: Id; readonly origem: 'ficha' | 'lancamento'; readonly corrigirId?: Id }
  | { readonly tela: 'recebido'; readonly clienteId: Id; readonly recebimentoId: Id; readonly troco: Centavos }
  | { readonly tela: 'lancamento'; readonly clienteId: Id; readonly lancamentoId: Id; readonly estoqueId?: Id }
  | { readonly tela: 'saldo-anterior'; readonly clienteId: Id; readonly origem: 'ficha' | 'lancamento'; readonly corrigirId?: Id }

/**
 * O aplicativo (E-09 a E-12): a tela inicial, a lista de devedores, a ficha, o cadastro, as
 * quatro telas da venda e as duas do recebimento. Estado de navegação em memória — recarregar
 * volta ao início, e está bem: nenhuma tela guarda nada que a base não tenha.
 *
 * A busca vive aqui, e não na tela inicial, para sobreviver à ida e volta da ficha: era assim
 * no protótipo (as seções eram escondidas, não destruídas) e é o que ela viu na sessão.
 *
 * `outroDiaLembrado` é a última data que ela digitou (D-049, item 1): "Outro dia" na venda e
 * no recebimento, e "Desde" no saldo anterior, já vêm com ela. Vive aqui, e não na base, por
 * ser conveniência de sessão — recarregar esquece, e nada se perde com isso.
 */
export function Aplicativo() {
  const [rota, setRota] = useState<Rota>({ tela: 'inicio' })
  const [busca, setBusca] = useState('')
  const [mesCaixa, setMesCaixa] = useState(() => hoje().slice(0, 7))
  const [corteCaixa, setCorteCaixa] = useState<CorteCaixa>('tudo')
  // Conserva a lista de origem durante entrada, ajuste, edição ou entrega pelo estoque.
  const [origemEstoque, setOrigemEstoque] = useState<'produtos' | 'minimo'>('produtos')
  const [outroDiaLembrado, setOutroDiaLembrado] = useState<Dia>('')
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
          aoVerProdutos={() => setRota({ tela: 'produtos' })}
          aoConferir={() => setRota({ tela: 'conferencias' })}
          aoVerCaixa={() => setRota({ tela: 'caixa' })}
          aoCopia={() => setRota({ tela: 'copia' })}
          aoModelos={() => setRota({ tela: 'modelos' })}
        />
      )
    case 'copia': return <TelaCopia aoVoltar={irParaInicio} aoEntrar={() => setRota({ tela: 'entrar', origem: 'copia' })} />
    case 'modelos': return <TelaModelos aoVoltar={irParaInicio} />
    case 'caixa':
      return <TelaCaixa mes={mesCaixa} corte={corteCaixa} aoMes={setMesCaixa} aoCorte={setCorteCaixa} aoVoltar={irParaInicio}
        aoAnotar={(tipo) => setRota({ tela: 'movimento-caixa', tipo })}
        aoCorrigir={(fato) => setRota({ tela: 'movimento-caixa', tipo: fato.tipo, alvo: { id: fato.id, revisao: fato.revisao } })} />
    case 'movimento-caixa':
      return <TelaMovimentoCaixa key={rota.alvo?.id ?? rota.tipo} tipo={rota.tipo} alvo={rota.alvo} aoVoltar={() => setRota({ tela: 'caixa' })}
        aoSalvar={(mes) => { setMesCaixa(mes); setCorteCaixa('tudo'); setRota({ tela: 'caixa' }) }} />
    case 'conferencias': return <TelaConferencias aoVoltar={irParaInicio} />
    case 'produtos':
      return <TelaProdutos aoVoltar={irParaInicio} aoNovo={() => setRota({ tela: 'produto' })}
        aoDivulgar={() => setRota({ tela: 'divulgacao' })}
        aoMinimo={() => setRota({ tela: 'minimo' })}
        aoAbrir={(produtoId) => { setOrigemEstoque('produtos'); setRota({ tela: 'produto', produtoId }) }} />
    case 'minimo':
      return <TelaProdutosNoMinimo aoVoltar={() => setRota({ tela: 'produtos' })}
        aoAbrir={(produtoId) => { setOrigemEstoque('minimo'); setRota({ tela: 'estoque', produtoId }) }} />
    case 'divulgacao': return <TelaDivulgacao aoVoltar={() => setRota({ tela: 'produtos' })} />
    case 'produto': {
      const { produtoId, origem } = rota
      const voltar = () => setRota(origem === 'estoque' && produtoId ? { tela: 'estoque', produtoId } : { tela: 'produtos' })
      return <TelaProduto key={produtoId ?? 'novo'} produtoId={produtoId} aoVoltar={voltar} aoSalvar={voltar} aoEstoque={() => { if (produtoId) setRota({ tela: 'estoque', produtoId }) }} />
    }
    case 'estoque': {
      const { produtoId } = rota
      return <TelaEstoque key={produtoId} produtoId={produtoId} aoVoltar={() => setRota({ tela: origemEstoque })}
        aoCompra={() => setRota({ tela: 'entrada', produtoId, tipo: 'compra' })}
        aoInicial={() => setRota({ tela: 'entrada', produtoId, tipo: 'estoque-inicial' })}
        aoCorrigir={(alvo) => setRota({ tela: 'entrada', produtoId, tipo: 'compra', alvo })}
        aoAjuste={(conferir) => setRota({ tela: 'ajuste', produtoId, conferir })}
        aoCorrigirAjuste={(alvo) => setRota({ tela: 'ajuste', produtoId, alvo })}
        aoCadastro={() => setRota({ tela: 'produto', produtoId, origem: 'estoque' })}
        aoVenda={(clienteId, lancamentoId) => setRota({ tela: 'lancamento', clienteId, lancamentoId, estoqueId: produtoId })} />
    }
    case 'entrada':
      return <TelaEntrada key={`${rota.produtoId}/${rota.alvo?.id ?? rota.tipo}/${rota.alvo?.revisao ?? ''}`} produtoId={rota.produtoId} tipo={rota.tipo} alvo={rota.alvo}
        aoVoltar={() => setRota({ tela: 'estoque', produtoId: rota.produtoId })} aoSalvar={(produtoId) => setRota({ tela: 'estoque', produtoId })} />
    case 'ajuste': {
      const voltar = () => setRota({ tela: 'estoque', produtoId: rota.produtoId })
      return <TelaAjuste key={`${rota.produtoId}/${rota.alvo?.id ?? 'novo'}/${rota.alvo?.revisao ?? ''}`} produtoId={rota.produtoId} alvo={rota.alvo} conferir={rota.conferir} aoVoltar={voltar} aoSalvar={voltar} />
    }
    case 'entrar':
      return <TelaEntrar aoVoltar={rota.origem === 'copia' ? () => setRota({ tela: 'copia' }) : irParaInicio}
        aoEntrar={rota.origem === 'copia' ? () => setRota({ tela: 'copia' }) : irParaInicio} />
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
          aoAnotarSaldoAnterior={() => setRota({ tela: 'saldo-anterior', clienteId: rota.clienteId, origem: 'ficha' })}
          aoMudarDados={() => setRota({ tela: 'dados', clienteId: rota.clienteId })}
        />
      )
    case 'dados':
      return (
        <TelaDadosDoCliente
          clienteId={rota.clienteId}
          aoVoltar={() => irParaFicha(rota.clienteId)}
          aoPronto={() => irParaFicha(rota.clienteId)}
          aoDesativar={() => {
            // A fichinha saiu da lista: a busca que a achava sairia vazia ao voltar.
            setBusca('')
            irParaInicio()
          }}
        />
      )
    case 'cadastro':
      return (
        <TelaCadastro
          nomeInicial={rota.nome}
          outroDiaLembrado={outroDiaLembrado}
          aoLembrarOutroDia={setOutroDiaLembrado}
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
          outroDiaLembrado={outroDiaLembrado}
          aoLembrarOutroDia={setOutroDiaLembrado}
          aoVoltar={voltar}
          aoVender={(vendaId) => setRota({ tela: 'vendido', clienteId, vendaId })}
          aoCorrigir={(destino) => irParaFicha(destino ?? clienteId)}
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
          outroDiaLembrado={outroDiaLembrado}
          aoLembrarOutroDia={setOutroDiaLembrado}
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
          aoVoltar={() => rota.estoqueId ? setRota({ tela: 'estoque', produtoId: rota.estoqueId }) : irParaFicha(rota.clienteId)}
          aoCorrigir={(tipo) => setRota({ tela: tipo, clienteId: rota.clienteId, origem: 'lancamento', corrigirId: rota.lancamentoId })}
        />
      )
    case 'saldo-anterior': {
      const { clienteId, origem, corrigirId } = rota
      const voltar = (): void => {
        if (origem === 'lancamento' && corrigirId !== undefined) setRota({ tela: 'lancamento', clienteId, lancamentoId: corrigirId })
        else setRota({ tela: 'ficha', clienteId })
      }
      return (
        <TelaSaldoAnterior
          clienteId={clienteId}
          corrigirId={corrigirId}
          outroDiaLembrado={outroDiaLembrado}
          aoLembrarOutroDia={setOutroDiaLembrado}
          aoVoltar={voltar}
          aoAnotar={() => irParaFicha(clienteId)}
        />
      )
    }
  }
}
