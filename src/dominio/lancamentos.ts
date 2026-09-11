/**
 * O que ela lança: as operações que criam ou corrigem lançamentos da ficha (E-04).
 *
 * Cada função aqui recebe a ficha como está, monta o lançamento novo (ou o substituto), e
 * só devolve depois que `validar` de `ficha.ts` aceitou a ficha resultante. É uma regra num
 * lugar só: nenhuma operação repete uma invariante que `validar` já confere — ela só
 * acrescenta a regra do **momento**, que o estado final não sabe recuperar (o troco de RN-03,
 * o limite de RN-15, a janela de D-013, a parcela paga de RN-08).
 *
 * Nada aqui gera id nem lê relógio: `id` e `data` entram de fora (E-05 gera o UUIDv7,
 * D-029; a data é a do fato, RN-09). Nada aqui consulta a fila de sincronização: o estado
 * "já subiu?" entra como argumento (`Correcao`), porque o domínio não conhece a fila (D-013).
 *
 * Toda recusa é um `Resultado` com `motivo` em código, para a tela mostrar antes do toque.
 */

import type { Centavos } from './dinheiro.ts'
import {
  LIMITE_QUITACAO,
  aceito,
  ehDebito,
  parcelas,
  recusado,
  saldo,
  validar,
  type Cliente,
  type Debito,
  type DescontoQuitacao,
  type Dia,
  type Estorno,
  type Ficha,
  type FormaDePagamento,
  type Id,
  type ItemVenda,
  type Lancamento,
  type Parcela,
  type Recebimento,
  type Resultado,
  type SaldoAnterior,
  type VendaAVista,
  type VendaFiado,
} from './ficha.ts'

/** Valida um lançamento por ele mesmo, como ficha de um item só. Serve aos construtores. */
function validarSozinho<L extends Lancamento>(lancamento: L): Resultado<L> {
  const resultado = validar([lancamento])
  return resultado.ok ? aceito(lancamento) : resultado
}

/** Valida a ficha com o lançamento acrescentado e devolve o lançamento. Serve às operações. */
function acrescentar<L extends Lancamento>(ficha: Ficha, lancamento: L): Resultado<L> {
  const resultado = validar([...ficha, lancamento])
  return resultado.ok ? aceito(lancamento) : resultado
}

export type EntradaCliente = {
  readonly id: Id
  readonly nome: string
  readonly telefone?: string
  readonly apelido?: string
  readonly observacao?: string
}

/**
 * Cadastro de cliente (RF-01): só o nome é obrigatório, e ele é guardado sem espaços em
 * volta. Duas clientes podem ter o mesmo nome — a desambiguação é humana, pelo apelido.
 * O telefone fica como digitado; normalizar é da hora de montar o link do WhatsApp (RF-09).
 */
export function novoCliente(entrada: EntradaCliente): Resultado<Cliente> {
  const nome = entrada.nome.trim()
  if (nome === '') return recusado('nome-obrigatorio')
  return aceito({ ...entrada, nome })
}

export type EntradaVendaFiado = {
  readonly id: Id
  readonly clienteId: Id
  readonly data: Dia
  readonly itens: readonly ItemVenda[]
  /** Desconto no total (RF-03). Ausente é zero. */
  readonly desconto?: Centavos
  /**
   * As parcelas combinadas, já com valor e data (RF-05). A divisão automática é
   * `repartir` de `dinheiro.ts` (D-012, D-030); o que ela editou à mão entra como está.
   * A soma precisa ser o total da venda, e é `validar` quem confere.
   */
  readonly parcelas: readonly Parcela[]
}

/** Venda fiado (RF-03, RF-05): a dívida nasce desta venda, nas parcelas combinadas. */
export function novaVendaFiado(entrada: EntradaVendaFiado): Resultado<VendaFiado> {
  return validarSozinho({
    tipo: 'venda',
    pagamento: 'fiado',
    id: entrada.id,
    clienteId: entrada.clienteId,
    data: entrada.data,
    itens: entrada.itens,
    desconto: entrada.desconto ?? 0n,
    parcelas: entrada.parcelas,
  })
}

export type EntradaVendaAVista = {
  readonly id: Id
  readonly clienteId: Id
  readonly data: Dia
  readonly itens: readonly ItemVenda[]
  readonly desconto?: Centavos
  readonly forma: FormaDePagamento
}

