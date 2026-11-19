import { criarTransporteBackup } from './transporte.ts'
import { criarHandlerBackup } from './emissor.ts'
import { criarHandlerBackupAparelho } from './aparelho.ts'
import { criarHandlerConexaoGoogle } from './conexao-google.ts'

const api = (Deno.env.get('SUPABASE_URL') ?? '').replace(/\/$/, '')
const destino = api === 'http://kong:8000' ? 'http://127.0.0.1:54321' : api
Deno.serve((req) => {
  const transporte = criarTransporteBackup(api, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '')
  const caminho = new URL(req.url).pathname
  if (caminho.endsWith('/conexao')) return criarHandlerConexaoGoogle({ ...transporte, destino })(req)
  if (caminho.endsWith('/aparelho')) return criarHandlerBackupAparelho({ ...transporte, destino })(req)
  return criarHandlerBackup({ ...transporte, destino,
    hashToken: Deno.env.get('BACKUP_TOKEN_SHA256') ?? '', agora: () => new Date().toISOString() })(req)
})
