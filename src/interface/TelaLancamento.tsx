import { useEffect, useState } from 'react'
import { repositorio } from '../dados/instancia.ts'
import { estornarLancamento } from '../dados/operacoes.ts'
import { emReais, somar } from '../dominio/dinheiro.ts'
import type { Id, Recebimento, SaldoAnterior, Venda } from '../dominio/ficha.ts'
import { caminhoDeCorrecao } from '../dominio/lancamentos.ts'
import { Botao } from './Botao.tsx'
import { diaCurto, hoje } from './datas.ts'
import { comoPagou, descricaoDosItens, PALAVRAS } from './palavras-da-ficha.ts'
import { fraseDaRecusa, PALAVRAS_DA_VENDA, quandoDaParcela } from './palavras-da-venda.ts'
import { PALAVRAS_DO_RECEBIMENTO } from './palavras-do-recebimento.ts'
import { PALAVRAS_DO_SALDO_ANTERIOR } from './palavras-do-saldo-anterior.ts'
import { Topo } from './Topo.tsx'
import { useLeitura } from './useLeitura.ts'

/** O que a anotação abre: só o que a linha da ficha oferece (`linhasDaFicha`, `lancamentoId`). */
type Anotado = Venda | Recebimento | SaldoAnterior

/**
 * A anotação de uma venda (E-10, RF-08, D-013, D-045), de um recebimento (E-11, D-046) ou de
 * um saldo anterior (E-14, D-049): o que ela tocou na ficha, aberto — data, itens, desconto,
 * total, parcelas ou forma; valor, forma e observação; ou o total e as parcelas — e **um**
 * botão, pelo `caminhoDeCorrecao` do domínio: "Corrigir" enquanto não subiu (a tela certa
 * reabre preenchida) ou "Desfazer" depois (estorno, RI-03). Nunca os dois. Item que a nuvem recusou ("com problema", D-042)
 * só desfaz: regravar tentaria de novo o que já foi recusado.
 *
 * "Desfazer" pede um segundo toque — é a única ação da tela que ela não desfaz com um "‹",
 * e a resposta fica visível: as duas linhas, na ficha. A janela de D-013 é lida ao abrir;
 * se fechar no meio, o domínio recusa e a frase diz o que fazer (`fraseDaRecusa`).
 */
export function TelaLancamento({
  clienteId,
  lancamentoId,
  aoVoltar,
  aoCorrigir,
}: {
  clienteId: Id
  lancamentoId: Id
  aoVoltar: () => void
  aoCorrigir: (tipo: Anotado['tipo']) => void
}) {
  const [confirmando, setConfirmando] = useState(false)
  const [desfazendo, setDesfazendo] = useState(false)
  const [erro, setErro] = useState<string | null>(null)

  const leitura = useLeitura(async () => {
    const cliente = await repositorio.lerCliente(clienteId)
    if (cliente === undefined) return null
    const ficha = await repositorio.lerFicha(clienteId)
    const anotado = ficha.find((lancamento) => lancamento.id === lancamentoId)
    if (anotado === undefined || (anotado.tipo !== 'venda' && anotado.tipo !== 'recebimento' && anotado.tipo !== 'saldo-anterior')) return null
    return {
      nome: cliente.nome,
      anotado,
      desfeito: ficha.some((lancamento) => lancamento.tipo === 'estorno' && lancamento.estornaId === lancamentoId),
      sincronizado: await repositorio.sincronizado(lancamentoId),
      comProblema: await repositorio.comProblema(lancamentoId),
    }
  }, lancamentoId)

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

  const { nome, anotado, desfeito, sincronizado, comProblema } = leitura.valor
  const caminho = comProblema ? 'estornar' : caminhoDeCorrecao(sincronizado)
  const palavras = palavrasDe(anotado)

  async function desfazer(): Promise<void> {
    setDesfazendo(true)
    setErro(null)
    try {
      const resultado = await estornarLancamento(repositorio, { clienteId, data: hoje(), estornaId: lancamentoId })
      if (!resultado.ok) {
        setErro(fraseDaRecusa(resultado.motivo))
        return
      }
      aoVoltar()
    } catch {
      setErro(PALAVRAS_DA_VENDA.anotacao.naoDeuParaDesfazer)
    } finally {
      setDesfazendo(false)
    }
  }

  return (
    <main className="tela">
      <Topo titulo={nome} subtitulo={`${quandoFoi(anotado)} ${diaCurto(anotado.data)}`} aoVoltar={aoVoltar} />

      {anotado.tipo === 'venda' && <DetalheDaVenda venda={anotado} />}
      {anotado.tipo === 'recebimento' && <DetalheDoRecebimento recebimento={anotado} />}
      {anotado.tipo === 'saldo-anterior' && <DetalheDoSaldoAnterior saldo={anotado} />}

      {comProblema && <p className="mt-5 mb-0 font-semibold text-atraso">{palavras.comProblema}</p>}
      {confirmando && <p className="mt-5 mb-0 font-semibold">{PALAVRAS_DA_VENDA.anotacao.desfazerMesmo}</p>}
      {erro !== null && <p className="mt-4 mb-0 font-semibold text-atraso">{erro}</p>}

      {!desfeito && (
        <div className="rodape-acao">
          {caminho === 'corrigir' && (
            <Botao tipo="principal" aoTocar={() => aoCorrigir(anotado.tipo)}>
              {PALAVRAS_DA_VENDA.anotacao.corrigir}
            </Botao>
          )}
          {caminho === 'estornar' && !confirmando && (
            <Botao tipo="secundario" aoTocar={() => setConfirmando(true)}>
              {palavras.desfazer}
            </Botao>
          )}
          {caminho === 'estornar' && confirmando && (
            <>
              <Botao tipo="principal" aoTocar={() => void desfazer()} desabilitado={desfazendo}>
                {PALAVRAS_DA_VENDA.anotacao.simDesfazer}
              </Botao>
              <Botao tipo="secundario" aoTocar={() => setConfirmando(false)}>
                {PALAVRAS_DA_VENDA.anotacao.deixarComoEsta}
              </Botao>
            </>
          )}
        </div>
      )}
    </main>
  )
}