/** Venda à vista (RN-04): um lançamento só, que nasce pago e não mexe no saldo (D-039). */
export function novaVendaAVista(entrada: EntradaVendaAVista): Resultado<VendaAVista> {
  return validarSozinho({
    tipo: 'venda',
    pagamento: 'avista',
    id: entrada.id,
    clienteId: entrada.clienteId,
    data: entrada.data,
    itens: entrada.itens,
    desconto: entrada.desconto ?? 0n,
    forma: entrada.forma,
  })
}

export type EntradaSaldoAnterior = {
  readonly id: Id
  readonly clienteId: Id
  /** "Desde tal data" (RF-07). */
  readonly data: Dia
  readonly parcelas: readonly Parcela[]
}

/** Saldo anterior (RF-07): "já me deve R$ X desde tal data", em parcelas, sem inventar venda. */
export function novoSaldoAnterior(entrada: EntradaSaldoAnterior): Resultado<SaldoAnterior> {
  return validarSozinho({
    tipo: 'saldo-anterior',
    id: entrada.id,
    clienteId: entrada.clienteId,
    data: entrada.data,
    parcelas: entrada.parcelas,
  })
}

/**
 * Quanto de um valor recebido entra na ficha e quanto volta como troco (RN-03, D-016).
 * A cliente deve R$ 47,00 e manda R$ 50,00: registra 47,00, troco 3,00 — ela devolve a
 * diferença na hora, como no caderno. Não vira crédito; a ficha nunca fica negativa.
 * A tela chama isto enquanto ela digita, para o troco aparecer **antes** de confirmar (E-11).
 */
export function calcularTroco(saldoAtual: Centavos, valor: Centavos): { registrado: Centavos; troco: Centavos } {
  if (valor > saldoAtual) return { registrado: saldoAtual, troco: valor - saldoAtual }
  return { registrado: valor, troco: 0n }
}

export type EntradaRecebimento = {
  readonly id: Id
  readonly clienteId: Id
  readonly data: Dia
  /** O que ela recebeu de fato. O que passa do saldo vira troco, não lançamento. */
  readonly valor: Centavos
  readonly forma: FormaDePagamento
  readonly observacao?: string
}

/**
 * Recebimento (RF-06): a operação mais frequente depois de abrir a ficha. Não pergunta nada
 * a ela (RI-08): o abatimento na parcela mais antiga é derivado em `parcelas()`, e o troco
 * é calculado aqui. Recusa valor não positivo e ficha sem dívida — nos dois casos a tela
 * já sabe antes do toque.
 */
export function registrarRecebimento(
  ficha: Ficha,
  entrada: EntradaRecebimento,
): Resultado<{ recebimento: Recebimento; troco: Centavos }> {
  if (entrada.valor <= 0n) return recusado('valor-invalido')
  const saldoAtual = saldo(ficha)
  if (saldoAtual === 0n) return recusado('nada-a-receber')
  const { registrado, troco } = calcularTroco(saldoAtual, entrada.valor)
  const recebimento: Recebimento = {
    tipo: 'recebimento',
    id: entrada.id,
    clienteId: entrada.clienteId,
    data: entrada.data,
    valor: registrado,
    forma: entrada.forma,
    observacao: entrada.observacao,
  }
  const resultado = acrescentar(ficha, recebimento)
  return resultado.ok ? aceito({ recebimento, troco }) : resultado
}

/** Se o botão "considerar pago" deve aparecer: só com saldo de até R$ 0,10, e maior que zero (RN-15, D-031). */
export function podeConsiderarPago(ficha: Ficha): boolean {
  const saldoAtual = saldo(ficha)
  return saldoAtual > 0n && saldoAtual <= LIMITE_QUITACAO
}

export type EntradaQuitacao = {
  readonly id: Id
  readonly clienteId: Id
  readonly data: Dia
}

/**
 * "Considerar pago" (RN-15, D-031): perdoa o resíduo de centavos e fecha a ficha. O valor é
 * o saldo inteiro — ela não escolhe quanto, só se. É um toque dela, e não automático,
 * porque perdoar dívida é dinheiro dela saindo (RI-08 não cobre isso).
 */
