import { useEffect, useState } from 'react'
import { repositorio } from '../dados/instancia.ts'
import { quitar, reativarCliente } from '../dados/operacoes.ts'
import { emReais } from '../dominio/dinheiro.ts'
import type { Cliente, Id } from '../dominio/ficha.ts'
import { podeConsiderarPago } from '../dominio/lancamentos.ts'
import { Botao, BotaoLink } from './Botao.tsx'
import { diaCurto, hoje } from './datas.ts'
import { linhasDaFicha, resumir, separarDesfeitas, type LinhaDaFicha, type ResumoDaFicha } from './leitura-da-ficha.ts'
import { mensagemDeCobranca, PALAVRAS_DA_COBRANCA } from './palavras-da-cobranca.ts'
import { linhaDaProxima, PALAVRAS, verDesfeitas } from './palavras-da-ficha.ts'
import { fraseDaRecusa, PALAVRAS_DA_VENDA } from './palavras-da-venda.ts'
import { PALAVRAS_DO_RECEBIMENTO } from './palavras-do-recebimento.ts'
import { PALAVRAS_DO_SALDO_ANTERIOR } from './palavras-do-saldo-anterior.ts'
import { Topo } from './Topo.tsx'
import { useLeitura } from './useLeitura.ts'
import { linkDoWhatsApp } from './whatsapp.ts'

/**
 * A ficha (RF-02): a tela que substitui a página do caderno. No topo, sem rolagem, quanto a
 * pessoa deve hoje e qual a próxima parcela — vencida em destaque; abaixo, o histórico em ordem
 * cronológica inversa. Tudo derivado (RN-01): nenhum número aqui é lido de um campo.
 *
 * Fiel ao protótipo validado em 2026-09-08, com o que ela pediu na visita de E-15 (D-050). No
 * rodapé, "Abater valor" (E-11, principal; era "Recebi R$ X" — o verbo é dela, item 4; some
 * quando não há o que receber) sobre "Vender fiado" (E-10, D-044; item 2). Quando o que falta é
 * de até R$ 0,10, "Considerar pago" toma o lugar do principal (D-031, D-046): um toque, e a
 * ficha relê. A linha de uma venda ou de um recebimento (ou de um saldo anterior, E-14) ainda
 * não desfeito é tocável e abre a anotação (D-045) — é por ali que ela corrige ou desfaz. **O
 * que foi desfeito fica escondido** sob "Ver o que foi desfeito (N)" no fim do histórico (item
 * 1), só naquela abertura. "Cobrar no WhatsApp" (E-12, RF-09) fica no cartão do saldo (D-047).
 * "Mudar dados ›" no cabeçalho (item 8) abre os dados da cliente — e é lá que a fichinha se
 * desativa. **Desativada, a ficha é inerte** (emenda ao item 6): diz isso sob o nome, mostra o
 * saldo e o histórico, mas sem cobrar, sem linha tocável, sem "Mudar dados", sem "Anotar o que
 * já devia" — o rodapé tem só "Reativar a fichinha", um toque, e a ficha relê. No fim do
 * histórico, fora do caminho diário, "Anotar o que já devia" (D-049).
 */
