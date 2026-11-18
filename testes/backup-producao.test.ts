import { describe, expect, test } from 'bun:test'
import { exigirDestinoDeTeste } from '../nuvem/ambiente-de-teste.ts'
import { exigirDestinoConfiguracaoBackup, ORIGEM_BACKUP_PRODUCAO, validarContaBackup } from '../nuvem/backup/destino.ts'
import { comandoBackupProducao } from '../nuvem/backup/producao.ts'
import { lerAutorizacaoGoogle } from '../nuvem/backup/cofre-google.ts'
import { FalhaGoogle, lerClienteGoogle, PROJETO_GOOGLE_DE_PRODUCAO } from '../nuvem/backup/google.ts'
import { criarTransporteBackup } from '../nuvem/backup/transporte.ts'
import { criarHandlerBackup } from '../nuvem/backup/emissor.ts'
import { hashDaFoto } from '../src/plataforma/fotos.ts'
import { autorizacaoGoogleFicticia, autorizacaoProducaoFicticia, clienteGoogleFicticio } from './fixtures/backup-google.ts'

const PROJETO = 'awmesexptpalzonbucwc', CONTA = autorizacaoProducaoFicticia.contaId
const BANCO = `postgresql://postgres.${PROJETO}:senha-ficticia@aws-0-sa-east-1.pooler.supabase.com:5432/postgres`

