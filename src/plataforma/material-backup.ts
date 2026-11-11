import type { DadosCopia } from '../dados/tipos-copia.ts'
import { conteudoDoEfeito } from '../dominio/regras-estoque.ts'
import { hashDaFoto } from './fotos.ts'

/** Índice de fatos da mesma captura. Conteúdo equivalente é comparável entre as duas origens (D-084). */
export async function indexarMaterialBackup(d: DadosCopia, resumir?: (conteudo: string) => string) {
  const pendentes = new Set(d.fila.map((i) => `${i.tabela}/${i.registroId}`))
  const material = new Set<string>(), exclusivos = new Set<string>()
  const codificador = new TextEncoder()
  async function anotar(tipo: string, valor: unknown, exclusivo: boolean): Promise<void> {
    const conteudo = conteudoDoEfeito([tipo, valor])
    const hash = resumir ? resumir(conteudo) : await hashDaFoto(codificador.encode(conteudo))
    material.add(hash)
    if (exclusivo) exclusivos.add(hash)
  }
  for (const v of d.clientes) await anotar('cliente', v, pendentes.has('clientes/' + v.id))
  for (const v of d.categorias) await anotar('categoria', v, pendentes.has('categorias/' + v.id))
  for (const v of d.produtos) await anotar('produto', v, pendentes.has('produtos/' + v.id))
  for (const v of d.lancamentos) await anotar('lancamento', v, pendentes.has('lancamentos/' + v.id))
  for (const v of d.movimentos) await anotar('movimento', v, false)
  for (const v of d.versoesEstoque) {
    await anotar('grupoEstoque', v.grupo, v.aceita !== true)
    for (const l of v.grupo.lancamentos) await anotar('lancamento', l, false)
    for (const m of v.grupo.movimentos) await anotar('movimento', m, false)
  }
  for (const v of d.versoesCaixa) await anotar('grupoCaixa', v.grupo, v.aceita !== true)
  for (const v of d.encerramentos) await anotar('encerramento', v, pendentes.has('encerramentos/' + v.id))
  for (const v of d.modelos) await anotar('modelos', v, pendentes.has('modelos/' + v.id))
  for (const v of d.identidadesLoja) await anotar('identidade', v, pendentes.has('identidadeLoja/' + v.id))
  for (const v of d.fotos) {
    // Metadado dispensado, sem os bytes, nunca autoriza apagar a única cópia com a foto.
    if (v.binario) await anotar('foto', { id: v.id, sha256: v.sha256, bytes: v.bytes, largura: v.largura, altura: v.altura },
      v.situacao !== 'disponivel' || pendentes.has('fotos/' + v.id))
  }
  for (const v of d.enviosProdutoFoto) await anotar('produto', v.cadastro, true)
  for (const v of d.evidenciasCopia) await anotar('evidencia', v, true)
  return { material: [...material].sort(), exclusivos: [...exclusivos].sort() }
}
