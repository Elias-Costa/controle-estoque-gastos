import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { SQL, type TransactionSQL } from 'bun'
import { exigirDestinoDeTeste } from '../../nuvem/ambiente-de-teste.ts'
import { conectar } from '../../nuvem/migrar.ts'
import { uuidv7 } from '../../src/dados/identidade.ts'

const LIGADA = process.env.INTEGRACAO === '1'
if (LIGADA) exigirDestinoDeTeste()
let sql: SQL
const A = '00000000-0000-4000-8000-00000000022a'
const B = '00000000-0000-4000-8000-00000000022b'
const SHA = '0'.repeat(64)
class Revertida extends Error {}
beforeAll(() => { if (LIGADA) sql = conectar() })
afterAll(async () => { if (LIGADA) await sql.close() })

async function assumir(tx: SQL, conta = A) {
  await tx`select set_config('request.jwt.claims',${JSON.stringify({ sub: conta, role: 'authenticated' })},true)`
}
async function transacao(fn: (tx: TransactionSQL) => Promise<void>) {
  try {
    await sql.begin(async (tx) => {
      await assumir(tx)
      await fn(tx)
      throw new Revertida()
    })
  } catch (erro) { if (!(erro instanceof Revertida)) throw erro }
}
async function recusar(tx: SQL, fn: () => Promise<unknown>, constraint: string) {
  await tx.unsafe('savepoint recusa_foto')
  let mensagem = ''
  try { await fn() } catch (erro) { mensagem = erro instanceof Error ? erro.message : String(erro) }
  await tx.unsafe('rollback to savepoint recusa_foto')
  expect(mensagem).toContain(constraint)
}
async function registrar(tx: SQL, fotoId = uuidv7(), copiaId = uuidv7(), aparelhoId = uuidv7(), geracao = uuidv7()) {
  const documento = { fotoId, copiaId, sha256: SHA, bytes: 4, largura: 1, altura: 1 }
  const [r] = await tx`select public.registrar_foto_fila(${documento}::jsonb,${aparelhoId}::uuid,${geracao}::uuid) as ref`
  return { ...documento, aparelhoId, geracao, caminho: String(r.ref.caminho) }
}
async function produto(tx: SQL, fotoId?: string, id = uuidv7(), carimbo = '2026-10-18T20:00:00.000Z') {
  const categoriaId = uuidv7()
  await tx`select public.gravar_categoria_estoque(${ { id: categoriaId, nome: 'Categoria de foto' } }::jsonb)`
  const cadastro = { id, categoriaId, nome: 'Foto de teste', atualizadoEm: carimbo, ...(fotoId ? { fotoId } : {}) }
  await tx`select public.gravar_produto_estoque(${cadastro}::jsonb)`
  return cadastro
}
async function metadadosDeArquivo(tx: SQL, caminho: string, bytes = 4) {
  // Só metadados efêmeros para atacar invariantes SQL; bytes reais/Storage têm prova separada.
  await tx`insert into storage.objects(bucket_id,name,metadata) values('fotos-produtos',${caminho},
    ${ { size: bytes, mimetype: 'image/jpeg' } }::jsonb)`
}

