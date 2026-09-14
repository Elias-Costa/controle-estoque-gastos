import { useEffect, useState } from 'react'
import { repositorio } from '../dados/instancia.ts'
import { quitar } from '../dados/operacoes.ts'
import type { Centavos } from '../dominio/dinheiro.ts'
import { saldo, type Id } from '../dominio/ficha.ts'
import { podeConsiderarPago } from '../dominio/lancamentos.ts'
import { Botao } from './Botao.tsx'
import { Confirmacao } from './Confirmacao.tsx'
import { hoje } from './datas.ts'
import { PALAVRAS } from './palavras-da-ficha.ts'
import { fraseDaRecusa } from './palavras-da-venda.ts'
import { fraseDoTroco, linhasDoRecebido, PALAVRAS_DO_RECEBIMENTO } from './palavras-do-recebimento.ts'
import { useLeitura } from './useLeitura.ts'

/**
 * A confirmação do recebimento (E-11), como no protótipo validado: "Anotado: R$ X da Rosa" e
 * o saldo novo — o que ela confere em voz alta com a cliente. O saldo é **relido da base**
 * (RN-01); o valor anotado é o do lançamento, que pode ser menor do que ela digitou (RN-03),
 * e a linha do troco é o que explica a diferença (D-016). O troco chega pela rota: não é
 * lançamento, e a base não o tem.
 *
 * Quando o que ficou é de até R$ 0,10, "Considerar pago" aparece aqui (D-031, D-046): é o
 * momento em que ela diria isso com a cliente na frente. Um toque, sem segunda confirmação
 * — ela decide —, e a mesma tela passa a dizer "Ela não deve mais nada".
 */
export function TelaRecebido({
  clienteId,
  recebimentoId,
  troco,
  aoVerFicha,
  aoVoltarAoInicio,
}: {
  clienteId: Id
  recebimentoId: Id
  troco: Centavos
  aoVerFicha: () => void
  aoVoltarAoInicio: () => void
}) {
  // Sobe a cada "Considerar pago" para a mesma tela reler o saldo: escrita própria não navega aqui.
  const [releituras, setReleituras] = useState(0)
  const [quitando, setQuitando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)

  const leitura = useLeitura(async () => {
    const cliente = await repositorio.lerCliente(clienteId)
    if (cliente === undefined) return null
    const ficha = await repositorio.lerFicha(clienteId)
    const recebimento = ficha.find((lancamento) => lancamento.id === recebimentoId)
    if (recebimento === undefined || recebimento.tipo !== 'recebimento') return null
    return { nome: cliente.nome, valor: recebimento.valor, saldo: saldo(ficha), podeQuitar: podeConsiderarPago(ficha) }
  }, `${recebimentoId}:${releituras}`)

  // O recebimento não está lá (só por outro aparelho, entre gravar e ler): o começo é o lugar seguro.
  const sumiu = leitura.estado === 'lido' && leitura.valor === null
  useEffect(() => {
    if (sumiu) aoVoltarAoInicio()
  }, [sumiu, aoVoltarAoInicio])

  async function considerarPago(): Promise<void> {
    setQuitando(true)
    setErro(null)
    try {
      const resultado = await quitar(repositorio, { clienteId, data: hoje() })
      if (!resultado.ok) {
        setErro(fraseDaRecusa(resultado.motivo))
        return
      }
      setReleituras((atual) => atual + 1)
    } catch {
      setErro(PALAVRAS_DO_RECEBIMENTO.naoDeu)
    } finally {
      setQuitando(false)
    }
  }

  if (leitura.estado !== 'lido' || leitura.valor === null) {
    return <main className="tela pt-14 text-center">{leitura.estado === 'falhou' && <p className="text-atraso">{PALAVRAS.naoDeuParaAbrir}</p>}</main>
  }

  const [primeira, segunda] = linhasDoRecebido(leitura.valor.nome, leitura.valor.valor, leitura.valor.saldo)
  return (
    <Confirmacao
      primeira={primeira}
      segunda={segunda}
      terceira={troco > 0n ? fraseDoTroco(troco) : undefined}
      aviso={erro}
      acaoPropria={
        leitura.valor.podeQuitar ? (
          <Botao tipo="principal" aoTocar={() => void considerarPago()} desabilitado={quitando}>
            {PALAVRAS_DO_RECEBIMENTO.considerarPago}
          </Botao>
        ) : undefined
      }
      aoVerFicha={aoVerFicha}
      aoVoltarAoInicio={aoVoltarAoInicio}
    />
  )
}
