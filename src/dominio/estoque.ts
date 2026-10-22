import type { Centavos } from './dinheiro.ts'
import type { Dia, Id } from './ficha.ts'
import type { ReferenciaCompra } from './produtos.ts'
import { conteudoDoEfeito, diaValido, quantidadeValida, type ResultadoEstoque } from './regras-estoque.ts'

/** Uma revisão identificada, não apenas o id que também pode ter sido corrigido (Q37/39). */
export type ReferenciaEfeito = { readonly id: Id; readonly revisao: number }

/** Identidade e causalidade são recebidas de fora; ordem de chegada não prova conhecimento. */
export type MovimentoBase = ReferenciaEfeito & {
  readonly operacaoId: Id
  readonly produtoId: Id
  readonly data: Dia
  readonly conhecidos: readonly ReferenciaEfeito[]
}

/** Entrada de compra; ausência de custo é desconhecido, não zero (D-018). */
export type CompraEstoque = MovimentoBase & {
  readonly tipo: 'compra'; readonly quantidade: number; readonly custoUnitario?: Centavos
  readonly ordemCadastro: bigint; readonly compraOriginalId?: Id
}
/** Custo e item sobrevivem à correção financeira; quantidade zero representa anotação desfeita. */
export type EntregaEstoque = MovimentoBase & {
  readonly tipo: 'entrega'; readonly quantidade: number; readonly itemId: Id; readonly custoUnitario?: Centavos
}
/** Retorno real do item; cancelar o financeiro não fabrica esta entrada (D-013). */
export type RetornoEstoque = MovimentoBase & { readonly tipo: 'retorno'; readonly quantidade: number; readonly itemId: Id }
/** Saída sem venda, com o motivo informado (RF-14). */
export type SaidaEstoque = MovimentoBase & {
  readonly tipo: 'saida'; readonly quantidade: number; readonly motivo: 'perda' | 'quebra' | 'uso-pessoal' | 'brinde'
}
/** Evidência da quantidade/revisão observada; não participa como novo movimento ativo (Q39). */
export type EvidenciaBase = ReferenciaEfeito & {
  readonly tipo: MovimentoEstoque['tipo']
  readonly quantidade: number
  readonly aplicada: boolean
  readonly conhecidos: readonly ReferenciaEfeito[]
}
/** Total contado e base observada; a diferença é calculada pelo sistema (D-054). */
export type ContagemEstoque = MovimentoBase & {
  readonly tipo: 'contagem'; readonly totalContado: number
  readonly motivo: 'estoque-inicial' | 'conferencia'
  readonly base: readonly EvidenciaBase[]; readonly resolvidas: readonly ReferenciaEfeito[]
}
/** O inverso aponta à revisão original; nada do histórico compartilhado é apagado. */
export type AnulacaoEstoque = MovimentoBase & { readonly tipo: 'anulacao'; readonly alvo: ReferenciaEfeito }
/** Histórico próprio de estoque, separado dos lançamentos financeiros (D-056/057). */
export type MovimentoEstoque = CompraEstoque | EntregaEstoque | RetornoEstoque | SaidaEstoque | ContagemEstoque | AnulacaoEstoque
/** Posição e evidências derivadas; nunca um saldo independente guardado. */
export type ProjecaoEstoque = {
  readonly fisico: number
  readonly movimentosVigentes: readonly MovimentoEstoque[]
  readonly comprasVigentes: readonly ReferenciaCompra[]
  readonly contagensAfetadas: readonly ReferenciaEfeito[]
}

/** Chave sem ambiguidade entre id/revisão, usada também pelas operações compostas. */
export function chaveDoEfeito(ref: ReferenciaEfeito): string { return JSON.stringify([ref.id, ref.revisao]) }
/** Referência pequena; não copia os valores do movimento para outra fonte da verdade. */
export function referenciaDoEfeito(movimento: ReferenciaEfeito): ReferenciaEfeito { return { id: movimento.id, revisao: movimento.revisao } }