describe.skipIf(!LIGADA)('fotos no Postgres — coordenação, proteção e invariantes E-22', () => {
  test('registro é idempotente e conteúdo/conta/teto não podem mudar sob o mesmo id', () => transacao(async (tx) => {
    const f = await registrar(tx)
    const repetida = await registrar(tx, f.fotoId, f.copiaId, f.aparelhoId, f.geracao)
    expect(repetida.caminho).toBe(f.caminho)
    const [n] = await tx`select count(*)::integer n from fotos_interno.protecoes where copia_id=${f.copiaId}::uuid`
    expect(n.n).toBe(1)
    await recusar(tx, () => tx`select public.registrar_foto_fila(${ { ...f, bytes: 5 } }::jsonb,${f.aparelhoId}::uuid,${f.geracao}::uuid)`, 'foto_conteudo_imutavel')
    await recusar(tx, () => tx`select public.registrar_foto_fila(${ { ...f, fotoId: uuidv7(), copiaId: uuidv7(), bytes: 204801 } }::jsonb,${f.aparelhoId}::uuid,${f.geracao}::uuid)`, 'foto_metadados_invalidos')
    await assumir(tx, B)
    await recusar(tx, () => tx`select public.registrar_foto_fila(${f}::jsonb,${f.aparelhoId}::uuid,${f.geracao}::uuid)`, 'foto_conteudo_imutavel')
  }))

  test('arquivo/tamanho/hash precisam ser confirmados; intenção pendente não anuncia disponibilidade', () => transacao(async (tx) => {
    const f = await registrar(tx), p = await produto(tx, f.fotoId)
    const leitura = uuidv7(), aparelho = uuidv7()
    const [antes] = await tx`select public.buscar_produtos_fotos(${aparelho}::uuid,${leitura}::uuid) r`
    expect(antes.r.foto_referencia.disponivel).toBe(false)
    const [protecao] = await tx`select count(*)::integer n from fotos_interno.protecoes where aparelho_id=${aparelho}::uuid and geracao=${leitura}::uuid and not liberada`
    expect(protecao.n).toBe(1)
    await recusar(tx, () => tx`select public.confirmar_arquivo_foto(${f.copiaId}::uuid,${SHA},${p.id}::uuid)`, 'foto_arquivo_nao_confirmado')
    await metadadosDeArquivo(tx, f.caminho, 5)
    await recusar(tx, () => tx`select public.confirmar_arquivo_foto(${f.copiaId}::uuid,${SHA},${p.id}::uuid)`, 'foto_arquivo_nao_confirmado')
  }))

  test('upload atrasado não cria carimbo nem mistura foto na versão vencedora do cadastro', () => transacao(async (tx) => {
    const f = await registrar(tx), p = await produto(tx, f.fotoId)
    await metadadosDeArquivo(tx, f.caminho)
    const vencedor = { ...p, nome: 'Outro aparelho ganhou', atualizadoEm: '2026-10-18T21:00:00.000Z', fotoId: undefined }
    await tx`select public.gravar_produto_estoque(${vencedor}::jsonb)`
    const [resposta] = await tx`select public.confirmar_arquivo_foto(${f.copiaId}::uuid,${SHA},${p.id}::uuid) r`
    expect(resposta.r.situacao).toBe('superada')
    const [atual] = await tx`select nome,foto_id,atualizado_em::text from public.produtos where id=${p.id}::uuid`
    expect(atual.nome).toBe(vencedor.nome)
    expect(atual.foto_id).toBeNull()
    expect(atual.atualizado_em).toContain('21:00:00')
    // O upload continua protegido até a reconciliação local autorizar sua liberação.
    const [coleta] = await tx`select public.autorizar_coleta_fotos() r`
    expect(coleta.r).toEqual([])
  }))

  test('publicação é idempotente e protege o cadastro vigente mesmo após liberar o envio', () => transacao(async (tx) => {
    const f = await registrar(tx), p = await produto(tx, f.fotoId)
    await metadadosDeArquivo(tx, f.caminho)
    for (let i = 0; i < 2; i++) {
      const [r] = await tx`select public.confirmar_arquivo_foto(${f.copiaId}::uuid,${SHA},${p.id}::uuid) r`
      expect(r.r.situacao).toBe('publicada')
    }
    await tx`select public.liberar_protecao_foto(${f.aparelhoId}::uuid,${f.copiaId}::uuid,${f.geracao}::uuid)`
    const [r] = await tx`select public.autorizar_coleta_fotos() r`
    expect(r.r).toEqual([])
    const [atual] = await tx`select foto_id,atualizado_em::text from public.produtos where id=${p.id}::uuid`
    expect(atual.foto_id).toBe(f.fotoId)
    expect(atual.atualizado_em).toContain('20:00:00')
  }))

  test('aparelho offline retém foto substituída; liberação antiga não apaga proteção nova', () => transacao(async (tx) => {
    const f = await registrar(tx), p = await produto(tx, f.fotoId)
    await metadadosDeArquivo(tx, f.caminho)
    await tx`select public.confirmar_arquivo_foto(${f.copiaId}::uuid,${SHA},${p.id}::uuid)`
    const aparelho = uuidv7(), antiga = uuidv7(), nova = uuidv7()
    await tx`select public.buscar_produtos_fotos(${aparelho}::uuid,${antiga}::uuid)`
    await tx`select public.buscar_produtos_fotos(${aparelho}::uuid,${nova}::uuid)`
    await tx`select public.gravar_produto_estoque(${ { ...p, fotoId: undefined, atualizadoEm: '2026-10-18T22:00:00.000Z' } }::jsonb)`
    await tx`select public.liberar_protecao_foto(${f.aparelhoId}::uuid,${f.copiaId}::uuid,${f.geracao}::uuid)`
    for (let i = 0; i < 2; i++) await tx`select public.liberar_protecao_foto(${aparelho}::uuid,${f.copiaId}::uuid,${antiga}::uuid)`
    const [ativas] = await tx`select public.listar_protecoes_fotos(${aparelho}::uuid) r`
    expect(ativas.r.length).toBe(1)
    expect(ativas.r[0].geracao).toBe(nova)
    const [coleta] = await tx`select public.autorizar_coleta_fotos() r`
    expect(coleta.r).toEqual([])
  }))

  test('coleta é tarefa retomável e impede nova publicação/proteção/reuso do caminho', () => transacao(async (tx) => {
    const f = await registrar(tx), p = await produto(tx, f.fotoId)
    await metadadosDeArquivo(tx, f.caminho)
    await tx`select public.confirmar_arquivo_foto(${f.copiaId}::uuid,${SHA},${p.id}::uuid)`
    await tx`select public.gravar_produto_estoque(${ { ...p, fotoId: undefined, atualizadoEm: '2026-10-18T22:00:00.000Z' } }::jsonb)`
    await tx`select public.liberar_protecao_foto(${f.aparelhoId}::uuid,${f.copiaId}::uuid,${f.geracao}::uuid)`
    const [primeira] = await tx`select public.autorizar_coleta_fotos() r`
    const [repetida] = await tx`select public.autorizar_coleta_fotos() r`
    expect(primeira.r).toEqual(repetida.r)
    expect(primeira.r[0].caminho).toBe(f.caminho)
    await recusar(tx, () => tx`select public.registrar_foto_fila(${f}::jsonb,${f.aparelhoId}::uuid,${uuidv7()}::uuid)`, 'foto_caminho_encerrado')
    await recusar(tx, () => tx`select public.confirmar_arquivo_foto(${f.copiaId}::uuid,${SHA},${p.id}::uuid)`, 'foto_caminho_encerrado')
    await recusar(tx, () => tx`select public.confirmar_coleta_foto(${f.copiaId}::uuid)`, 'foto_arquivo_ainda_existe')
    await recusar(tx, () => tx`select public.gravar_produto_estoque(${ { ...p, atualizadoEm: '2026-10-18T23:00:00.000Z' } }::jsonb)`, 'foto_caminho_encerrado')
  }))

  test('outra conta não lê referência nem bytes, não publica nem libera proteção alheia', () => transacao(async (tx) => {
    const f = await registrar(tx), p = await produto(tx, f.fotoId)
    await metadadosDeArquivo(tx, f.caminho)
    await tx`select public.confirmar_arquivo_foto(${f.copiaId}::uuid,${SHA},${p.id}::uuid)`
    await assumir(tx, B)
    const [leitura] = await tx`select public.listar_protecoes_fotos(${f.aparelhoId}::uuid) r`
    expect(leitura.r).toEqual([])
    await tx.unsafe('set local role authenticated')
    const [bytes] = await tx`select count(*)::integer n from storage.objects where bucket_id='fotos-produtos' and name=${f.caminho}`
    expect(bytes.n).toBe(0)
    await recusar(tx, () => tx`select public.confirmar_arquivo_foto(${f.copiaId}::uuid,${SHA},${p.id}::uuid)`, 'foto_caminho_encerrado')
    await tx`select public.liberar_protecao_foto(${f.aparelhoId}::uuid,${f.copiaId}::uuid,${f.geracao}::uuid)`
    await tx.unsafe('reset role')
    const [protecao] = await tx`select liberada from fotos_interno.protecoes where dono=${A}::uuid and copia_id=${f.copiaId}::uuid`
    expect(protecao.liberada).toBe(false)
  }))

  test('publicação/leitura e coleta disputam trava real; coleta vencedora impede caminho antigo', async () => {
    const conta = uuidv7()
    const { f, p } = await sql.begin(async (tx) => {
      await assumir(tx, conta)
      const f = await registrar(tx), p = await produto(tx, f.fotoId)
      await metadadosDeArquivo(tx, f.caminho)
      return { f, p }
    })
    // A publicação segura a coordenação até commit; uma coleta concorrente não passa à frente.
    await disputar(conta, async (tx) => {
      await tx`select public.confirmar_arquivo_foto(${f.copiaId}::uuid,${SHA},${p.id}::uuid)`
    }, async (tx) => {
      const [r] = await tx`select public.autorizar_coleta_fotos() r`
      expect(r.r).toEqual([])
    })
    const aparelho = uuidv7(), geracao = uuidv7()
    await disputar(conta, async (tx) => {
      await tx`select public.buscar_produtos_fotos(${aparelho}::uuid,${geracao}::uuid)`
    }, async (tx) => {
      await tx`select public.gravar_produto_estoque(${ { ...p, fotoId: undefined, atualizadoEm: '2026-10-18T23:00:00.000Z' } }::jsonb)`
      await tx`select public.liberar_protecao_foto(${f.aparelhoId}::uuid,${f.copiaId}::uuid,${f.geracao}::uuid)`
      const [r] = await tx`select public.autorizar_coleta_fotos() r`
      expect(r.r).toEqual([])
    })
    await sql.begin(async (tx) => {
      await assumir(tx, conta)
      await tx`select public.liberar_protecao_foto(${aparelho}::uuid,${f.copiaId}::uuid,${geracao}::uuid)`
    })
    await disputar(conta, async (tx) => {
      const [r] = await tx`select public.autorizar_coleta_fotos() r`
      expect(r.r).toContainEqual({ copiaId: f.copiaId, caminho: f.caminho })
    }, async (tx) => {
      await recusar(tx, () => tx`select public.confirmar_arquivo_foto(${f.copiaId}::uuid,${SHA},${p.id}::uuid)`, 'foto_caminho_encerrado')
    })
  })
})

