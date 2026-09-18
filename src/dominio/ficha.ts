/**
 * A ficha: a página do caderno dela, como regras puras (E-04).
 *
 * Aqui mora o lado da **leitura** — os tipos dos lançamentos e tudo que a ficha mostra:
 * o saldo (RN-01), as parcelas em aberto (RN-02), a próxima parcela e o histórico (RF-02),
 * mais a validação que toda operação de `lancamentos.ts` chama antes de devolver qualquer
 * coisa. O lado da **escrita** — o que ela lança — está em `lancamentos.ts`.
 *
 * Duas escolhas atravessam este arquivo, e as duas são D-039:
 *
 * - **Nada aqui é guardado; tudo é derivado.** Não existe campo de saldo, não existe marca
 *   de "parcela paga", não existe "este recebimento abateu aquela parcela". O saldo é a soma
 *   dos lançamentos; as parcelas em aberto são a projeção do total recebido sobre as
 *   parcelas ordenadas por vencimento. Como as duas coisas nascem da mesma soma, elas
 *   **não podem** divergir — EL-02 impossível por construção, e provada por teste
 *   (`testes/ficha.test.ts`, RT-04).
 * - **Lançamento é imutável.** Todo campo é `readonly` porque correção é estorno ou
 *   substituição pelo mesmo id (RI-03, D-013), nunca alteração de um objeto que já existe.
 *   O compilador recusa `venda.parcelas.push(...)`.
 *
 * Dinheiro é `bigint` de centavos (`./dinheiro.ts`, D-022). Datas são texto `AAAA-MM-DD`,
 * sem hora: comparar texto é comparar dia, sem fuso, e o domínio não lê relógio — `hoje`
 * entra como argumento onde importa.
 */

import { somar, type Centavos } from './dinheiro.ts'

/** Identidade de um registro. Gerada fora do domínio, no dispositivo (UUIDv7, D-029, E-05). */
export type Id = string

/**
 * Um dia, como texto `AAAA-MM-DD`. É sempre a data do **fato**, não a do lançamento (RN-09):
 * ela lança no fim do dia, ou no dia seguinte. O formato é validado; o calendário (30 de
 * fevereiro) é responsabilidade do campo de data da tela.
 */
export type Dia = string

/**
 * A cliente. Só o nome é obrigatório (RF-01); telefone fica como ela digitou. `desativadoEm` é
 * a marca de "fichinha desativada" (D-050, item 6): cliente não se apaga (D-041), some das
 * listas — e volta quando a marca sai.
 */
export type Cliente = {
  readonly id: Id
  readonly nome: string
  readonly telefone?: string
  readonly apelido?: string
  readonly observacao?: string
  readonly desativadoEm?: Dia
}

/** Um item da venda: descrição livre e preço, e só isso em F1 (D-011). Sem produto, sem quantidade. */
export type ItemVenda = {
  readonly descricao: string
  readonly preco: Centavos
}

/**
 * Uma parcela combinada: quanto e quando. Tem id próprio porque a renegociação (RN-08)
 * precisa dizer "esta parcela, que já está paga, continua igual" — e sem identidade não
 * haveria o que comparar quando ela remove ou acrescenta parcelas.
 */
export type Parcela = {
  readonly id: Id
  readonly vencimento: Dia
  readonly valor: Centavos
}

/** Como o dinheiro chegou (RF-06). */
export type FormaDePagamento = 'pix' | 'dinheiro' | 'outro'

/** O que todo lançamento carrega: quem, quando, e a identidade que é a chave de idempotência (RI-05). */
type LancamentoBase = {
  readonly id: Id
  readonly clienteId: Id
  readonly data: Dia
}

/** Venda fiado: itens, desconto no total (RF-03) e as parcelas combinadas (RF-05). */
export type VendaFiado = LancamentoBase & {
  readonly tipo: 'venda'
  readonly pagamento: 'fiado'
  readonly itens: readonly ItemVenda[]
  readonly desconto: Centavos
  readonly parcelas: readonly Parcela[]
}

