import { useEffect, useState } from 'react'
import { repositorio } from '../dados/instancia.ts'
import { corrigirVenda, lancarVendaAVista, lancarVendaFiado, type VendaCorrigida } from '../dados/operacoes.ts'
import { emReais, somar, type Centavos } from '../dominio/dinheiro.ts'
import type { Cliente, Dia, Id, Venda } from '../dominio/ficha.ts'
import { Botao } from './Botao.tsx'
import { CLASSES_DE_CAMPO, CLASSES_DE_CAMPO_COMPACTO } from './Campo.tsx'
import { CampoDeDinheiro, EntradaDeDinheiro, LeituraDoValor } from './CampoDeDinheiro.tsx'
import { diaDoQuando, hoje, quandoDe } from './datas.ts'
import { Escolha, Vezes } from './Opcoes.tsx'
import { PALAVRAS } from './palavras-da-ficha.ts'
import { fraseDaGuarda, fraseDaRecusa, PALAVRAS_DA_VENDA, quandoDaParcela, tituloDaVenda } from './palavras-da-venda.ts'
import { QuandoFoi } from './QuandoFoi.tsx'
import {
  conferir,
  parcelasCorrigidas,
  rascunhoDaVenda,
  textoDeCentavos,
  type EdicaoDeParcela,
  type ParcelaMontada,
  type Rascunho,
} from './rascunho-da-venda.ts'
import { Topo } from './Topo.tsx'
import { useLeitura } from './useLeitura.ts'

/** O máximo de "vezes" do protótipo; a correção de uma venda com mais parcelas nunca oferece menos do que ela tem. */
const VEZES_DO_PROTOTIPO = 4

/** Um rascunho em branco: dois itens (a tarefa cronometrada tem dois), fiado, uma vez, dinheiro (D-045, item 3). */
function rascunhoNovo(): Rascunho {
  return {
    itens: [
      { descricao: '', precoTexto: '' },
      { descricao: '', precoTexto: '' },
    ],
    descontoTexto: '',
    pagamento: 'fiado',
    forma: 'dinheiro',
    vezes: 1,
    edicoes: [],
    data: '',
  }
}

/**
 * A tela de venda (E-10, RF-03, RF-04, RF-05, RN-04, RN-09): "O que a Rosa levou". O caminho
 * cronometrado é o do protótipo validado em 2026-09-08 (RT-15 em 48 s): itens → fiado → em
 * quantas vezes → hoje → Pronto. O que E-10 acrescentou fica atrás de um toque (D-045):
 * "Dar desconto", "Mudar datas ou valores", "Outro dia", e Pix/Dinheiro só quando é à vista.
 *
 * Tem duas portas — "Para quem?" e a ficha — e o "‹" volta por onde ela entrou. Com
 * `corrigirId` é a **correção** (D-013): a mesma tela, preenchida com a venda como está, e o
 * "Pronto" regrava a mesma linha; a ficha é a confirmação. Tudo que ela vê antes do toque
 * vem de `conferir` (`rascunho-da-venda.ts`): total, parcelas e guardas — nenhum número é
 * somado aqui (EL-03).
 */
export function TelaVenda({
  clienteId,
  corrigirId,
  aoVoltar,
  aoVender,
  aoCorrigir,
}: {
  clienteId: Id
  corrigirId?: Id
  aoVoltar: () => void
  aoVender: (vendaId: Id) => void
  aoCorrigir: () => void
}) {
  const leitura = useLeitura(async () => {
    const cliente = await repositorio.lerCliente(clienteId)
    if (cliente === undefined) return null
    if (corrigirId === undefined) return { cliente, original: undefined }
    const original = (await repositorio.lerFicha(clienteId)).find((lancamento) => lancamento.id === corrigirId)
    if (original === undefined || original.tipo !== 'venda') return null
    return { cliente, original }
  }, `${clienteId}:${corrigirId ?? ''}`)

  // Cliente ou venda que sumiu entre um toque e outro (só por outro aparelho): volta por onde entrou.
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

  return <Formulario cliente={leitura.valor.cliente} original={leitura.valor.original} aoVoltar={aoVoltar} aoVender={aoVender} aoCorrigir={aoCorrigir} />
}

