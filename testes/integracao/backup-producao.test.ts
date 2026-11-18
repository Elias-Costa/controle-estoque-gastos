import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { SQL, type TransactionSQL } from 'bun'
import { exigirDestinoDeTeste } from '../../nuvem/ambiente-de-teste.ts'
import { conectar, lerMigracoes } from '../../nuvem/migrar.ts'
import { consultarAutorizacaoGoogle, registrarAutorizacaoGoogle, SEGREDO_GOOGLE_BACKUP, SEGREDO_GOOGLE_BACKUP_PRODUCAO } from '../../nuvem/backup/cofre-google.ts'
import { conferirContaFichinhas } from '../../nuvem/backup/configurar-google.ts'
import { autorizacaoGoogleFicticia, autorizacaoProducaoFicticia } from '../fixtures/backup-google.ts'
import { uuidv7 } from '../../src/dados/identidade.ts'

const LIGADA = process.env.INTEGRACAO === '1'
if (LIGADA) exigirDestinoDeTeste()
let sql: SQL
class Revertida extends Error {}
beforeAll(() => { if (LIGADA) sql = conectar() })
afterAll(async () => { if (LIGADA) await sql.close() })
async function transacao(fn: (tx: TransactionSQL) => Promise<void>) {
  try { await sql.begin(async (tx) => {
    const [existe] = await tx<{ configurada: boolean }[]>`select exists(select 1 from vault.secrets where name=${SEGREDO_GOOGLE_BACKUP_PRODUCAO}) configurada`
    if (existe?.configurada) throw new Error('A prova preserva um cofre definitivo preexistente; não substitui sua autorização.')
    await fn(tx); throw new Revertida()
  }) } catch (e) { if (!(e instanceof Revertida)) throw e }
}
async function recusarSql(tx: TransactionSQL, operacao: (sp: SQL) => Promise<unknown>, codigo: string) {
  let recusou = false
  try { await tx.savepoint(operacao) } catch (e) {
    if (!(e instanceof SQL.PostgresError)) throw e
    expect(e.errno).toBe(codigo); recusou = true
  }
  expect(recusou).toBe(true)
}

