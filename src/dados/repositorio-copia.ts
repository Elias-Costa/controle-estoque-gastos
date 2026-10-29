import type { BancoLocal } from './banco.ts'
import { dadosDaCopia, exigirCopia, lerDadosCopia, validarVinculosCopia } from './formato-copia.ts'
import { uuidv7 } from './identidade.ts'
import type { FotoLocal } from './tipos-fotos.ts'
import { tabelasDaCopia, TABELAS_COPIA, type DadosCopia, type EstagioCopia, type VinculoConta } from './tipos-copia.ts'
import { conteudoDoEfeito } from '../dominio/regras-estoque.ts'

/** Conta já estabelecida é imutável; expirar sessão não apaga nem desvincula dados (D-071). */
export async function vincularContaCopia(banco: BancoLocal, vinculo: VinculoConta): Promise<void> {
  await banco.transaction('rw', banco.controleCopia, async () => {
    const atual = await banco.controleCopia.get('conta')
    exigirCopia(!atual || (atual.chave === 'conta' && mesmoVinculo(atual.vinculo, vinculo)), 'conta')
    if (!atual) await banco.controleCopia.add({ chave: 'conta', vinculo })
  })
}
/** Comparação inclui destino para que uma conta de teste nunca autorize o pacote de produção. */
export function mesmoVinculo(a: VinculoConta, b: VinculoConta): boolean { return a.contaId === b.contaId && a.destino === b.destino }
/** Referências ainda utilizáveis precisam de original completo; metadado dispensado fica no histórico. */
export function fotosNecessariasCopia(dados: DadosCopia): readonly FotoLocal[] {
  const ids = new Set([...dados.produtos.flatMap((p) => p.fotoId ? [p.fotoId] : []),
    ...dados.enviosProdutoFoto.flatMap((e) => e.cadastro.fotoId ? [e.cadastro.fotoId] : []), ...dados.usosFotos.map((u) => u.fotoId)])
  return dados.fotos.filter((f) => !!f.binario || ids.has(f.id))
}
/** Operações de estágio só alteram temporários próprios; publicação insere em base vazia. */
export function criarRepositorioCopia(banco: BancoLocal, agora = () => new Date()) {
  const escopo = [...tabelasDaCopia(banco), banco.controleCopia, banco.estagiosCopia, banco.lotesCopia]
  async function conferirConta(vinculo: VinculoConta): Promise<void> {
    const atual = await banco.controleCopia.get('conta')
    exigirCopia(atual?.chave === 'conta' && mesmoVinculo(atual.vinculo, vinculo), 'conta')
  }
  async function conferirVazia(): Promise<void> {
    for (const nome of TABELAS_COPIA) {
      if (nome === 'sincronizacao' || nome === 'estadoFotos' || nome === 'relogioEstoque') continue
      exigirCopia(await banco.table(nome).count() === 0, 'vazia')
    }
  }
  async function guardarLotes(operacaoId: string, dados: DadosCopia): Promise<void> {
    for (const tabela of TABELAS_COPIA) {
      if (tabela === 'fotos') {
        for (const foto of dados.fotos) await banco.lotesCopia.add({
          id: `${operacaoId}/fotos/${foto.id}`, operacaoId, tabela, linhas: [foto] })
        continue
      }
      const tamanho = 250
      const linhas: readonly unknown[] = dados[tabela]
      for (let i = 0; i < linhas.length; i += tamanho) await banco.lotesCopia.add({
        id: `${operacaoId}/${tabela}/${String(i).padStart(9, '0')}`, operacaoId, tabela, linhas: linhas.slice(i, i + tamanho) })
    }
  }
  async function lerEstagio(id: string): Promise<{ estagio: EstagioCopia; dados: DadosCopia }> {
    return banco.transaction('r', banco.estagiosCopia, banco.lotesCopia, async () => {
      const estagio = await banco.estagiosCopia.get(id)
      exigirCopia(estagio, 'estagio')
      const linhas: Record<string, unknown[]> = Object.fromEntries(TABELAS_COPIA.map((t) => [t, []]))
      const lotes = await banco.lotesCopia.where('operacaoId').equals(id).sortBy('id')
      for (const lote of lotes) { const tabela = linhas[lote.tabela]; exigirCopia(tabela); tabela.push(...lote.linhas) }
      return { estagio, dados: dadosDaCopia(linhas) }
    })
  }
  async function capturar(vinculo: VinculoConta): Promise<string> {
    const id = uuidv7()
    await banco.transaction('rw', escopo, async () => {
      await conferirConta(vinculo)
      const restauracao = await banco.controleCopia.get('restauracao')
      exigirCopia(!restauracao || restauracao.chave !== 'restauracao' || restauracao.fase !== 'escolher', 'estagio')
      const dados = await lerDadosCopia(banco)
      const usos: string[] = []
      for (const foto of fotosNecessariasCopia(dados)) {
        exigirCopia(!foto.dispensada || !!foto.binario, 'foto')
        const uso = uuidv7(); usos.push(uso)
        await banco.usosFotos.add({ id: uso, fotoId: foto.id })
      }
      await banco.estagiosCopia.add({ id, tipo: 'exportacao', vinculo, capturadoEm: agora().toISOString(), pronto: false, usos })
      await guardarLotes(id, dados)
    })
    return id
  }
  async function completarFoto(id: string, fotoId: string, binario: Uint8Array, miniatura: Uint8Array): Promise<void> {
    await banco.transaction('rw', banco.estagiosCopia, banco.lotesCopia, async () => {
      const estagio = await banco.estagiosCopia.get(id)
      exigirCopia(estagio?.tipo === 'exportacao' && !estagio.pronto, 'estagio')
      // O endereço direto evita reler centenas de originais para completar uma foto.
      const lote = await banco.lotesCopia.get(`${id}/fotos/${fotoId}`)
      exigirCopia(lote && lote.linhas.length === 1, 'foto')
      const original = lote.linhas[0]
      exigirCopia(typeof original === 'object' && original !== null, 'foto')
      await banco.lotesCopia.put({ ...lote, linhas: [{ ...original, binario, miniatura }] })
    })
  }
  async function concluirCaptura(id: string): Promise<void> {
    await banco.transaction('rw', banco.estagiosCopia, banco.lotesCopia, async () => {
      const { estagio, dados } = await lerEstagio(id)
      exigirCopia(estagio.tipo === 'exportacao' && fotosNecessariasCopia(dados).every((f) => !!f.binario && !!f.miniatura), 'foto')
      await banco.estagiosCopia.put({ ...estagio, pronto: true })
    })
  }
  async function reservarImportacao(): Promise<string> {
    return banco.transaction('rw', escopo, async () => {
      await conferirVazia()
      const existente = await banco.controleCopia.get('restauracao')
      if (existente?.chave === 'restauracao') { exigirCopia(existente.fase === 'escolher', 'estagio'); return existente.id }
      const id = uuidv7()
      await banco.controleCopia.add({ chave: 'restauracao', id, fase: 'escolher' })
      return id
    })
  }
  async function prepararImportacao(id: string, vinculo: VinculoConta, capturadoEm: string, dados: DadosCopia): Promise<void> {
    validarVinculosCopia(dados)
    exigirCopia(fotosNecessariasCopia(dados).every((f) => !!f.binario && !!f.miniatura), 'foto')
    await banco.transaction('rw', escopo, async () => {
      await conferirConta(vinculo); await conferirVazia()
      const controle = await banco.controleCopia.get('restauracao')
      exigirCopia(controle?.chave === 'restauracao' && controle.id === id && controle.fase === 'escolher', 'estagio')
      exigirCopia(!await banco.estagiosCopia.get(id), 'estagio')
      await banco.estagiosCopia.add({ id, tipo: 'importacao', vinculo, capturadoEm, pronto: true })
      await guardarLotes(id, dados)
    })
  }
  async function publicar(id: string, vinculo: VinculoConta): Promise<void> {
    await banco.transaction('rw', escopo, async () => {
      await conferirConta(vinculo); await conferirVazia()
      const controle = await banco.controleCopia.get('restauracao')
      exigirCopia(controle?.chave === 'restauracao' && controle.id === id && controle.fase === 'escolher', 'estagio')
      const { estagio, dados } = await lerEstagio(id)
      exigirCopia(estagio.tipo === 'importacao' && estagio.pronto && !estagio.publicada && mesmoVinculo(estagio.vinculo, vinculo), 'estagio')
      exigirCopia(fotosNecessariasCopia(dados).every((f) => !!f.binario && !!f.miniatura), 'foto')
      for (const nome of TABELAS_COPIA) {
        // Identidade e cursores antigos permanecem no estágio como evidência, sem ficarem ativos.
        if (nome === 'estadoFotos' || nome === 'sincronizacao' || nome === 'relogioEstoque') continue
        const linhas = nome === 'fotos' ? dados.fotos.map((f) => ({ ...f, geracaoEnvio: uuidv7(), geracaoReferencia: undefined }))
          : nome === 'versoesEstoque' ? dados.versoesEstoque.map((v) => ({ ...v, restaurada: true }))
          : nome === 'versoesCaixa' ? dados.versoesCaixa.map((v) => ({ ...v, restaurada: true })) : dados[nome]
        await banco.table<unknown>(nome).bulkAdd(linhas)
      }
      await banco.estadoFotos.put({ chave: 'aparelho', valor: uuidv7() })
      await banco.estadoFotos.put({ chave: 'leitura', valor: uuidv7() })
      const atual = (await banco.relogioEstoque.get('cadastro'))?.ultimo ?? 0n
      const original = dados.relogioEstoque.find((r) => r.chave === 'cadastro')?.ultimo ?? 0n
      if (atual || original) await banco.relogioEstoque.put({ chave: 'cadastro', ultimo: atual > original ? atual : original })
      for (const l of dados.lancamentos) await banco.controleCopia.put({ chave: `registro:lancamentos/${l.id}`, conteudo: conteudoDoEfeito(l) })
      for (const c of dados.clientes) await banco.controleCopia.put({ chave: `registro:clientes/${c.id}`, conteudo: conteudoDoEfeito(c) })
      for (const p of dados.produtos) await banco.controleCopia.put({ chave: `registro:produtos/${p.id}`, conteudo: conteudoDoEfeito(p) })
      for (const m of dados.modelos) await banco.controleCopia.put({ chave: `registro:modelos/${m.id}`, conteudo: conteudoDoEfeito(m) })
      for (const p of dados.identidadesLoja) await banco.controleCopia.put({ chave: `registro:identidadeLoja/${p.id}`, conteudo: conteudoDoEfeito(p) })
      // Todos os cursores recomeçam; não confiar no ponto em que o aparelho de origem parou.
      for (const cursor of await banco.sincronizacao.toArray()) await banco.sincronizacao.delete(cursor.chave)
      await banco.controleCopia.put({ chave: 'restauracao', id, fase: 'reconciliar' })
      await banco.estagiosCopia.put({ ...estagio, publicada: true })
    })
  }
  async function descartar(id: string): Promise<void> {
    await banco.transaction('rw', banco.estagiosCopia, banco.lotesCopia, banco.usosFotos, banco.controleCopia, async () => {
      const estagio = await banco.estagiosCopia.get(id)
      exigirCopia(!estagio?.publicada, 'estagio')
      for (const uso of estagio?.usos ?? []) await banco.usosFotos.delete(uso)
      await banco.lotesCopia.where('operacaoId').equals(id).delete()
      await banco.estagiosCopia.delete(id)
      const controle = await banco.controleCopia.get('restauracao')
      if (controle?.chave === 'restauracao' && controle.id === id && controle.fase === 'escolher') await banco.controleCopia.delete('restauracao')
    })
  }
  return { capturar, lerEstagio, completarFoto, concluirCaptura, reservarImportacao, prepararImportacao, publicar, descartar,
    listar: () => banco.estagiosCopia.toArray(),
    async vinculo() { const c = await banco.controleCopia.get('conta'); return c?.chave === 'conta' ? c.vinculo : null },
    async restauracao() { const c = await banco.controleCopia.get('restauracao'); return c?.chave === 'restauracao' ? c : null },
    async conferirDados() { return banco.transaction('r', tabelasDaCopia(banco), () => lerDadosCopia(banco)) },
    igual: (a: unknown, b: unknown) => conteudoDoEfeito(a) === conteudoDoEfeito(b),
  }
}
