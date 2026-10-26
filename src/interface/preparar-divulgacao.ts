import type { RetratoDivulgacao } from '../dados/leitura-divulgacao.ts'
import { filtrarDivulgacao, secoesPdfDivulgacao, mesmasLinhasDivulgacao, relerPreviaDivulgacao,
  type FiltrosDivulgacao, type SecaoPdfDivulgacao, type PreviaDivulgacao } from './divulgacao-produtos.ts'

/** Reler antes/depois da geração; reter as referências só enquanto o arquivo é preparado (D-025). */
export async function prepararDivulgacao(previa: PreviaDivulgacao, filtros: FiltrosDivulgacao, portas: {
  readonly ler: () => Promise<RetratoDivulgacao>; readonly fotos: { readonly reterReferencia: (id: string) => Promise<string>; readonly liberarUso: (id: string) => Promise<void> };
  readonly gerar: (secoes: readonly SecaoPdfDivulgacao[]) => Promise<File>;
}) {
  const usos: string[] = []
  const conferir = async () => relerPreviaDivulgacao(previa, filtrarDivulgacao(await portas.ler(), filtros))
  try {
    let atual = await conferir()
    if (!mesmasLinhasDivulgacao(previa.linhas, atual.linhas)) return { estado: 'alterada', previa: atual } as const
    const selecionadas = previa.linhas.filter((linha) => !previa.desmarcados.includes(linha.produto.id))
    const secoes = secoesPdfDivulgacao(selecionadas)
    for (const fotoId of new Set(selecionadas.flatMap((linha) => linha.produto.fotoId ? [linha.produto.fotoId] : []))) usos.push(await portas.fotos.reterReferencia(fotoId))
    atual = await conferir()
    if (!mesmasLinhasDivulgacao(previa.linhas, atual.linhas)) return { estado: 'alterada', previa: atual } as const
    const arquivo = await portas.gerar(secoes)
    atual = await conferir()
    if (!mesmasLinhasDivulgacao(previa.linhas, atual.linhas)) return { estado: 'alterada', previa: atual } as const
    return { estado: 'pronta', previa: { ...atual, alterada: false }, arquivo } as const
  } finally {
    // Se a liberação falhar, a linha permanece protegida; não substituir o resultado por perda de proteção.
    for (const uso of usos) await portas.fotos.liberarUso(uso).catch(() => undefined)
  }
}
