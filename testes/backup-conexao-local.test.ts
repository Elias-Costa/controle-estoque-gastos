import { describe, expect, test } from 'bun:test'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { BancoLocal } from '../src/dados/banco.ts'
import { criarRepositorioCopia, vincularContaCopia } from '../src/dados/repositorio-copia.ts'

describe('D-085 troca do Drive no aparelho — IndexedDB real de teste', () => {
  test('arquiva confirmação/ponteiro antigos, conserva estágio e recusa respostas atrasadas', async () => {
    const banco = new BancoLocal(crypto.randomUUID(), { indexedDB: new IDBFactory(), IDBKeyRange })
    try {
      const conta = { contaId: crypto.randomUUID(), destino: 'http://127.0.0.1:54321' }
      await vincularContaCopia(banco, conta)
      const repo = criarRepositorioCopia(banco), antigo = crypto.randomUUID(), novo = crypto.randomUUID()
      const instante = new Date('2026-11-18T18:00:00.000Z')
      const id = await repo.reservarBackup(conta, '2026-11-18', instante)
      expect(id).toBeString()
      await repo.guardarUltimoBackup({ origem: 'servidor', capturadoEm: instante.toISOString() })
      expect(await repo.vincularDrive(antigo, '2026-11-18T18:01:00.000Z')).toBe(true)
      expect((await repo.lerEstadoBackup()).ultima).toBeUndefined()
      expect((await repo.lerEstadoBackup()).tentativa).toBeUndefined()
      expect(await banco.estagiosCopia.count()).toBe(1)
      expect(await repo.guardarUltimoBackup({ origem: 'servidor', capturadoEm: instante.toISOString() })).toBe(false)
      expect(await repo.guardarUltimoBackup({ origem: 'servidor', capturadoEm: instante.toISOString() }, antigo)).toBe(true)
      expect(await repo.vincularDrive(novo, '2026-11-18T18:02:00.000Z')).toBe(true)
      expect(await repo.vincularDrive(antigo, '2026-11-18T18:01:00.000Z')).toBe(false)
      expect(await repo.guardarUltimoBackup({ origem: 'servidor', capturadoEm: instante.toISOString() }, antigo)).toBe(false)
      expect(await repo.reservarBackup(conta, '2026-11-18', instante, antigo)).toBeNull()
      const depois = await repo.reservarBackup(conta, '2026-11-18', instante, novo)
      expect(depois).toBeString()
      expect(depois).not.toBe(id)
      expect(await banco.estagiosCopia.count()).toBe(2)
      expect((await repo.lerEstadoBackup()).vinculoId).toBe(novo)
      expect((await repo.lerEstadoBackup()).ultima).toBeUndefined()
    } finally { await banco.delete() }
  })
})
