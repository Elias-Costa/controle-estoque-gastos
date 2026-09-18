/**
 * A borda entre o aparelho e a nuvem (E-07, D-041, D-042): a forma que uma linha tem no
 * Postgres e a tradução de ida e volta para os tipos do domínio.
 *
 * O que muda de um lado para o outro, e só isso:
 *
 * - **`camelCase` ↔ `snake_case`** nas colunas (`clienteId` ↔ `cliente_id`, `estornaId` ↔
 *   `estorna_id`, `atualizadoEm` ↔ `atualizado_em`). Dentro do `jsonb` (`itens`, `parcelas`) os
 *   nomes já são os do domínio.
 * - **`bigint` ↔ texto de dígitos** (D-022, RI-01). Dinheiro atravessa a rede como texto e volta
 *   por `BigInt(texto)`, que é exato para qualquer tamanho; nunca vira `number`. Na ida o banco
 *   aceita texto para `bigint` e para os inteiros do `jsonb`; na volta, `nuvem.ts` pede as
 *   colunas com `::text` para que o PostgREST não as serialize como número JSON.
 * - **`undefined` ↔ `null`**: o domínio omite o campo opcional; a linha do banco o tem nulo.
 *   Na volta, o campo nulo é omitido de novo, para que a linha baixada seja **igual** à que o
 *   outro aparelho gravou (`toEqual` nos testes; `validar` no domínio não vê diferença).
 * - **Carimbos como ISO UTC** com `Z` (`toISOString()`): o PostgREST devolve `+00:00`, e as
 *   duas formas não se comparam como texto. Normalizar aqui é o que permite ao motor decidir
 *   o último-que-escreve com `<` entre strings, o mesmo critério do gatilho na nuvem.
 *
 * Linha vinda da nuvem que não tenha a forma esperada **lança**: é erro de programador (as
 * duas pontas são este código, e o banco valida a forma por constraint), não caso de uso. O
 * motor deixa o ciclo abortar e o cursor não avança — nada é perdido, e o erro aparece no
 * console para o mantenedor.
 *
 * Esta pasta não é o domínio: `BigInt()` e `Date` são permitidos aqui, e `number` nunca toca
 * dinheiro.
 */

import type { Centavos } from '../dominio/dinheiro.ts'
import type {
  Dia,
  FormaDePagamento,
  Id,
  ItemVenda,
  Lancamento,
  Parcela,
} from '../dominio/ficha.ts'
import type { ClienteLocal } from '../dados/banco.ts'

/** Um cliente como a nuvem o guarda (`public.clientes`, sem `dono` e sem `recebido_em`). */
export type ClienteNaNuvem = {
  readonly id: Id
  readonly nome: string
  readonly telefone: string | null
  readonly apelido: string | null
  readonly observacao: string | null
  /** A marca de fichinha desativada, um `Dia` (migration 0003, D-050 item 6); `null` é ativa. */
  readonly desativado_em: Dia | null
  /** Relógio do aparelho, ISO UTC (D-042, item 1). */
  readonly atualizado_em: string
}

/** Um item de venda dentro do `jsonb`: o preço como texto de dígitos. */
export type ItemNaNuvem = {
  readonly descricao: string
  readonly preco: string
}

/** Uma parcela dentro do `jsonb`: o valor como texto de dígitos. */
export type ParcelaNaNuvem = {
  readonly id: Id
  readonly vencimento: Dia
  readonly valor: string
}

/**
 * Um lançamento como a nuvem o guarda (`public.lancamentos`): uma tabela, cinco tipos, cada
 * um com as suas colunas e as outras nulas (`lancamentos_forma_por_tipo`). `desconto` e
 * `valor` são texto de dígitos nos dois sentidos.
 */
export type LancamentoNaNuvem = {
  readonly id: Id
  readonly cliente_id: Id
  readonly data: Dia
  readonly tipo: string
  readonly pagamento: string | null
  readonly forma: string | null
  readonly itens: readonly ItemNaNuvem[] | null
  readonly desconto: string | null
  readonly parcelas: readonly ParcelaNaNuvem[] | null
  readonly valor: string | null
  readonly observacao: string | null
  readonly estorna_id: Id | null
  readonly motivo: string | null
}

/** Texto de dígitos → centavos. Só dígitos passam; `39.9`, vazio e sinal são erro de forma. */
const DIGITOS = /^\d+$/

/** Lança com o caminho do campo, para o console dizer o que veio errado. */
function malformada(caminho: string, valor: unknown): never {
  throw new Error(`linha da nuvem malformada em ${caminho}: ${JSON.stringify(valor)}`)
}

/** Centavos → texto. `bigint` não tem `toFixed` nem ponto: `String(3990n)` é `"3990"`. */
function centavosParaTexto(centavos: Centavos): string {
  return String(centavos)
}

