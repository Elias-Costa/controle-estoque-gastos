import type { BancoLocal } from './banco.ts'
import type { VersaoCaixa } from './tipos-caixa.ts'
import { validarFatosCaixa, type FatoCaixa } from '../dominio/gastos.ts'
import { conteudoDoEfeito } from '../dominio/regras-estoque.ts'

function igual(a: unknown, b: unknown): boolean { return conteudoDoEfeito(a) === conteudoDoEfeito(b) }
function incompativeis(a: VersaoCaixa, b: VersaoCaixa): boolean {
  const x = a.grupo.operacao, y = b.grupo.operacao
  return (x.id === y.id && !igual(a.grupo, b.grupo)) ||
    (!!x.alvo && (!!y.alvo && x.alvo.id === y.alvo.id || b.grupo.fatos.some((f) => f.id === x.alvo?.id && f.revisao !== x.alvo.revisao)))
}

/** Recompõe apenas efeitos correntes dentro do rw do chamador; evidência nunca é apagada (D-070). */
export async function recomporProjecaoCaixa(banco: BancoLocal): Promise<void> {
  const versoes = await banco.versoesCaixa.toArray(), atuais = await banco.operacoesCaixa.toArray()
  const aceitas = versoes.filter((v) => v.aceita)
  const porId = new Map(versoes.map((v) => [v.id, v]))
  const locais = atuais.flatMap((op) => { const v = porId.get(op.versaoId); return v && !v.aceita ? [v] : [] })
  // Uma recusa não retira nada sozinha: é necessário conhecer o aceite incompatível.
  for (const v of locais) {
    if (v.problema && aceitas.some((a) => incompativeis(v, a))) {
      await banco.versoesCaixa.put({ ...v, foraDaProjecao: { causaId: v.id } })
    }
  }
  let retiradas = (await banco.versoesCaixa.toArray()).filter((v) => v.foraDaProjecao)
  for (;;) {
    const dependentes = locais.filter((v) => !retiradas.some((r) => r.id === v.id) && v.grupo.operacao.alvo &&
      retiradas.some((r) => r.grupo.fatos.some((f) =>
        f.id === v.grupo.operacao.alvo?.id && f.revisao === v.grupo.operacao.alvo.revisao)) &&
      !aceitas.some((a) => a.grupo.fatos.some((f) => f.id === v.grupo.operacao.alvo?.id && f.revisao === v.grupo.operacao.alvo.revisao)))
    if (!dependentes.length) break
    for (const v of dependentes) {
      const causa = retiradas.find((r) => r.grupo.fatos.some((f) => f.id === v.grupo.operacao.alvo?.id))
      const retirada = { ...v, foraDaProjecao: { causaId: causa?.foraDaProjecao?.causaId ?? v.id } }
      await banco.versoesCaixa.put(retirada)
      retiradas = [...retiradas, retirada]
    }
  }
  const pendentes = locais.filter((v) => !retiradas.some((r) => r.id === v.id))
  // D-042/069: uma versão ainda pendente tem prioridade sobre chegada antiga. O aceite
  // permanece na evidência; seu grupo inteiro aguarda a resolução da versão incompatível.
  const candidatos = [...pendentes, ...aceitas.filter((a) => !pendentes.some((p) => incompativeis(p, a)))]
  const fatos: FatoCaixa[] = [], aplicadas: VersaoCaixa[] = []
  const presentes = new Map<string, FatoCaixa>(), estornados = new Set<string>()
  let restantes = candidatos
  for (;;) {
    const depois: VersaoCaixa[] = []
    for (const v of restantes) {
      // Conferir os vínculos novos sem revalidar todo o prefixo a cada grupo da página.
      if (v.grupo.fatos.some((f) => presentes.has(f.id) || f.tipo === 'estorno' &&
        (estornados.has(f.alvo.id) || presentes.get(f.alvo.id)?.tipo === 'estorno' || presentes.get(f.alvo.id)?.revisao !== f.alvo.revisao))) {
        depois.push(v); continue
      }
      for (const f of v.grupo.fatos) { presentes.set(f.id, f); if (f.tipo === 'estorno') estornados.add(f.alvo.id) }
      fatos.push(...v.grupo.fatos); aplicadas.push(v)
    }
    if (depois.length === restantes.length) break
    restantes = depois
  }
  if (pendentes.some((p) => !aplicadas.includes(p))) throw new Error('Projeção de caixa local com dependência inválida')
  if (!validarFatosCaixa(fatos).ok) throw new Error('Projeção de caixa inválida')
  // Somente tabelas de projeção: as fotografias e os ponteiros/diagnósticos FIFO ficam.
  const idsFatos = new Set(fatos.map((f) => f.id)), idsOperacoes = new Set(aplicadas.map((v) => v.operacaoId))
  const fatosAtuais = new Map((await banco.fatosCaixa.toArray()).map((f) => [f.id, f]))
  for (const f of fatosAtuais.values()) if (!idsFatos.has(f.id)) await banco.fatosCaixa.delete(f.id)
  for (const op of atuais) if (!idsOperacoes.has(op.id)) await banco.operacoesCaixa.delete(op.id)
  for (const f of fatos) if (!igual(fatosAtuais.get(f.id), f)) await banco.fatosCaixa.put(f)
  const operacoesAtuais = new Map(atuais.map((op) => [op.id, op]))
  for (const v of aplicadas) if (operacoesAtuais.get(v.operacaoId)?.versaoId !== v.id) {
    await banco.operacoesCaixa.put({ ...v.grupo.operacao, versaoId: v.id })
  }
}
