import type { Id } from '../dominio/ficha.ts'
import { conteudoDoEfeito } from '../dominio/regras-estoque.ts'
import type { BancoLocal, ProdutoLocal } from './banco.ts'
import { uuidv7 } from './identidade.ts'
import { produtoRecebido } from './receber-produto.ts'
import type { EnvioProdutoFoto, ProtecaoFoto, ProtecaoFotoLocal } from './tipos-fotos.ts'

/** Chave composta apenas de identidades geradas em clientes; geração antiga não libera a nova. */
export function chaveDaProtecao(protecao: Pick<ProtecaoFoto, 'copiaId' | 'geracao'>): string {
  return `${protecao.copiaId}/${protecao.geracao}`
}

/** Estado durável de foto/proteções. Não conhece transporte, sessão nem disponibilidade da rede. */
export function criarRepositorioFotos(banco: BancoLocal) {
  const tabelas = [banco.fotos, banco.produtos, banco.fila, banco.protecoesFotos,
    banco.enviosProdutoFoto, banco.usosFotos, banco.estadoFotos, banco.categorias, banco.controleCopia]

  async function identidade(chave: 'aparelho' | 'leitura'): Promise<Id> {
    return banco.transaction('rw', banco.estadoFotos, async () => {
      const existente = await banco.estadoFotos.get(chave)
      if (existente) return existente.valor
      const valor = uuidv7()
      await banco.estadoFotos.add({ chave, valor })
      return valor
    })
  }

  async function enfileirar(fotoId: Id): Promise<void> {
    if (!await banco.fila.where('registroId').equals(fotoId).first()) {
      await banco.fila.add({ tabela: 'fotos', registroId: fotoId, criadoEm: new Date().toISOString(), versao: 0 })
    }
  }

  async function guardarProtecao(protecao: ProtecaoFoto): Promise<void> {
    const id = chaveDaProtecao(protecao)
    const existente = await banco.protecoesFotos.get(id)
    if (existente?.liberar) throw new Error('Geração de proteção já encerrada localmente')
    await banco.protecoesFotos.put({ ...protecao, id })
  }

  async function registrarEnvio(fotoId: Id, protecao: ProtecaoFoto): Promise<void> {
    await banco.transaction('rw', tabelas, async () => {
      const foto = await banco.fotos.get(fotoId)
      if (!foto || foto.copiaId !== protecao.copiaId || foto.sha256 !== protecao.sha256) throw new Error('Registro de foto divergente')
      await guardarProtecao(protecao)
      await banco.fotos.put({ ...foto, registrada: true, caminho: protecao.caminho })
    })
  }

  async function capturarProduto(cadastro: ProdutoLocal): Promise<EnvioProdutoFoto> {
    return banco.transaction('rw', banco.enviosProdutoFoto, async () => {
      const existente = (await banco.enviosProdutoFoto.where('produtoId').equals(cadastro.id).toArray())
        .find((item) => conteudoDoEfeito(item.cadastro) === conteudoDoEfeito(cadastro))
      if (existente) return existente
      const envio = { id: uuidv7(), produtoId: cadastro.id, cadastro }
      await banco.enviosProdutoFoto.add(envio)
      return envio
    })
  }

  /** Produto e proteção recebidos se tornam duráveis antes de qualquer reconciliação/liberação. */
  async function receberProduto(produto: ProdutoLocal, protecao?: ProtecaoFoto): Promise<void> {
    await banco.transaction('rw', tabelas, async () => {
      if (!await banco.categorias.get(produto.categoriaId)) throw new Error('Produto remoto sem categoria')
      const local = await banco.produtos.get(produto.id)
      const restaurando = !!await banco.controleCopia.get('restauracao')
      const origem = await banco.controleCopia.get(`registro:produtos/${produto.id}`)
      const copiado = origem && 'conteudo' in origem && origem.conteudo === conteudoDoEfeito(local)
      const remotoVence = !local || local.atualizadoEm < produto.atualizadoEm || (restaurando && copiado && local.atualizadoEm === produto.atualizadoEm)
      if (remotoVence) {
        await banco.produtos.put(restaurando && copiado ? produto : produtoRecebido(local, produto))
        if (restaurando) {
          const fila = await banco.fila.where('registroId').equals(produto.id).and((i) => i.tabela === 'produtos').first()
          if (fila) await banco.fila.delete(fila.ordem)
          for (const e of await banco.enviosProdutoFoto.where('produtoId').equals(produto.id).toArray()) {
            if (e.cadastro.atualizadoEm <= produto.atualizadoEm) await banco.enviosProdutoFoto.delete(e.id)
          }
        }
      }
      else await banco.produtos.put(produtoRecebido(local, produto))
      if (!protecao) return
      if (protecao.fotoId !== produto.fotoId) throw new Error('Proteção não corresponde à intenção do cadastro')
      await guardarProtecao(protecao)
      const foto = await banco.fotos.get(protecao.fotoId)
      if (foto && foto.sha256 !== protecao.sha256) throw new Error('Identidade de foto com conteúdo divergente')
      // Um envio local conserva sua localização até o próprio desfecho; o remoto não o apaga.
      if (foto?.binario) {
        if (restaurando) await banco.fotos.put({ ...foto, copiaId: protecao.copiaId, caminho: protecao.caminho,
          geracaoReferencia: protecao.geracao, registrada: true, situacao: protecao.disponivel ? 'disponivel' : foto.situacao })
        else if (foto.copiaId === protecao.copiaId) await banco.fotos.put({ ...foto, geracaoReferencia: protecao.geracao })
      } else {
        const { fotoId, aparelhoId: _aparelho, geracao, disponivel, ...arquivo } = protecao
        await banco.fotos.put({ ...foto, ...arquivo, id: fotoId, produtoId: produto.id,
          cadastroEm: produto.atualizadoEm, geracaoEnvio: foto?.geracaoEnvio ?? geracao,
          geracaoReferencia: geracao, situacao: disponivel ? 'disponivel' : 'pendente', dispensada: false })
      }
      if (!protecao.disponivel || !foto?.miniatura) await enfileirar(protecao.fotoId)
    })
  }

  async function emUso(fotoId: Id): Promise<boolean> {
    return (await banco.produtos.toArray()).some((p) => p.fotoId === fotoId) ||
      (await banco.enviosProdutoFoto.toArray()).some((e) => e.cadastro.fotoId === fotoId) ||
      await banco.usosFotos.where('fotoId').equals(fotoId).count() > 0
  }

  async function concluirFoto(fotoId: Id, desfecho: 'publicada' | 'superada'): Promise<boolean> {
    return banco.transaction('rw', tabelas, async () => {
      const foto = await banco.fotos.get(fotoId)
      if (!foto) throw new Error('Conclusão de foto sem registro local')
      if (desfecho === 'superada' && await emUso(fotoId)) return false
      await banco.fotos.put({ ...foto, binario: undefined, situacao: desfecho === 'publicada' ? 'disponivel' : 'superada' })
      const fila = await banco.fila.where('registroId').equals(fotoId).first()
      if (fila?.tabela === 'fotos') await banco.fila.delete(fila.ordem)
      return true
    })
  }

  async function superarAntesDoRegistro(fotoId: Id): Promise<boolean> {
    return banco.transaction('rw', tabelas, async () => {
      const foto = await banco.fotos.get(fotoId)
      if (!foto || foto.registrada || await emUso(fotoId)) return false
      return concluirFoto(fotoId, 'superada')
    })
  }

  async function guardarMiniatura(fotoId: Id, copiaId: Id, miniatura: Uint8Array): Promise<void> {
    await banco.transaction('rw', banco.fotos, banco.fila, async () => {
      const foto = await banco.fotos.get(fotoId)
      if (!foto || foto.copiaId !== copiaId || foto.binario) return
      await banco.fotos.put({ ...foto, miniatura })
      const fila = await banco.fila.where('registroId').equals(fotoId).first()
      if (fila?.tabela === 'fotos') await banco.fila.delete(fila.ordem)
    })
  }

  async function reterReferencia(fotoId: Id): Promise<Id> {
    return banco.transaction('rw', banco.fotos, banco.usosFotos, banco.controleCopia, banco.protecoesFotos, banco.estadoFotos, async () => {
      const foto = await banco.fotos.get(fotoId)
      if (!foto || foto.dispensada) throw new Error('Referência indisponível para edição')
      const restauracao = await banco.controleCopia.get('restauracao')
      if (restauracao) {
        const aparelho = await banco.estadoFotos.get('aparelho')
        const protegida = await banco.protecoesFotos.where('fotoId').equals(fotoId)
          .and((p) => p.aparelhoId === aparelho?.valor && !p.liberar).first()
        if (!protegida) throw new Error('A foto da cópia ainda aguarda proteção neste aparelho')
      }
      const id = uuidv7()
      await banco.usosFotos.add({ id, fotoId })
      return id
    })
  }

  async function planejarLiberacoes(remotas: readonly ProtecaoFoto[]): Promise<readonly ProtecaoFotoLocal[]> {
    return banco.transaction('rw', tabelas, async () => {
      const necessarias = new Set((await banco.produtos.toArray()).flatMap((p) => p.fotoId ? [p.fotoId] : []))
      for (const envio of await banco.enviosProdutoFoto.toArray()) if (envio.cadastro.fotoId) necessarias.add(envio.cadastro.fotoId)
      for (const uso of await banco.usosFotos.toArray()) necessarias.add(uso.fotoId)
      const fotos = await banco.fotos.toArray()
      for (const foto of fotos) if (foto.binario) necessarias.add(foto.id)
      const liberacoes: ProtecaoFotoLocal[] = []
      const leitura = await banco.estadoFotos.get('leitura')
      for (const remota of remotas) {
        const id = chaveDaProtecao(remota)
        const existente = await banco.protecoesFotos.get(id)
        const foto = fotos.find((item) => item.id === remota.fotoId)
        const geracao = foto?.geracaoReferencia ?? foto?.geracaoEnvio
        const substituta = foto && remotas.find((item) => item.fotoId === foto.id && item.copiaId === foto.copiaId && item.geracao === geracao)
        const provaSubstituta = substituta && await banco.protecoesFotos.get(chaveDaProtecao(substituta))
        const redundante = provaSubstituta && !provaSubstituta.liberar && substituta && chaveDaProtecao(substituta) !== id
        if (existente?.liberar || !necessarias.has(remota.fotoId) || redundante) {
          const marcada = { ...remota, id, liberar: true }
          await banco.protecoesFotos.put(marcada)
          liberacoes.push(marcada)
          // Reutilizar a geração nas consultas normais evita crescer uma proteção por minuto.
          // Só girar antes de encerrar uma geração que ainda seria usada numa nova leitura.
          if (remota.geracao === leitura?.valor) await banco.estadoFotos.delete('leitura')
        }
      }
      for (const foto of fotos) {
        if (necessarias.has(foto.id)) continue
        await banco.fotos.put({ ...foto, dispensada: true })
        const fila = await banco.fila.where('registroId').equals(foto.id).first()
        if (fila?.tabela === 'fotos') await banco.fila.delete(fila.ordem)
      }
      return liberacoes
    })
  }

  return { aparelhoId: () => identidade('aparelho'), geracaoLeitura: () => identidade('leitura'), registrarEnvio,
    capturarProduto, receberProduto, concluirFoto, superarAntesDoRegistro, guardarMiniatura, reterReferencia,
    liberarUso: (id: Id) => banco.usosFotos.delete(id),
    concluirProduto: (id: Id) => banco.enviosProdutoFoto.delete(id),
    concluirLiberacao: (protecao: ProtecaoFoto) => banco.protecoesFotos.delete(chaveDaProtecao(protecao)),
    planejarLiberacoes,
    fotos: () => banco.fotos.toArray(),
    lerMiniatura: async (fotoId: Id) => (await banco.fotos.get(fotoId))?.miniatura,
  }
}

/** Porta local de fotos para o motor e os consumidores de cadastro; não expõe nenhuma chamada de rede. */
export type RepositorioFotos = ReturnType<typeof criarRepositorioFotos>
