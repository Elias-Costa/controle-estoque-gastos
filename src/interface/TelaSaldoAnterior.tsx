import { useEffect, useState } from 'react'
import { repositorio } from '../dados/instancia.ts'
import { corrigirSaldoAnterior, lancarSaldoAnterior } from '../dados/operacoes.ts'
import { somar } from '../dominio/dinheiro.ts'
import type { Cliente, Dia, Id, SaldoAnterior } from '../dominio/ficha.ts'
import { Botao } from './Botao.tsx'
import { Campo } from './Campo.tsx'
import { CampoDeDinheiro } from './CampoDeDinheiro.tsx'
import { hoje } from './datas.ts'
import { PALAVRAS } from './palavras-da-ficha.ts'
import { fraseDaRecusa } from './palavras-da-venda.ts'
import { fraseDaGuardaDoSaldoAnterior, PALAVRAS_DO_SALDO_ANTERIOR, tituloDoSaldoAnterior } from './palavras-do-saldo-anterior.ts'
import { Parcelas } from './Parcelas.tsx'
import { parcelasCorrigidas, type EdicaoDeParcela } from './rascunho-da-venda.ts'
import { conferirSaldoAnterior, rascunhoDoSaldoAnterior, type ConferenciaDoSaldoAnterior, type RascunhoDoSaldoAnterior } from './rascunho-do-saldo-anterior.ts'
import { Topo } from './Topo.tsx'
import { useLeitura } from './useLeitura.ts'

/** O máximo de "vezes" da venda; a correção de um saldo com mais parcelas nunca oferece menos do que ele tem. */
const VEZES_DO_PROTOTIPO = 4

/**
 * O saldo anterior para uma cliente já cadastrada (E-14, RF-07, D-009, D-049): "O que a Rosa
 * já devia". A mesma migração em uma linha do cadastro (D-044), aberta pela linha "Anotar o
 * que ela já devia" no fim da ficha — para a ficha de papel que aparece depois do cadastro,
 * ou que não vale relançar detalhado. Volta à ficha ao gravar: "Deve R$ X" e a linha "Já
 * devia" são a confirmação (não há cliente na frente para conferir número em voz alta).
 *
 * Com `corrigirId` é a **correção** (D-013): a mesma tela, preenchida com o saldo como está;
 * o "Pronto" regrava a mesma linha, com o id das parcelas pela posição (RN-08).
 *
 * "Desde" já vem com a última data digitada nesta sessão (`outroDiaLembrado`, D-049 item 1) —
 * ou hoje, sem nenhuma.
 */
export function TelaSaldoAnterior({
  clienteId,
  corrigirId,
  outroDiaLembrado,
  aoLembrarOutroDia,
  aoVoltar,
  aoAnotar,
}: {
  clienteId: Id
  corrigirId?: Id
  outroDiaLembrado: Dia
  aoLembrarOutroDia: (dia: Dia) => void
  aoVoltar: () => void
  aoAnotar: () => void
}) {
  const leitura = useLeitura(async () => {
    const cliente = await repositorio.lerCliente(clienteId)
    if (cliente === undefined) return null
    if (corrigirId === undefined) return { cliente, original: undefined }
    const original = (await repositorio.lerFicha(clienteId)).find((lancamento) => lancamento.id === corrigirId)
    if (original === undefined || original.tipo !== 'saldo-anterior') return null
    return { cliente, original }
  }, `${clienteId}:${corrigirId ?? ''}`)

  // Cliente ou saldo que sumiu entre um toque e outro (só por outro aparelho): volta por onde entrou.
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
      outroDiaLembrado={outroDiaLembrado}
      aoLembrarOutroDia={aoLembrarOutroDia}
      aoVoltar={aoVoltar}
      aoAnotar={aoAnotar}
    />
  )
}