/** Texto → centavos, exato. Recusa qualquer coisa que não seja só dígitos. */
function textoParaCentavos(caminho: string, texto: unknown): Centavos {
  if (typeof texto !== 'string' || !DIGITOS.test(texto)) return malformada(caminho, texto)
  return BigInt(texto)
}

/**
 * Carimbo do servidor ou do aparelho → ISO UTC com `Z`. É o que torna dois carimbos
 * comparáveis como texto; um carimbo que `Date` não entende é forma errada.
 */
export function normalizarCarimbo(caminho: string, carimbo: unknown): string {
  if (typeof carimbo !== 'string') return malformada(caminho, carimbo)
  const instante = new Date(carimbo)
  if (Number.isNaN(instante.getTime())) return malformada(caminho, carimbo)
  return instante.toISOString()
}

function texto(caminho: string, valor: unknown): string {
  return typeof valor === 'string' ? valor : malformada(caminho, valor)
}

function textoOuNulo(caminho: string, valor: unknown): string | undefined {
  if (valor === null || valor === undefined) return undefined
  return texto(caminho, valor)
}

function forma(caminho: string, valor: unknown): FormaDePagamento {
  if (valor === 'pix' || valor === 'dinheiro' || valor === 'outro') return valor
  return malformada(caminho, valor)
}

/**
 * Os campos opcionais são acrescentados só quando há valor (`...(x === undefined ? {} : { x })`),
 * para que a linha lida seja igual à que o outro aparelho gravou, campo a campo.
 */

// ---------------------------------------------------------------------------------------------
// Cliente
// ---------------------------------------------------------------------------------------------

/** A linha local do cliente → a linha da nuvem. `dono` nunca vai (o banco carimba). */
export function clienteParaNuvem(cliente: ClienteLocal): ClienteNaNuvem {
  return {
    id: cliente.id,
    nome: cliente.nome,
    telefone: cliente.telefone ?? null,
    apelido: cliente.apelido ?? null,
    observacao: cliente.observacao ?? null,
    desativado_em: cliente.desativadoEm ?? null,
    atualizado_em: cliente.atualizadoEm,
  }
}

/** A linha da nuvem → a linha local, com o carimbo normalizado. Lança se a forma estiver errada. */
export function clienteDaNuvem(linha: unknown): ClienteLocal {
  if (typeof linha !== 'object' || linha === null) return malformada('cliente', linha)
  const campos: Record<string, unknown> = { ...linha }
  const telefone = textoOuNulo('cliente.telefone', campos['telefone'])
  const apelido = textoOuNulo('cliente.apelido', campos['apelido'])
  const observacao = textoOuNulo('cliente.observacao', campos['observacao'])
  // Linha anterior à migration 0003 vem sem a chave: é ativa, como `null`.
  const desativadoEm = textoOuNulo('cliente.desativado_em', campos['desativado_em'])
  return {
    id: texto('cliente.id', campos['id']),
    nome: texto('cliente.nome', campos['nome']),
    ...(telefone === undefined ? {} : { telefone }),
    ...(apelido === undefined ? {} : { apelido }),
    ...(observacao === undefined ? {} : { observacao }),
    ...(desativadoEm === undefined ? {} : { desativadoEm }),
    atualizadoEm: normalizarCarimbo('cliente.atualizado_em', campos['atualizado_em']),
  }
}

// ---------------------------------------------------------------------------------------------
// Lançamento
// ---------------------------------------------------------------------------------------------

function itensParaNuvem(itens: readonly ItemVenda[]): ItemNaNuvem[] {
  return itens.map((item) => ({ descricao: item.descricao, preco: centavosParaTexto(item.preco) }))
}

function parcelasParaNuvem(parcelas: readonly Parcela[]): ParcelaNaNuvem[] {
  return parcelas.map((parcela) => ({ id: parcela.id, vencimento: parcela.vencimento, valor: centavosParaTexto(parcela.valor) }))
}

/** Uma linha só com as colunas comuns; cada tipo preenche as suas. */
function base(lancamento: Lancamento): LancamentoNaNuvem {
  return {
    id: lancamento.id,
    cliente_id: lancamento.clienteId,
    data: lancamento.data,
    tipo: lancamento.tipo,
    pagamento: null,
    forma: null,
    itens: null,
    desconto: null,
    parcelas: null,
    valor: null,
    observacao: null,
    estorna_id: null,
    motivo: null,
  }
}