export function considerarPago(ficha: Ficha, entrada: EntradaQuitacao): Resultado<DescontoQuitacao> {
  const saldoAtual = saldo(ficha)
  if (saldoAtual === 0n) return recusado('nada-a-quitar')
  if (saldoAtual > LIMITE_QUITACAO) return recusado('acima-do-limite-de-quitacao')
  return acrescentar(ficha, {
    tipo: 'desconto-quitacao',
    id: entrada.id,
    clienteId: entrada.clienteId,
    data: entrada.data,
    valor: saldoAtual,
  })
}

export type EntradaEstorno = {
  readonly id: Id
  readonly clienteId: Id
  readonly data: Dia
  /** O lançamento que está sendo desfeito. */
  readonly estornaId: Id
  readonly motivo?: string
}

/**
 * Estorno (RF-08, RN-07, RI-03): o lançamento inverso. Nada é apagado; o alvo fica no
 * histórico ao lado desta linha. As recusas vêm todas de `validar`: alvo inexistente, alvo
 * que é estorno (não se estorna estorno, D-039), alvo já estornado, e **ficha que ficaria
 * negativa** — estornar um débito já pago deixaria dinheiro recebido sem o que abater, e
 * a saída registrada é estornar o recebimento antes (D-039). Para E-10: renegociar depois
 * de sincronizado é lançar a venda nova **antes** de estornar a velha.
 */
export function estornar(ficha: Ficha, entrada: EntradaEstorno): Resultado<Estorno> {
  return acrescentar(ficha, {
    tipo: 'estorno',
    id: entrada.id,
    clienteId: entrada.clienteId,
    data: entrada.data,
    estornaId: entrada.estornaId,
    motivo: entrada.motivo,
  })
}

/** O estado da fila de sincronização para o lançamento em questão, informado por quem a conhece (E-07). */
export type Correcao = {
  /** `true` se o lançamento já subiu para a nuvem. A fila é a fonte; nunca um relógio. */
  readonly sincronizado: boolean
}

/**
 * Qual verbo a tela mostra para um lançamento (D-013): "corrigir" enquanto não sincronizou,
 * "estornar" depois — nunca os dois. Existe como função para a regra ter um lugar só, e para
 * E-10 e E-11 não a escreverem de dois jeitos.
 */
export function caminhoDeCorrecao(sincronizado: boolean): 'corrigir' | 'estornar' {
  return sincronizado ? 'estornar' : 'corrigir'
}

/**
 * Correção no lugar (RF-08, D-013): substitui um lançamento pelo mesmo id, **só enquanto ele
 * não sincronizou** — depois disso nenhum outro aparelho pode tê-lo visto, e substituir é
 * seguro para D-010. Recusa: já sincronizado; id que não existe; estorno (não se corrige,
 * D-039); tipo diferente (uma venda não vira recebimento); e, num débito, **parcela já paga
 * alterada** (RN-08) — paga é a parcela derivada como quitada em `parcelas()`, e ela precisa
 * continuar na lista nova com o mesmo id, valor e vencimento. O resto é `validar`: a soma
 * das parcelas ainda fecha o total, a ficha não fica negativa.
 *
 * O substituto precisa ser da mesma cliente. Corrigir "cliente errado" atravessa duas fichas,
 * e o domínio é por ficha: a origem valida sem o lançamento, o destino valida com ele —
 * responsabilidade de E-05, com `validar` dos dois lados.
 *
 * Devolve o próprio substituto quando aceito; quem persiste o grava sobre o mesmo id.
 */