/** O formulário, montado uma vez com o rascunho inicial — em branco ou o saldo a corrigir. */
function Formulario({
  cliente,
  original,
  outroDiaLembrado,
  aoLembrarOutroDia,
  aoVoltar,
  aoAnotar,
}: {
  cliente: Cliente
  original: SaldoAnterior | undefined
  outroDiaLembrado: Dia
  aoLembrarOutroDia: (dia: Dia) => void
  aoVoltar: () => void
  aoAnotar: () => void
}) {
  const dia = hoje()
  const [rascunho, setRascunho] = useState<RascunhoDoSaldoAnterior>(() =>
    original === undefined ? rascunhoNovo(outroDiaLembrado === '' ? dia : outroDiaLembrado) : rascunhoDoSaldoAnterior(original),
  )
  // "Vence em" acompanha "desde" até ela mexer (D-044); na correção já vem mexido.
  const [venceEmEditado, setVenceEmEditado] = useState<Dia | null>(() => (original === undefined ? null : rascunho.venceEm))
  const [gravando, setGravando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)

  const completo: RascunhoDoSaldoAnterior = { ...rascunho, venceEm: venceEmEditado ?? rascunho.desde }
  const conferencia = conferirSaldoAnterior(completo, dia)
  const frases = conferencia.guardas
    .map((guarda) => fraseDaGuardaDoSaldoAnterior(guarda, somar(conferencia.parcelas.map((parcela) => parcela.valor)), conferencia.valor))
    .filter((frase): frase is string => frase !== null)
  const podeGravar = conferencia.guardas.length === 0 && !gravando

  function mudar(mudanca: Partial<RascunhoDoSaldoAnterior>): void {
    if (mudanca.venceEm !== undefined) setVenceEmEditado(mudanca.venceEm)
    setRascunho((atual) => ({ ...atual, ...mudanca }))
  }

  async function gravar(): Promise<void> {
    if (!podeGravar) return
    setGravando(true)
    setErro(null)
    const parcelas = conferencia.parcelas.map(({ vencimento, valor }) => ({ vencimento, valor }))
    try {
      if (original === undefined) {
        const resultado = await lancarSaldoAnterior(repositorio, { clienteId: cliente.id, data: completo.desde, parcelas })
        if (!resultado.ok) {
          setErro(fraseDaRecusa(resultado.motivo))
          return
        }
      } else {
        // A janela de D-013 é lida na hora de gravar, não na de abrir: a fila pode ter subido no meio.
        const sincronizado = await repositorio.sincronizado(original.id)
        const resultado = await corrigirSaldoAnterior(
          repositorio,
          { tipo: 'saldo-anterior', id: original.id, clienteId: cliente.id, data: completo.desde, parcelas: parcelasCorrigidas(conferencia.parcelas, original.parcelas) },
          { sincronizado },
        )
        if (!resultado.ok) {
          setErro(fraseDaRecusa(resultado.motivo))
          return
        }
      }
      // A data que ela digitou vale para o próximo "Outro dia" (D-049); hoje não é digitado.
      if (completo.desde !== dia) aoLembrarOutroDia(completo.desde)
      aoAnotar()
    } catch {
      // A base local não gravou (EL-06): dito na tela, com palavras dela; nada foi perdido em silêncio.
      setErro(PALAVRAS_DO_SALDO_ANTERIOR.naoDeu)
    } finally {
      setGravando(false)
    }
  }

  return (
    <main className="tela">
      <Topo titulo={tituloDoSaldoAnterior(cliente.nome)} aoVoltar={aoVoltar} />

      <CamposDoSaldoAnterior
        rotuloDoValor={PALAVRAS_DO_SALDO_ANTERIOR.quanto}
        rascunho={completo}
        conferencia={conferencia}
        maximoDeVezes={Math.max(VEZES_DO_PROTOTIPO, rascunho.vezes)}
        aoMudar={mudar}
      />

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
          {PALAVRAS_DO_SALDO_ANTERIOR.pronto}
        </Botao>
      </div>
    </main>
  )
}

/** Um rascunho em branco: sem valor, "desde" no dia dado, uma vez. */
function rascunhoNovo(desde: Dia): RascunhoDoSaldoAnterior {
  return { valorTexto: '', desde, venceEm: desde, vezes: 1, edicoes: [] }
}

/**
 * Os campos do saldo anterior (D-044, D-049), os mesmos no cadastro e na tela própria: o
 * valor e, só depois que há um, "Desde", "Vence em" e o bloco das parcelas — com 1×, "Vence em"
 * é a parcela inteira e a lista não aparece; com 2× ou mais, a lista vem de "vence em" em
 * diante. Nada é carimbado em silêncio: as datas ficam visíveis, com padrão visível.
 * Quem lê e monta é `conferirSaldoAnterior`; aqui só se mostra e se recolhe o que ela digitou.
 */
export function CamposDoSaldoAnterior({
  rotuloDoValor,
  rascunho,
  conferencia,
  maximoDeVezes,
  aoMudar,
}: {
  rotuloDoValor: string
  rascunho: RascunhoDoSaldoAnterior
  conferencia: ConferenciaDoSaldoAnterior
  maximoDeVezes: number
  aoMudar: (mudanca: Partial<RascunhoDoSaldoAnterior>) => void
}) {
  const temValor = conferencia.valor > 0n

  function mudarParcela(posicao: number, mudanca: EdicaoDeParcela): void {
    const edicoes = Array.from({ length: rascunho.vezes }, (_, i) => rascunho.edicoes[i] ?? {})
    aoMudar({ edicoes: edicoes.map((edicao, i) => (i === posicao ? { ...edicao, ...mudanca } : edicao)) })
  }

  return (
    <>
      <CampoDeDinheiro rotulo={rotuloDoValor} texto={rascunho.valorTexto} aoMudar={(valorTexto) => aoMudar({ valorTexto })} />
      {temValor && (
        <>
          <Campo rotulo={PALAVRAS.cadastro.desde} valor={rascunho.desde} aoMudar={(desde) => aoMudar({ desde })} tipo="date" />
          <Campo rotulo={PALAVRAS.cadastro.venceEm} valor={rascunho.venceEm} aoMudar={(venceEm) => aoMudar({ venceEm })} tipo="date" />
          <Parcelas
            maximo={maximoDeVezes}
            vezes={rascunho.vezes}
            parcelas={conferencia.parcelas}
            edicoes={rascunho.edicoes}
            lista={rascunho.vezes > 1 && conferencia.parcelas.length > 0}
            // Mudar o número de vezes recomeça a divisão do zero (D-045): as edições anteriores não fazem sentido em outra contagem.
            aoMudarVezes={(vezes) => aoMudar({ vezes, edicoes: [] })}
            aoMudarParcela={mudarParcela}
          />
        </>
      )}
    </>
  )
}