/** O lançamento do domínio → a linha da nuvem, com as colunas do tipo e as outras nulas. */
export function lancamentoParaNuvem(lancamento: Lancamento): LancamentoNaNuvem {
  const linha = base(lancamento)
  switch (lancamento.tipo) {
    case 'venda':
      return lancamento.pagamento === 'fiado'
        ? {
            ...linha,
            pagamento: 'fiado',
            itens: itensParaNuvem(lancamento.itens),
            desconto: centavosParaTexto(lancamento.desconto),
            parcelas: parcelasParaNuvem(lancamento.parcelas),
          }
        : {
            ...linha,
            pagamento: 'avista',
            forma: lancamento.forma,
            itens: itensParaNuvem(lancamento.itens),
            desconto: centavosParaTexto(lancamento.desconto),
          }
    case 'saldo-anterior':
      return { ...linha, parcelas: parcelasParaNuvem(lancamento.parcelas) }
    case 'recebimento':
      return { ...linha, valor: centavosParaTexto(lancamento.valor), forma: lancamento.forma, observacao: lancamento.observacao ?? null }
    case 'desconto-quitacao':
      return { ...linha, valor: centavosParaTexto(lancamento.valor) }
    case 'estorno':
      return { ...linha, estorna_id: lancamento.estornaId, motivo: lancamento.motivo ?? null }
  }
}

function itensDaNuvem(valor: unknown): ItemVenda[] {
  if (!Array.isArray(valor)) return malformada('lancamento.itens', valor)
  return valor.map((item: unknown, posicao) => {
    if (typeof item !== 'object' || item === null) return malformada(`lancamento.itens[${posicao}]`, item)
    const campos: Record<string, unknown> = { ...item }
    return {
      descricao: texto(`lancamento.itens[${posicao}].descricao`, campos['descricao']),
      preco: textoParaCentavos(`lancamento.itens[${posicao}].preco`, campos['preco']),
    }
  })
}

function parcelasDaNuvem(valor: unknown): Parcela[] {
  if (!Array.isArray(valor)) return malformada('lancamento.parcelas', valor)
  return valor.map((parcela: unknown, posicao) => {
    if (typeof parcela !== 'object' || parcela === null) return malformada(`lancamento.parcelas[${posicao}]`, parcela)
    const campos: Record<string, unknown> = { ...parcela }
    return {
      id: texto(`lancamento.parcelas[${posicao}].id`, campos['id']),
      vencimento: texto(`lancamento.parcelas[${posicao}].vencimento`, campos['vencimento']),
      valor: textoParaCentavos(`lancamento.parcelas[${posicao}].valor`, campos['valor']),
    }
  })
}

/**
 * A linha da nuvem → o lançamento do domínio, no membro exato da união pelo `tipo` (e
 * `pagamento`, na venda). O que o tipo não usa é ignorado — o banco já garantiu que está nulo.
 * Lança se `tipo`, `pagamento` ou `forma` forem desconhecidos, ou se dinheiro não for dígitos.
 */
export function lancamentoDaNuvem(linha: unknown): Lancamento {
  if (typeof linha !== 'object' || linha === null) return malformada('lancamento', linha)
  const campos: Record<string, unknown> = { ...linha }
  const comum = {
    id: texto('lancamento.id', campos['id']),
    clienteId: texto('lancamento.cliente_id', campos['cliente_id']),
    data: texto('lancamento.data', campos['data']),
  }
  switch (campos['tipo']) {
    case 'venda': {
      const itens = itensDaNuvem(campos['itens'])
      const desconto = textoParaCentavos('lancamento.desconto', campos['desconto'])
      if (campos['pagamento'] === 'fiado') {
        return { ...comum, tipo: 'venda', pagamento: 'fiado', itens, desconto, parcelas: parcelasDaNuvem(campos['parcelas']) }
      }
      if (campos['pagamento'] === 'avista') {
        return { ...comum, tipo: 'venda', pagamento: 'avista', forma: forma('lancamento.forma', campos['forma']), itens, desconto }
      }
      return malformada('lancamento.pagamento', campos['pagamento'])
    }
    case 'saldo-anterior':
      return { ...comum, tipo: 'saldo-anterior', parcelas: parcelasDaNuvem(campos['parcelas']) }
    case 'recebimento': {
      const observacao = textoOuNulo('lancamento.observacao', campos['observacao'])
      return {
        ...comum,
        tipo: 'recebimento',
        valor: textoParaCentavos('lancamento.valor', campos['valor']),
        forma: forma('lancamento.forma', campos['forma']),
        ...(observacao === undefined ? {} : { observacao }),
      }
    }
    case 'desconto-quitacao':
      return { ...comum, tipo: 'desconto-quitacao', valor: textoParaCentavos('lancamento.valor', campos['valor']) }
    case 'estorno': {
      const motivo = textoOuNulo('lancamento.motivo', campos['motivo'])
      return {
        ...comum,
        tipo: 'estorno',
        estornaId: texto('lancamento.estorna_id', campos['estorna_id']),
        ...(motivo === undefined ? {} : { motivo }),
      }
    }
    default:
      return malformada('lancamento.tipo', campos['tipo'])
  }
}
