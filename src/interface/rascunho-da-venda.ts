import type { ParcelaNova } from '../dados/operacoes.ts'
import { lerDinheiro, repartir, somar, type Centavos } from '../dominio/dinheiro.ts'
import type { Dia, FormaDePagamento, ItemVenda, Parcela, Venda } from '../dominio/ficha.ts'
import { mesesDepois } from './datas.ts'

/**
 * A venda enquanto ela digita (E-10, D-045) — puro, sem React, testável no `bun test`
 * (`testes/rascunho-da-venda.test.ts`). A tela guarda o texto cru de cada campo; este módulo
 * lê tudo pelo domínio (`lerDinheiro`, `repartir`, `somar`) e devolve o que ela precisa ver
 * antes do toque: os itens lidos, o total, as parcelas montadas e as guardas. Nenhum
 * `number` aqui é dinheiro (EL-03): contagem de parcelas e posição, só.
 */

/** Um item como ela o digita: descrição e o texto do preço, ainda não lido. */
export type ItemDoRascunho = {
  readonly descricao: string
  readonly precoTexto: string
}

/** O que ela mexeu numa parcela, pela posição — e só isso; o resto é sugerido. */
export type EdicaoDeParcela = {
  readonly valorTexto?: string
  readonly vencimento?: Dia
}

/** Tudo que a tela de venda guarda; `data` é a data do fato já resolvida (`''` enquanto "Outro dia" não tem dia). */
export type Rascunho = {
  readonly itens: readonly ItemDoRascunho[]
  readonly descontoTexto: string
  readonly pagamento: 'fiado' | 'avista'
  readonly forma: FormaDePagamento
  readonly vezes: number
  readonly edicoes: readonly EdicaoDeParcela[]
  readonly data: Dia
}

/** Um item depois de lido. `vazio` é "nada digitado": não conta e não trava. `semPreco` distingue "falta" de "não entendi". */
export type ItemLido = {
  readonly descricao: string
  readonly preco: Centavos | null
  readonly vazio: boolean
  readonly semPreco: boolean
}

/** Uma parcela como a lista mostra: sugerida ou editada; `ilegivel` quando o valor editado não é um valor. */
export type ParcelaMontada = {
  readonly vencimento: Dia
  readonly valor: Centavos
  readonly editada: boolean
  readonly ilegivel: boolean
}

/**
 * O que impede o "Pronto", em código; a tela põe as palavras (RI-07). `sem-valor` é o estado
 * inicial (nada digitado ainda) e não vira frase — só botão indisponível, como o protótipo.
 */
export type Guarda =
  | 'sem-valor'
  | 'falta-preco'
  | 'preco-ilegivel'
  | 'desconto-ilegivel'
  | 'desconto-maior'
  | 'parcela-ilegivel'
  | 'parcelas-nao-fecham'
  | 'falta-a-data'
  | 'data-no-futuro'

/** A venda conferida: o que vai para o domínio e o que falta para poder ir. */
export type Conferencia = {
  readonly itens: readonly ItemLido[]
  readonly itensDaVenda: readonly ItemVenda[]
  readonly somaDosItens: Centavos
  readonly desconto: Centavos
  readonly total: Centavos
  readonly parcelas: readonly ParcelaMontada[]
  readonly guardas: readonly Guarda[]
}

/** Lê cada item: descrição sem espaços em volta, preço pelo domínio. */
export function lerItens(itens: readonly ItemDoRascunho[]): ItemLido[] {
  return itens.map((item) => {
    const descricao = item.descricao.trim()
    const precoTexto = item.precoTexto.trim()
    return { descricao, preco: lerDinheiro(precoTexto), vazio: descricao === '' && precoTexto === '', semPreco: precoTexto === '' }
  })
}

/** As datas sugeridas para N parcelas: de mês em mês a partir da data da venda (RF-05). */
export function datasSugeridas(dataDaVenda: Dia, vezes: number): Dia[] {
  return Array.from({ length: vezes }, (_, posicao) => mesesDepois(dataDaVenda, posicao + 1))
}

/**
 * Monta as parcelas (D-045, item 2): a que ela editou fica como digitada; as que ela não
 * mexeu dividem o resto por `repartir` (D-030). Data editada vale; vazia volta à sugerida.
 * Quando não há o que absorver — editou todas, ou o resto ficaria negativo — as parcelas
 * não fecham o total, e é a guarda `parcelas-nao-fecham` que diz isso.
 */
export function montarParcelas(total: Centavos, dataDaVenda: Dia, vezes: number, edicoes: readonly EdicaoDeParcela[]): ParcelaMontada[] {
  const datas = datasSugeridas(dataDaVenda, vezes)
  const base = datas.map((sugerida, posicao): ParcelaMontada => {
    const edicao = edicoes[posicao]
    const vencimento = edicao?.vencimento !== undefined && edicao.vencimento !== '' ? edicao.vencimento : sugerida
    const valorTexto = edicao?.valorTexto?.trim() ?? ''
    if (valorTexto === '') return { vencimento, valor: 0n, editada: false, ilegivel: false }
    const lido = lerDinheiro(valorTexto)
    return { vencimento, valor: lido ?? 0n, editada: true, ilegivel: lido === null }
  })

  const fixas = somar(base.filter((parcela) => parcela.editada).map((parcela) => parcela.valor))
  const livres = base.filter((parcela) => !parcela.editada).length
  const resto = total - fixas
  if (livres === 0 || resto < 0n) return base

  const divididas = repartir(resto, livres)
  let proxima = 0
  return base.map((parcela) => {
    if (parcela.editada) return parcela
    const valor = divididas[proxima] ?? 0n
    proxima += 1
    return { ...parcela, valor }
  })
}