function inteiroComSinal(valor: number): boolean { return quantidadeValida(valor, -9_007_199_254_740_991) }
function referenciaValida(ref: ReferenciaEfeito): boolean { return !!ref.id && quantidadeValida(ref.revisao, 1) }
function quantidadeDoMovimento(movimento: MovimentoEstoque): number {
  switch (movimento.tipo) {
    case 'compra': case 'retorno': return movimento.quantidade
    case 'entrega': case 'saida': return -movimento.quantidade
    case 'anulacao': return 0
    case 'contagem': return movimento.totalContado - movimento.base.reduce((total, item) => total + (item.aplicada ? item.quantidade : 0), 0)
  }
}

function organizar(historico: readonly MovimentoEstoque[]): ResultadoEstoque<{
  todos: Map<string, MovimentoEstoque>; atuais: Map<Id, MovimentoEstoque>
}> {
  const todos = new Map<string, MovimentoEstoque>()
  const atuais = new Map<Id, MovimentoEstoque>()
  for (const movimento of historico) {
    if (!referenciaValida(movimento) || !movimento.operacaoId || !movimento.produtoId) return { ok: false, motivo: 'revisao-invalida' }
    if (!diaValido(movimento.data)) return { ok: false, motivo: 'data-invalida' }
    if (movimento.conhecidos.some((ref) => !referenciaValida(ref) || chaveDoEfeito(ref) === chaveDoEfeito(movimento))) return { ok: false, motivo: 'base-invalida' }
    if ('quantidade' in movimento && !quantidadeValida(movimento.quantidade, movimento.tipo === 'entrega' ? 0 : 1)) return { ok: false, motivo: 'quantidade-invalida' }
    if ('custoUnitario' in movimento && movimento.custoUnitario !== undefined && (typeof movimento.custoUnitario !== 'bigint' || movimento.custoUnitario < 0n)) return { ok: false, motivo: 'custo-invalido' }
    if (movimento.tipo === 'compra' && (typeof movimento.ordemCadastro !== 'bigint' || movimento.ordemCadastro < 0n)) return { ok: false, motivo: 'revisao-invalida' }
    if ((movimento.tipo === 'entrega' || movimento.tipo === 'retorno') && !movimento.itemId) return { ok: false, motivo: 'item-invalido' }
    if (movimento.tipo === 'saida' && !['perda', 'quebra', 'uso-pessoal', 'brinde'].includes(movimento.motivo)) return { ok: false, motivo: 'motivo-obrigatorio' }
    if (movimento.tipo === 'contagem') {
      let somaDaBase = 0
      for (const item of movimento.base) {
        if (item.aplicada) somaDaBase += item.quantidade
        if (!inteiroComSinal(somaDaBase)) return { ok: false, motivo: 'quantidade-invalida' }
      }
      if (!quantidadeValida(movimento.totalContado) || !inteiroComSinal(quantidadeDoMovimento(movimento))) return { ok: false, motivo: 'quantidade-invalida' }
      if (!['estoque-inicial', 'conferencia'].includes(movimento.motivo)) return { ok: false, motivo: 'motivo-obrigatorio' }
      const base = new Set(movimento.base.map(chaveDoEfeito))
      if (base.size !== movimento.base.length || movimento.base.some((ref) => !referenciaValida(ref) || !inteiroComSinal(ref.quantidade)) ||
        movimento.conhecidos.length !== base.size || movimento.conhecidos.some((ref) => !base.has(chaveDoEfeito(ref))) ||
        movimento.resolvidas.some((ref) => !movimento.base.some((item) => chaveDoEfeito(item) === chaveDoEfeito(ref) && item.tipo === 'contagem' && !item.aplicada))) return { ok: false, motivo: 'base-invalida' }
    }
    const chave = chaveDoEfeito(movimento)
    const anterior = todos.get(chave)
    if (anterior && conteudoDoEfeito(anterior) !== conteudoDoEfeito(movimento)) return { ok: false, motivo: 'conteudo-divergente' }
    todos.set(chave, movimento)
    const atual = atuais.get(movimento.id)
    if (atual && (atual.tipo !== movimento.tipo || atual.operacaoId !== movimento.operacaoId)) return { ok: false, motivo: 'correcao-invalida' }
    if (!atual || movimento.revisao > atual.revisao) atuais.set(movimento.id, movimento)
  }
  return { ok: true, valor: { todos, atuais } }
}