export function TelaFicha({
  clienteId,
  aoVoltar,
  aoReceber,
  aoVender,
  aoAbrirLancamento,
  aoAnotarSaldoAnterior,
  aoMudarDados,
}: {
  clienteId: Id
  aoVoltar: () => void
  aoReceber: () => void
  aoVender: () => void
  aoAbrirLancamento: (lancamentoId: Id) => void
  aoAnotarSaldoAnterior: () => void
  aoMudarDados: () => void
}) {
  // Sobe a cada "Considerar pago" para a ficha reler: escrita própria não navega aqui.
  const [releituras, setReleituras] = useState(0)
  const [quitando, setQuitando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)

  const leitura = useLeitura(async () => {
    const cliente = await repositorio.lerCliente(clienteId)
    if (cliente === undefined) return null
    const ficha = await repositorio.lerFicha(clienteId)
    const dia = hoje()
    return { resumo: resumir(cliente, ficha, dia), linhas: linhasDaFicha(ficha, dia), podeQuitar: podeConsiderarPago(ficha) }
  }, `${clienteId}:${releituras}`)

  // Cliente que sumiu entre um toque e outro (só por outro aparelho): a lista é o lugar certo.
  const sumiu = leitura.estado === 'lido' && leitura.valor === null
  useEffect(() => {
    if (sumiu) aoVoltar()
  }, [sumiu, aoVoltar])

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

  // Reativar (D-050, emenda ao item 6): um toque, sem confirmação — é o desfazer de um engano.
  // Não navega: a ficha relê e volta a ter os botões. Só existe com a ficha desativada.
  async function reativar(cliente: Cliente): Promise<void> {
    setQuitando(true)
    setErro(null)
    try {
      await reativarCliente(repositorio, cliente)
      setReleituras((atual) => atual + 1)
    } catch {
      setErro(PALAVRAS.cadastro.naoDeu)
    } finally {
      setQuitando(false)
    }
  }

  if (leitura.estado !== 'lido' || leitura.valor === null) {
    return (
      <main className="tela">
        <Topo titulo="" aoVoltar={aoVoltar} />
        {leitura.estado === 'falhou' && <p className="text-atraso">{PALAVRAS.naoDeuParaAbrir}</p>}
      </main>
    )
  }

  const { resumo, linhas, podeQuitar } = leitura.valor
  // Ficha desativada é inerte (D-050, emenda ao item 6): mostra, mas não oferece nada além de reativar.
  const desativada = resumo.cliente.desativadoEm !== undefined
  return (
    <main className="tela">
      <Topo titulo={resumo.cliente.nome} subtitulo={resumo.cliente.apelido} aoVoltar={aoVoltar} acao={desativada ? undefined : { texto: PALAVRAS.dados.abrir, aoTocar: aoMudarDados }} />
      {desativada && <p className="mt-0 mb-3 text-[0.95rem] font-semibold text-suave">{PALAVRAS.fichinhaDesativada}</p>}
      <CartaoDeSaldo resumo={resumo} cobravel={!podeQuitar && !desativada} />
      <h2 className="mt-7 mb-2 text-[1rem] font-semibold text-suave">{PALAVRAS.oQueAconteceu}</h2>
      <Historico linhas={linhas} aoAbrir={desativada ? undefined : aoAbrirLancamento} />
      {!desativada && (
        <button type="button" className="mt-3 block min-h-11 border-0 bg-transparent p-0 text-left text-[1rem] text-acento underline" onClick={aoAnotarSaldoAnterior}>
          {PALAVRAS_DO_SALDO_ANTERIOR.anotarJaDevia}
        </button>
      )}
      {erro !== null && <p className="mt-4 mb-0 font-semibold text-atraso">{erro}</p>}
      <div className="rodape-acao">
        {desativada ? (
          <Botao tipo="principal" aoTocar={() => void reativar(resumo.cliente)} desabilitado={quitando}>
            {PALAVRAS.reativar}
          </Botao>
        ) : (
          <>
            {podeQuitar ? (
              <Botao tipo="principal" aoTocar={() => void considerarPago()} desabilitado={quitando}>
                {PALAVRAS_DO_RECEBIMENTO.considerarPago}
              </Botao>
            ) : (
              resumo.proxima !== null && (
                <Botao tipo="principal" aoTocar={aoReceber}>
                  {PALAVRAS_DO_RECEBIMENTO.abater}
                </Botao>
              )
            )}
            <Botao tipo="secundario" aoTocar={aoVender}>
              {PALAVRAS_DA_VENDA.venderFiado}
            </Botao>
          </>
        )}
      </div>
    </main>
  )
}

/**
 * RF-02 exige saldo e próxima parcela "no topo e sem rolagem". O cartão é curto de propósito:
 * o que compete com ele por espaço é o histórico, e o histórico pode rolar.
 *
 * "Cobrar no WhatsApp" (RF-09, E-12) mora aqui, sob o número que ela vai cobrar (D-047 item 4),
 * e só quando há o que cobrar: some sem parcela em aberto e quando `cobravel` é falso (saldo
 * de até R$ 0,10 — ninguém cobra três centavos; a ficha oferece "Considerar pago"). É um link:
 * o app monta o texto, ela envia (D-007). Sem telefone legível, abre o WhatsApp sem número.
 */