/** As palavras do botão de desfazer e do aviso de problema, por tipo. */
function palavrasDe(anotado: Anotado): { desfazer: string; comProblema: string } {
  if (anotado.tipo === 'venda') return PALAVRAS_DA_VENDA.anotacao
  if (anotado.tipo === 'recebimento') return PALAVRAS_DO_RECEBIMENTO.anotacao
  return PALAVRAS_DO_SALDO_ANTERIOR.anotacao
}

/** "Fiado em", "Pagou na hora em", "Pagou em" ou "Já devia desde" — o subtítulo, antes da data. */
function quandoFoi(anotado: Anotado): string {
  if (anotado.tipo === 'recebimento') return PALAVRAS_DO_RECEBIMENTO.anotacao.pagouEm
  if (anotado.tipo === 'saldo-anterior') return PALAVRAS_DO_SALDO_ANTERIOR.anotacao.jaDeviaDesde
  return anotado.pagamento === 'fiado' ? PALAVRAS_DA_VENDA.anotacao.fiadoEm : PALAVRAS_DA_VENDA.anotacao.pagouNaHoraEm
}

/** Os itens, o desconto, o total e as parcelas (ou a forma), como na tela de venda — para ela reconhecer o que anotou. */
function DetalheDaVenda({ venda }: { venda: Venda }) {
  const somaDosItens = somar(venda.itens.map((item) => item.preco))
  const linha = 'flex justify-between gap-3 border-b border-borda py-2 tabular-nums'
  return (
    <>
      <ul className="m-0 list-none p-0">
        {venda.itens.map((item, posicao) => (
          <li key={posicao} className={linha}>
            <span>{descricaoDosItens([item])}</span>
            <span>{emReais(item.preco)}</span>
          </li>
        ))}
        {venda.desconto > 0n && (
          <li className={`${linha} text-suave`}>
            <span>{PALAVRAS_DA_VENDA.desconto}</span>
            <span>&minus; {emReais(venda.desconto)}</span>
          </li>
        )}
      </ul>
      <p className="mt-2 mb-0 flex justify-between text-[1.25rem]">
        <span>{PALAVRAS_DA_VENDA.total}</span>
        <strong className="tabular-nums">{emReais(somaDosItens - venda.desconto)}</strong>
      </p>
      {venda.pagamento === 'fiado' ? (
        <ul className="m-0 mt-4 list-none p-0">
          {venda.parcelas.map((parcela, posicao) => (
            <li key={parcela.id} className={linha}>
              <span className="text-suave">{quandoDaParcela(posicao + 1, parcela.vencimento)}</span>
              <span>{emReais(parcela.valor)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 mb-0 text-suave">{comoPagou(venda.forma)}</p>
      )}
    </>
  )
}

/** O valor grande, a forma e a observação, como na tela de recebimento (E-11). */
function DetalheDoRecebimento({ recebimento }: { recebimento: Recebimento }) {
  return (
    <>
      <p className="m-0 text-[2.25rem] leading-none font-bold tabular-nums">{emReais(recebimento.valor)}</p>
      <p className="mt-3 mb-0 text-suave">{comoPagou(recebimento.forma)}</p>
      {recebimento.observacao !== undefined && recebimento.observacao !== '' && <p className="mt-2 mb-0">{recebimento.observacao}</p>}
    </>
  )
}

/** O total grande e as parcelas, como na tela "O que a X já devia" (E-14) — para ela reconhecer o que anotou. */
function DetalheDoSaldoAnterior({ saldo }: { saldo: SaldoAnterior }) {
  const linha = 'flex justify-between gap-3 border-b border-borda py-2 tabular-nums'
  return (
    <>
      <p className="m-0 text-[2.25rem] leading-none font-bold tabular-nums">{emReais(somar(saldo.parcelas.map((parcela) => parcela.valor)))}</p>
      <ul className="m-0 mt-4 list-none p-0">
        {saldo.parcelas.map((parcela, posicao) => (
          <li key={parcela.id} className={linha}>
            <span className="text-suave">{quandoDaParcela(posicao + 1, parcela.vencimento)}</span>
            <span>{emReais(parcela.valor)}</span>
          </li>
        ))}
      </ul>
    </>
  )
}
