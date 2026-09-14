import { useEffect } from 'react'
import { repositorio } from '../dados/instancia.ts'
import { somar } from '../dominio/dinheiro.ts'
import { saldo, type Id } from '../dominio/ficha.ts'
import { Confirmacao } from './Confirmacao.tsx'
import { PALAVRAS } from './palavras-da-ficha.ts'
import { linhasDaConfirmacao } from './palavras-da-venda.ts'
import { useLeitura } from './useLeitura.ts'

/**
 * A confirmação da venda (E-10), como no protótipo validado: o "✓", o que aconteceu e o
 * saldo novo — o número que ela confere em voz alta com a cliente. O saldo é **relido da
 * base** depois de gravar (RN-01), inclusive na venda à vista: a confirmação de "ela não deve
 * nada" com uma dívida antiga na ficha foi defeito achado na revisão do protótipo.
 *
 * Correção não passa por aqui (D-045): volta à ficha, onde a linha corrigida é a prova.
 */
export function TelaVendido({
  clienteId,
  vendaId,
  aoVerFicha,
  aoVoltarAoInicio,
}: {
  clienteId: Id
  vendaId: Id
  aoVerFicha: () => void
  aoVoltarAoInicio: () => void
}) {
  const leitura = useLeitura(async () => {
    const cliente = await repositorio.lerCliente(clienteId)
    if (cliente === undefined) return null
    const ficha = await repositorio.lerFicha(clienteId)
    const venda = ficha.find((lancamento) => lancamento.id === vendaId)
    if (venda === undefined || venda.tipo !== 'venda') return null
    const total = somar(venda.itens.map((item) => item.preco)) - venda.desconto
    return { nome: cliente.nome, fiado: venda.pagamento === 'fiado', total, saldo: saldo(ficha) }
  }, vendaId)

  // A venda não está lá (só por outro aparelho, entre gravar e ler): o começo é o lugar seguro.
  const sumiu = leitura.estado === 'lido' && leitura.valor === null
  useEffect(() => {
    if (sumiu) aoVoltarAoInicio()
  }, [sumiu, aoVoltarAoInicio])

  if (leitura.estado !== 'lido' || leitura.valor === null) {
    return <main className="tela pt-14 text-center">{leitura.estado === 'falhou' && <p className="text-atraso">{PALAVRAS.naoDeuParaAbrir}</p>}</main>
  }

  const [primeira, segunda] = linhasDaConfirmacao(leitura.valor.nome, leitura.valor.fiado, leitura.valor.total, leitura.valor.saldo)
  return <Confirmacao primeira={primeira} segunda={segunda} aoVerFicha={aoVerFicha} aoVoltarAoInicio={aoVoltarAoInicio} />
}
