import { executarBackupServidor, type EtapaBackupServidor, type PortasBackupServidor } from './servidor.ts'
import { lerAutorizacaoGoogle } from './cofre-google.ts'
import { FalhaDrive } from './drive.ts'
import { FalhaTransporteBackup } from './transporte.ts'
import { ErroCopia } from '../../src/dados/formato-copia.ts'
import { hashDaFoto } from '../../src/plataforma/fotos.ts'

/** Token próprio do serviço; não reutiliza material nem jobs de lembretes (D-084). */
export function criarHandlerBackup(portas: PortasBackupServidor & { readonly hashToken: string; readonly agora: () => string }) {
  return async (req: Request): Promise<Response> => {
    const inicio = performance.now()
    const token = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.get('authorization') ?? '')?.[1]
    if (!/^[a-f0-9]{64}$/.test(portas.hashToken) || !token || await hashDaFoto(new TextEncoder().encode(token)) !== portas.hashToken) {
      return Response.json({ erro: 'nao_autorizado' }, { status: 401 })
    }
    if (req.method !== 'POST') return Response.json({ erro: 'metodo_invalido' }, { status: 405 })
    let corpo: unknown
    try { const texto = await req.text(); if (texto.length > 256) throw new Error(); corpo = JSON.parse(texto) }
    catch { return Response.json({ erro: 'pedido_invalido' }, { status: 400 }) }
    if (typeof corpo !== 'object' || corpo === null || Array.isArray(corpo) ||
      Object.keys(corpo).some((k) => k !== 'verificar') || ('verificar' in corpo && corpo.verificar !== true)) {
      return Response.json({ erro: 'pedido_invalido' }, { status: 400 })
    }
    let etapa: EtapaBackupServidor | 'configuracao' = 'configuracao'
    try {
      if ('verificar' in corpo) {
        const autorizacao = lerAutorizacaoGoogle(await portas.rpc('obter_autorizacao_backup', {}))
        if (autorizacao.destino !== portas.destino) throw new Error()
        return Response.json({ pronto: true, alcance: 'configuracao_e_banco', arquivosEnviados: 0, segredosImpressos: false })
      }
      const resultado = await executarBackupServidor({ ...portas, aoConsultarPosicao(bytesAceitos) {
        console.info(JSON.stringify({ evento: 'backup_posicao', bytesAceitos }))
        portas.aoConsultarPosicao?.(bytesAceitos)
      }, aoAvancar(avanco) {
        // Registrar a entrada na fase permite localizar até encerramento forçado pelo Edge (BA-04).
        if (etapa !== avanco) console.info(JSON.stringify({ evento: 'backup_etapa', etapa: avanco, decorridoMs: Math.round(performance.now() - inicio) }))
        etapa = avanco
        portas.aoAvancar?.(avanco)
      } }, portas.agora())
      return Response.json({ ...resultado, duracaoMs: Math.round(performance.now() - inicio), segredosImpressos: false })
    } catch (e) {
      // Corpos de erro do Drive/PostgREST podem refletir capacidade de upload ou dados da conta.
      const codigo = e instanceof FalhaDrive ? `drive_${e.status}` : e instanceof FalhaTransporteBackup ? `supabase_${e.status}`
        : e instanceof ErroCopia ? e.motivo : 'interno'
      console.warn(JSON.stringify({ evento: 'backup_nao_concluido', etapa, codigo, segredosImpressos: false }))
      return Response.json({ erro: 'backup_nao_concluido', segredosImpressos: false }, { status: 503 })
    }
  }
}
