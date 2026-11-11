import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { SQL, type TransactionSQL } from 'bun'
import { exigirDestinoDeTeste } from '../../nuvem/ambiente-de-teste.ts'
import { conectar } from '../../nuvem/migrar.ts'
import { uuidv7 } from '../../src/dados/identidade.ts'

const LIGADA = process.env.INTEGRACAO === '1'
if (LIGADA) exigirDestinoDeTeste()
const DESTINO = 'http://127.0.0.1:54321', AGORA = '2026-11-05T14:00:00Z', SHA = 'a'.repeat(64), CHAVE = 'b'.repeat(64)
let sql: SQL
class Revertida extends Error {}
beforeAll(() => { if (LIGADA) sql = conectar() })
afterAll(async () => { if (LIGADA) await sql.close() })

async function transacao(fn: (tx: TransactionSQL, conta: string, captura: string) => Promise<void>) {
  try { await sql.begin(async (tx) => {
    if (process.env.PROVAR_MIGRACAO_RETOMAVEL === '1') {
      if (exigirDestinoDeTeste() !== 'local') throw new Error('Prévia da migration exige o Docker local.')
      await tx.unsafe(await Bun.file('nuvem/migracoes/0016_backup-retomavel.sql').text())
    }
    const conta = uuidv7(), captura = uuidv7()
    await tx`select public.capturar_backup_servidor(${conta}::uuid,${captura}::uuid,${DESTINO},${AGORA}::timestamptz)`
    await fn(tx, conta, captura); throw new Revertida()
  }) } catch (e) { if (!(e instanceof Revertida)) throw e }
}
async function assumir(tx: SQL, conta: string, captura: string, posse: string) {
  const [r] = await tx<{ r: { modo: string; fase?: string; passo?: number; reutilizavel?: unknown; apagar?: string[] } }[]>`
    select public.assumir_preparo_backup(${conta}::uuid,${captura}::uuid,${DESTINO},${posse}::uuid) r`
  if (!r) throw new Error('Sem resposta do preparo'); return r.r
}
function avancar(tx: SQL, conta: string, captura: string, posse: string, passo: number, r: object) {
  return tx`select public.avancar_preparo_backup(${conta}::uuid,${captura}::uuid,${posse}::uuid,${passo},${r}::jsonb,false)`
}
async function recusar(tx: TransactionSQL, fn: (sp: SQL) => Promise<unknown>, codigo = '23514') {
  try { await tx.savepoint(fn) } catch (e) {
    if (!(e instanceof SQL.PostgresError)) throw e
    expect(e.errno).toBe(codigo); return
  }
  throw new Error('A operação devia ter sido recusada.')
}
const plano = { grupos: [{ chave: CHAVE, referencias: [] }], dados: [], consultas: [], quantidades: {}, material: [] }

