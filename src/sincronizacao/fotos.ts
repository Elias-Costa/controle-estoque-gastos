import type { BancoLocal, ProdutoLocal } from '../dados/banco.ts'
import { criarRepositorioFotos } from '../dados/fotos.ts'
import type { FotoLocal } from '../dados/tipos-fotos.ts'
import { hashDaFoto, miniaturaDaFoto } from '../plataforma/fotos.ts'
import { documentoEstoque, produtoDaNuvem } from './borda-estoque.ts'
import { documentoDaFoto, protecaoDaNuvem, type NuvemFotos } from './nuvem-fotos.ts'
import type { Nuvem, Resposta, LinhaRecebida } from './nuvem.ts'
import { uuidv7 } from '../dados/identidade.ts'

const OK: Resposta<void> = { ok: true, valor: undefined }

/** Ciclo durável de fotos. A rede só roda depois da transação de cadastro e do financeiro. */
export function criarSincronizacaoFotos(banco: BancoLocal, nuvem: Nuvem, transporte: NuvemFotos,
  miniaturizar = miniaturaDaFoto) {
  const repo = criarRepositorioFotos(banco)

  async function registrar(foto: FotoLocal): Promise<Resposta<void>> {
    const resposta = await transporte.rpc('registrar_foto_fila', { documento: documentoDaFoto(foto),
      aparelho_id: await repo.aparelhoId(), geracao: foto.geracaoEnvio })
    if (!resposta.ok) return resposta
    await repo.registrarEnvio(foto.id, protecaoDaNuvem(resposta.valor))
    return OK
  }

  async function enviarProduto(produto: ProdutoLocal): Promise<Resposta<void>> {
    await repo.capturarProduto(produto)
    // Resposta perdida conserva a intenção enviada, mesmo se o cadastro local mudou no intervalo.
    for (const envio of await banco.enviosProdutoFoto.where('produtoId').equals(produto.id).toArray()) {
      const foto = envio.cadastro.fotoId ? await banco.fotos.get(envio.cadastro.fotoId) : undefined
      if (foto?.binario) {
        const r = await registrar(foto)
        if (!r.ok) return r
      }
      const r = await nuvem.enviarProduto(documentoEstoque(envio.cadastro))
      if (!r.ok) return r
      await repo.concluirProduto(envio.id)
    }
    return OK
  }

  async function buscarProdutos(desde: string | null): Promise<Resposta<readonly LinhaRecebida[]>> {
    const geracao = await repo.geracaoLeitura(), aparelho = await repo.aparelhoId()
    const todas: LinhaRecebida[] = []
    for (let inicio = 0; ; inicio += 500) {
      const r = await transporte.rpc('buscar_produtos_fotos', { aparelho_id: aparelho, geracao, desde, inicio, limite: 500 })
      if (!r.ok) return r
      if (!Array.isArray(r.valor)) throw new Error('Produtos sem página protegida')
      for (const linha of r.valor) {
        if (!linha || typeof linha !== 'object') throw new Error('Produto protegido malformado')
        todas.push({ ...linha })
      }
      if (r.valor.length < 500) return { ok: true, valor: todas }
    }
  }

  async function receberProduto(linha: LinhaRecebida): Promise<void> {
    const ref = linha['foto_referencia']
    await repo.receberProduto(produtoDaNuvem(linha), ref == null ? undefined : protecaoDaNuvem(ref))
  }

  async function conferir(foto: Pick<FotoLocal, 'bytes' | 'sha256'>, bytes: Uint8Array): Promise<void> {
    if (bytes.byteLength !== foto.bytes || await hashDaFoto(bytes) !== foto.sha256) {
      throw new Error('A foto na nuvem não corresponde ao arquivo salvo neste aparelho')
    }
  }

  /** D-071: proteger referências importadas antes de liberar edição, envios ou coleta. */
  async function protegerRestauracao(): Promise<Resposta<void>> {
    const referencias = new Set([...(await banco.produtos.toArray()).flatMap((p) => p.fotoId ? [p.fotoId] : []),
      ...(await banco.enviosProdutoFoto.toArray()).flatMap((e) => e.cadastro.fotoId ? [e.cadastro.fotoId] : []),
      ...(await banco.usosFotos.toArray()).map((u) => u.fotoId)])
    for (const foto of await repo.fotos()) {
      if (!referencias.has(foto.id)) {
        if (foto.binario) await repo.concluirFoto(foto.id, 'superada')
        continue
      }
      let resposta = await registrar(foto)
      // Arquivo antigo pode citar localização já coletada. Bytes íntegros permitem uma
      // cópia física nova, nunca reutilizar caminho encerrado nem mudar identidade lógica.
      if (!resposta.ok && resposta.falha.tipo === 'recusa' && /foto_caminho_encerrado/.test(`${resposta.falha.constraint} ${resposta.falha.mensagem}`) && foto.binario) {
        const nova = await banco.transaction('rw', banco.fotos, async () => {
          const atual = await banco.fotos.get(foto.id)
          if (!atual) throw new Error('Foto restaurada ausente')
          if (atual.copiaId !== foto.copiaId) return atual
          const nova = { ...atual, copiaId: uuidv7(), geracaoEnvio: uuidv7(), caminho: undefined, registrada: false, geracaoReferencia: undefined }
          await banco.fotos.put(nova); return nova
        })
        resposta = await registrar(nova)
      }
      if (!resposta.ok) return resposta
    }
    return OK
  }

  async function ciclo(): Promise<Resposta<void>> {
    for (const foto of await repo.fotos()) {
      if (foto.dispensada) continue
      if (foto.binario) {
        if (await repo.superarAntesDoRegistro(foto.id)) continue
        const registro = await registrar(foto)
        if (!registro.ok) return registro
        const atual = await banco.fotos.get(foto.id)
        if (!atual?.caminho) throw new Error('Envio de foto sem caminho confirmado')
        // Uma publicação pode ter ocorrido antes da resposta se perder. Sem UPDATE no bucket,
        // essa cópia já disponível não aceita outro INSERT: primeiro procurar os bytes existentes.
        let remoto = await transporte.baixar(atual.caminho)
        if (!remoto.ok) {
          const envio = await transporte.enviar(atual.caminho, foto.binario)
          remoto = await transporte.baixar(atual.caminho)
          if (!envio.ok && !remoto.ok) return envio
        }
        // Nem sucesso nem erro de duplicata provam o conteúdo: conferir os bytes reais.
        if (!remoto.ok) return remoto
        await conferir(foto, remoto.valor)
        const publicada = await transporte.rpc('confirmar_arquivo_foto', {
          copia_id: foto.copiaId, sha256: foto.sha256, produto_id: foto.produtoId })
        if (!publicada.ok) return publicada
        if (!publicada.valor || typeof publicada.valor !== 'object') throw new Error('Publicação malformada')
        const documento: Record<string, unknown> = { ...publicada.valor }
        const situacao = documento['situacao']
        if (situacao === 'publicada' || situacao === 'superada') await repo.concluirFoto(foto.id, situacao)
        else if (situacao !== 'aguardando') throw new Error('Publicação sem desfecho válido')
      } else if (foto.situacao === 'disponivel' && !foto.miniatura && foto.caminho) {
        const r = await transporte.baixar(foto.caminho)
        if (!r.ok) return r
        await conferir(foto, r.valor)
        await repo.guardarMiniatura(foto.id, foto.copiaId, await miniaturizar(r.valor))
      }
    }
    const remotas = await transporte.rpc('listar_protecoes_fotos', { aparelho_id: await repo.aparelhoId() })
    if (!remotas.ok) return remotas
    if (!Array.isArray(remotas.valor)) throw new Error('Proteções sem lista')
    for (const protecao of await repo.planejarLiberacoes(remotas.valor.map(protecaoDaNuvem))) {
      const r = await transporte.rpc('liberar_protecao_foto', {
        aparelho_id: protecao.aparelhoId, copia_id: protecao.copiaId, geracao: protecao.geracao })
      if (!r.ok) return r
      await repo.concluirLiberacao(protecao)
    }
    const coleta = await transporte.rpc('autorizar_coleta_fotos', {})
    if (!coleta.ok) return coleta
    if (!Array.isArray(coleta.valor)) throw new Error('Coleta sem tarefas')
    for (const item of coleta.valor) {
      if (!item || typeof item.copiaId !== 'string' || typeof item.caminho !== 'string') throw new Error('Coleta malformada')
      const r = await transporte.apagar(item.caminho)
      if (!r.ok) return r
      const confirmado = await transporte.rpc('confirmar_coleta_foto', { copia_id: item.copiaId })
      if (!confirmado.ok) return confirmado
    }
    return OK
  }
  return { enviarProduto, buscarProdutos, receberProduto, ciclo, protegerRestauracao }
}
