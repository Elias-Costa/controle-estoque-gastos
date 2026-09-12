import { useEffect, useState } from 'react'
import { repositorio } from '../dados/instancia.ts'
import { estornarLancamento } from '../dados/operacoes.ts'
import { emReais, somar } from '../dominio/dinheiro.ts'
import type { Id, Venda } from '../dominio/ficha.ts'
import { caminhoDeCorrecao } from '../dominio/lancamentos.ts'
import { Botao } from './Botao.tsx'
import { diaCurto, hoje } from './datas.ts'
import { comoPagou, descricaoDosItens, PALAVRAS } from './palavras-da-ficha.ts'
import { fraseDaRecusa, PALAVRAS_DA_VENDA, quandoDaParcela } from './palavras-da-venda.ts'
import { Topo } from './Topo.tsx'
import { useLeitura } from './useLeitura.ts'

/**
 * A anotação de uma venda (E-10, RF-08, D-013, D-045): o que ela tocou na ficha, aberto —
 * data, itens, desconto, total, parcelas ou forma — e **um** botão, pelo `caminhoDeCorrecao`
 * do domínio: "Corrigir" enquanto a venda não subiu (a tela de venda reabre preenchida) ou
 * "Desfazer esta venda" depois (estorno, RI-03). Nunca os dois. Item que a nuvem recusou
 * ("com problema", D-042) só desfaz: regravar tentaria de novo o que já foi recusado.
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
  aoCorrigir: () => void
}) {
  const [confirmando, setConfirmando] = useState(false)
  const [desfazendo, setDesfazendo] = useState(false)
  const [erro, setErro] = useState<string | null>(null)

  const leitura = useLeitura(async () => {
    const cliente = await repositorio.lerCliente(clienteId)
    if (cliente === undefined) return null
    const ficha = await repositorio.lerFicha(clienteId)
    const venda = ficha.find((lancamento) => lancamento.id === lancamentoId)
    if (venda === undefined || venda.tipo !== 'venda') return null
    return {
      nome: cliente.nome,
      venda,
      desfeita: ficha.some((lancamento) => lancamento.tipo === 'estorno' && lancamento.estornaId === lancamentoId),
      sincronizada: await repositorio.sincronizado(lancamentoId),
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

  const { nome, venda, desfeita, sincronizada, comProblema } = leitura.valor
  const fiado = venda.pagamento === 'fiado'
  const caminho = comProblema ? 'estornar' : caminhoDeCorrecao(sincronizada)

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
      <Topo titulo={nome} subtitulo={`${fiado ? PALAVRAS_DA_VENDA.anotacao.fiadoEm : PALAVRAS_DA_VENDA.anotacao.pagouNaHoraEm} ${diaCurto(venda.data)}`} aoVoltar={aoVoltar} />

      <Detalhe venda={venda} />

      {comProblema && <p className="mt-5 mb-0 font-semibold text-atraso">{PALAVRAS_DA_VENDA.anotacao.comProblema}</p>}
      {confirmando && <p className="mt-5 mb-0 font-semibold">{PALAVRAS_DA_VENDA.anotacao.desfazerMesmo}</p>}
      {erro !== null && <p className="mt-4 mb-0 font-semibold text-atraso">{erro}</p>}

      {!desfeita && (
        <div className="rodape-acao">
          {caminho === 'corrigir' && (
            <Botao tipo="principal" aoTocar={aoCorrigir}>
              {PALAVRAS_DA_VENDA.anotacao.corrigir}
            </Botao>
          )}
          {caminho === 'estornar' && !confirmando && (
            <Botao tipo="secundario" aoTocar={() => setConfirmando(true)}>
              {PALAVRAS_DA_VENDA.anotacao.desfazer}
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

/** Os itens, o desconto, o total e as parcelas (ou a forma), como na tela de venda — para ela reconhecer o que anotou. */
function Detalhe({ venda }: { venda: Venda }) {
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