export function corrigir<L extends Lancamento>(ficha: Ficha, substituto: L, correcao: Correcao): Resultado<L> {
  if (correcao.sincronizado) return recusado('ja-sincronizado')
  const original = ficha.find((lancamento) => lancamento.id === substituto.id)
  if (original === undefined) return recusado('lancamento-nao-encontrado')
  if (original.tipo === 'estorno') return recusado('lancamento-e-estorno')
  if (original.tipo !== substituto.tipo) return recusado('tipo-diferente')

  if (ehDebito(original)) {
    // RN-08: toda parcela derivada como paga continua igual. Parcela de valor zero não conta
    // como paga — não houve o que pagar, e ela pode ser renegociada para fora.
    const pagas = parcelas(ficha).filter(
      (item) => item.debito.id === original.id && item.parcela.valor > 0n && item.restante === 0n,
    )
    const novas: readonly Parcela[] = ehDebito(substituto) ? substituto.parcelas : []
    for (const { parcela } of pagas) {
      const mantida = novas.find((nova) => nova.id === parcela.id)
      if (mantida === undefined || mantida.valor !== parcela.valor || mantida.vencimento !== parcela.vencimento) {
        return recusado('parcela-paga-alterada')
      }
    }
  }

  const resultado = validar(ficha.map((lancamento) => (lancamento.id === substituto.id ? substituto : lancamento)))
  return resultado.ok ? aceito(substituto) : resultado
}

/**
 * Cliente errado (RF-08, D-013, D-040): move um lançamento da ficha em que ela lançou por
 * engano para a ficha certa, **só enquanto não sincronizou** — a mesma janela de `corrigir`,
 * pelo mesmo motivo. O domínio é por ficha, então a correção atravessa duas: a origem precisa
 * continuar válida **sem** o lançamento, e o destino precisa ser válido **com** ele. Quem
 * persiste grava o substituto sobre o mesmo id, com o `clienteId` novo — uma linha só (E-05).
 *
 * Recusas próprias, antes de `validar`: já sincronizado; id que não existe na origem; estorno
 * (anda junto do alvo, não se move sozinho); alvo já estornado (o estorno ficaria apontando
 * para o nada); mesma cliente (não há o que corrigir); e débito com **qualquer parte paga** na
 * origem (RN-08) — mover levaria a parcela paga para uma ficha onde ela não está, e o
 * recebimento que a pagou escorreria em silêncio para outro débito. A saída, como em D-039, é
 * desfazer o recebimento antes.
 *
 * O resto é `validar`, nos dois lados: a origem não fica negativa sem o lançamento (um
 * recebimento que só tinha aquele débito para abater); o destino não fica negativo com ele
 * (um recebimento maior que a dívida da outra cliente — sem troco aqui, é recusa).
 */
export function corrigirCliente(
  origem: Ficha,
  destino: Ficha,
  lancamentoId: Id,
  novoClienteId: Id,
  correcao: Correcao,
): Resultado<Lancamento> {
  if (correcao.sincronizado) return recusado('ja-sincronizado')
  const original = origem.find((lancamento) => lancamento.id === lancamentoId)
  if (original === undefined) return recusado('lancamento-nao-encontrado')
  if (original.tipo === 'estorno') return recusado('lancamento-e-estorno')
  if (original.clienteId === novoClienteId) return recusado('mesmo-cliente')
  if (origem.some((lancamento) => lancamento.tipo === 'estorno' && lancamento.estornaId === lancamentoId)) {
    return recusado('ja-estornado')
  }
  if (ehDebito(original) && parcelas(origem).some((item) => item.debito.id === original.id && item.pago > 0n)) {
    return recusado('parcela-paga-alterada')
  }

  const origemSemEle = validar(origem.filter((lancamento) => lancamento.id !== lancamentoId))
  if (!origemSemEle.ok) return origemSemEle
  const substituto: Lancamento = { ...original, clienteId: novoClienteId }
  const destinoComEle = validar([...destino, substituto])
  return destinoComEle.ok ? aceito(substituto) : destinoComEle
}

/**
 * Renegociação de parcelas (RN-08, D-012): troca as parcelas de um débito mantendo a soma
 * igual ao total e sem tocar parcela já paga. É `corrigir` restrito às parcelas, com as
 * mesmas regras e a mesma janela — no lugar enquanto não sincronizou, estorno depois.
 * O valor que ela digita não precisa ser múltiplo de nada (D-030 só vale para a divisão
 * automática).
 */
export function renegociarParcelas(
  ficha: Ficha,
  debitoId: Id,
  novasParcelas: readonly Parcela[],
  correcao: Correcao,
): Resultado<Debito> {
  const debito = ficha.find((lancamento) => lancamento.id === debitoId)
  if (debito === undefined || !ehDebito(debito)) return recusado('lancamento-nao-encontrado')
  return corrigir(ficha, { ...debito, parcelas: novasParcelas }, correcao)
}