async function disputar(conta: string, primeira: (tx: SQL) => Promise<void>, segunda: (tx: SQL) => Promise<void>) {
  const c1 = conectar(), c2 = conectar()
  const pronta = Promise.withResolvers<void>(), liberacao = Promise.withResolvers<void>(), pidPronto = Promise.withResolvers<number>()
  let p1: Promise<unknown> | undefined, p2: Promise<unknown> | undefined
  try {
    p1 = c1.begin(async (tx) => { await assumir(tx, conta); await primeira(tx); pronta.resolve(); await liberacao.promise })
    await Promise.race([pronta.promise, p1.then(() => { throw new Error('Primeira conexão terminou cedo') })])
    p2 = c2.begin(async (tx) => {
      await assumir(tx, conta)
      const [r] = await tx`select pg_backend_pid() pid`
      pidPronto.resolve(r.pid)
      await segunda(tx)
    })
    const pid = await Promise.race([pidPronto.promise, p2.then(() => { throw new Error('Segunda conexão terminou cedo') })])
    let bloqueada = false
    const ate = Date.now() + 10000
    while (Date.now() < ate) {
      const [r] = await sql`select cardinality(pg_blocking_pids(${pid}))>0 bloqueada`
      if (r.bloqueada) { bloqueada = true; break }
      await Bun.sleep(20)
    }
    expect(bloqueada).toBe(true)
    liberacao.resolve()
    await p1; await p2
  } finally {
    liberacao.resolve()
    await Promise.allSettled([p1, p2]); await Promise.all([c1.close(), c2.close()])
  }
}
