import { criarTransporteBackup } from './transporte.ts'
import { criarHandlerBackup } from './emissor.ts'
import { criarHandlerBackupAparelho } from './aparelho.ts'

const api = (Deno.env.get('SUPABASE_URL') ?? '').replace(/\/$/, '')
const transporte = criarTransporteBackup(api, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '')
const destino = api === 'http://kong:8000' ? 'http://127.0.0.1:54321' : api
const handler = criarHandlerBackup({ ...transporte, destino,
  hashToken: Deno.env.get('BACKUP_TOKEN_SHA256') ?? '', agora: () => new Date().toISOString() })
const aparelho = criarHandlerBackupAparelho({ ...transporte, destino })
Deno.serve((req) => new URL(req.url).pathname.endsWith('/aparelho') ? aparelho(req) : handler(req))
