import { criarTransporteBackup } from './transporte.ts'
import { criarHandlerBackup } from './emissor.ts'

const api = (Deno.env.get('SUPABASE_URL') ?? '').replace(/\/$/, '')
const transporte = criarTransporteBackup(api, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '')
const handler = criarHandlerBackup({ ...transporte, destino: api === 'http://kong:8000' ? 'http://127.0.0.1:54321' : api,
  hashToken: Deno.env.get('BACKUP_TOKEN_SHA256') ?? '', agora: () => new Date().toISOString() })
Deno.serve(handler)
