import { validar, type Id, type Lancamento } from './ficha.ts'
import { chaveDoEfeito, projetarEstoque, registrarMovimentos, type MovimentoEstoque, type ReferenciaEfeito } from './estoque.ts'
import { conteudoDoEfeito, diaValido, quantidadeValida, type ResultadoEstoque } from './regras-estoque.ts'
import type { GrupoEstoque } from './vendas-estoque.ts'

/** Estado já aceito, separado da tentativa local; não é permissão para apagar a base (Q47A). */
export type EstadoAceitoEstoque = {
  readonly operacoes: readonly GrupoEstoque[]
  readonly lancamentos: readonly Lancamento[]
  readonly movimentos: readonly MovimentoEstoque[]
}
/** Revisão e conteúdo identificam a tentativa; o id sozinho também pode designar outra versão aceita. */
export type IdentidadeTentativa = ReferenciaEfeito & { readonly conteudo: string }
/** Evidência transportável da recusa ou da ausência de resposta; só a primeira permite encerramento. */
export type TentativaEstoque = {
  readonly grupo: GrupoEstoque
  readonly desfecho: 'recusada' | 'resposta-perdida'
  readonly diagnostico: string
}
/** Confirmação humana preservada; novas operações têm seus próprios ids e vínculo com esta evidência. */
export type EncerramentoTentativa = {
  readonly id: Id
  readonly data: string
  readonly tentativa: IdentidadeTentativa
  readonly evidencia: TentativaEstoque
  readonly aceitosConhecidos: readonly GrupoEstoque[]
  readonly novaOperacao?: GrupoEstoque
}

/** Conteúdo integral sem hash aproximado: custo/quantidade/financeiro divergentes não se confundem. */
export function identidadeDaTentativa(grupo: GrupoEstoque): IdentidadeTentativa {
  return { id: grupo.operacao.id, revisao: grupo.operacao.revisao, conteudo: conteudoDoEfeito(grupo) }
}
function mesmaTentativa(a: IdentidadeTentativa, b: IdentidadeTentativa): boolean {
  return a.id === b.id && a.revisao === b.revisao && a.conteudo === b.conteudo
}
function idsDosRegistros(grupo: GrupoEstoque): readonly Id[] {
  return [grupo.operacao.id, ...grupo.lancamentos.flatMap((item) => [item.id, ...('parcelas' in item ? item.parcelas.map((parcela) => parcela.id) : [])]), ...grupo.movimentos.map((item) => item.id)]
}

/** Aceite serial puro de Q40; a trava e a transação equivalentes são provas posteriores de E-20. */
export function aceitarGrupoEstoque(estado: EstadoAceitoEstoque, grupo: GrupoEstoque): ResultadoEstoque<EstadoAceitoEstoque> {
  const anterior = estado.operacoes.find((item) => item.operacao.id === grupo.operacao.id)
  if (anterior) return mesmaTentativa(identidadeDaTentativa(anterior), identidadeDaTentativa(grupo))
    ? { ok: true, valor: estado } : { ok: false, motivo: 'conteudo-divergente' }
  const { operacao } = grupo
  if (operacao.formato !== 1 || !quantidadeValida(operacao.revisao, 1) || !operacao.id) return { ok: false, motivo: 'revisao-invalida' }
  const ids = idsDosRegistros(grupo)
  if (new Set(ids).size !== ids.length) return { ok: false, motivo: 'id-repetido' }
  const existentes = new Set([...estado.operacoes.map((item) => item.operacao.id), ...estado.lancamentos.flatMap((item) => [item.id, ...('parcelas' in item ? item.parcelas.map((parcela) => parcela.id) : [])]), ...estado.movimentos.map((item) => item.id)])
  if (ids.some((id) => existentes.has(id))) return { ok: false, motivo: 'identidade-reutilizada' }
  if (operacao.lancamentos.length !== grupo.lancamentos.length || operacao.movimentos.length !== grupo.movimentos.length ||
    new Set(operacao.lancamentos.map(chaveDoEfeito)).size !== operacao.lancamentos.length ||
    new Set(operacao.movimentos.map(chaveDoEfeito)).size !== operacao.movimentos.length ||
    operacao.lancamentos.some((ref) => ref.revisao !== operacao.revisao || !grupo.lancamentos.some((item) => item.id === ref.id)) ||
    operacao.movimentos.some((ref) => !grupo.movimentos.some((item) => chaveDoEfeito(item) === chaveDoEfeito(ref))) ||
    grupo.movimentos.some((item) => item.operacaoId !== operacao.id)) return { ok: false, motivo: 'base-invalida' }
  const referenciasFinanceiras = new Map(estado.lancamentos.map((item) => [item.id, { id: item.id, revisao: 1 }]))
  for (const ref of estado.operacoes.flatMap((item) => item.operacao.lancamentos)) referenciasFinanceiras.set(ref.id, ref)
  const referenciasConhecidas = new Set([...estado.operacoes.map((item) => item.operacao),
    ...estado.movimentos, ...referenciasFinanceiras.values()].map(chaveDoEfeito))
  if (operacao.dependencias.some((ref) => !referenciasConhecidas.has(chaveDoEfeito(ref)))) return { ok: false, motivo: 'dependencia-ausente' }
  if (operacao.alvo) {
    const alvo = operacao.alvo
    const referencias = [...estado.operacoes.flatMap((item) => item.operacao.lancamentos), ...estado.movimentos]
    const conhecida = referencias.find((item) => item.id === alvo.id) ?? (estado.lancamentos.some((item) => item.id === alvo.id) ? { id: alvo.id, revisao: 1 } : undefined)
    if (!conhecida || conhecida.revisao !== alvo.revisao || estado.operacoes.some((item) => item.operacao.alvo && chaveDoEfeito(item.operacao.alvo) === chaveDoEfeito(alvo))) return { ok: false, motivo: 'alvo-invalido' }
  }
  const lancamentos = [...estado.lancamentos, ...grupo.lancamentos]
  for (const clienteId of new Set(lancamentos.map((item) => item.clienteId))) {
    const ficha = validar(lancamentos.filter((item) => item.clienteId === clienteId))
    if (!ficha.ok) return ficha
  }
  const movimentos = registrarMovimentos(estado.movimentos, grupo.movimentos)
  if (!movimentos.ok) return movimentos
  // Duas entregas independentes são preservadas. Dois retornos só cabem até o efetivamente entregue.
  for (const produtoId of new Set(movimentos.valor.map((item) => item.produtoId))) {
    const projecao = projetarEstoque(movimentos.valor, produtoId)
    if (!projecao.ok) return projecao
    const itens = new Map<Id, { entregue: number; retornado: number }>()
    for (const movimento of projecao.valor.movimentosVigentes) {
      if (movimento.tipo !== 'entrega' && movimento.tipo !== 'retorno') continue
      const item = itens.get(movimento.itemId) ?? { entregue: 0, retornado: 0 }
      if (movimento.tipo === 'entrega') item.entregue += movimento.quantidade
      else item.retornado += movimento.quantidade
      itens.set(movimento.itemId, item)
    }
    if ([...itens.values()].some((item) => item.retornado > item.entregue)) return { ok: false, motivo: 'excede-retorno' }
  }
  return { ok: true, valor: { operacoes: [...estado.operacoes, grupo], lancamentos, movimentos: movimentos.valor } }
}