/** Deriva físico, compras e contagens afetadas de todas as revisões conhecidas (Q39). */
export function projetarEstoque(historico: readonly MovimentoEstoque[], produtoId: Id): ResultadoEstoque<ProjecaoEstoque> {
  const organizacao = organizar(historico)
  if (!organizacao.ok) return organizacao
  const { todos, atuais } = organizacao.valor
  const evidencias = new Map<string, EvidenciaBase>()
  for (const movimento of todos.values()) {
    if (movimento.tipo !== 'contagem') continue
    for (const evidencia of movimento.base) {
      const observado = todos.get(chaveDoEfeito(evidencia))
      if (observado && (observado.produtoId !== movimento.produtoId || observado.tipo !== evidencia.tipo || quantidadeDoMovimento(observado) !== evidencia.quantidade ||
        conteudoDoEfeito(observado.conhecidos) !== conteudoDoEfeito(evidencia.conhecidos))) return { ok: false, motivo: 'base-invalida' }
      const anterior = evidencias.get(chaveDoEfeito(evidencia))
      if (anterior && (anterior.quantidade !== evidencia.quantidade || anterior.tipo !== evidencia.tipo || conteudoDoEfeito(anterior.conhecidos) !== conteudoDoEfeito(evidencia.conhecidos))) return { ok: false, motivo: 'base-invalida' }
      evidencias.set(chaveDoEfeito(evidencia), evidencia)
    }
  }
  // A fotografia conserva a causalidade mesmo quando a revisão local anterior não chegou à nuvem.
  const dependencias = (chave: string): readonly ReferenciaEfeito[] | undefined => todos.get(chave)?.conhecidos ?? evidencias.get(chave)?.conhecidos
  const visitando = new Set<string>()
  const conferidos = new Set<string>()
  function conferirCausa(chave: string): boolean {
    if (conferidos.has(chave)) return true
    if (visitando.has(chave)) return false
    const refs = dependencias(chave)
    if (!refs) return false
    visitando.add(chave)
    for (const ref of refs) if (!conferirCausa(chaveDoEfeito(ref))) return false
    visitando.delete(chave)
    conferidos.add(chave)
    return true
  }
  for (const movimento of todos.values()) if (!conferirCausa(chaveDoEfeito(movimento))) return { ok: false, motivo: 'dependencia-ausente' }
  function conhece(movimento: ReferenciaEfeito, alvo: ReferenciaEfeito): boolean {
    const alvoChave = chaveDoEfeito(alvo)
    const vistos = new Set<string>()
    const fila = [...(dependencias(chaveDoEfeito(movimento)) ?? [])]
    for (let indice = 0; indice < fila.length; indice++) {
      const ref = fila[indice]
      if (!ref) continue
      const chave = chaveDoEfeito(ref)
      if (chave === alvoChave) return true
      if (vistos.has(chave)) continue
      vistos.add(chave)
      fila.push(...(dependencias(chave) ?? []))
    }
    return false
  }
  const anulados = new Set<string>()
  for (const movimento of atuais.values()) {
    if (movimento.tipo !== 'anulacao') continue
    const alvo = atuais.get(movimento.alvo.id)
    if (!alvo || alvo.revisao !== movimento.alvo.revisao || alvo.tipo === 'anulacao' || alvo.produtoId !== movimento.produtoId) return { ok: false, motivo: 'alvo-invalido' }
    const chave = chaveDoEfeito(alvo)
    if (anulados.has(chave)) return { ok: false, motivo: 'ja-anulado' }
    anulados.add(chave)
  }
  const movimentos = [...atuais.values()].filter((movimento) => movimento.produtoId === produtoId)
  const ativos = movimentos.filter((movimento) => !anulados.has(chaveDoEfeito(movimento)))
  const contagens = ativos.filter((movimento): movimento is ContagemEstoque => movimento.tipo === 'contagem')
  const resolvidas = new Set(contagens.flatMap((contagem) => contagem.resolvidas.map(chaveDoEfeito)))
  const afetadas = new Set<string>()
  for (const contagem of contagens) {
    const chave = chaveDoEfeito(contagem)
    if (resolvidas.has(chave)) continue
    const base = new Set(contagem.base.map(chaveDoEfeito))
    if (contagem.base.some((ref) => ref.aplicada && (atuais.get(ref.id)?.revisao !== ref.revisao || anulados.has(chaveDoEfeito(ref))))) afetadas.add(chave)
    for (const movimento of ativos) {
      if (movimento.id === contagem.id || base.has(chaveDoEfeito(movimento)) || resolvidas.has(chaveDoEfeito(movimento))) continue
      if (!conhece(movimento, contagem)) afetadas.add(chave)
    }
  }
  let mudou = true
  while (mudou) {
    mudou = false
    for (const contagem of contagens) {
      const chave = chaveDoEfeito(contagem)
      if (afetadas.has(chave) || resolvidas.has(chave)) continue
      if (contagem.base.some((ref) => ref.aplicada && (afetadas.has(chaveDoEfeito(ref)) || resolvidas.has(chaveDoEfeito(ref))))) {
        afetadas.add(chave); mudou = true
      }
    }
  }
  const vigentes = ativos.filter((movimento) => movimento.tipo !== 'anulacao' && !afetadas.has(chaveDoEfeito(movimento)) && !resolvidas.has(chaveDoEfeito(movimento)))
  let fisico = 0
  for (const movimento of vigentes) {
    fisico += quantidadeDoMovimento(movimento)
    if (!inteiroComSinal(fisico)) return { ok: false, motivo: 'quantidade-invalida' }
  }
  const comprasVigentes = vigentes.filter((movimento): movimento is CompraEstoque => movimento.tipo === 'compra')
    .map((compra): ReferenciaCompra => ({ id: compra.compraOriginalId ?? compra.id, produtoId: compra.produtoId,
      data: compra.data, ordemCadastro: compra.ordemCadastro, custoUnitario: compra.custoUnitario }))
  return { ok: true, valor: { fisico, movimentosVigentes: vigentes, comprasVigentes,
    contagensAfetadas: contagens.filter((contagem) => afetadas.has(chaveDoEfeito(contagem))).map(referenciaDoEfeito) } }
}

