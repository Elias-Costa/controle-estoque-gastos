import type { AutorizacaoGoogle } from '../../nuvem/backup/cofre-google.ts'
import { PROJETO_GOOGLE_DE_TESTE } from '../../nuvem/backup/google.ts'

/** JSON Desktop fictício; não autoriza nenhuma conta Google real. */
export const clienteGoogleFicticio = { installed: { project_id: PROJETO_GOOGLE_DE_TESTE,
  client_id: '1234567890-ficticio.apps.googleusercontent.com', client_secret: 'segredo-apenas-ficticio',
  auth_uri: 'https://accounts.google.com/o/oauth2/auth', token_uri: 'https://oauth2.googleapis.com/token', redirect_uris: ['http://localhost'] } }
/** Conteúdo fictício para provas de formato/Vault; nunca enviado ao provedor. */
export const autorizacaoGoogleFicticia: AutorizacaoGoogle = { formato: 1, ambiente: 'local', destino: 'http://127.0.0.1:54321',
  contaId: '019a4b25-0000-7000-8000-000000000001', contaGoogleId: '1234567890',
  cliente: { projetoId: PROJETO_GOOGLE_DE_TESTE, clienteId: clienteGoogleFicticio.installed.client_id, segredo: clienteGoogleFicticio.installed.client_secret },
  renovacao: 'token-apenas-ficticio', autorizadoEm: '2026-11-05T12:00:00.000Z' }