/** Encerra somente a tentativa conferida; não transforma resposta perdida em recusa (Q47A). */
export function encerrarTentativaEstoque(tentativa: TentativaEstoque, aceito: EstadoAceitoEstoque,
  encerramentos: readonly EncerramentoTentativa[], entrada: {
    readonly id: Id; readonly data: string; readonly confirmado: boolean; readonly intencaoPendente: boolean; readonly novaOperacao?: GrupoEstoque
  }): ResultadoEstoque<EncerramentoTentativa> {
  const identidade = identidadeDaTentativa(tentativa.grupo)
  const existente = encerramentos.find((item) => mesmaTentativa(item.tentativa, identidade))
  if (existente) return { ok: true, valor: existente }
  if (!entrada.confirmado) return { ok: false, motivo: 'confirmacao-necessaria' }
  if (tentativa.desfecho !== 'recusada' || !tentativa.diagnostico.trim()) return { ok: false, motivo: 'recusa-nao-confirmada' }
  if (!entrada.id || encerramentos.some((item) => item.id === entrada.id)) return { ok: false, motivo: 'id-repetido' }
  if (!diaValido(entrada.data)) return { ok: false, motivo: 'data-invalida' }
  if (entrada.intencaoPendente !== (entrada.novaOperacao !== undefined)) return { ok: false, motivo: 'intencao-incompativel' }
  if (aceito.operacoes.some((item) => mesmaTentativa(identidadeDaTentativa(item), identidade))) return { ok: false, motivo: 'recusa-nao-confirmada' }
  if (entrada.novaOperacao) {
    const recusados = new Set(idsDosRegistros(tentativa.grupo))
    if (idsDosRegistros(entrada.novaOperacao).some((id) => recusados.has(id))) return { ok: false, motivo: 'identidade-reutilizada' }
    const conferida = aceitarGrupoEstoque(aceito, entrada.novaOperacao)
    if (!conferida.ok) return conferida
  }
  return { ok: true, valor: { id: entrada.id, data: entrada.data, tentativa: identidade, evidencia: tentativa,
    aceitosConhecidos: aceito.operacoes, novaOperacao: entrada.novaOperacao } }
}

/** Projeção local após encerramento; a evidência continua nos grupos/resoluções originais. */
export function efeitosAposEncerramentos(aceito: EstadoAceitoEstoque, pendentes: readonly GrupoEstoque[], encerramentos: readonly EncerramentoTentativa[]): {
  readonly lancamentos: readonly Lancamento[]; readonly movimentos: readonly MovimentoEstoque[]; readonly pendentes: readonly GrupoEstoque[]
} {
  const candidatos = [...pendentes, ...encerramentos.flatMap((item) => item.novaOperacao ? [item.novaOperacao] : [])]
  const vivos = candidatos.filter((grupo) => !encerramentos.some((encerramento) => mesmaTentativa(encerramento.tentativa, identidadeDaTentativa(grupo))))
  const operacoes = new Map<Id, GrupoEstoque>()
  for (const grupo of vivos) {
    if (aceito.operacoes.some((atual) => mesmaTentativa(identidadeDaTentativa(atual), identidadeDaTentativa(grupo)))) continue
    const anterior = operacoes.get(grupo.operacao.id)
    if (!anterior || grupo.operacao.revisao > anterior.operacao.revisao) operacoes.set(grupo.operacao.id, grupo)
  }
  const lancamentos = new Map(aceito.lancamentos.map((item) => [item.id, item]))
  const movimentos = new Map(aceito.movimentos.map((item) => [chaveDoEfeito(item), item]))
  for (const grupo of operacoes.values()) {
    for (const item of grupo.lancamentos) lancamentos.set(item.id, item)
    for (const item of grupo.movimentos) movimentos.set(chaveDoEfeito(item), item)
  }
  return { lancamentos: [...lancamentos.values()], movimentos: [...movimentos.values()], pendentes: [...operacoes.values()] }
}