function CartaoDeSaldo({ resumo, cobravel }: { resumo: ResumoDaFicha; cobravel: boolean }) {
  const vencida = resumo.proxima?.vencida === true
  return (
    <div className="rounded-2xl border border-borda bg-papel px-[1.125rem] pt-4 pb-[1.125rem]">
      <p className="m-0 text-[0.95rem] text-suave">{PALAVRAS.deve}</p>
      <p className="m-0 mt-0.5 text-[2.75rem] leading-[1.05] font-bold tabular-nums">
        {resumo.saldo === 0n ? PALAVRAS.nada : emReais(resumo.saldo)}
      </p>
      <p
        className={
          vencida
            ? 'mt-2 inline-block rounded-lg bg-atraso-fundo px-2.5 py-1.5 text-[1rem] font-semibold text-atraso'
            : 'm-0 mt-2 text-[1rem] text-suave'
        }
      >
        {linhaDaProxima(resumo.proxima, resumo.vazia)}
      </p>
      {resumo.proxima !== null && cobravel && (
        <BotaoLink
          tipo="secundario"
          className="mt-4"
          href={linkDoWhatsApp(
            resumo.cliente.telefone,
            mensagemDeCobranca({ nome: resumo.cliente.nome, vencimento: resumo.proxima.vencimento, vencida: resumo.proxima.vencida }),
          )}
        >
          {PALAVRAS_DA_COBRANCA.cobrar}
        </BotaoLink>
      )}
    </div>
  )
}

/**
 * O histórico: data, o que foi, quanto. Vencida em vermelho; pagamento em cinza; estornado
 * riscado (RN-07). A linha com `lancamentoId` é um botão que abre a anotação (D-045), com o
 * "›" à direita dizendo que abre — a mesma linha, o mesmo tamanho, sem cartão a mais. O que foi
 * desfeito — o alvo riscado e o seu "Desfez" — começa escondido (D-050, item 1): a linha de
 * texto no fim, "Ver o que foi desfeito (N)", mostra tudo naquela abertura; nada é guardado.
 */
function Historico({ linhas, aoAbrir }: { linhas: LinhaDaFicha[]; aoAbrir: ((lancamentoId: Id) => void) | undefined }) {
  const [mostrandoDesfeitas, setMostrandoDesfeitas] = useState(false)
  if (linhas.length === 0) return <p className="m-0 text-suave">{PALAVRAS.nadaAnotado}</p>
  const { aVista, quantas } = separarDesfeitas(linhas)
  return (
    <>
      <Linhas linhas={mostrandoDesfeitas ? linhas : aVista} aoAbrir={aoAbrir} />
      {quantas > 0 && (
        <button type="button" className="mt-3 block min-h-11 border-0 bg-transparent p-0 text-left text-[1rem] text-acento underline" onClick={() => setMostrandoDesfeitas((atual) => !atual)}>
          {mostrandoDesfeitas ? PALAVRAS.esconderDesfeitas : verDesfeitas(quantas)}
        </button>
      )}
    </>
  )
}

/** As linhas em si. Sem `aoAbrir` (ficha desativada), nenhuma é botão — nada de corrigir ou desfazer numa ficha inerte. */
function Linhas({ linhas, aoAbrir }: { linhas: LinhaDaFicha[]; aoAbrir: ((lancamentoId: Id) => void) | undefined }) {
  return (
    <ul className="m-0 list-none p-0">
      {linhas.map((linha) => {
        const destaque = linha.tipo === 'vencida' ? 'font-semibold text-atraso' : ''
        const apagado = linha.tipo === 'pagamento' ? 'text-suave' : ''
        const riscado = linha.estornado ? 'line-through text-suave' : ''
        const conteudo = (
          <>
            <span className="w-[4.25rem] flex-none text-suave tabular-nums">{diaCurto(linha.data)}</span>
            <span className={`flex-1 ${destaque}`}>{linha.descricao}</span>
            <span className={`flex-none whitespace-nowrap tabular-nums ${destaque}`}>{emReais(linha.valor)}</span>
          </>
        )
        const classes = `flex w-full items-center justify-between gap-3 border-b border-borda py-3 ${apagado} ${riscado}`
        const lancamentoId = linha.lancamentoId
        return (
          <li key={linha.chave}>
            {lancamentoId === undefined || aoAbrir === undefined ? (
              <div className={classes}>{conteudo}</div>
            ) : (
              <button type="button" className={`${classes} border-x-0 border-t-0 bg-transparent px-0 text-left text-tinta`} onClick={() => aoAbrir(lancamentoId)}>
                {conteudo}
                <span className="flex-none text-suave" aria-hidden="true">
                  &rsaquo;
                </span>
              </button>
            )}
          </li>
        )
      })}
    </ul>
  )
}
