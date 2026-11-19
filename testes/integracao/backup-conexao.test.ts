import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { SQL, type TransactionSQL } from 'bun'
import { exigirDestinoDeTeste } from '../../nuvem/ambiente-de-teste.ts'
import { conectar } from '../../nuvem/migrar.ts'
import { ORIGEM_BACKUP_PRODUCAO } from '../../nuvem/backup/destino.ts'

const LIGADA = process.env.INTEGRACAO === '1'
if (LIGADA) exigirDestinoDeTeste()
let sql: SQL
class Revertida extends Error {}
beforeAll(() => { if (LIGADA) sql = conectar() })
afterAll(async () => { if (LIGADA) await sql.close() })
async function transacao(fn: (tx: TransactionSQL, conta: string) => Promise<void>) {
  try { await sql.begin(async (tx) => {
    const [conta] = await tx<{ id: string }[]>`select id::text from auth.users where email=${process.env.SUPABASE_TESTE_EMAIL ?? ''}`
    if (!conta) throw new Error('Conta fictícia D-050 ausente.')
    await fn(tx, conta.id); throw new Revertida()
  }) } catch (e) { if (!(e instanceof Revertida)) throw e }
}
async function recusar(tx: TransactionSQL, fn: (sp: SQL) => Promise<unknown>, codigo = '23514') {
  let recusou = false
  try { await tx.savepoint(fn) } catch (e) { if (!(e instanceof SQL.PostgresError)) throw e; expect(e.errno).toBe(codigo); recusou = true }
  expect(recusou).toBe(true)
}
async function preparar(tx: TransactionSQL, conta: string) {
  const cliente = { projetoId: 'fichinhas-backup', clienteId: '123456-cliente.apps.googleusercontent.com', segredo: 'cliente-ficticio' }
  const [segredo] = await tx<{ id: string }[]>`select vault.create_secret(${JSON.stringify(cliente)},${`teste-web:${crypto.randomUUID()}`})::text id`
  if (!segredo) throw new Error('Cofre fictício não preparado.')
  // Rótulo de produção fictício no banco D-050, sem HTTP para Google ou produção.
  await tx`insert into backup_interno.clientes_web(ambiente,dono,destino,retorno,segredo_id)
    values('producao',${conta}::uuid,${ORIGEM_BACKUP_PRODUCAO},'https://controle-estoque-gastos.vercel.app/google-drive-retorno.html',${segredo.id}::uuid)`
  return { formato: 2, ambiente: 'producao', destino: ORIGEM_BACKUP_PRODUCAO, contaId: conta, cliente,
    contaGoogleId: 'google-ficticio', renovacao: 'renovacao-ficticia', autorizadoEm: new Date().toISOString(),
    vinculoId: crypto.randomUUID(), emailGoogle: 'drive-ficticio@example.invalid' }
}

