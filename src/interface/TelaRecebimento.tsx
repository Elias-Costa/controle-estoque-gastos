import { useEffect, useState } from 'react'
import { repositorio } from '../dados/instancia.ts'
import { corrigirLancamento, receber } from '../dados/operacoes.ts'
import type { Centavos } from '../dominio/dinheiro.ts'
import { proximaParcela, saldo, type Cliente, type Dia, type Id, type Recebimento } from '../dominio/ficha.ts'
import { Botao } from './Botao.tsx'
import { Campo } from './Campo.tsx'
import { CampoDeDinheiro } from './CampoDeDinheiro.tsx'
import { diaDoQuando, hoje, quandoDe } from './datas.ts'
import { Escolha } from './Opcoes.tsx'
import { PALAVRAS } from './palavras-da-ficha.ts'
import { fraseDaRecusa, PALAVRAS_DA_VENDA } from './palavras-da-venda.ts'
import { fraseDaGuardaDoRecebimento, fraseDoTroco, PALAVRAS_DO_RECEBIMENTO, tituloDoRecebimento } from './palavras-do-recebimento.ts'
import { textoDeCentavos } from './rascunho-da-venda.ts'
import { conferirRecebimento, observacaoDe, rascunhoDoRecebimento, saldoParaCorrigir, type RascunhoDoRecebimento } from './rascunho-do-recebimento.ts'
import { QuandoFoi } from './QuandoFoi.tsx'
import { Topo } from './Topo.tsx'
import { useLeitura } from './useLeitura.ts'

/**
 * A tela de recebimento (E-11, RF-06): "Recebi da Rosa". A operação mais frequente e o alvo
 * mais duro (RNF-02: até 4 toques, menos de 20 s). O caminho é o do protótipo validado em
 * 2026-09-08 (RT-14 em 14 s e 3 toques): a ficha → "Recebi R$ X" → "Confirmar" — o valor já
 * vem preenchido com o que falta da próxima parcela (D-006) e o abatimento é derivado, sem
 * perguntar em qual parcela (RI-08). O que E-11 acrescentou fica fora desse caminho (D-046):
 * o troco enquanto ela digita (D-016), "Outro dia", e a observação atrás de "Anotar algo".
 *
 * Sem foco automático no valor: o teclado aberto cobriria o "Confirmar" no caminho em que ela
 * não digita nada. Tocar o campo seleciona tudo, para digitar por cima.
 *
 * Com `corrigirId` é a **correção** (D-013): a mesma tela, preenchida com o recebimento como
 * está; o "Confirmar" regrava a mesma linha e a ficha é a confirmação. O troco é contado
 * contra o saldo **sem** o recebimento original (`saldoParaCorrigir`).
 */
export function TelaRecebimento({
  clienteId,
  corrigirId,
  aoVoltar,
  aoReceber,
  aoCorrigir,
}: {
  clienteId: Id
  corrigirId?: Id
  aoVoltar: () => void
  aoReceber: (recebimentoId: Id, troco: Centavos) => void
  aoCorrigir: () => void
}) {
  const leitura = useLeitura(async () => {
    const cliente = await repositorio.lerCliente(clienteId)
    if (cliente === undefined) return null
    const ficha = await repositorio.lerFicha(clienteId)
    if (corrigirId === undefined) {
      const proxima = proximaParcela(ficha)
      if (proxima === null) return null
      return { cliente, original: undefined, saldoDisponivel: saldo(ficha), valorInicial: textoDeCentavos(proxima.restante) }
    }
    const original = ficha.find((lancamento) => lancamento.id === corrigirId)
    if (original === undefined || original.tipo !== 'recebimento') return null
    return { cliente, original, saldoDisponivel: saldoParaCorrigir(ficha, corrigirId), valorInicial: '' }
  }, `${clienteId}:${corrigirId ?? ''}`)

  // Cliente ou recebimento que sumiu, ou ficha que já não tem o que receber: volta por onde entrou.
  const sumiu = leitura.estado === 'lido' && leitura.valor === null
  useEffect(() => {
    if (sumiu) aoVoltar()
  }, [sumiu, aoVoltar])

  if (leitura.estado !== 'lido' || leitura.valor === null) {
    return (
      <main className="tela">
        <Topo titulo="" aoVoltar={aoVoltar} />
        {leitura.estado === 'falhou' && <p className="text-atraso">{PALAVRAS.naoDeuParaAbrir}</p>}
      </main>
    )
  }

  const { cliente, original, saldoDisponivel, valorInicial } = leitura.valor
  return (
    <Formulario
      cliente={cliente}
      original={original}
      saldoDisponivel={saldoDisponivel}
      valorInicial={valorInicial}
      aoVoltar={aoVoltar}
      aoReceber={aoReceber}
      aoCorrigir={aoCorrigir}
    />
  )
}