/** Confere o conjunto todo; recusa não devolve meio lote e reenvio idêntico não soma novamente. */
export function registrarMovimentos(historico: readonly MovimentoEstoque[], novos: readonly MovimentoEstoque[]): ResultadoEstoque<readonly MovimentoEstoque[]> {
  const organizacao = organizar([...historico, ...novos])
  if (!organizacao.ok) return organizacao
  const todos = [...organizacao.valor.todos.values()]
  for (const produtoId of new Set(todos.map((movimento) => movimento.produtoId))) {
    const resultado = projetarEstoque(todos, produtoId)
    if (!resultado.ok) return resultado
  }
  return { ok: true, valor: todos }
}

/** Referências correntes que o aparelho conhece; a persistência fará a leitura junto da escrita. */
export function baseConhecida(historico: readonly MovimentoEstoque[], produtoId: Id): readonly ReferenciaEfeito[] {
  const atuais = new Map<Id, MovimentoEstoque>()
  for (const movimento of historico) if (!atuais.has(movimento.id) || movimento.revisao > (atuais.get(movimento.id)?.revisao ?? 0)) atuais.set(movimento.id, movimento)
  return [...atuais.values()].filter((movimento) => movimento.produtoId === produtoId).map(referenciaDoEfeito)
}

/** Só o total contado é humano; diferença, base e conflitos resolvidos são derivados (RI-08). */
export function novaContagem(historico: readonly MovimentoEstoque[], entrada: Omit<ContagemEstoque, 'tipo' | 'base' | 'resolvidas' | 'conhecidos'>): ResultadoEstoque<ContagemEstoque> {
  const projecao = projetarEstoque(historico, entrada.produtoId)
  if (!projecao.ok) return projecao
  const conhecidos = baseConhecida(historico, entrada.produtoId)
  const vigentes = new Set(projecao.valor.movimentosVigentes.map(chaveDoEfeito))
  const base: EvidenciaBase[] = []
  for (const ref of conhecidos) {
    const movimento = historico.find((item) => chaveDoEfeito(item) === chaveDoEfeito(ref))
    if (movimento) base.push({ ...ref, tipo: movimento.tipo, quantidade: quantidadeDoMovimento(movimento), aplicada: vigentes.has(chaveDoEfeito(ref)), conhecidos: movimento.conhecidos })
  }
  const contagem: ContagemEstoque = { ...entrada, tipo: 'contagem', conhecidos, base, resolvidas: projecao.valor.contagensAfetadas }
  const resultado = registrarMovimentos(historico, [contagem])
  return resultado.ok ? { ok: true, valor: contagem } : resultado
}