describe.skipIf(!LIGADA)('D-085 conexão pelo app — SQL real D-050, credenciais fictícias e rollback', () => {
  test('troca isola pasta/capturas/última confirmação e preserva o catálogo anterior', () => transacao(async (tx, conta) => {
    const antiga = crypto.randomUUID(), nova = crypto.randomUUID()
    await tx`select public.reservar_pasta_backup(${conta}::uuid,${ORIGEM_BACKUP_PRODUCAO},'pasta-antiga')`
    await tx`insert into backup_interno.capturas(id,dono,destino,origem,dia,capturado_em,estado,arquivo_id,pasta_id,tamanho,sha256,confirmado_em)
      values(${antiga}::uuid,${conta}::uuid,${ORIGEM_BACKUP_PRODUCAO},'servidor',(clock_timestamp() at time zone 'America/Fortaleza')::date,
        clock_timestamp(),'pronta','arquivo-antigo','pasta-antiga',1,${'a'.repeat(64)},clock_timestamp())`
    const documento = await preparar(tx, conta)
    await tx`select public.concluir_conexao_google(${conta}::uuid,null,${documento}::jsonb)`
    const pedir = async (nome: string, argumentos: Record<string, unknown>) => (await tx<{ r: unknown }[]>`
      select public.rpc_backup_vinculado(${documento.vinculoId}::uuid,${nome},${{ conta, ...argumentos }}::jsonb) r`)[0]?.r
    expect(await pedir('ultimo_backup_confirmado', { destino: ORIGEM_BACKUP_PRODUCAO })).toBeNull()
    expect(await pedir('reservar_pasta_backup', { destino: ORIGEM_BACKUP_PRODUCAO, pasta: 'pasta-nova' })).toBe('pasta-nova')
    const capturada = await pedir('capturar_backup_servidor', { captura: nova, destino: ORIGEM_BACKUP_PRODUCAO, agora: new Date().toISOString() })
    expect(capturada).toMatchObject({ id: nova, estado: 'capturada' })
    expect(await pedir('consultar_upload_backup', { captura: antiga })).toBeNull()
    expect(await pedir('planejar_rotacao_backup', {})).toEqual([])
    const [preservada] = await tx<{ estado: string; arquivo_id: string }[]>`select estado,arquivo_id from backup_interno.capturas where id=${antiga}::uuid`
    expect(preservada).toEqual({ estado: 'pronta', arquivo_id: 'arquivo-antigo' })
    await tx`select set_config('fichinhas.backup_geracao','',true)`
    await recusar(tx, (sp) => sp`select public.confirmar_backup(${conta}::uuid,${antiga}::uuid,'arquivo-antigo','1',${'a'.repeat(64)})`)
  }))

  test('callback concorrente/antigo não substitui conexão nova; renovação mantém comparação', () => transacao(async (tx, conta) => {
    const primeira = await preparar(tx, conta)
    await tx`select public.concluir_conexao_google(${conta}::uuid,null,${primeira}::jsonb)`
    const segunda = { ...primeira, vinculoId: crypto.randomUUID(), contaGoogleId: 'outra-google-ficticia', emailGoogle: 'outra@example.invalid' }
    await recusar(tx, (sp) => sp`select public.concluir_conexao_google(${conta}::uuid,null,${segunda}::jsonb)`)
    await tx`select public.concluir_conexao_google(${conta}::uuid,${primeira.vinculoId}::uuid,${segunda}::jsonb)`
    await recusar(tx, (sp) => sp`select public.rpc_backup_vinculado(${primeira.vinculoId}::uuid,'ultimo_backup_confirmado',${{conta,destino:ORIGEM_BACKUP_PRODUCAO}}::jsonb)`)
    await recusar(tx, (sp) => sp`select public.renovar_google_web(${primeira.vinculoId}::uuid,'renovacao-ficticia','nao-gravar')`)
    await tx`select public.renovar_google_web(${segunda.vinculoId}::uuid,'renovacao-ficticia','renovada-ficticia')`
    await tx`select public.renovar_google_web(${segunda.vinculoId}::uuid,'renovacao-ficticia','renovada-ficticia')`
    const [ativa] = await tx<{ d: unknown }[]>`select public.obter_autorizacao_backup_producao() d`
    expect(ativa?.d).toMatchObject({ vinculoId: segunda.vinculoId, renovacao: 'renovada-ficticia' })
    const [anteriores] = await tx<{ n: number }[]>`select count(*)::int n from backup_interno.conexoes_google where dono=${conta}::uuid`
    expect(anteriores?.n).toBe(2)
  }))

  test('tentativa tem prazo, uso único e verificador removido após consumo', () => transacao(async (tx, conta) => {
    await preparar(tx, conta)
    const hash = 'a'.repeat(64), expirado = 'b'.repeat(64)
    await tx`select public.abrir_tentativa_google(${conta}::uuid,${hash},${'v'.repeat(43)},null)`
    const [tentativa] = await tx<{ r: unknown }[]>`select public.consumir_tentativa_google(${hash}) r`
    expect(tentativa?.r).toMatchObject({ conta, verificador: 'v'.repeat(43), anterior: null })
    const [consumida] = await tx<{ usada: boolean; verificador: string | null }[]>`select usada,verificador from backup_interno.tentativas_google where estado_hash=${hash}`
    expect(consumida).toEqual({ usada: true, verificador: null })
    await recusar(tx, (sp) => sp`select public.consumir_tentativa_google(${hash})`)
    await tx`select public.abrir_tentativa_google(${conta}::uuid,${expirado},${'v'.repeat(43)},null)`
    await tx`update backup_interno.tentativas_google set ate=clock_timestamp()-interval '1 second' where estado_hash=${expirado}`
    await recusar(tx, (sp) => sp`select public.consumir_tentativa_google(${expirado})`)
  }))

  test('papéis do app não leem cliente/verificador nem gravam conexão ou chamam o dispatcher', () => transacao(async (tx, conta) => {
    await preparar(tx, conta)
    for (const papel of ['anon', 'authenticated']) {
      await recusar(tx, async (sp) => { await sp.unsafe(`set local role ${papel}`); await sp`select public.configuracao_google_web(${conta}::uuid)` }, '42501')
      await recusar(tx, async (sp) => { await sp.unsafe(`set local role ${papel}`); await sp`select public.consumir_tentativa_google(${'a'.repeat(64)})` }, '42501')
      await recusar(tx, async (sp) => { await sp.unsafe(`set local role ${papel}`); await sp`select public.rpc_backup_vinculado(${crypto.randomUUID()}::uuid,'ultimo_backup_confirmado',${{conta,destino:ORIGEM_BACKUP_PRODUCAO}}::jsonb)` }, '42501')
    }
  }))
})
