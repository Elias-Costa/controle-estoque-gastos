import { projetarCaixa, type CaixaMensal } from './caixa.ts'
import { parcelas, type Cliente, type Dia, type Id, type Lancamento } from './ficha.ts'
import { posicaoEstoque, type MovimentoEstoque } from './estoque.ts'
import type { FatoCaixa } from './gastos.ts'
import type { Produto } from './produtos.ts'
import { projetarCompromissos } from './vendas-estoque.ts'

/** Fontes correntes de uma conta, lidas na mesma fotografia pelo chamador (D-079). */
export type FotografiaLembretes = {
  readonly clientes: readonly Pick<Cliente, 'id' | 'desativadoEm'>[]
  readonly lancamentos: readonly Lancamento[]
  readonly produtos: readonly Produto[]
  readonly movimentos: readonly MovimentoEstoque[]
  readonly fatosCaixa: readonly FatoCaixa[]
}

/** Observação técnica própria do aparelho ou servidor; nunca acompanha arquivo de cópia. */
export type ObservacaoLembretes = {
  readonly baixos: readonly Id[]
  readonly pendentes: readonly Id[]
  readonly diaLembrado?: Dia
  readonly lembrados: readonly Id[]
}

/** Motivos locais atuais; o transporte externo recebe somente aviso genérico (D-068). */
export type MotivosLembretes = {
  readonly dia: Dia
  readonly fichas: readonly { readonly clienteId: Id; readonly vencimento: Dia }[]
  readonly minimo: readonly { readonly produtoId: Id; readonly conferir: boolean }[]
  readonly caixa: CaixaMensal | null
}

/** Relógio explícito no fuso fixo aprovado; nenhuma leitura do relógio global (D-068/079). */
export function calendarioLembretes(instante: string) {
  const data = new Date(instante)
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(instante) || !data.toISOString().startsWith(instante.slice(0, 19))) {
    throw new Error('Instante de lembrete inválido')
  }
  const local = new Date(data.getTime() - 3 * 60 * 60 * 1000)
  const dia = local.toISOString().slice(0, 10)
  const minutos = local.getUTCHours() * 60 + local.getUTCMinutes()
  return { dia, segunda: local.getUTCDay() === 1, minutos,
    oportunidade: minutos < 540 || minutos > 570 ? null : minutos >= 570 ? '09:30' : minutos >= 555 ? '09:15' : '09:00',
    venceEm: `${dia}T13:00:00.000Z` }
}

/** Estado inicial não presume que um produto já foi avisado em outro contexto (D-068). */
export function observacaoInicialLembretes(): ObservacaoLembretes {
  return { baixos: [], pendentes: [], lembrados: [] }
}

/** Observa entrada/reentrada sem inferir transições entre leituras; não altera as fontes. */
export function avaliarLembretes(fontes: FotografiaLembretes, anterior: ObservacaoLembretes, instante: string): {
  readonly motivos: MotivosLembretes; readonly observacao: ObservacaoLembretes
} {
  const calendario = calendarioLembretes(instante)
  const compromissos = projetarCompromissos(fontes.lancamentos, fontes.movimentos,
    fontes.produtos.filter((p) => p.estoqueMinimo !== undefined).map((p) => p.id))
  if (!compromissos.ok) throw new Error('Estoque incompleto nos lembretes')
  const baixos = fontes.produtos.flatMap((produto) => {
    if (produto.estoqueMinimo === undefined) return []
    const compromisso = compromissos.valor.get(produto.id)
    if (!compromisso) throw new Error('Estoque incompleto nos lembretes')
    const posicao = posicaoEstoque(compromisso.estoque.fisico, compromisso.prometido, produto.estoqueMinimo)
    if (!posicao.ok) throw new Error('Posição inválida nos lembretes')
    return posicao.valor.noMinimo ? [{ produtoId: produto.id, conferir: compromisso.estoque.contagensAfetadas.length > 0 }] : []
  }).sort((a, b) => a.produtoId.localeCompare(b.produtoId))
  const anteriores = new Set(anterior.baixos)
  const pendentes = new Set(anterior.pendentes)
  for (const baixo of baixos) if (!anteriores.has(baixo.produtoId)) pendentes.add(baixo.produtoId)
  const lembradosHoje = new Set(anterior.diaLembrado === calendario.dia ? anterior.lembrados : [])
  const minimo = baixos.filter(({ produtoId }) => pendentes.has(produtoId) || calendario.segunda || lembradosHoje.has(produtoId))
  const fichas = fontes.clientes.filter((cliente) => cliente.desativadoEm === undefined).flatMap((cliente) => {
    const parcela = parcelas(fontes.lancamentos.filter((l) => l.clienteId === cliente.id))
      .find((p) => p.restante > 0n && p.parcela.vencimento <= calendario.dia)
    return parcela ? [{ clienteId: cliente.id, vencimento: parcela.parcela.vencimento }] : []
  }).sort((a, b) => a.vencimento.localeCompare(b.vencimento) || a.clienteId.localeCompare(b.clienteId))
  let caixa: CaixaMensal | null = null
  if (calendario.dia.endsWith('-01')) {
    const mesAnterior = new Date(`${calendario.dia}T12:00:00Z`)
    mesAnterior.setUTCDate(0)
    const projetado = projetarCaixa(fontes.fatosCaixa, fontes.lancamentos, mesAnterior.toISOString().slice(0, 7))
    if (!projetado.ok) throw new Error('Caixa incompleto nos lembretes')
    caixa = projetado.valor
  }
  return { motivos: { dia: calendario.dia, fichas, minimo, caixa }, observacao: {
    baixos: baixos.map((p) => p.produtoId), pendentes: baixos.filter((p) => pendentes.has(p.produtoId)).map((p) => p.produtoId),
    ...(anterior.diaLembrado ? { diaLembrado: anterior.diaLembrado } : {}),
    lembrados: baixos.filter((p) => lembradosHoje.has(p.produtoId)).map((p) => p.produtoId),
  } }
}

/** Consome só os motivos mínimos desta rodada; o aviso local permanece durante o dia. */
export function registrarRodadaLembretes(observacao: ObservacaoLembretes, motivos: MotivosLembretes): ObservacaoLembretes {
  const ids = new Set(motivos.minimo.map((p) => p.produtoId))
  return { ...observacao, pendentes: observacao.pendentes.filter((id) => !ids.has(id)), diaLembrado: motivos.dia,
    lembrados: [...new Set([...(observacao.diaLembrado === motivos.dia ? observacao.lembrados : []), ...ids])].sort() }
}

/** Uma rodada agrega os três assuntos; sem motivo não há chamada ao provedor. */
export function haLembretes(motivos: MotivosLembretes): boolean {
  return motivos.fichas.length > 0 || motivos.minimo.length > 0 || motivos.caixa !== null
}