/**
 * Venda à vista: um lançamento só (D-039). O dinheiro entrou junto com a venda, então não
 * há parcela, não há saldo a abater e ela nunca vence (RN-04). O que saiu e o que entrou
 * são o mesmo campo, com a mesma data — não têm como divergir.
 */
export type VendaAVista = LancamentoBase & {
  readonly tipo: 'venda'
  readonly pagamento: 'avista'
  readonly forma: FormaDePagamento
  readonly itens: readonly ItemVenda[]
  readonly desconto: Centavos
}

export type Venda = VendaFiado | VendaAVista

/**
 * Saldo anterior: a migração do papel em uma linha (RF-07, D-009). "Já me deve R$ X desde
 * tal data", com parcelas como qualquer fiado, sem itens. Distinguível de venda no histórico
 * e fora do lucro (RN-11) — não há custo conhecido.
 */
export type SaldoAnterior = LancamentoBase & {
  readonly tipo: 'saldo-anterior'
  readonly parcelas: readonly Parcela[]
}

/** Dinheiro que chegou (RF-06). O valor já vem limitado ao saldo (RN-03): nunca passa dele. */
export type Recebimento = LancamentoBase & {
  readonly tipo: 'recebimento'
  readonly valor: Centavos
  readonly forma: FormaDePagamento
  readonly observacao?: string
}

/**
 * Desconto de quitação: o resíduo de centavos que ela perdoa ("considera pago", D-031, RN-15).
 * Não é recebimento — dinheiro não entrou — nem estorno. Abate o saldo como um recebimento
 * e, em F4, abate o lucro (RN-11).
 */
export type DescontoQuitacao = LancamentoBase & {
  readonly tipo: 'desconto-quitacao'
  readonly valor: Centavos
}

/**
 * Estorno: o lançamento inverso (RN-07, RI-03). Aponta para o alvo e não copia o valor —
 * o valor é derivado do alvo, e é assim que não pode divergir dele. O alvo continua no
 * histórico, marcado; as duas linhas ficam visíveis. Estorno não se estorna (D-039): o
 * desfazer é lançar de novo.
 */
export type Estorno = LancamentoBase & {
  readonly tipo: 'estorno'
  readonly estornaId: Id
  readonly motivo?: string
}

export type Lancamento = Venda | SaldoAnterior | Recebimento | DescontoQuitacao | Estorno

/** O que tem parcelas e entra no saldo como dívida (RN-01). */
export type Debito = VendaFiado | SaldoAnterior

/** A ficha de uma cliente é a lista dos lançamentos dela. Nada além disso é guardado. */
export type Ficha = readonly Lancamento[]

/** Até quanto de saldo o botão "considerar pago" pode perdoar: R$ 0,10 (D-031, RN-15). */
export const LIMITE_QUITACAO: Centavos = 10n

/**
 * Por que uma operação foi recusada, em código. A tela escolhe as palavras (RI-07) e mostra
 * a guarda **antes** do toque — a lição de E-02: botão que não faz nada e não diz nada é
 * indistinguível de defeito.
 */
export type Motivo =
  | 'cliente-diferente'
  | 'id-repetido'
  | 'data-invalida'
  | 'sem-itens'
  | 'preco-negativo'
  | 'desconto-invalido'
  | 'sem-parcelas'
  | 'parcela-negativa'
  | 'parcelas-nao-fecham'
  | 'valor-invalido'
  | 'acima-do-limite-de-quitacao'
  | 'lancamento-nao-encontrado'
  | 'lancamento-e-estorno'
  | 'ja-estornado'
  | 'ficha-ficaria-negativa'
  | 'nada-a-receber'
  | 'nada-a-quitar'
  | 'ja-sincronizado'
  | 'tipo-diferente'
  | 'parcela-paga-alterada'
  | 'nome-obrigatorio'
  | 'mesmo-cliente'
  | 'cliente-nao-encontrado'

/**
 * O que toda operação da ficha devolve: o resultado, ou o motivo da recusa. Recusa é
 * valor, não exceção, porque a tela precisa dela antes do toque; `throw` fica para erro de
 * programador, como em `dinheiro.ts`.
 */
export type Resultado<T> =
  | { readonly ok: true; readonly valor: T }
  | { readonly ok: false; readonly motivo: Motivo }

