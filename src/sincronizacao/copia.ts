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
  async function prepararExportacao(estagioId: string, conta: VinculoConta, automatico: boolean) {
    const captura = await repo.lerEstagio(estagioId)
    exigirCopia(captura.estagio.tipo === 'exportacao' && !!captura.estagio.aparelhoId === automatico &&
      mesmoVinculo(captura.estagio.vinculo, conta), 'conta')
    if (!captura.estagio.pronto) {
      for (const foto of fotosNecessariasCopia(captura.dados)) {
        let binario = foto.binario
        if (!binario) {
          exigirCopia(nuvem?.fotos && foto.caminho, 'foto')
          const resposta = await nuvem.fotos.baixar(foto.caminho)
          exigirCopia(resposta.ok, 'foto'); binario = resposta.valor
        }
        exigirCopia(binario.byteLength === foto.bytes && await hashDaFoto(binario) === foto.sha256, 'foto')
        if (!foto.binario || (!automatico && !foto.miniatura)) {
          const miniatura = automatico ? foto.miniatura : foto.miniatura ?? await miniaturizar(binario)
          await repo.completarFoto(estagioId, foto.id, binario, miniatura)
        }
      }
      await repo.concluirCaptura(estagioId)
    }
    return repo.lerEstagio(estagioId)
  }
  async function exportar(id?: string): Promise<{ id: string; arquivo: Blob; nome: string }> {
    const conta = await vinculo()
    const estagioId = id ?? await repo.capturar(conta)
    const completa = await prepararExportacao(estagioId, conta, false)
    const { criarArquivoCopia } = await import('../plataforma/arquivo-copia.ts')
    return { id: estagioId, arquivo: await criarArquivoCopia(completa.estagio, completa.dados),
      nome: `fichinhas-${completa.estagio.capturadoEm.slice(0, 10)}.zip` }
  }
  async function importar(arquivo: Blob, id: string): Promise<void> {
    const conta = await vinculo()
    const { lerArquivoCopia } = await import('../plataforma/arquivo-copia.ts')
    const validada = await lerArquivoCopia(arquivo, conta, miniaturizar)
    await repo.prepararImportacao(id, conta, validada.capturadoEm, validada.dados)
    await repo.publicar(id, conta)
    aoPublicar()
  }
  async function retomarImportacao(id: string): Promise<void> { await repo.publicar(id, await vinculo()); aoPublicar() }
  return { exportar, importar, retomarImportacao, vinculo, prepararBackup: (id: string, conta: VinculoConta) => prepararExportacao(id, conta, true),
    reservarImportacao: repo.reservarImportacao,
    descartar: repo.descartar, listar: repo.listar, restauracao: repo.restauracao }
}
