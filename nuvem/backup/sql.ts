import type { SQL } from 'bun'
import { exigirCopia } from '../../src/dados/formato-copia.ts'
import type { RpcBackup } from './captura.ts'

/** Adaptador do instrumento Bun para as mesmas RPCs do Edge; somente SQL parametrizado. */
export function criarRpcBackupSql(sql: SQL): RpcBackup {
  return async (nome, p) => {
    const texto = (chave: string) => { const v = p[chave]; exigirCopia(typeof v === 'string'); return v }
    const inteiro = (chave: string) => { const v = p[chave]; exigirCopia(typeof v === 'number' && Number.isSafeInteger(v)); return v }
    const lista = (chave: string) => { const v = p[chave]; exigirCopia(Array.isArray(v) && v.every((h: unknown) => typeof h === 'string')); return sql.array(v, 'TEXT') }
    let linhas: { r: unknown }[]
    switch (nome) {
      case 'obter_autorizacao_backup': linhas = await sql`select public.obter_autorizacao_backup() r`; break
      case 'atualizar_renovacao_backup': linhas = await sql`select public.atualizar_renovacao_backup(${texto('conta')}::uuid,${texto('anterior')},${texto('renovacao')}) r`; break
      case 'capturar_backup_servidor': linhas = await sql`select public.capturar_backup_servidor(${texto('conta')}::uuid,${texto('captura')}::uuid,${texto('destino')},${texto('agora')}::timestamptz) r`; break
      case 'proxima_captura_backup': linhas = await sql`select public.proxima_captura_backup(${texto('conta')}::uuid) r`; break
      case 'ler_captura_backup': linhas = await sql`select public.ler_captura_backup(${texto('conta')}::uuid,${texto('captura')}::uuid,${texto('tabela')},${inteiro('inicio')},${inteiro('limite')}) r`; break
      case 'consultar_upload_backup': linhas = await sql`select public.consultar_upload_backup(${texto('conta')}::uuid,${texto('captura')}::uuid) r`; break
      case 'reservar_pasta_backup': linhas = await sql`select public.reservar_pasta_backup(${texto('conta')}::uuid,${texto('destino')},${texto('pasta')}) r`; break
      case 'registrar_upload_backup': {
        const sessao = p['sessao']; exigirCopia(sessao === null || typeof sessao === 'string')
        linhas = await sql`select public.registrar_upload_backup(${texto('conta')}::uuid,${texto('captura')}::uuid,${texto('arquivo')},${texto('pasta')},${sessao},${texto('tamanho')},${texto('sha256')},${lista('material')},${lista('exclusivos')}) r`; break
      }
      case 'confirmar_backup': linhas = await sql`select public.confirmar_backup(${texto('conta')}::uuid,${texto('captura')}::uuid,${texto('arquivo')},${texto('tamanho')},${texto('sha256')}) r`; break
      case 'planejar_rotacao_backup': linhas = await sql`select public.planejar_rotacao_backup(${texto('conta')}::uuid) r`; break
      case 'concluir_rotacao_backup': linhas = await sql`select public.concluir_rotacao_backup(${texto('conta')}::uuid,${texto('captura')}::uuid,${texto('arquivo')}) r`; break
      default: throw new Error('RPC fora do instrumento de backup')
    }
    exigirCopia(linhas.length === 1)
    return linhas[0]?.r ?? null
  }
}