describe('D-085 produção — formato/guardas sem conexão ao projeto real', () => {
  test('entradas fechadas exigem projeto, UUID nas ações Google e JSON só ao consentir', () => {
    for (const acao of ['preparar', 'agendar'] as const) expect(comandoBackupProducao([acao, `--projeto=${PROJETO}`])).toEqual({ acao, projeto: PROJETO })
    for (const acao of ['autorizar', 'reautorizar'] as const) {
      expect(comandoBackupProducao([acao, `--projeto=${PROJETO}`, `--conta=${CONTA}`, 'C:\\privado\\cliente.json'])).toEqual({ acao, projeto: PROJETO, contaId: CONTA, caminho: 'C:\\privado\\cliente.json' })
    }
    expect(comandoBackupProducao(['verificar', `--projeto=${PROJETO}`, `--conta=${CONTA}`])).toEqual({ acao: 'verificar', projeto: PROJETO, contaId: CONTA })
    for (const argumentos of [[], ['preparar'], ['migrar', `--projeto=${PROJETO}`], ['agendar', `--projeto=${PROJETO}`, '--extra'],
      ['autorizar', `--projeto=${PROJETO}`, `--conta=${CONTA}`], ['verificar', `--projeto=${PROJETO}`, `--conta=${CONTA}`, 'extra'],
      ['autorizar', `--projeto=${PROJETO}`, `--conta=${CONTA}`, '--conta=outra'], ['verificar', `--projeto=${PROJETO}`, '--conta=invalidade']]) {
      expect(() => comandoBackupProducao(argumentos)).toThrow(FalhaGoogle)
    }
    expect(validarContaBackup(CONTA.toUpperCase())).toBe(CONTA)
  })

  test('guarda D-081 reutilizada recusa misturas e mantém produção fora das suítes', () => {
    const campos = ['AMBIENTE_DE_TESTE', 'INTEGRACAO', 'VITE_LABORATORIO', 'VITE_SUPABASE_URL', 'SUPABASE_DB_URL']
    const anteriores = campos.map((c) => process.env[c])
    try {
      for (const c of campos) delete process.env[c]
      process.env.VITE_SUPABASE_URL = ORIGEM_BACKUP_PRODUCAO; process.env.SUPABASE_DB_URL = BANCO
      expect(exigirDestinoConfiguracaoBackup(PROJETO)).toBe('producao')
      expect(() => exigirDestinoConfiguracaoBackup()).toThrow('Produção não recebe suítes')
      for (const c of campos.slice(0, 3)) {
        process.env[c] = '1'
        expect(() => exigirDestinoConfiguracaoBackup(PROJETO)).toThrow('variáveis de teste')
        delete process.env[c]
      }
      for (const [projeto, api, banco] of [
        ['outroprojetodiferente', ORIGEM_BACKUP_PRODUCAO, BANCO], [PROJETO, 'http://127.0.0.1:54321', BANCO],
        [PROJETO, ORIGEM_BACKUP_PRODUCAO + '.fraude.test', BANCO], [PROJETO, ORIGEM_BACKUP_PRODUCAO, BANCO.replace(':5432/', ':6543/')],
      ]) {
        process.env.VITE_SUPABASE_URL = api; process.env.SUPABASE_DB_URL = banco
        expect(() => exigirDestinoConfiguracaoBackup(projeto)).toThrow(FalhaGoogle)
      }
      process.env.AMBIENTE_DE_TESTE = 'producao'
      expect(() => exigirDestinoDeTeste()).toThrow('Produção não recebe suítes')
    } finally {
      campos.forEach((c, i) => { const valor = anteriores[i]; if (valor === undefined) delete process.env[c]; else process.env[c] = valor })
    }
  })

  test('cliente e autorização não atravessam ambiente, origem ou projeto Google', () => {
    const desktop = { installed: { ...clienteGoogleFicticio.installed, project_id: PROJETO_GOOGLE_DE_PRODUCAO } }
    expect(lerClienteGoogle(desktop, PROJETO_GOOGLE_DE_PRODUCAO)).toEqual(autorizacaoProducaoFicticia.cliente)
    expect(() => lerClienteGoogle(desktop)).toThrow(FalhaGoogle)
    expect(() => lerClienteGoogle(clienteGoogleFicticio, PROJETO_GOOGLE_DE_PRODUCAO)).toThrow(FalhaGoogle)
    expect(() => lerClienteGoogle({ installed: { ...desktop.installed, project_id: 'outro' } }, 'outro')).toThrow(FalhaGoogle)
    expect(lerAutorizacaoGoogle(autorizacaoProducaoFicticia)).toEqual(autorizacaoProducaoFicticia)
    for (const parte of [{ destino: autorizacaoGoogleFicticia.destino }, { ambiente: 'homologacao' }, { cliente: autorizacaoGoogleFicticia.cliente }]) {
      expect(() => lerAutorizacaoGoogle({ ...autorizacaoProducaoFicticia, ...parte })).toThrow(FalhaGoogle)
    }
  })

  test('transporte usa somente RPCs do cofre definitivo na origem confirmada', async () => {
    const chamadas: string[] = []
    const t = criarTransporteBackup(ORIGEM_BACKUP_PRODUCAO, 'chave-ficticia', async (url) => { chamadas.push(url); return Response.json({}) })
    await t.rpc('obter_autorizacao_backup', {})
    await t.rpc('atualizar_renovacao_backup', {})
    await t.rpc('consultar_upload_backup', {})
    expect(chamadas.map((c) => new URL(c).pathname)).toEqual([
      '/rest/v1/rpc/obter_autorizacao_backup_producao', '/rest/v1/rpc/atualizar_renovacao_backup_producao', '/rest/v1/rpc/consultar_upload_backup',
    ])
    await expect(t.rpc('qualquer_funcao', {})).rejects.toThrow()
    expect(chamadas).toHaveLength(3)
    expect(() => criarTransporteBackup(ORIGEM_BACKUP_PRODUCAO + '.fraude.test', 'chave-ficticia')).toThrow()
    const teste = criarTransporteBackup('http://127.0.0.1:54321', 'chave-ficticia', async (url) => { chamadas.push(url); return Response.json({}) })
    await teste.rpc('obter_autorizacao_backup', {})
    expect(chamadas.at(-1)).toBe('http://127.0.0.1:54321/rest/v1/rpc/obter_autorizacao_backup')
  })

  test('saúde não confirma autorização de outro destino nem faz chamadas Google', async () => {
    const token = 'a'.repeat(64), hashToken = await hashDaFoto(new TextEncoder().encode(token))
    let autorizacao = autorizacaoProducaoFicticia, chamadas = 0
    const handler = criarHandlerBackup({ destino: ORIGEM_BACKUP_PRODUCAO, hashToken, agora: () => '2026-11-18T14:00:00Z',
      baixarOriginal: async () => { throw new Error('Não deveria ler fotos') },
      rpc: async (nome) => { expect(nome).toBe('obter_autorizacao_backup'); chamadas++; return autorizacao } })
    const pedido = () => new Request('https://servidor-ficticio.example', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{"verificar":true}' })
    expect((await handler(pedido())).status).toBe(200)
    autorizacao = autorizacaoGoogleFicticia
    const recusada = await handler(pedido())
    expect(recusada.status).toBe(503)
    expect(await recusada.text()).not.toContain(autorizacaoGoogleFicticia.renovacao)
    expect(chamadas).toBe(2)
  })
})
