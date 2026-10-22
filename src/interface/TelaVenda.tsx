import { RodapeDeAcoes } from './rodape-de-acoes.tsx'
import { useEffect, useState } from 'react'
import { repositorio, repositorioEstoque, operacoesEstoque } from '../dados/instancia.ts'
import type { CatalogoProdutos, EstadoLocalEstoque } from '../dados/repositorio-estoque.ts'
import { corrigirVenda, type VendaCorrigida } from '../dados/operacoes.ts'
import { emReais, lerDinheiro, somar, type Centavos } from '../dominio/dinheiro.ts'
import type { Cliente, Dia, Id, Venda } from '../dominio/ficha.ts'
import { projetarEstoque } from '../dominio/estoque.ts'
import { ehVendaEstoque } from '../dominio/vendas-estoque.ts'
import { Botao } from './Botao.tsx'
import { CLASSES_DE_CAMPO } from './Campo.tsx'
import { CampoDeDinheiro } from './CampoDeDinheiro.tsx'
import { ItensDaVenda } from './itens-da-venda.tsx'
import { conferirVendaComEstoque, lerQuantidade, rascunhoComEstoque, type RascunhoComEstoque } from './venda-com-estoque.ts'
import { fraseVendaEstoque } from './palavras-venda-estoque.ts'
import { diaDoQuando, hoje, quandoDe } from './datas.ts'
import { Escolha, MAXIMO_DE_VEZES } from './Opcoes.tsx'
import { PALAVRAS } from './palavras-da-ficha.ts'
import { fraseDaGuarda, fraseDaRecusa, PALAVRAS_DA_VENDA, tituloDaVenda } from './palavras-da-venda.ts'
import { Parcelas } from './Parcelas.tsx'
import { QuandoFoi } from './QuandoFoi.tsx'
import { parcelasCorrigidas, type EdicaoDeParcela, type ParcelaMontada } from './rascunho-da-venda.ts'
import { Topo } from './Topo.tsx'
import { useLeitura } from './useLeitura.ts'