/** Corrige a revisão local ou acrescenta inverso/substituto; preserva a ordem e o custo histórico. */
export function corrigirMovimento(historico: readonly MovimentoEstoque[], alvo: ReferenciaEfeito, substituto: MovimentoEstoque,
  estado: { readonly sincronizado: boolean; readonly anulacao?: AnulacaoEstoque }): ResultadoEstoque<readonly MovimentoEstoque[]> {
  const organizacao = organizar(historico)
  if (!organizacao.ok) return organizacao
  const original = organizacao.valor.atuais.get(alvo.id)
  if (!original || original.revisao !== alvo.revisao || original.tipo === 'anulacao' || original.tipo !== substituto.tipo) return { ok: false, motivo: 'alvo-invalido' }
  if (historico.some((item) => item.tipo === 'anulacao' && chaveDoEfeito(item.alvo) === chaveDoEfeito(alvo))) return { ok: false, motivo: 'ja-anulado' }
  let novo = substituto
  if (original.tipo === 'compra' && novo.tipo === 'compra') novo = { ...novo, ordemCadastro: original.ordemCadastro, compraOriginalId: original.compraOriginalId ?? original.id }
  if (original.tipo === 'entrega' && novo.tipo === 'entrega' && original.produtoId === novo.produtoId) novo = { ...novo, custoUnitario: original.custoUnitario }
  // Corrigir o número anotado mantém o instante observado. Uma nova conferência usa novaContagem.
  if (original.tipo === 'contagem' && novo.tipo === 'contagem') novo = { ...novo, base: original.base, conhecidos: original.conhecidos, resolvidas: original.resolvidas }
  if (!estado.sincronizado) {
    if (novo.id !== original.id || novo.revisao !== original.revisao + 1 || novo.operacaoId !== original.operacaoId) return { ok: false, motivo: 'correcao-invalida' }
    return registrarMovimentos(historico, [novo])
  }
  const inverso = estado.anulacao
  if (!inverso || chaveDoEfeito(inverso.alvo) !== chaveDoEfeito(alvo) || inverso.operacaoId !== novo.operacaoId ||
    inverso.id === novo.id || organizacao.valor.atuais.has(novo.id) || organizacao.valor.atuais.has(inverso.id)) return { ok: false, motivo: 'correcao-invalida' }
  if (original.tipo === 'contagem' && novo.tipo === 'contagem') {
    const base: EvidenciaBase[] = [...original.base,
      { ...referenciaDoEfeito(original), tipo: original.tipo, quantidade: quantidadeDoMovimento(original), aplicada: false, conhecidos: original.conhecidos },
      { ...referenciaDoEfeito(inverso), tipo: inverso.tipo, quantidade: 0, aplicada: false, conhecidos: inverso.conhecidos }]
    novo = { ...novo, base, conhecidos: base.map(referenciaDoEfeito) }
  }
  return registrarMovimentos(historico, [inverso, novo])
}

/** Disponibilidade e mínimo usam físico menos prometido; o piso zero vale só para apresentação. */
export function posicaoEstoque(fisico: number, prometido: number, minimo?: number): ResultadoEstoque<{
  readonly fisico: number; readonly prometido: number; readonly disponivel: number; readonly falta: number; readonly noMinimo: boolean; readonly divergenciaFisica: boolean
}> {
  if (!inteiroComSinal(fisico) || !quantidadeValida(prometido) || (minimo !== undefined && !quantidadeValida(minimo)) || !inteiroComSinal(fisico - prometido)) return { ok: false, motivo: 'quantidade-invalida' }
  const referencia = fisico - prometido
  return { ok: true, valor: { fisico, prometido, disponivel: referencia > 0 ? referencia : 0, falta: referencia < 0 ? -referencia : 0,
    noMinimo: minimo !== undefined && referencia <= minimo, divergenciaFisica: fisico < 0 } }
}
