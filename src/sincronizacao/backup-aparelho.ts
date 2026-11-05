import type { BancoLocal } from '../dados/banco.ts'
import { exigirCopia, objetoCopia } from '../dados/formato-copia.ts'
import { criarRepositorioCopia, vincularContaCopia } from '../dados/repositorio-copia.ts'
import type { BackupConfirmado, VinculoConta } from '../dados/tipos-copia.ts'
import { hashDaFoto } from '../plataforma/fotos.ts'
import { diaDoBackup, sessaoDoDrive, type PedidoBackupAparelho } from '../plataforma/protocolo-backup.ts'
import type { criarServicoCopia } from './copia.ts'

const BLOCO = 4 * 1024 * 1024

function lerConfirmada(v: unknown): BackupConfirmado {
  exigirCopia(objetoCopia(v))
  const origem = v['origem'], capturadoEm = v['capturadoEm']
  exigirCopia((origem === 'servidor' || origem === 'aparelho') && typeof capturadoEm === 'string' && Number.isFinite(Date.parse(capturadoEm)))
  return { origem, capturadoEm }
}

async function enviarBloco(url: string, arquivo: Blob, inicio: number): Promise<number> {
  const fim = Math.min(inicio + BLOCO, arquivo.size)
  // Chromium expõe o 308 sem Location e o Range pelo CORS do Drive (sonda BA-03).
  const resposta = await fetch(url, { method: 'PUT', credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(45_000),
    headers: { 'content-type': 'application/zip', 'content-range': `bytes ${inicio}-${fim - 1}/${arquivo.size}` },
    body: arquivo.slice(inicio, fim) })
  await resposta.body?.cancel()
  exigirCopia(!resposta.redirected && (resposta.url === '' || resposta.url === url))
  if (resposta.status === 200 || resposta.status === 201) { exigirCopia(fim === arquivo.size); return fim }
  const parte = /^bytes=0-(\d+)$/.exec(resposta.headers.get('range') ?? '')?.[1]
  exigirCopia(resposta.status === 308 && parte !== undefined)
  const proximo = Number(parte) + 1
  exigirCopia(Number.isSafeInteger(proximo) && proximo > inicio && proximo <= fim)
  return proximo
}

/** RF-30: captura/retomada diária em primeiro plano, independente das operações de negócio. */
export function criarBackupAparelho(banco: BancoLocal, copia: Pick<ReturnType<typeof criarServicoCopia>, 'prepararBackup'>, portas: {
  readonly identidade: () => Promise<VinculoConta | null>
  readonly pedir: (pedido: PedidoBackupAparelho) => Promise<unknown>
  readonly ativo: () => boolean
  readonly agora?: () => Date
}) {
  const repo = criarRepositorioCopia(banco)
  let executando = false
  async function acordar(): Promise<void> {
    if (executando || !portas.ativo()) return
    executando = true
    let id: string | null = null
    try {
      const conta = await portas.identidade()
      if (!conta || !portas.ativo()) return
      const estado = await portas.pedir({ acao: 'estado' })
      if (!objetoCopia(estado) || estado['estado'] !== 'configuracao' || estado['habilitado'] !== true || !portas.ativo()) return
      await vincularContaCopia(banco, conta)
      if (estado['ultima'] !== null) await repo.guardarUltimoBackup(lerConfirmada(estado['ultima']))
      const instante = portas.agora?.() ?? new Date()
      id = await repo.reservarBackup(conta, diaDoBackup(instante), instante)
      if (!id || !portas.ativo()) return
      await repo.marcarFalhaBackup(id, false)
      const { estagio, dados } = await copia.prepararBackup(id, conta)
      const aparelho = estagio.aparelhoId
      exigirCopia(aparelho)
      if (!portas.ativo()) return
      const [{ criarArquivoBackup }, { indexarMaterialBackup }] = await Promise.all([
        import('../plataforma/arquivo-copia.ts'), import('../plataforma/material-backup.ts'),
      ])
      const arquivo = await criarArquivoBackup(estagio, dados, { tipo: 'aparelho', aparelhoId: aparelho })
      const sha256 = await hashDaFoto(new Uint8Array(await arquivo.arrayBuffer()))
      const indice = await indexarMaterialBackup(dados)
      if (!portas.ativo()) return
      let resposta = await portas.pedir({ acao: 'abrir', captura: id, aparelho, instante: estagio.capturadoEm,
        tamanho: arquivo.size, sha256, ...indice })
      exigirCopia(objetoCopia(resposta))
      if (resposta['estado'] === 'enviando') {
        const sessao = resposta['sessao']
        const inicio = resposta['posicao']
        exigirCopia(typeof sessao === 'string' && typeof inicio === 'number' &&
          Number.isSafeInteger(inicio) && inicio >= 0 && inicio <= arquivo.size)
        const url = sessaoDoDrive(sessao)
        let posicao = inicio
        while (posicao < arquivo.size) {
          if (!portas.ativo()) return
          try { posicao = await enviarBloco(url, arquivo, posicao) }
          catch (erro) {
            if (posicao + BLOCO < arquivo.size) throw erro
            // O Drive pode guardar o último bloco sem devolver uma resposta legível ao browser.
            // A confirmação abaixo consulta tamanho/hash do arquivo salvo antes de declarar sucesso.
            break
          }
        }
        if (!portas.ativo()) return
        resposta = await portas.pedir({ acao: 'confirmar', captura: id, aparelho })
      }
      exigirCopia(objetoCopia(resposta) && resposta['estado'] === 'pronta')
      const confirmada = lerConfirmada(resposta['confirmada'])
      exigirCopia(confirmada.origem === 'aparelho' && Date.parse(confirmada.capturadoEm) === Date.parse(estagio.capturadoEm))
      await repo.concluirBackup(id, confirmada)
    } catch {
      // Uma resposta perdida não solta o estágio nem a foto. A próxima abertura consulta a mesma candidata.
      if (id && portas.ativo()) await repo.marcarFalhaBackup(id, true).catch(() => undefined)
    } finally { executando = false }
  }
  return { acordar }
}
