import type { Motivo } from './ficha.ts'

/** Recusas de F2; as palavras apresentadas à usuária pertencem à interface (RI-07). */
export type MotivoEstoque = Motivo
  | 'categoria-obrigatoria' | 'categoria-inexistente' | 'produto-inexistente'
  | 'quantidade-invalida' | 'custo-invalido' | 'custo-definido-por-compra'
  | 'motivo-obrigatorio' | 'dependencia-ausente' | 'revisao-invalida'
  | 'conteudo-divergente' | 'alvo-invalido' | 'ja-anulado' | 'base-invalida'
  | 'correcao-invalida' | 'item-invalido' | 'excede-pendencia' | 'excede-retorno'
  | 'venda-gratuita' | 'confirmacao-necessaria' | 'recusa-nao-confirmada'
  | 'intencao-incompativel' | 'identidade-reutilizada'

/** Resultado puro das operações de estoque, sem banco ou dependência de rede. */
export type ResultadoEstoque<T> =
  | { readonly ok: true; readonly valor: T }
  | { readonly ok: false; readonly motivo: MotivoEstoque }

/** Inteiros de contagem precisam continuar exatos também quando representados por number. */
export function quantidadeValida(valor: number, minimo = 0): boolean {
  return typeof valor === 'number' && valor % 1 === 0 && valor >= minimo && valor <= 9_007_199_254_740_991
}

/** Mesma convenção de Dia de F1; o calendário completo é conferido pela entrada de data. */
export function diaValido(dia: string): boolean {
  return /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/.test(dia)
}

/** Conteúdo canônico para distinguir revisões, inclusive centavos, sem depender da ordem das chaves. */
export function conteudoDoEfeito(valor: unknown): string {
  if (typeof valor === 'bigint') return `bigint:${valor}`
  if (valor === null || typeof valor !== 'object') return `${typeof valor}:${JSON.stringify(valor)}`
  if (Array.isArray(valor)) return `[${valor.map(conteudoDoEfeito).join(',')}]`
  return `{${Object.entries(valor).filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([chave, item]) => `${JSON.stringify(chave)}:${conteudoDoEfeito(item)}`).join(',')}}`
}