/** Confere o rascunho inteiro: lê, soma, monta e lista o que falta. `hoje` é parâmetro para o teste fixar o dia. */
export function conferir(rascunho: Rascunho, hoje: Dia): Conferencia {
  const itens = lerItens(rascunho.itens)
  const guardas: Guarda[] = []

  const preenchidos = itens.filter((item) => !item.vazio)
  for (const item of preenchidos) {
    if (item.preco === null) guardas.push(item.semPreco ? 'falta-preco' : 'preco-ilegivel')
  }
  const itensDaVenda: ItemVenda[] = preenchidos.flatMap((item) => (item.preco === null ? [] : [{ descricao: item.descricao, preco: item.preco }]))
  const somaDosItens = somar(itensDaVenda.map((item) => item.preco))

  const descontoTexto = rascunho.descontoTexto.trim()
  const descontoLido = descontoTexto === '' ? 0n : lerDinheiro(descontoTexto)
  if (descontoLido === null) guardas.push('desconto-ilegivel')
  const desconto = descontoLido ?? 0n
  if (desconto > somaDosItens) guardas.push('desconto-maior')
  const total = desconto > somaDosItens ? 0n : somaDosItens - desconto
  if (itensDaVenda.length === 0 || total === 0n) guardas.push('sem-valor')

  const parcelas = rascunho.pagamento === 'fiado' ? montarParcelas(total, rascunho.data === '' ? hoje : rascunho.data, rascunho.vezes, rascunho.edicoes) : []
  if (parcelas.some((parcela) => parcela.ilegivel)) guardas.push('parcela-ilegivel')
  else if (parcelas.length > 0 && somar(parcelas.map((parcela) => parcela.valor)) !== total) guardas.push('parcelas-nao-fecham')

  const guardaDeData = guardaDaData(rascunho.data, hoje)
  if (guardaDeData !== null) guardas.push(guardaDeData)

  return { itens, itensDaVenda, somaDosItens, desconto, total, parcelas, guardas }
}

/**
 * O que falta na data de um lançamento (RN-09): "Outro dia" sem dia escolhido, ou um dia que
 * ainda não chegou. A mesma regra para a venda e para o recebimento (E-11) — por isso mora aqui, uma vez.
 */
export function guardaDaData(data: Dia, hoje: Dia): 'falta-a-data' | 'data-no-futuro' | null {
  if (data === '') return 'falta-a-data'
  if (data > hoje) return 'data-no-futuro'
  return null
}

/** `3990n` → `"39,90"`: centavos de volta ao texto que ela teria digitado, para preencher a correção. Sem ponto de milhar. */
export function textoDeCentavos(centavos: Centavos): string {
  const reais = centavos / 100n
  const resto = centavos % 100n
  return `${reais},${String(resto).padStart(2, '0')}`
}

/**
 * O rascunho de uma venda já gravada, para a correção (D-013, D-045): itens e desconto como
 * texto; toda data de parcela entra como editada (as datas são dela); o **valor** só entra
 * como editado quando difere do que `repartir` daria — assim, mudar um preço redistribui o
 * resto como na venda nova, e uma parcela que ela combinou à mão continua combinada.
 */
export function rascunhoDaVenda(venda: Venda): Rascunho {
  const itens = venda.itens.map((item) => ({ descricao: item.descricao, precoTexto: textoDeCentavos(item.preco) }))
  const descontoTexto = venda.desconto > 0n ? textoDeCentavos(venda.desconto) : ''
  if (venda.pagamento === 'avista') {
    return { itens, descontoTexto, pagamento: 'avista', forma: venda.forma, vezes: 1, edicoes: [], data: venda.data }
  }
  const total = somar(venda.itens.map((item) => item.preco)) - venda.desconto
  const automaticas = repartir(total, venda.parcelas.length)
  const edicoes = venda.parcelas.map((parcela, posicao): EdicaoDeParcela => ({
    vencimento: parcela.vencimento,
    ...(parcela.valor !== automaticas[posicao] && { valorTexto: textoDeCentavos(parcela.valor) }),
  }))
  return { itens, descontoTexto, pagamento: 'fiado', forma: 'dinheiro', vezes: venda.parcelas.length, edicoes, data: venda.data }
}

/** As parcelas montadas com o id da parcela original na mesma posição (RN-08): a 1ª continua a 1ª; a que sobra é nova. */
export function parcelasCorrigidas(montadas: readonly ParcelaMontada[], originais: readonly Parcela[]): (Parcela | ParcelaNova)[] {
  return montadas.map((parcela, posicao) => {
    const original = originais[posicao]
    const nova: ParcelaNova = { vencimento: parcela.vencimento, valor: parcela.valor }
    return original === undefined ? nova : { id: original.id, ...nova }
  })
}