/** O formulário, montado uma vez com o rascunho inicial — em branco ou a venda a corrigir. */
function Formulario({
  cliente,
  original,
  aoVoltar,
  aoVender,
  aoCorrigir,
}: {
  cliente: Cliente
  original: Venda | undefined
  aoVoltar: () => void
  aoVender: (vendaId: Id) => void
  aoCorrigir: () => void
}) {
  const dia = hoje()
  const [rascunho, setRascunho] = useState<Rascunho>(() => (original === undefined ? rascunhoNovo() : rascunhoDaVenda(original)))
  const [quando, setQuando] = useState(() => quandoDe(original?.data, dia))
  const [descontoAberto, setDescontoAberto] = useState(() => rascunho.descontoTexto !== '')
  const [editandoParcelas, setEditandoParcelas] = useState(false)
  const [gravando, setGravando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)

  const data: Dia = diaDoQuando(quando, dia)
  const conferencia = conferir({ ...rascunho, data }, dia)
  const frases = conferencia.guardas
    .map((guarda) => fraseDaGuarda(guarda, somaDasParcelas(conferencia.parcelas), conferencia.total))
    .filter((frase): frase is string => frase !== null)
  const podeGravar = conferencia.guardas.length === 0 && !gravando
  const maximoDeVezes = Math.max(VEZES_DO_PROTOTIPO, rascunho.vezes)

  function mudar(mudanca: Partial<Rascunho>): void {
    setRascunho((atual) => ({ ...atual, ...mudanca }))
  }

  function mudarItem(posicao: number, mudanca: Partial<Rascunho['itens'][number]>): void {
    mudar({ itens: rascunho.itens.map((item, i) => (i === posicao ? { ...item, ...mudanca } : item)) })
  }

  function mudarParcela(posicao: number, mudanca: EdicaoDeParcela): void {
    const edicoes = Array.from({ length: rascunho.vezes }, (_, i) => rascunho.edicoes[i] ?? {})
    mudar({ edicoes: edicoes.map((edicao, i) => (i === posicao ? { ...edicao, ...mudanca } : edicao)) })
  }

  async function gravar(): Promise<void> {
    if (!podeGravar) return
    setGravando(true)
    setErro(null)
    const comum = { clienteId: cliente.id, data, itens: conferencia.itensDaVenda, desconto: conferencia.desconto }
    try {
      if (original === undefined) {
        const resultado =
          rascunho.pagamento === 'fiado'
            ? await lancarVendaFiado(repositorio, { ...comum, parcelas: conferencia.parcelas.map(({ vencimento, valor }) => ({ vencimento, valor })) })
            : await lancarVendaAVista(repositorio, { ...comum, forma: rascunho.forma })
        if (!resultado.ok) {
          setErro(fraseDaRecusa(resultado.motivo))
          return
        }
        aoVender(resultado.valor.id)
        return
      }
      // A janela de D-013 é lida na hora de gravar, não na de abrir: a fila pode ter subido no meio.
      const sincronizado = await repositorio.sincronizado(original.id)
      const substituto: VendaCorrigida =
        rascunho.pagamento === 'fiado'
          ? {
              tipo: 'venda',
              pagamento: 'fiado',
              id: original.id,
              ...comum,
              parcelas: parcelasCorrigidas(conferencia.parcelas, original.pagamento === 'fiado' ? original.parcelas : []),
            }
          : { tipo: 'venda', pagamento: 'avista', id: original.id, ...comum, forma: rascunho.forma }
      const resultado = await corrigirVenda(repositorio, substituto, { sincronizado })
      if (!resultado.ok) {
        setErro(fraseDaRecusa(resultado.motivo))
        return
      }
      aoCorrigir()
    } catch {
      // A base local não gravou (EL-06): dito na tela, com palavras dela; nada foi perdido em silêncio.
      setErro(PALAVRAS_DA_VENDA.naoDeu)
    } finally {
      setGravando(false)
    }
  }

  return (
    <main className="tela">
      <Topo titulo={tituloDaVenda(cliente.nome)} aoVoltar={aoVoltar} />

      <ul className="m-0 mt-2 list-none p-0">
        {rascunho.itens.map((item, posicao) => (
          <li key={posicao} className="mb-2">
            <div className="flex gap-2">
              <input
                className={`${CLASSES_DE_CAMPO} min-w-0 flex-1`}
                type="text"
                autoComplete="off"
                placeholder={PALAVRAS_DA_VENDA.itemExemplo}
                aria-label={PALAVRAS_DA_VENDA.itemExemplo}
                value={item.descricao}
                onChange={(evento) => mudarItem(posicao, { descricao: evento.target.value })}
                autoFocus={original === undefined && posicao === 0}
              />
              <EntradaDeDinheiro
                className={`${CLASSES_DE_CAMPO_COMPACTO} w-[6.5rem] flex-none text-right tabular-nums`}
                texto={item.precoTexto}
                aoMudar={(precoTexto) => mudarItem(posicao, { precoTexto })}
                exemplo={PALAVRAS_DA_VENDA.precoExemplo}
                rotuloAcessivel={PALAVRAS_DA_VENDA.precoExemplo}
              />
            </div>
            {/* A leitura do domínio ao lado do item (D-034): "25" é R$ 0,25, e ela vê antes de confirmar. */}
            <LeituraDoValor texto={item.precoTexto} className="mt-1 text-right text-[1.125rem]" />
          </li>
        ))}
      </ul>

      <Botao tipo="secundario" aoTocar={() => mudar({ itens: [...rascunho.itens, { descricao: '', precoTexto: '' }] })}>
        {PALAVRAS_DA_VENDA.maisUm}
      </Botao>

      {descontoAberto && <CampoDeDinheiro rotulo={PALAVRAS_DA_VENDA.desconto} texto={rascunho.descontoTexto} aoMudar={(descontoTexto) => mudar({ descontoTexto })} />}

      <p className="mt-3 mb-0 flex items-baseline justify-between gap-3 border-t border-borda pt-3 text-[1.25rem]">
        <span>{PALAVRAS_DA_VENDA.total}</span>
        <span className="text-right tabular-nums">
          {conferencia.desconto > 0n && (
            <span className="mr-2 text-[1rem] text-suave">
              {emReais(conferencia.somaDosItens)} &minus; {emReais(conferencia.desconto)} =
            </span>
          )}
          <strong className="text-[1.5rem]">{emReais(conferencia.total)}</strong>
        </span>
      </p>
      {!descontoAberto && (
        <button type="button" className="mt-1 min-h-11 border-0 bg-transparent p-0 text-[1rem] text-acento underline" onClick={() => setDescontoAberto(true)}>
          {PALAVRAS_DA_VENDA.darDesconto}
        </button>
      )}

      <Escolha
        rotulo={PALAVRAS_DA_VENDA.comoVaiPagar}
        opcoes={[
          { valor: 'fiado', texto: PALAVRAS_DA_VENDA.fiado },
          { valor: 'avista', texto: PALAVRAS_DA_VENDA.aVista },
        ]}
        valor={rascunho.pagamento}
        aoEscolher={(pagamento) => mudar({ pagamento })}
      />

      {rascunho.pagamento === 'avista' && (
        <Escolha
          rotulo={PALAVRAS_DA_VENDA.como}
          opcoes={[
            { valor: 'pix', texto: PALAVRAS_DA_VENDA.pix },
            { valor: 'dinheiro', texto: PALAVRAS_DA_VENDA.dinheiro },
          ]}
          valor={rascunho.forma}
          aoEscolher={(forma) => mudar({ forma })}
        />
      )}

      {rascunho.pagamento === 'fiado' && (
        <>
          <Vezes
            rotulo={PALAVRAS_DA_VENDA.emQuantasVezes}
            maximo={maximoDeVezes}
            valor={rascunho.vezes}
            // Mudar o número de vezes recomeça a divisão do zero (D-045): as edições anteriores não fazem sentido em outra contagem.
            aoEscolher={(vezes) => mudar({ vezes, edicoes: [] })}
          />
          {conferencia.total > 0n && (
            <>
              <ul className="m-0 mt-3 list-none p-0">
                {conferencia.parcelas.map((parcela, posicao) =>
                  editandoParcelas ? (
                    <ParcelaEditavel
                      key={posicao}
                      posicao={posicao}
                      parcela={parcela}
                      edicao={rascunho.edicoes[posicao] ?? {}}
                      aoMudar={(mudanca) => mudarParcela(posicao, mudanca)}
                    />
                  ) : (
                    <li key={posicao} className="flex justify-between border-b border-borda py-2 tabular-nums">
                      <span className="text-suave">{quandoDaParcela(posicao + 1, parcela.vencimento)}</span>
                      <span className={parcela.editada ? 'font-semibold' : ''}>{emReais(parcela.valor)}</span>
                    </li>
                  ),
                )}
              </ul>
              {!editandoParcelas && (
                <button type="button" className="mt-1 min-h-11 border-0 bg-transparent p-0 text-[1rem] text-acento underline" onClick={() => setEditandoParcelas(true)}>
                  {PALAVRAS_DA_VENDA.mudarParcelas}
                </button>
              )}
            </>
          )}
        </>
      )}

      <QuandoFoi rotulo={PALAVRAS_DA_VENDA.quandoFoi} quando={quando} hoje={dia} aoMudar={setQuando} />

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
          {PALAVRAS_DA_VENDA.pronto}
        </Botao>
      </div>
    </main>
  )
}

