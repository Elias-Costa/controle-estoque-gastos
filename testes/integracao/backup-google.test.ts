import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { SQL, type TransactionSQL } from 'bun'
import { exigirDestinoDeTeste } from '../../nuvem/ambiente-de-teste.ts'
import { conectar } from '../../nuvem/migrar.ts'
import { consultarAutorizacaoGoogle, registrarAutorizacaoGoogle, SEGREDO_GOOGLE_BACKUP } from '../../nuvem/backup/cofre-google.ts'
import { autorizacaoGoogleFicticia } from '../fixtures/backup-google.ts'
import { uuidv7 } from '../../src/dados/identidade.ts'

const LIGADA = process.env.INTEGRACAO === '1'
if (LIGADA) exigirDestinoDeTeste()
let sql: SQL
class Revertida extends Error {}
beforeAll(() => { if (LIGADA) sql = conectar() })
afterAll(async () => { if (LIGADA) await sql.close() })
async function transacao(fn: (tx: TransactionSQL, nome: string) => Promise<void>) {
  try { await sql.begin(async (tx) => { await fn(tx, `${SEGREDO_GOOGLE_BACKUP}:teste:${uuidv7()}`); throw new Revertida() }) }
  catch (e) { if (!(e instanceof Revertida)) throw e }
}

describe.skipIf(!LIGADA)('BA-02 Vault real — conteúdo fictício e rollback, sem tocar autorização configurada', () => {
  test('guarda/relê inteiro e preserva primeira autorização após tentativa concorrente', () => transacao(async (tx, nome) => {
    expect(await consultarAutorizacaoGoogle(tx, nome)).toBeNull()
    await registrarAutorizacaoGoogle(tx, autorizacaoGoogleFicticia, null, nome)
    expect(await consultarAutorizacaoGoogle(tx, nome)).toEqual(autorizacaoGoogleFicticia)
    await expect(registrarAutorizacaoGoogle(tx, { ...autorizacaoGoogleFicticia, renovacao: 'segunda' }, null, nome)).rejects.toThrow('mudou durante')
    expect((await consultarAutorizacaoGoogle(tx, nome))?.renovacao).toBe(autorizacaoGoogleFicticia.renovacao)
  }))
  test('reautoriza versão conhecida; outra conta/cliente não substitui a guardada', () => transacao(async (tx, nome) => {
    await registrarAutorizacaoGoogle(tx, autorizacaoGoogleFicticia, null, nome)
    const nova = { ...autorizacaoGoogleFicticia, renovacao: 'segunda', autorizadoEm: '2026-11-05T13:00:00.000Z' }
    await registrarAutorizacaoGoogle(tx, nova, autorizacaoGoogleFicticia, nome)
    expect(await consultarAutorizacaoGoogle(tx, nome)).toEqual(nova)
    await expect(registrarAutorizacaoGoogle(tx, { ...nova, contaGoogleId: 'outra' }, nova, nome)).rejects.toThrow('não pode trocar')
    await expect(registrarAutorizacaoGoogle(tx, { ...nova, cliente: { ...nova.cliente, clienteId: '9876543210-outro.apps.googleusercontent.com' } }, nova, nome)).rejects.toThrow('não pode trocar')
    expect(await consultarAutorizacaoGoogle(tx, nome)).toEqual(nova)
  }))
  test('anon/authenticated não leem Vault; namespace recusa segredos de outro serviço', () => transacao(async (tx, nome) => {
    await registrarAutorizacaoGoogle(tx, autorizacaoGoogleFicticia, null, nome)
    for (const papel of ['anon', 'authenticated']) {
      let recusou = false
      try { await tx.savepoint(async (sp) => {
        await sp.unsafe(`set local role ${papel}`)
        await consultarAutorizacaoGoogle(sp, nome)
      }) } catch (e) { if (!(e instanceof SQL.PostgresError)) throw e; expect(e.errno).toBe('42501'); recusou = true }
      expect(recusou).toBe(true)
    }
    await expect(consultarAutorizacaoGoogle(tx, 'fichinhas-lembretes-v1')).rejects.toThrow('fora do backup')
    expect(await consultarAutorizacaoGoogle(tx, nome)).toEqual(autorizacaoGoogleFicticia)
  }))
})
