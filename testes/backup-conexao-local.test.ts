import { describe, expect, test } from 'bun:test'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { BancoLocal } from '../src/dados/banco.ts'
import { criarRepositorioCopia, vincularContaCopia } from '../src/dados/repositorio-copia.ts'

describe('D-085 troca do Drive no aparelho — IndexedDB real de teste', () => {
  test('reabertura conserva identidade pública e falha pendente sem persistir campos adicionais', async () => {
    const fabrica = new IDBFactory(), nome = crypto.randomUUID()
    const banco = new BancoLocal(nome, { indexedDB: fabrica, IDBKeyRange })
    const conta = { contaId: crypto.randomUUID(), destino: 'http://127.0.0.1:54321' }
    const conexao = { vinculoId: crypto.randomUUID(), conectadoEm: '2026-11-18T18:01:00.000Z', email: 'drive-ficticio@example.invalid' }
    const repo = criarRepositorioCopia(banco)
    await vincularContaCopia(banco, conta)
    await repo.vincularDrive(conexao.vinculoId, conexao.conectadoEm)
    const comCampoExtra = { ...conexao, segredo: 'ficticio-nunca-persistir' }
    expect(await repo.guardarConexaoDrive(comCampoExtra)).toBe(true)
    const id = await repo.reservarBackup(conta, '2026-11-18', new Date('2026-11-18T18:02:00.000Z'), conexao.vinculoId)
    if (!id) throw new Error('Candidata fictícia não criada')
    await repo.marcarFalhaBackup(id, true)
    const controle = await banco.controleCopia.get('registro:conexao-google')
    expect(controle?.chave === 'registro:conexao-google' && controle.conteudo).not.toContain('ficticio-nunca-persistir')
    banco.close()
    const reaberto = new BancoLocal(nome, { indexedDB: fabrica, IDBKeyRange })
    try {
      const estado = await criarRepositorioCopia(reaberto).lerEstadoBackup()
      expect(estado.conexaoDrive).toEqual(conexao)
      expect(estado.tentativa).toEqual({ id, dia: '2026-11-18', falhou: true })
      expect(estado.vinculoId).toBe(conexao.vinculoId)
    } finally { await reaberto.delete() }
  })

  test('identidade antiga, de outra conta/destino ou ilegível não é exibida no vínculo corrente', async () => {
    const banco = new BancoLocal(crypto.randomUUID(), { indexedDB: new IDBFactory(), IDBKeyRange })
    try {
      const conta = { contaId: crypto.randomUUID(), destino: 'http://127.0.0.1:54321' }
      const conexao = { vinculoId: crypto.randomUUID(), conectadoEm: '2026-11-18T18:01:00.000Z', email: 'drive-ficticio@example.invalid' }
      const repo = criarRepositorioCopia(banco)
      await vincularContaCopia(banco, conta)
      await repo.vincularDrive(conexao.vinculoId, conexao.conectadoEm)
      await repo.guardarConexaoDrive(conexao)
      for (const vinculo of [{ ...conta, contaId: crypto.randomUUID() }, { ...conta, destino: 'https://outro.example' }]) {
        await banco.controleCopia.put({ chave: 'registro:conexao-google', conteudo: JSON.stringify({ vinculo, conexao }) })
        expect((await repo.lerEstadoBackup()).conexaoDrive).toBeUndefined()
      }
      await banco.controleCopia.put({ chave: 'registro:conexao-google', conteudo: '{' })
      expect((await repo.lerEstadoBackup()).conexaoDrive).toBeUndefined()
      await repo.guardarConexaoDrive(conexao)
      await repo.vincularDrive(crypto.randomUUID(), '2026-11-18T18:03:00.000Z')
      expect((await repo.lerEstadoBackup()).conexaoDrive).toBeUndefined()
      expect(await repo.guardarConexaoDrive(conexao)).toBe(false)
    } finally { await banco.delete() }
  })

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