/** Um rascunho em branco: dois itens (a tarefa cronometrada tem dois), fiado, uma vez, dinheiro (D-045, item 3). */
function rascunhoNovo(): RascunhoComEstoque {
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
 *
 * `outroDiaLembrado` é a última data digitada nesta sessão (D-049): "Outro dia" já vem com
 * ela, e `aoLembrarOutroDia` devolve a que foi gravada — a migração ajusta o dia em vez de
 * digitar a data inteira a cada ficha.
 */
export function TelaVenda({
  clienteId,
  corrigirId,
  outroDiaLembrado,
  aoLembrarOutroDia,
  aoVoltar,
  aoVender,
  aoCorrigir,
}: {
  clienteId: Id
  corrigirId?: Id
  outroDiaLembrado: Dia
  aoLembrarOutroDia: (dia: Dia) => void
  aoVoltar: () => void
  aoVender: (vendaId: Id) => void
  aoCorrigir: (clienteId?: Id) => void
}) {
  const leitura = useLeitura(async () => {
    const cliente = await repositorio.lerCliente(clienteId)
    if (cliente === undefined) return null
    const estado = await repositorioEstoque.lerEstado(), catalogo = await repositorioEstoque.lerCatalogo()
    const clientes = await repositorio.listarClientes()
    if (corrigirId === undefined) return { cliente, original: undefined, estado, catalogo, clientes }
    const original = (await repositorio.lerFicha(clienteId)).find((lancamento) => lancamento.id === corrigirId)
    if (original === undefined || original.tipo !== 'venda') return null
    return { cliente, original, estado, catalogo, clientes }
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

  return (
    <Formulario
      cliente={leitura.valor.cliente}
      original={leitura.valor.original}
      estado={leitura.valor.estado}
      catalogo={leitura.valor.catalogo}
      clientes={leitura.valor.clientes}
      outroDiaLembrado={outroDiaLembrado}
      aoLembrarOutroDia={aoLembrarOutroDia}
      aoVoltar={aoVoltar}
      aoVender={aoVender}
      aoCorrigir={aoCorrigir}
    />
  )
}

/** O formulário, montado uma vez com o rascunho inicial — em branco ou a venda a corrigir. */
function Formulario({
  cliente,
  original,
  estado,
  catalogo,
  clientes,
  outroDiaLembrado,
  aoLembrarOutroDia,
  aoVoltar,
  aoVender,
  aoCorrigir,
}: {
  cliente: Cliente
  original: Venda | undefined
  estado: EstadoLocalEstoque
  catalogo: CatalogoProdutos
  clientes: readonly Cliente[]
  outroDiaLembrado: Dia
  aoLembrarOutroDia: (dia: Dia) => void
  aoVoltar: () => void
  aoVender: (vendaId: Id) => void
  aoCorrigir: (clienteId?: Id) => void
}) {
  const dia = hoje()
  const [rascunho, setRascunho] = useState<RascunhoComEstoque>(() => (original === undefined ? rascunhoNovo() : rascunhoComEstoque(original)))
  const [clienteCorrigido, setClienteCorrigido] = useState(cliente.id)
  const [natureza, setNatureza] = useState<'financeira' | 'anotacao'>('financeira')
  const [entregasCorrigidas, setEntregasCorrigidas] = useState<Record<string, { quantidade?: string; custo?: string }>>({})
  const [quando, setQuando] = useState(() => quandoDe(original?.data, dia, outroDiaLembrado))
  const [descontoAberto, setDescontoAberto] = useState(() => rascunho.descontoTexto !== '')
  const [gravando, setGravando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)

  const data: Dia = diaDoQuando(quando, dia)
  const conferencia = conferirVendaComEstoque({ ...rascunho, data }, estado, dia)
  const frases = conferencia.guardas
    .map((guarda) => fraseDaGuarda(guarda, somaDasParcelas(conferencia.parcelas), conferencia.total))
    .filter((frase): frase is string => frase !== null)
  const podeGravar = conferencia.guardas.length === 0 && !conferencia.erro && !gravando && cliente.desativadoEm === undefined
  const originalF2 = original !== undefined && ehVendaEstoque(original)
  const entregas = originalF2 ? [...new Set(original.itens.flatMap((i) => i.produtoId ? [i.produtoId] : []))].flatMap((id) => {
    const p = projetarEstoque(estado.movimentos, id)
    return p.ok ? p.valor.movimentosVigentes.filter((m) => m.tipo === 'entrega' && original.itens.some((i) => i.id === m.itemId)) : []
  }) : []
  // A correção de uma venda com mais parcelas nunca oferece menos do que ela tem.
  const maximoDeVezes = Math.max(MAXIMO_DE_VEZES, rascunho.vezes)

  function mudar(mudanca: Partial<RascunhoComEstoque>): void {
    setRascunho((atual) => ({ ...atual, ...mudanca }))
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
      if (original === undefined || originalF2) {
        const entrada = { ...comum, clienteId: clienteCorrigido, itens: conferencia.itensLocais,
          ...(rascunho.pagamento === 'fiado' ? { pagamento: 'fiado' as const,
            parcelas: parcelasCorrigidas(conferencia.parcelas, original?.pagamento === 'fiado' ? original.parcelas : []) }
            : { pagamento: 'avista' as const, forma: rascunho.forma }) }
        const mudancas = entregas.flatMap((m) => {
          if (m.tipo !== 'entrega' || natureza !== 'anotacao') return []
          const item = rascunho.itens.find((i) => i.id === m.itemId)
          const edicao = entregasCorrigidas[m.id]
          const quantidade = lerQuantidade(edicao?.quantidade ?? String(m.quantidade))
          const produtoId = item?.produtoId
          if (quantidade === null || !produtoId) throw new Error('entrega incompleta')
          const custo = edicao?.custo?.trim() ? lerDinheiro(edicao.custo) ?? undefined : undefined
          return produtoId === m.produtoId && quantidade === m.quantidade ? [] : [{ alvo: { id: m.id, revisao: m.revisao }, produtoId, quantidade, custoUnitario: custo }]
        })
        const resultado = original === undefined ? await operacoesEstoque.lancarVenda(entrada)
          : await operacoesEstoque.corrigirVenda(original.id, entrada, { data: dia, natureza, entregas: mudancas })
        if (!resultado.ok) { setErro(fraseVendaEstoque(resultado.motivo)); return }
        if (quando.escolha === 'outro') aoLembrarOutroDia(data)
        if (original) aoCorrigir(clienteCorrigido)
        else {
          const venda = resultado.valor.lancamentos.find((l) => l.tipo === 'venda')
          if (venda) aoVender(venda.id)
        }
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

      {originalF2 && <>
        <label>Fichinha<select className={CLASSES_DE_CAMPO} value={clienteCorrigido} onChange={(e) => setClienteCorrigido(e.target.value)}>
          {clientes.filter((c) => !c.desativadoEm || c.id === cliente.id).map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}
        </select></label>
        <Escolha rotulo="O que vai corrigir" valor={natureza} aoEscolher={setNatureza} opcoes={[
          { valor: 'financeira', texto: 'Só valor ou fichinha' }, { valor: 'anotacao', texto: 'Anotei errado o que saiu' }]} />
        {natureza === 'anotacao' && <p>Informe o que realmente saiu naquela entrega. Se a mercadoria voltou depois, use “Devolução ou troca” na venda.</p>}
      </>}
      <ItensDaVenda rascunho={{ ...rascunho, data }} estado={estado} catalogo={catalogo} aoMudar={(itens) => mudar({ itens })} correcao={!!original} legada={!!original && !originalF2} />
      {natureza === 'anotacao' && entregas.map((m) => m.tipo === 'entrega' && <fieldset key={m.id} className="my-3 rounded-xl border border-borda p-3">
        <legend>Entrega de {m.data.split('-').reverse().join('/')}</legend>
        <label>Quantidade que realmente saiu<input className={CLASSES_DE_CAMPO} inputMode="numeric" value={entregasCorrigidas[m.id]?.quantidade ?? String(m.quantidade)}
          onChange={(e) => setEntregasCorrigidas((a) => ({ ...a, [m.id]: { ...a[m.id], quantidade: e.target.value } }))} /></label>
        {rascunho.itens.find((i) => i.id === m.itemId)?.produtoId !== m.produtoId && <CampoDeDinheiro rotulo="Custo daquela entrega, se souber"
          texto={entregasCorrigidas[m.id]?.custo ?? ''} permitirZero aoMudar={(custo) => setEntregasCorrigidas((a) => ({ ...a, [m.id]: { ...a[m.id], custo } }))} />}
      </fieldset>)}

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
        <Parcelas
          maximo={maximoDeVezes}
          vezes={rascunho.vezes}
          parcelas={conferencia.parcelas}
          edicoes={rascunho.edicoes}
          lista={conferencia.total > 0n}
          // Mudar o número de vezes recomeça a divisão do zero (D-045): as edições anteriores não fazem sentido em outra contagem.
          aoMudarVezes={(vezes) => mudar({ vezes, edicoes: [] })}
          aoMudarParcela={mudarParcela}
        />
      )}

      <QuandoFoi rotulo={PALAVRAS_DA_VENDA.quandoFoi} quando={quando} hoje={dia} aoMudar={setQuando} />

      {(frases.length > 0 || conferencia.erro || erro !== null) && (
        <div className="mt-4">
          {frases.map((frase) => (
            <p key={frase} className="m-0 font-semibold text-atraso">
              {frase}
            </p>
          ))}
          {erro !== null && <p className="m-0 font-semibold text-atraso">{erro}</p>}
          {conferencia.erro && <p className="m-0 font-semibold text-atraso">{conferencia.erro}</p>}
        </div>
      )}

      <RodapeDeAcoes>
        <Botao tipo="principal" aoTocar={() => void gravar()} desabilitado={!podeGravar}>
          {PALAVRAS_DA_VENDA.pronto}
        </Botao>
      </RodapeDeAcoes>
    </main>
  )
}

/** A soma das parcelas montadas, só para a frase da guarda — o domínio confere de verdade. */
function somaDasParcelas(parcelas: readonly ParcelaMontada[]): Centavos {
  return somar(parcelas.map((parcela) => parcela.valor))
}