describe.skipIf(!LIGADA)('D-085 produção — SQL real D-050, tokens fictícios e rollback; sem acesso à produção', () => {
  test('UUID é conferido no Auth do banco de teste; ausência ou UUID malformado falham', () => transacao(async (tx) => {
    const [conta] = await tx<{ id: string; email: string }[]>`select id::text,email from auth.users where email=${process.env.SUPABASE_TESTE_EMAIL ?? ''}`
    if (!conta) throw new Error('Conta fictícia do destino não localizada.')
    expect(await conferirContaFichinhas(tx, conta.id)).toBe(conta.email)
    await expect(conferirContaFichinhas(tx, uuidv7())).rejects.toThrow('não localizado')
    await expect(conferirContaFichinhas(tx, 'invalida')).rejects.toThrow('UUID')
  }))

  test('cofres separados recusam mistura; comparação preserva autorização sob reenvio concorrente', () => transacao(async (tx) => {
    const teste = `${SEGREDO_GOOGLE_BACKUP}:teste:${uuidv7()}`
    await registrarAutorizacaoGoogle(tx, autorizacaoGoogleFicticia, null, teste)
    await expect(registrarAutorizacaoGoogle(tx, autorizacaoProducaoFicticia, null, teste)).rejects.toThrow('Cofre e ambiente')
    await expect(registrarAutorizacaoGoogle(tx, autorizacaoGoogleFicticia, null, SEGREDO_GOOGLE_BACKUP_PRODUCAO)).rejects.toThrow('Cofre e ambiente')
    await registrarAutorizacaoGoogle(tx, autorizacaoProducaoFicticia, null, SEGREDO_GOOGLE_BACKUP_PRODUCAO)
    await expect(registrarAutorizacaoGoogle(tx, { ...autorizacaoProducaoFicticia, renovacao: 'segunda-ficticia' }, null, SEGREDO_GOOGLE_BACKUP_PRODUCAO)).rejects.toThrow('mudou durante')
    await expect(registrarAutorizacaoGoogle(tx, { ...autorizacaoProducaoFicticia, contaGoogleId: 'outra-conta' }, autorizacaoProducaoFicticia, SEGREDO_GOOGLE_BACKUP_PRODUCAO)).rejects.toThrow('não pode trocar')
    expect(await consultarAutorizacaoGoogle(tx, teste)).toEqual(autorizacaoGoogleFicticia)
    expect(await consultarAutorizacaoGoogle(tx, SEGREDO_GOOGLE_BACKUP_PRODUCAO)).toEqual(autorizacaoProducaoFicticia)
  }))

  test('RPCs restritas ao servidor leem só o cofre definitivo e renovam por comparação idempotente', () => transacao(async (tx) => {
    await registrarAutorizacaoGoogle(tx, autorizacaoProducaoFicticia, null, SEGREDO_GOOGLE_BACKUP_PRODUCAO)
    const ler = async () => (await tx<{ valor: unknown }[]>`select public.obter_autorizacao_backup_producao() valor`)[0]?.valor
    expect(await ler()).toEqual(autorizacaoProducaoFicticia)
    for (const papel of ['anon', 'authenticated']) {
      await recusarSql(tx, async (sp) => { await sp.unsafe(`set local role ${papel}`); await sp`select public.obter_autorizacao_backup_producao()` }, '42501')
      await recusarSql(tx, async (sp) => { await sp.unsafe(`set local role ${papel}`); await sp`select public.atualizar_renovacao_backup_producao(${autorizacaoProducaoFicticia.contaId}::uuid,'anterior','nova')` }, '42501')
    }
    await tx.savepoint(async (sp) => {
      await sp.unsafe('set local role service_role')
      expect((await sp<{ valor: unknown }[]>`select public.obter_autorizacao_backup_producao() valor`)[0]?.valor).toEqual(autorizacaoProducaoFicticia)
      for (let repeticao = 0; repeticao < 2; repeticao++) {
        await sp`select public.atualizar_renovacao_backup_producao(${autorizacaoProducaoFicticia.contaId}::uuid,${autorizacaoProducaoFicticia.renovacao},'nova-ficticia')`
      }
      await sp.unsafe('reset role')
    })
    expect(await ler()).toEqual({ ...autorizacaoProducaoFicticia, renovacao: 'nova-ficticia' })
    await recusarSql(tx, (sp) => sp`select public.atualizar_renovacao_backup_producao(${uuidv7()}::uuid,'nova-ficticia','recusada')`, '23514')
    await recusarSql(tx, (sp) => sp`select public.atualizar_renovacao_backup_producao(${autorizacaoProducaoFicticia.contaId}::uuid,'obsoleta','recusada')`, '23514')
    expect(await ler()).toEqual({ ...autorizacaoProducaoFicticia, renovacao: 'nova-ficticia' })
  }))

  test('RPC não entrega cofre contaminado por ambiente de teste; reversão preserva autorização existente', () => transacao(async (tx) => {
    await tx`select vault.create_secret(${JSON.stringify({ ...autorizacaoProducaoFicticia, ambiente: 'homologacao' })},${SEGREDO_GOOGLE_BACKUP_PRODUCAO})`
    await recusarSql(tx, (sp) => sp`select public.obter_autorizacao_backup_producao()`, '23514')
    const migracao = (await lerMigracoes()).find((m) => m.nome === '0018_backup-autorizacao-de-producao')
    if (!migracao) throw new Error('Migration 0018 ausente.')
    await recusarSql(tx, (sp) => sp.unsafe(migracao.reverter), 'P0001')
    const [preservada] = await tx<{ existe: boolean }[]>`select exists(select 1 from vault.secrets where name=${SEGREDO_GOOGLE_BACKUP_PRODUCAO}) existe`
    expect(preservada?.existe).toBe(true)
  }))
})
