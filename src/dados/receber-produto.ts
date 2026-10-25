import type { ProdutoLocal } from './banco.ts'

/** LWW inteiro; em empate, D-075 permite completar só o campo desconhecido pelo legado. */
export function produtoRecebido(local: ProdutoLocal | undefined, remoto: ProdutoLocal): ProdutoLocal {
  if (!local || local.atualizadoEm < remoto.atualizadoEm) return remoto
  if (local.atualizadoEm === remoto.atualizadoEm && !local.classificacaoConhecida && local.classificacao === undefined && remoto.classificacaoConhecida) {
    return { ...local, classificacao: remoto.classificacao, classificacaoConhecida: true }
  }
  return local
}