describe.skipIf(!LIGADA)('BA-04 catálogo retomável no Postgres', () => {
  test('recusa papéis do app, isola conta e preserva a reserva quando outro executor chega', () => transacao(async (tx, conta, captura) => {
    const posse = uuidv7(), outra = uuidv7()
    for (const papel of ['anon', 'authenticated']) await recusar(tx, async (sp) => {
      await sp.unsafe(`set local role ${papel}`); await assumir(sp, conta, captura, posse)
    }, '42501')
    await recusar(tx, (sp) => assumir(sp, uuidv7(), captura, posse))
    expect(await assumir(tx, conta, captura, posse)).toMatchObject({ modo: 'preparo', fase: 'dados', passo: 0 })
    expect(await assumir(tx, conta, captura, outra)).toMatchObject({ modo: 'ocupado' })
    await recusar(tx, (sp) => avancar(sp, conta, captura, outra, 0, plano))
    await tx`update backup_interno.preparos set ate=clock_timestamp()-interval '1 second' where dono=${conta}::uuid`
    expect(await assumir(tx, conta, captura, outra)).toMatchObject({ modo: 'preparo', passo: 0 })
    await recusar(tx, (sp) => avancar(sp, conta, captura, posse, 0, plano))
    await avancar(tx, conta, captura, outra, 0, plano)
    await avancar(tx, conta, captura, outra, 0, plano)
    await recusar(tx, (sp) => avancar(sp, conta, captura, outra, 0, { ...plano, grupos: [] }))
    expect(await assumir(tx, conta, captura, posse)).toMatchObject({ fase: 'fotos', passo: 1 })
  }))

  test('a conferência antecede o reuso e a limpeza exclui apenas partes sem referência', () => transacao(async (tx, conta, captura) => {
    const posse = uuidv7(), outroSha = 'c'.repeat(64)
    const caminho = `${conta}/${captura}/${SHA}.bin`, descartavel = `${conta}/${captura}/${outroSha}.bin`
    await assumir(tx, conta, captura, posse)
    const objetos = [{ sha256: SHA, bytes: 14 }, { sha256: outroSha, bytes: 10 }]
    await tx`select public.reservar_objetos_backup(${conta}::uuid,${captura}::uuid,${posse}::uuid,0,${JSON.stringify(objetos)}::text::jsonb)`
    await avancar(tx, conta, captura, posse, 0, plano)
    await assumir(tx, conta, captura, posse)
    const foto = { chave: CHAVE, lote: { segmentos: [{ caminho, bytes: 14, sha256: SHA }] } }
    await recusar(tx, (sp) => avancar(sp, conta, captura, posse, 1, { ...foto, chave: SHA }))
    await avancar(tx, conta, captura, posse, 1, foto)
    await assumir(tx, conta, captura, posse)
    await avancar(tx, conta, captura, posse, 2, { indice: { tamanho: 14, sha256: SHA }, material: [], manter: true })
    await recusar(tx, (sp) => avancar(sp, conta, captura, posse, 3, { pronta: true }))
    await tx`select public.registrar_upload_backup(${conta}::uuid,${captura}::uuid,'arquivo','pasta',null,'14',${SHA},'{}','{}')`
    await tx`select public.confirmar_backup(${conta}::uuid,${captura}::uuid,'arquivo','14',${SHA})`
    await avancar(tx, conta, captura, posse, 3, { pronta: true })
    expect(await assumir(tx, conta, captura, posse)).toMatchObject({ fase: 'limpar', apagar: [descartavel] })
    await recusar(tx, (sp) => avancar(sp, conta, captura, posse, 4, { apagados: [caminho] }))
    await avancar(tx, conta, captura, posse, 4, { apagados: [descartavel] })
    expect(await tx<{ caminho: string }[]>`select caminho from backup_interno.objetos_preparo where dono=${conta}::uuid`).toEqual([{ caminho }])
    const nova = uuidv7()
    await tx`select public.capturar_backup_servidor(${conta}::uuid,${nova}::uuid,${DESTINO},'2026-11-06T14:00:00Z'::timestamptz)`
    await assumir(tx, conta, nova, posse); await avancar(tx, conta, nova, posse, 0, plano)
    expect((await assumir(tx, conta, nova, posse)).reutilizavel).toEqual(foto.lote)
    await recusar(tx, async (sp) => sp.unsafe(await Bun.file('nuvem/migracoes/0016_backup-retomavel.reverter.sql').text()))
  }))

  test('reserva anterior continua no empacotador original', () => transacao(async (tx, conta, captura) => {
    await tx`select public.registrar_upload_backup(${conta}::uuid,${captura}::uuid,'arquivo','pasta',null,'14',${SHA},'{}','{}')`
    expect(await assumir(tx, conta, captura, uuidv7())).toEqual({ modo: 'legado' })
    expect(await tx`select 1 from backup_interno.preparos where dono=${conta}::uuid`).toHaveLength(0)
  }))
})