/** Embrulha um resultado aceito. */
export function aceito<T>(valor: T): Resultado<T> {
  return { ok: true, valor }
}

/** Embrulha uma recusa. `Resultado<never>` cabe em qualquer `Resultado<T>`. */
export function recusado(motivo: Motivo): Resultado<never> {
  return { ok: false, motivo }
}

/** Formato de `Dia`. Mês 01–12 e dia 01–31; o resto do calendário é da tela. */
const DIA = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/

/** Ordem de texto, para datas `AAAA-MM-DD` e para ids UUIDv7 (que ordenam por criação, D-029). */
function comparar(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Total da venda: soma dos itens menos o desconto (RF-03). Vale para fiado e à vista. */
export function totalDaVenda(venda: Venda): Centavos {
  return somar(venda.itens.map((item) => item.preco)) - venda.desconto
}

/**
 * Total de um débito: a soma das parcelas. É o que ela combinou pagar, e é o número que o
 * saldo e o abatimento usam — `validar` garante que, numa venda, é igual a `totalDaVenda`.
 */
export function totalDoDebito(debito: Debito): Centavos {
  return somar(debito.parcelas.map((parcela) => parcela.valor))
}

/** Venda fiado ou saldo anterior: o que tem parcelas e entra no saldo (RN-01). */
export function ehDebito(lancamento: Lancamento): lancamento is Debito {
  return (
    lancamento.tipo === 'saldo-anterior' ||
    (lancamento.tipo === 'venda' && lancamento.pagamento === 'fiado')
  )
}

/** Ids dos lançamentos que têm um estorno apontando para eles. */
function estornados(ficha: Ficha): Set<Id> {
  const ids = new Set<Id>()
  for (const lancamento of ficha) {
    if (lancamento.tipo === 'estorno') ids.add(lancamento.estornaId)
  }
  return ids
}

/** O que conta: nem estorno, nem estornado. O par some junto, e é assim que o estorno reverte (RN-07). */
function vigentes(ficha: Ficha): Exclude<Lancamento, Estorno>[] {
  const fora = estornados(ficha)
  const lista: Exclude<Lancamento, Estorno>[] = []
  for (const lancamento of ficha) {
    if (lancamento.tipo !== 'estorno' && !fora.has(lancamento.id)) lista.push(lancamento)
  }
  return lista
}

function debitos(ficha: Ficha): Debito[] {
  return vigentes(ficha).filter(ehDebito)
}

/** Recebimentos e descontos de quitação vigentes: tudo que abate parcela. */
function abatimentos(ficha: Ficha): (Recebimento | DescontoQuitacao)[] {
  return vigentes(ficha).filter(
    (lancamento): lancamento is Recebimento | DescontoQuitacao =>
      lancamento.tipo === 'recebimento' || lancamento.tipo === 'desconto-quitacao',
  )
}

/**
 * Quanto ela deve hoje — derivado, sempre (RN-01, EL-02):
 *
 *   saldo = soma(débitos vigentes) − soma(recebimentos e descontos vigentes)
 *
 * "Vigente" já exclui o que foi estornado, e é assim que o estorno entra na conta sem um
 * termo próprio. Venda à vista não aparece em lado nenhum: não é dívida (D-039). Nunca é
 * negativo numa ficha válida — `validar` recusa, e cada operação de `lancamentos.ts` só
 * devolve o que passou por `validar`.
 */
export function saldo(ficha: Ficha): Centavos {
  return (
    somar(debitos(ficha).map(totalDoDebito)) -
    somar(abatimentos(ficha).map((abatimento) => abatimento.valor))
  )
}

/** Uma parcela vista da ficha: de qual débito é, quanto já tem pago e quanto falta. */
export type ParcelaNaFicha = {
  readonly parcela: Parcela
  readonly debito: Debito
  readonly pago: Centavos
  readonly restante: Centavos
}

/**
 * As parcelas da ficha, da mais antiga para a mais nova, com o que já está pago em cada uma.
 *
 * É o abatimento de RN-02 e D-006, **derivado**: o total recebido (recebimentos + descontos
 * de quitação, sem os estornados) escorre pela lista, enchendo cada parcela até o valor dela
 * e passando o resto para a seguinte. Nenhuma decisão é pedida a ela (RI-08); nenhum
 * lançamento diz "abati nesta"; e a ordem em que os recebimentos aconteceram não muda o
 * resultado — só o total importa.
 *
 * "Mais antiga" é **menor vencimento** (D-039). Empate: data do débito, depois id do débito
 * (UUIDv7 ordena por criação), depois posição na lista — para que duas fichas iguais
 * produzam a mesma resposta em qualquer aparelho.
 *
 * Invariante que `testes/ficha.test.ts` prova: a soma dos `restante` é o `saldo`.
 */
export function parcelas(ficha: Ficha): ParcelaNaFicha[] {
  const todas: { parcela: Parcela; debito: Debito; posicao: number }[] = []
  for (const debito of debitos(ficha)) {
    debito.parcelas.forEach((parcela, posicao) => todas.push({ parcela, debito, posicao }))
  }
  todas.sort(
    (a, b) =>
      comparar(a.parcela.vencimento, b.parcela.vencimento) ||
      comparar(a.debito.data, b.debito.data) ||
      comparar(a.debito.id, b.debito.id) ||
      a.posicao - b.posicao,
  )
  let sobra = somar(abatimentos(ficha).map((abatimento) => abatimento.valor))
  return todas.map(({ parcela, debito }) => {
    const pago = sobra < parcela.valor ? sobra : parcela.valor
    sobra -= pago
    return { parcela, debito, pago, restante: parcela.valor - pago }
  })
}

/** A parcela que ela vai cobrar em seguida (RF-02): a mais antiga com algo faltando. `null` se não deve nada. */
export function proximaParcela(ficha: Ficha): ParcelaNaFicha | null {
  return parcelas(ficha).find((parcela) => parcela.restante > 0n) ?? null
}

export type SituacaoDaParcela = 'paga' | 'vencida' | 'a-vencer'

/** Paga, vencida ou a vencer, dado o dia de hoje (RF-02: vencida aparece diferente). */
export function situacaoDaParcela(parcela: ParcelaNaFicha, hoje: Dia): SituacaoDaParcela {
  if (parcela.restante === 0n) return 'paga'
  return parcela.parcela.vencimento < hoje ? 'vencida' : 'a-vencer'
}

/** Uma linha do histórico: o lançamento, o valor que a linha mostra, e se foi estornado. */
export type LinhaDoHistorico = {
  readonly lancamento: Lancamento
  readonly valor: Centavos
  readonly estornado: boolean
}

/** O valor que a linha mostra. Para o estorno, é o valor do alvo — derivado, nunca copiado. */
function valorDaLinha(lancamento: Lancamento, porId: ReadonlyMap<Id, Lancamento>): Centavos {
  switch (lancamento.tipo) {
    case 'venda':
      return totalDaVenda(lancamento)
    case 'saldo-anterior':
      return totalDoDebito(lancamento)
    case 'recebimento':
    case 'desconto-quitacao':
      return lancamento.valor
    case 'estorno': {
      const alvo = porId.get(lancamento.estornaId)
      // Alvo ausente ou estorno de estorno não passam por `validar`; aqui só não há o que mostrar.
      return alvo === undefined || alvo.tipo === 'estorno' ? 0n : valorDaLinha(alvo, porId)
    }
  }
}

/**
 * O histórico da ficha em ordem cronológica inversa (RF-02): o mais recente primeiro, pela
 * data do fato; empate pelo id, que ordena por criação (D-029). Estorno é linha própria, com
 * a data dele (RF-08); o alvo continua na lista, marcado (RN-07). Venda à vista aparece
 * como compra paga na hora.
 */
export function historico(ficha: Ficha): LinhaDoHistorico[] {
  const porId = new Map<Id, Lancamento>(ficha.map((lancamento): [Id, Lancamento] => [lancamento.id, lancamento]))
  const fora = estornados(ficha)
  return [...ficha]
    .sort((a, b) => comparar(b.data, a.data) || comparar(b.id, a.id))
    .map((lancamento) => ({
      lancamento,
      valor: valorDaLinha(lancamento, porId),
      estornado: fora.has(lancamento.id),
    }))
}

/** Regras de uma lista de parcelas (RF-05). Registra os ids no conjunto para pegar repetição. */
function motivoDasParcelas(lista: readonly Parcela[], ids: Set<Id>): Motivo | null {
  if (lista.length === 0) return 'sem-parcelas'
  for (const parcela of lista) {
    if (ids.has(parcela.id)) return 'id-repetido'
    ids.add(parcela.id)
    if (!DIA.test(parcela.vencimento)) return 'data-invalida'
    if (parcela.valor < 0n) return 'parcela-negativa'
  }
  return null
}

/** Regras de uma venda, fiado ou à vista (RF-03). */
function motivoDaVenda(venda: Venda): Motivo | null {
  if (venda.itens.length === 0) return 'sem-itens'
  if (venda.itens.some((item) => item.preco < 0n)) return 'preco-negativo'
  if (venda.desconto < 0n || venda.desconto > somar(venda.itens.map((item) => item.preco))) {
    return 'desconto-invalido'
  }
  return null
}

/**
 * As invariantes da ficha, num lugar só. Toda operação de `lancamentos.ts` monta a ficha
 * resultante e passa por aqui antes de devolver — é o que faz "uma regra, um lugar" valer.
 *
 * O que se confere: todos os lançamentos são da mesma cliente; nenhum id se repete
 * (lançamentos e parcelas); toda data tem formato de dia; venda tem item, preço não
 * negativo e desconto dentro da soma; débito tem parcela, nenhuma negativa, e numa venda a
 * soma delas é o total (RF-05, D-012); recebimento é positivo; desconto de quitação é
 * positivo e cabe no limite (RN-15); estorno aponta para um lançamento que existe, que não é
 * estorno e que ainda não foi estornado (D-039); e o saldo não é negativo (D-016).
 *
 * Devolve a própria ficha quando aceita, para que o chamador possa encadear.
 */
export function validar(ficha: Ficha): Resultado<Ficha> {
  const clienteId = ficha[0]?.clienteId
  const ids = new Set<Id>()
  const alvos = new Set<Id>()
  const porId = new Map<Id, Lancamento>(ficha.map((lancamento): [Id, Lancamento] => [lancamento.id, lancamento]))

  for (const lancamento of ficha) {
    if (lancamento.clienteId !== clienteId) return recusado('cliente-diferente')
    if (ids.has(lancamento.id)) return recusado('id-repetido')
    ids.add(lancamento.id)
    if (!DIA.test(lancamento.data)) return recusado('data-invalida')

    switch (lancamento.tipo) {
      case 'venda': {
        const motivo = motivoDaVenda(lancamento)
        if (motivo) return recusado(motivo)
        if (lancamento.pagamento === 'fiado') {
          const motivoParcelas = motivoDasParcelas(lancamento.parcelas, ids)
          if (motivoParcelas) return recusado(motivoParcelas)
          if (totalDoDebito(lancamento) !== totalDaVenda(lancamento)) return recusado('parcelas-nao-fecham')
        }
        break
      }
      case 'saldo-anterior': {
        const motivo = motivoDasParcelas(lancamento.parcelas, ids)
        if (motivo) return recusado(motivo)
        break
      }
      case 'recebimento':
        if (lancamento.valor <= 0n) return recusado('valor-invalido')
        break
      case 'desconto-quitacao':
        if (lancamento.valor <= 0n) return recusado('valor-invalido')
        if (lancamento.valor > LIMITE_QUITACAO) return recusado('acima-do-limite-de-quitacao')
        break
      case 'estorno': {
        const alvo = porId.get(lancamento.estornaId)
        if (alvo === undefined) return recusado('lancamento-nao-encontrado')
        if (alvo.tipo === 'estorno') return recusado('lancamento-e-estorno')
        if (alvos.has(lancamento.estornaId)) return recusado('ja-estornado')
        alvos.add(lancamento.estornaId)
        break
      }
    }
  }

  if (saldo(ficha) < 0n) return recusado('ficha-ficaria-negativa')
  return aceito(ficha)
}