/**
 * Uma parcela em edição (D-012, D-045): "1ª", o campo de data e o campo de valor. O valor
 * vazio mostra, como exemplo, o que a divisão dá — digitar por cima é "combinei outro";
 * apagar é "deixa o sistema dividir de novo".
 */
function ParcelaEditavel({
  posicao,
  parcela,
  edicao,
  aoMudar,
}: {
  posicao: number
  parcela: ParcelaMontada
  edicao: EdicaoDeParcela
  aoMudar: (mudanca: EdicaoDeParcela) => void
}) {
  const ordem = `${posicao + 1}ª`
  return (
    <li className="border-b border-borda py-2">
      <div className="flex items-center gap-2">
        <span className="w-7 flex-none text-suave">{ordem}</span>
        <input
          className={`${CLASSES_DE_CAMPO} min-w-0 flex-1`}
          type="date"
          aria-label={`${ordem} vence em`}
          value={edicao.vencimento ?? parcela.vencimento}
          onChange={(evento) => aoMudar({ vencimento: evento.target.value })}
        />
        <EntradaDeDinheiro
          className={`${CLASSES_DE_CAMPO_COMPACTO} w-[7rem] flex-none text-right tabular-nums`}
          texto={edicao.valorTexto ?? ''}
          aoMudar={(valorTexto) => aoMudar({ valorTexto })}
          exemplo={textoDeCentavos(parcela.valor)}
          rotuloAcessivel={`${ordem} valor`}
        />
      </div>
      <LeituraDoValor texto={edicao.valorTexto ?? ''} className="mt-1 text-right text-[1.125rem]" />
    </li>
  )
}

/** A soma das parcelas montadas, só para a frase da guarda — o domínio confere de verdade. */
function somaDasParcelas(parcelas: readonly ParcelaMontada[]): Centavos {
  return somar(parcelas.map((parcela) => parcela.valor))
}
