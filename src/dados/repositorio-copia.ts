import type { BancoLocal } from './banco.ts'
import { dadosDaCopia, exigirCopia, lerDadosCopia, objetoCopia, validarVinculosCopia } from './formato-copia.ts'
import { uuidv7 } from './identidade.ts'
import type { FotoLocal } from './tipos-fotos.ts'
import { tabelasDaCopia, TABELAS_COPIA, type BackupConfirmado, type ConexaoDriveConferida, type DadosCopia, type EstagioCopia, type VinculoConta } from './tipos-copia.ts'
import { conteudoDoEfeito } from '../dominio/regras-estoque.ts'
import { criarRepositorioFotos } from './fotos.ts'

function lerConexaoDrive(v: unknown): ConexaoDriveConferida | undefined {
  if (!objetoCopia(v) || typeof v['vinculoId'] !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v['vinculoId']) ||
    typeof v['conectadoEm'] !== 'string' || !Number.isFinite(Date.parse(v['conectadoEm'])) || typeof v['email'] !== 'string' ||
    v['email'].length < 3 || v['email'].length > 320 || [...v['email']].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) return undefined
  return { vinculoId: v['vinculoId'], conectadoEm: v['conectadoEm'], email: v['email'] }
}

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
  async function capturar(vinculo: VinculoConta, automatico?: { aparelhoId: string; instante: Date }): Promise<string> {
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
      await banco.estagiosCopia.add({ id, tipo: 'exportacao', vinculo, capturadoEm: (automatico?.instante ?? agora()).toISOString(),
        pronto: false, usos, ...(automatico ? { aparelhoId: automatico.aparelhoId } : {}) })
      await guardarLotes(id, dados)
    })
    return id
  }
  async function completarFoto(id: string, fotoId: string, binario: Uint8Array, miniatura?: Uint8Array): Promise<void> {
    await banco.transaction('rw', banco.estagiosCopia, banco.lotesCopia, async () => {
      const estagio = await banco.estagiosCopia.get(id)
      exigirCopia(estagio?.tipo === 'exportacao' && !estagio.pronto, 'estagio')
      // O endereço direto evita reler centenas de originais para completar uma foto.
      const lote = await banco.lotesCopia.get(`${id}/fotos/${fotoId}`)
      exigirCopia(lote && lote.linhas.length === 1, 'foto')
      const original = lote.linhas[0]
      exigirCopia(typeof original === 'object' && original !== null, 'foto')
      await banco.lotesCopia.put({ ...lote, linhas: [{ ...original, binario, ...(miniatura ? { miniatura } : {}) }] })
    })
  }
  async function concluirCaptura(id: string): Promise<void> {
    await banco.transaction('rw', banco.estagiosCopia, banco.lotesCopia, async () => {
      const { estagio, dados } = await lerEstagio(id)
      exigirCopia(estagio.tipo === 'exportacao' && fotosNecessariasCopia(dados).every((f) => !!f.binario && (!!estagio.aparelhoId || !!f.miniatura)), 'foto')
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
      for (const p of dados.prazosEncalhe) await banco.controleCopia.put({ chave: `registro:prazoEncalhe/${p.id}`, conteudo: conteudoDoEfeito(p) })
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
  async function backupConcluidoNoDia(vinculo: VinculoConta, dia: string): Promise<boolean> {
    const [conta, controle] = await banco.controleCopia.bulkGet(['conta', 'backup-aparelho'])
    return conta?.chave === 'conta' && mesmoVinculo(conta.vinculo, vinculo) &&
      controle?.chave === 'backup-aparelho' && !controle.tentativa &&
      controle.concluido !== undefined && controle.concluido >= dia
  }
  async function driveAtual(id: string | undefined): Promise<boolean> {
    const c = await banco.controleCopia.get('registro:vinculo-google')
    return (c?.chave === 'registro:vinculo-google' ? c.conteudo : undefined) === id
  }
  async function vincularDrive(id: string, instante: string): Promise<boolean> {
    exigirCopia(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id) && Number.isFinite(Date.parse(instante)))
    return banco.transaction('rw', banco.controleCopia, async () => {
      const anterior = await banco.controleCopia.get('registro:vinculo-google')
      if (anterior?.chave === 'registro:vinculo-google' && anterior.conteudo === id) return true
      const horaAnterior = await banco.controleCopia.get('registro:hora-vinculo-google')
      if (horaAnterior?.chave === 'registro:hora-vinculo-google' && Date.parse(horaAnterior.conteudo) >= Date.parse(instante)) return false
      // D-085: conservar estágios e suas fotos; só trocar os ponteiros da confirmação corrente.
      for (const chave of ['backup-aparelho', 'backup-confirmado'] as const) {
        const controle = await banco.controleCopia.get(chave)
        if (controle) await banco.controleCopia.put({ chave: `registro:backup-anterior:${id}:${chave}`, conteudo: JSON.stringify(controle) })
        await banco.controleCopia.delete(chave)
      }
      await banco.controleCopia.put({ chave: 'registro:vinculo-google', conteudo: id })
      await banco.controleCopia.put({ chave: 'registro:hora-vinculo-google', conteudo: instante })
      await banco.controleCopia.delete('registro:conexao-google')
      return true
    })
  }
  async function guardarConexaoDrive(conexao: ConexaoDriveConferida): Promise<boolean> {
    const conferida = lerConexaoDrive(conexao)
    exigirCopia(conferida)
    return banco.transaction('rw', banco.controleCopia, async () => {
      const conta = await banco.controleCopia.get('conta')
      if (conta?.chave !== 'conta' || !await driveAtual(conferida.vinculoId)) return false
      // D-085: lista pública fechada; nunca persistir a resposta inteira do serviço ou credenciais.
      const conteudo = JSON.stringify({ vinculo: { contaId: conta.vinculo.contaId, destino: conta.vinculo.destino }, conexao: conferida })
      await banco.controleCopia.put({ chave: 'registro:conexao-google', conteudo })
      return true
    })
  }
  async function reservarBackup(vinculo: VinculoConta, dia: string, instante: Date, drive?: string): Promise<string | null> {
    return banco.transaction('rw', escopo, async () => {
      await conferirConta(vinculo)
      if (!await driveAtual(drive)) return null
      if (await banco.controleCopia.get('restauracao')) return null
      const controle = await banco.controleCopia.get('backup-aparelho')
      if (controle?.chave === 'backup-aparelho') {
        if (controle.tentativa) return controle.tentativa.id
        if (controle.concluido && controle.concluido >= dia) return null
      }
      // A identidade do aparelho, o estágio e o gatilho nascem juntos. Outra aba vê a mesma candidata.
      const aparelhoId = await criarRepositorioFotos(banco).aparelhoId()
      const id = await capturar(vinculo, { aparelhoId, instante })
      await banco.controleCopia.put({ chave: 'backup-aparelho', tentativa: { id, dia, falhou: false } })
      return id
    })
  }
  async function marcarFalhaBackup(id: string, falhou: boolean): Promise<void> {
    await banco.transaction('rw', banco.controleCopia, async () => {
      const c = await banco.controleCopia.get('backup-aparelho')
      if (c?.chave === 'backup-aparelho' && c.tentativa?.id === id && c.tentativa.falhou !== falhou) {
        await banco.controleCopia.put({ ...c, tentativa: { ...c.tentativa, falhou } })
      }
    })
  }
  async function guardarUltimoBackup(ultima: BackupConfirmado, drive?: string): Promise<boolean> {
    return banco.transaction('rw', banco.controleCopia, async () => {
      if (!await driveAtual(drive)) return false
      const c = await banco.controleCopia.get('backup-confirmado')
      if (c?.chave !== 'backup-confirmado' || Date.parse(c.ultima.capturadoEm) <= Date.parse(ultima.capturadoEm)) {
        await banco.controleCopia.put({ chave: 'backup-confirmado', ultima })
      }
      return true
    })
  }
  async function concluirBackup(id: string, ultima: BackupConfirmado, drive?: string): Promise<void> {
    await banco.transaction('rw', banco.controleCopia, banco.estagiosCopia, banco.lotesCopia, banco.usosFotos, async () => {
      const c = await banco.controleCopia.get('backup-aparelho')
      if (c?.chave !== 'backup-aparelho' || c.tentativa?.id !== id) return
      if (!await guardarUltimoBackup(ultima, drive)) return
      await descartar(id)
      await banco.controleCopia.put({ chave: 'backup-aparelho', concluido: c.tentativa.dia })
    })
  }
  async function lerEstadoBackup() {
    const [c, u, g, identidade, conta] = await banco.controleCopia.bulkGet(['backup-aparelho', 'backup-confirmado', 'registro:vinculo-google', 'registro:conexao-google', 'conta'])
    let conexaoDrive: ConexaoDriveConferida | undefined
    if (identidade?.chave === 'registro:conexao-google' && conta?.chave === 'conta') {
      try {
        const valor: unknown = JSON.parse(identidade.conteudo)
        if (objetoCopia(valor) && objetoCopia(valor['vinculo']) && valor['vinculo']['contaId'] === conta.vinculo.contaId && valor['vinculo']['destino'] === conta.vinculo.destino) {
          const conferida = lerConexaoDrive(valor['conexao'])
          if (g?.chave === 'registro:vinculo-google' && conferida?.vinculoId === g.conteudo) conexaoDrive = conferida
        }
      } catch { /* Identidade local inválida não oculta o estado da tentativa nem bloqueia as anotações. */ }
    }
    return { tentativa: c?.chave === 'backup-aparelho' ? c.tentativa : undefined,
      ultima: u?.chave === 'backup-confirmado' ? u.ultima : undefined,
      vinculoId: g?.chave === 'registro:vinculo-google' ? g.conteudo : undefined, conexaoDrive }
  }
  return { capturar, lerEstagio, completarFoto, concluirCaptura, reservarImportacao, prepararImportacao, publicar, descartar,
    backupConcluidoNoDia, reservarBackup, marcarFalhaBackup, guardarUltimoBackup, concluirBackup, lerEstadoBackup, vincularDrive, guardarConexaoDrive,
    listar: async () => (await banco.estagiosCopia.toArray()).filter((e) => !e.aparelhoId),
    async vinculo() { const c = await banco.controleCopia.get('conta'); return c?.chave === 'conta' ? c.vinculo : null },
    async restauracao() { const c = await banco.controleCopia.get('restauracao'); return c?.chave === 'restauracao' ? c : null },
    async conferirDados() { return banco.transaction('r', tabelasDaCopia(banco), () => lerDadosCopia(banco)) },
    igual: (a: unknown, b: unknown) => conteudoDoEfeito(a) === conteudoDoEfeito(b),
  }
}