/** O formulário, montado uma vez com o rascunho inicial — a próxima parcela, ou o recebimento a corrigir. */
function Formulario({
  cliente,
  original,
  saldoDisponivel,
  valorInicial,
  aoVoltar,
  aoReceber,
  aoCorrigir,
}: {
  cliente: Cliente
  original: Recebimento | undefined
  saldoDisponivel: Centavos
  valorInicial: string
  aoVoltar: () => void
  aoReceber: (recebimentoId: Id, troco: Centavos) => void
  aoCorrigir: () => void
}) {
  const dia = hoje()
  const [rascunho, setRascunho] = useState<Omit<RascunhoDoRecebimento, 'data'>>(() =>
    original === undefined ? { valorTexto: valorInicial, forma: 'dinheiro', observacao: '' } : rascunhoDoRecebimento(original),
  )
  const [quando, setQuando] = useState(() => quandoDe(original?.data, dia))
  const [observacaoAberta, setObservacaoAberta] = useState(() => rascunho.observacao !== '')
  const [gravando, setGravando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)

  const data: Dia = diaDoQuando(quando, dia)
  const conferencia = conferirRecebimento({ ...rascunho, data }, saldoDisponivel, dia)
  const frases = conferencia.guardas.map(fraseDaGuardaDoRecebimento).filter((frase): frase is string => frase !== null)
  const podeGravar = conferencia.guardas.length === 0 && !gravando

  function mudar(mudanca: Partial<typeof rascunho>): void {
    setRascunho((atual) => ({ ...atual, ...mudanca }))
  }

  async function gravar(): Promise<void> {
    if (!podeGravar || conferencia.valor === null) return
    setGravando(true)
    setErro(null)
    const comum = { clienteId: cliente.id, data, forma: rascunho.forma, observacao: observacaoDe({ ...rascunho, data }) }
    try {
      if (original === undefined) {
        // O domínio limita ao saldo e devolve o troco (RN-03): o que ela digitou entra inteiro.
        const resultado = await receber(repositorio, { ...comum, valor: conferencia.valor })
        if (!resultado.ok) {
          setErro(fraseDaRecusa(resultado.motivo))
          return
        }
        aoReceber(resultado.valor.recebimento.id, resultado.valor.troco)
        return
      }
      // A janela de D-013 é lida na hora de gravar, não na de abrir: a fila pode ter subido no meio.
      const sincronizado = await repositorio.sincronizado(original.id)
      const substituto: Recebimento = { tipo: 'recebimento', id: original.id, ...comum, valor: conferencia.registrado }
      const resultado = await corrigirLancamento(repositorio, substituto, { sincronizado })
      if (!resultado.ok) {
        setErro(fraseDaRecusa(resultado.motivo))
        return
      }
      aoCorrigir()
    } catch {
      // A base local não gravou (EL-06): dito na tela, com palavras dela; nada foi perdido em silêncio.
      setErro(PALAVRAS_DO_RECEBIMENTO.naoDeu)
    } finally {
      setGravando(false)
    }
  }

  return (
    <main className="tela">
      <Topo titulo={tituloDoRecebimento(cliente.nome)} aoVoltar={aoVoltar} />

      <CampoDeDinheiro rotulo={PALAVRAS_DO_RECEBIMENTO.quantoPagou} texto={rascunho.valorTexto} aoMudar={(valorTexto) => mudar({ valorTexto })} selecionarAoFocar />
      {conferencia.troco > 0n && (
        // Antes de confirmar (D-016): ela devolve a diferença na hora, e a ficha nunca fica negativa.
        <p className="mt-1.5 mb-0 text-[1.25rem] font-semibold tabular-nums">{fraseDoTroco(conferencia.troco)}</p>
      )}

      <Escolha
        rotulo={PALAVRAS_DA_VENDA.como}
        opcoes={[
          { valor: 'pix', texto: PALAVRAS_DA_VENDA.pix },
          { valor: 'dinheiro', texto: PALAVRAS_DA_VENDA.dinheiro },
        ]}
        valor={rascunho.forma}
        aoEscolher={(forma) => mudar({ forma })}
      />

      <QuandoFoi rotulo={PALAVRAS_DO_RECEBIMENTO.quando} quando={quando} hoje={dia} aoMudar={setQuando} />

      {observacaoAberta ? (
        <Campo rotulo={PALAVRAS_DO_RECEBIMENTO.observacao} valor={rascunho.observacao} aoMudar={(observacao) => mudar({ observacao })} autoFoco />
      ) : (
        <button type="button" className="mt-4 min-h-11 border-0 bg-transparent p-0 text-[1rem] text-acento underline" onClick={() => setObservacaoAberta(true)}>
          {PALAVRAS_DO_RECEBIMENTO.anotarAlgo}
        </button>
      )}

      {(frases.length > 0 || erro !== null) && (
        <div className="mt-4">
          {frases.map((frase) => (
            <p key={frase} className="m-0 font-semibold text-atraso">
              {frase}
            </p>
          ))}
          {erro !== null && <p className="m-0 font-semibold text-atraso">{erro}</p>}
        </div>
      )}

      <div className="rodape-acao">
        <Botao tipo="principal" aoTocar={() => void gravar()} desabilitado={!podeGravar}>
          {PALAVRAS_DO_RECEBIMENTO.confirmar}
        </Botao>
      </div>
    </main>
  )
}
