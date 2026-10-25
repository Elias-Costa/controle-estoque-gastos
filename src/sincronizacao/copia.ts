import type { BancoLocal } from '../dados/banco.ts'
import { exigirCopia } from '../dados/formato-copia.ts'
import { criarRepositorioCopia, fotosNecessariasCopia, mesmoVinculo, vincularContaCopia } from '../dados/repositorio-copia.ts'
import { hashDaFoto, miniaturaDaFoto } from '../plataforma/fotos.ts'
import type { VinculoConta } from '../dados/tipos-copia.ts'
import type { Nuvem } from './nuvem.ts'

/** Orquestra arquivo/fotos fora das transações; a venda não conhece este serviço (RI-02). */
export function criarServicoCopia(banco: BancoLocal, nuvem: Nuvem | null, aoPublicar: () => void = () => undefined,
  miniaturizar = miniaturaDaFoto) {
  const repo = criarRepositorioCopia(banco)
  async function vinculo(): Promise<VinculoConta> {
    const sessao = await nuvem?.identidade?.()
    if (sessao) await vincularContaCopia(banco, sessao)
    const atual = await repo.vinculo()
    exigirCopia(atual, 'entrar')
    return atual
  }
  async function exportar(id?: string): Promise<{ id: string; arquivo: Blob; nome: string }> {
    const conta = await vinculo()
    const estagioId = id ?? await repo.capturar(conta)
    const captura = await repo.lerEstagio(estagioId)
    exigirCopia(captura.estagio.tipo === 'exportacao' && mesmoVinculo(captura.estagio.vinculo, conta), 'conta')
    if (!captura.estagio.pronto) {
      for (const foto of fotosNecessariasCopia(captura.dados)) {
        let binario = foto.binario
        if (!binario) {
          exigirCopia(nuvem?.fotos && foto.caminho, 'foto')
          const resposta = await nuvem.fotos.baixar(foto.caminho)
          exigirCopia(resposta.ok, 'foto'); binario = resposta.valor
        }
        exigirCopia(binario.byteLength === foto.bytes && await hashDaFoto(binario) === foto.sha256, 'foto')
        if (!foto.binario || !foto.miniatura) await repo.completarFoto(estagioId, foto.id, binario, foto.miniatura ?? await miniaturizar(binario))
      }
      await repo.concluirCaptura(estagioId)
    }
    const completa = await repo.lerEstagio(estagioId)
    const { criarArquivoCopia } = await import('../plataforma/arquivo-copia.ts')
    return { id: estagioId, arquivo: await criarArquivoCopia(completa.estagio, completa.dados),
      nome: `fichinhas-${completa.estagio.capturadoEm.slice(0, 10)}.zip` }
  }
  async function importar(arquivo: Blob, id: string): Promise<void> {
    const conta = await vinculo()
    const { lerArquivoCopia } = await import('../plataforma/arquivo-copia.ts')
    const validada = await lerArquivoCopia(arquivo, conta)
    await repo.prepararImportacao(id, conta, validada.capturadoEm, validada.dados)
    await repo.publicar(id, conta)
    aoPublicar()
  }
  async function retomarImportacao(id: string): Promise<void> { await repo.publicar(id, await vinculo()); aoPublicar() }
  return { exportar, importar, retomarImportacao, vinculo, reservarImportacao: repo.reservarImportacao,
    descartar: repo.descartar, listar: repo.listar, restauracao: repo.restauracao }
}
