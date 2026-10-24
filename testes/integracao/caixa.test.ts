import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { SQL, type TransactionSQL } from 'bun'
import { createClient } from '@supabase/supabase-js'
import { conectar, lerMigracoes } from '../../nuvem/migrar.ts'
import { exigirDestinoDeTeste } from '../../nuvem/ambiente-de-teste.ts'
import { uuidv7 } from '../../src/dados/identidade.ts'

// D-050: só destinos de teste validados; transações diretas são desfeitas.
const LIGADA = process.env.INTEGRACAO === '1'
if (LIGADA) exigirDestinoDeTeste()
const A = '00000000-0000-4000-8000-00000000032a'
const B = '00000000-0000-4000-8000-00000000032b'
type Documento = Record<string, unknown>
type Fato = Documento & { id: string; revisao: number; tipo: string }
type Grupo = { operacao: Documento & { id: string; alvo?: Documento }; fatos: Fato[] }
let sql: SQL
class Revertida extends Error {}
beforeAll(() => { if (LIGADA) sql = conectar() })
afterAll(async () => { if (LIGADA) await sql.close() })

async function assumir(tx: SQL, dono = A): Promise<void> {
  await tx`select set_config('request.jwt.claims',${JSON.stringify({ sub: dono, role: 'authenticated' })},true)`
  await tx.unsafe('set local role authenticated')
}
async function transacao(fn: (tx: TransactionSQL) => Promise<void>): Promise<void> {
  try {
    await sql.begin(async (tx) => {
      if (process.env.MUTACAO_CAIXA) await tx.unsafe(process.env.MUTACAO_CAIXA)
      await assumir(tx)
      await fn(tx)
      await tx.unsafe('set constraints all immediate')
      throw new Revertida()
    })
  } catch (erro) { if (!(erro instanceof Revertida)) throw erro }
}
async function recusa(tx: TransactionSQL, fn: (sp: SQL) => Promise<unknown>, regra?: string): Promise<string> {
  try { await tx.savepoint(fn) } catch (erro) {
    if (!(erro instanceof SQL.PostgresError)) throw erro
    if (regra) expect(erro.constraint).toBe(regra)
    return erro.errno ?? erro.code
  }
  throw new Error('o banco aceitou a violação de E-32')
}
function movimento(extras: Documento = {}): Fato {
  return { id: uuidv7(), revisao: 1, tipo: 'despesa', data: '2026-09-30', valor: '10000',
    categoria: 'Categoria livre', classificacao: 'negocio', mercadoria: true, ...extras }
}
function grupo(tipo = 'registro', fatos = [movimento()], alvo?: Documento): Grupo {
  return { operacao: { id: uuidv7(), formato: 1, revisao: 1, tipo,
    fatos: fatos.map(({ id, revisao }) => ({ id, revisao })), ...(alvo ? { alvo } : {}) }, fatos }
}
function corrigir(original: Fato, tipo = 'correcao'): Grupo {
  const alvo = { id: original.id, revisao: original.revisao }
  const estorno: Fato = { id: uuidv7(), revisao: 1, tipo: 'estorno', data: '2026-10-24', alvo }
  return grupo(tipo, tipo === 'estorno' ? [estorno] : [estorno, movimento({ valor: '8000' })], alvo)
}
async function aceitar(tx: SQL, g: Grupo): Promise<string> {
  const [r] = await tx<{ posicao: string }[]>`select public.aceitar_grupo_caixa(${g}::jsonb) posicao`
  if (!r) throw new Error('sem resposta de caixa')
  return r.posicao
}
async function baixar(tx: SQL, apos = '0', limite = 500): Promise<Documento[]> {
  const r = await tx<{ registro: Documento }[]>`select public.baixar_caixa(${apos},${limite}) registro`
  return r.map(({ registro }) => registro)
}
// SQL direto contorna a RPC, mantendo constraints e gatilhos ativos (RI-09).
async function inserirOperacao(tx: SQL, g: Grupo, dono = A): Promise<void> {
  const op = g.operacao
  await tx`insert into public.operacoes_caixa(id,dono,revisao,formato,tipo,fatos,alvo_id,alvo_revisao)
    values(${op.id}::uuid,${dono}::uuid,${op['revisao']}::bigint,${op['formato']}::int,${op['tipo']}::text,
      ${op['fatos']}::jsonb,${op.alvo?.['id'] ?? null}::uuid,${op.alvo?.['revisao'] ?? null}::bigint)`
}
async function inserirFatos(tx: SQL, g: Grupo, dono = A): Promise<void> {
  for (const f of g.fatos) {
    await tx`insert into public.fatos_caixa(id,dono,revisao,operacao_id,revisao_operacao,conteudo)
      values(${f.id}::uuid,${dono}::uuid,${f.revisao},${g.operacao.id}::uuid,${g.operacao['revisao']}::bigint,${f}::jsonb)`
  }
}
async function direto(tx: SQL, g: Grupo, dono = A): Promise<void> {
  await inserirOperacao(tx, g, dono)
  await inserirFatos(tx, g, dono)
  await tx.unsafe('set constraints all immediate')
  await tx.unsafe('set constraints all deferred')
}

describe.skipIf(!LIGADA)('caixa no Postgres E-32', () => {
  test('centavos grandes, revisões locais, cortes e grupo completo preservados sem arredondar', async () => {
    await transacao(async (tx) => {
      const receita = movimento({ tipo: 'receita-avulsa', valor: '9007199254740993', classificacao: 'pessoal', revisao: 3 })
      delete receita['mercadoria']
      const g = grupo('registro', [receita])
      g.operacao['revisao'] = 3
      const posicao = await aceitar(tx, g)
      expect(typeof posicao).toBe('string')
      expect(await baixar(tx)).toEqual([{ recepcao: posicao, grupo: g }])
      expect(await tx<Documento[]>`select valor::text,tipo from public.fatos_caixa where id=${receita.id}::uuid`)
        .toEqual([{ valor: '9007199254740993', tipo: 'receita-avulsa' }])
    })
  })

  test('reenvio é idempotente; conteúdo, revisão e dono divergentes nunca substituem aceite', async () => {
    await transacao(async (tx) => {
      const g = grupo(), posicao = await aceitar(tx, g)
      expect(await aceitar(tx, g)).toBe(posicao)
      for (const alterado of [
        { ...g, fatos: g.fatos.map((f) => ({ ...f, valor: '999' })) },
        { ...g, operacao: { ...g.operacao, revisao: 2 } },
      ]) expect(await recusa(tx, (sp) => aceitar(sp, alterado), 'caixa_conteudo_divergente')).toBe('23514')
      await assumir(tx, B)
      expect(await baixar(tx)).toEqual([])
      expect(await recusa(tx, (sp) => aceitar(sp, g), 'caixa_conteudo_divergente')).toBe('23514')
      await assumir(tx)
      expect(await baixar(tx)).toEqual([{ recepcao: posicao, grupo: g }])
    })
  })

  test('SQL direto recusa dinheiro numérico/fracionário/negativo e campos/tipos inválidos', async () => {
    await transacao(async (tx) => {
      await tx.unsafe('reset role')
      const invalidos: Documento[] = [
        { valor: 39.9 }, { valor: 100 }, { valor: '39.9' }, { valor: '0' }, { valor: '-1' },
        { valor: '9223372036854775808' }, { valor: null }, { categoria: '  ' }, { categoria: 123 },
        { classificacao: 'outro' }, { mercadoria: 'true' }, { classificacao: 'pessoal' },
        { data: '2026-02-30' }, { data: 'infinity' }, { tipo: 'outro' }, { forma: 'pix' },
        { tipo: 'estorno', alvo: { id: uuidv7(), revisao: 1 } },
      ]
      for (const extra of invalidos) {
        const g = grupo('registro', [movimento(extra)])
        const codigo = await recusa(tx, (sp) => direto(sp, g))
        expect(['23514','22P02','22003']).toContain(codigo)
      }
      expect(await tx`select id from public.operacoes_caixa where dono=${A}::uuid`).toHaveLength(0)
    })
  })

  test('RPC recusa documentos malformados, campos extras e referências inconsistentes', async () => {
    await transacao(async (tx) => {
      const g = grupo()
      const alterados = [
        { ...g, dono: A }, { ...g, operacao: { ...g.operacao, dono: A } },
        { ...g, operacao: { ...g.operacao, id: 'sem-id' } },
        { ...g, operacao: { ...g.operacao, revisao: 1.5 } },
        { ...g, operacao: { ...g.operacao, formato: 2 } },
        { ...g, operacao: { ...g.operacao, fatos: [] } },
        { ...g, fatos: g.fatos.map((f) => ({ ...f, valor: 100 })) },
      ]
      for (const alterado of alterados) expect(await recusa(tx, (sp) => aceitar(sp, alterado))).toBe('23514')
      for (const documento of [null, [], {}, { operacao: g.operacao, fatos: null }]) {
        expect(await recusa(tx, (sp) => sp`select public.aceitar_grupo_caixa(${documento}::jsonb)`)).toBe('23514')
      }
      expect(await baixar(tx)).toEqual([])
    })
  })

  test('SQL direto: id obrigatório, conteúdo vinculado ao id/revisão e manifesto completo', async () => {
    await transacao(async (tx) => {
      await tx.unsafe('reset role')
      expect(await recusa(tx, (sp) => sp`insert into public.operacoes_caixa(dono,revisao,formato,tipo,fatos)
        values(${A}::uuid,1,1,'registro','[]')`)).toBe('23502')
      const g = grupo()
      expect(await recusa(tx, async (sp) => {
        await inserirOperacao(sp, g)
        await sp.unsafe('set constraints all immediate')
      }, 'caixa_grupo_incompleto')).toBe('23514')
      const f = g.fatos[0]
      if (!f) throw new Error('amostra sem fato')
      expect(await recusa(tx, (sp) => sp`insert into public.fatos_caixa(dono,revisao,operacao_id,revisao_operacao,conteudo)
        values(${A}::uuid,1,${g.operacao.id}::uuid,1,${f}::jsonb)`)).toBe('23502')
      for (const conteudo of [{ ...f, id: uuidv7() }, { ...f, revisao: 2 }]) {
        expect(await recusa(tx, (sp) => sp`insert into public.fatos_caixa(id,dono,revisao,operacao_id,revisao_operacao,conteudo)
          values(${f.id}::uuid,${A}::uuid,1,${g.operacao.id}::uuid,1,${conteudo}::jsonb)`, 'fatos_caixa_conteudo')).toBe('23514')
      }
      const repetido = { ...g, operacao: { ...g.operacao, fatos: [{ id: f.id, revisao: 1 }, { id: f.id, revisao: 2 }] } }
      expect(await recusa(tx, (sp) => direto(sp, repetido), 'caixa_grupo_incompleto')).toBe('23514')
      expect(await recusa(tx, (sp) => direto(sp, { ...g, operacao: { ...g.operacao, id: f.id } }), 'caixa_identidade_reutilizada')).toBe('23514')
      await direto(tx, g)
    })
  })

  test('histórico de caixa é imutável inclusive para postgres e não muda por upsert divergente', async () => {
    await transacao(async (tx) => {
      const g = grupo(), f = g.fatos[0]
      if (!f) throw new Error('amostra sem fato')
      await aceitar(tx, g)
      await tx.unsafe('reset role')
      expect(await tx`update public.fatos_caixa set conteudo=conteudo where id=${f.id}::uuid returning id`).toHaveLength(1)
      expect(await tx`update public.operacoes_caixa set tipo=tipo where id=${g.operacao.id}::uuid returning id`).toHaveLength(1)
      for (const tabela of ['fatos_caixa','operacoes_caixa']) {
        expect(await recusa(tx, (sp) => sp.unsafe(`delete from public.${tabela} where dono='${A}'`), 'caixa_imutavel')).toBe('23514')
        expect(await recusa(tx, (sp) => sp.unsafe(`update public.${tabela} set revisao=2 where dono='${A}'`), 'caixa_imutavel')).toBe('23514')
      }
      expect(await recusa(tx, (sp) => sp`insert into public.fatos_caixa(id,dono,revisao,operacao_id,revisao_operacao,conteudo)
        values(${f.id}::uuid,${A}::uuid,1,${g.operacao.id}::uuid,1,${{ ...f, valor: '999' }}::jsonb)
        on conflict(id) do update set conteudo=excluded.conteudo`, 'caixa_imutavel')).toBe('23514')
    })
  })

  test('RLS, ACL, sessão e dono/alvo isolam duas contas inclusive na RPC', async () => {
    await transacao(async (tx) => {
      const g = grupo(), f = g.fatos[0]
      if (!f) throw new Error('amostra sem fato')
      await aceitar(tx, g)
      await assumir(tx, B)
      expect(await tx`select id from public.fatos_caixa where id=${f.id}::uuid`).toHaveLength(0)
      expect(await tx`select id from public.operacoes_caixa where id=${g.operacao.id}::uuid`).toHaveLength(0)
      expect(await recusa(tx, (sp) => aceitar(sp, corrigir(f)), 'caixa_alvo_invalido')).toBe('23514')
      expect(await recusa(tx, (sp) => inserirOperacao(sp, grupo(), B))).toBe('42501')
      expect(await recusa(tx, (sp) => sp`update public.fatos_caixa set revisao=2`)).toBe('42501')
      expect(await recusa(tx, (sp) => sp`delete from public.operacoes_caixa`)).toBe('42501')
      await tx.unsafe('set local role anon')
      expect(await recusa(tx, (sp) => sp`select * from public.fatos_caixa`)).toBe('42501')
      expect(await recusa(tx, (sp) => aceitar(sp, grupo()))).toBe('42501')
      await tx.unsafe('reset role')
      await tx`select set_config('request.jwt.claims','{}',true)`
      expect(await recusa(tx, (sp) => aceitar(sp, grupo()), 'caixa_sessao_obrigatoria')).toBe('23514')
    })
  })

  test('correção composta preserva alvo, estorno/substituto e reenvio; recusa segundo grupo inteiro', async () => {
    await transacao(async (tx) => {
      const original = movimento(), g = grupo('registro', [original])
      await aceitar(tx, g)
      const correcao = corrigir(original), posicao = await aceitar(tx, correcao)
      expect(await aceitar(tx, correcao)).toBe(posicao)
      for (const tipo of ['correcao','estorno']) {
        expect(await recusa(tx, (sp) => aceitar(sp, corrigir(original, tipo)), 'operacoes_caixa_um_alvo')).toBe('23505')
      }
      expect((await baixar(tx)).map((r) => r['grupo'])).toEqual([g, correcao])
      expect(await tx`select id from public.fatos_caixa`).toHaveLength(3)
    })
  })

  test('SQL direto: correção pela metade, alvo/revisão/dono, estorno de estorno e tipo de grupo recusados', async () => {
    await transacao(async (tx) => {
      const original = movimento()
      await aceitar(tx, grupo('registro', [original]))
      await tx.unsafe('reset role')
      const c = corrigir(original), estorno = c.fatos[0], substituto = c.fatos[1]
      if (!estorno || !substituto) throw new Error('amostra sem correção')
      const metades = [grupo('correcao', [estorno], { id: original.id, revisao: 1 }),
        grupo('correcao', [substituto], { id: original.id, revisao: 1 }),
        grupo('estorno', [estorno, substituto], { id: original.id, revisao: 1 })]
      for (const metade of metades) expect(await recusa(tx, (sp) => direto(sp, metade), 'caixa_efeitos_invalidos')).toBe('23514')
      expect(await recusa(tx, (sp) => direto(sp, c, B))).toMatch(/^23/)
      const revisaoErrada = corrigir({ ...original, revisao: 2 })
      expect(await recusa(tx, (sp) => direto(sp, revisaoErrada), 'operacoes_caixa_alvo_fato')).toBe('23503')
      const alvoErrado = { ...c, fatos: [{ ...estorno, alvo: { id: uuidv7(), revisao: 1 } }, substituto] }
      expect(await recusa(tx, (sp) => direto(sp, alvoErrado), 'caixa_alvo_divergente')).toBe('23514')
      await direto(tx, c)
      expect(await recusa(tx, (sp) => direto(sp, corrigir(estorno)), 'caixa_alvo_invalido')).toBe('23514')
      expect(await recusa(tx, (sp) => direto(sp, corrigir(original)), 'operacoes_caixa_um_alvo')).toBe('23505')
      expect(await tx`select id from public.fatos_caixa where dono=${A}::uuid`).toHaveLength(3)
    })
  })

  test('índice de estorno protege o alvo mesmo se um manifesto tenta usar outro alvo', async () => {
    await transacao(async (tx) => {
      const f1 = movimento(), f2 = movimento()
      await aceitar(tx, grupo('registro', [f1]))
      await aceitar(tx, grupo('registro', [f2]))
      await aceitar(tx, corrigir(f1, 'estorno'))
      await tx.unsafe('reset role')
      const c = corrigir(f1)
      c.operacao['alvo'] = { id: f2.id, revisao: 1 }
      expect(await recusa(tx, (sp) => direto(sp, c), 'fatos_caixa_um_estorno')).toBe('23505')
    })
  })

  test('falha no segundo efeito desfaz manifesto, estorno, contador e nenhum órfão fica', async () => {
    await transacao(async (tx) => {
      const original = movimento()
      await aceitar(tx, grupo('registro', [original]))
      const c = corrigir(original), estorno = c.fatos[0], substituto = c.fatos[1]
      if (!estorno || !substituto) throw new Error('amostra sem correção')
      await tx.unsafe('reset role')
      const antes = await tx`select ultimo::text from caixa_interno.contadores where dono=${A}::uuid`
      // Falha após inserir o estorno, por identidade já ocupada no primeiro grupo.
      const colidido = { ...substituto, id: original.id }
      const falha = { ...c, fatos: [estorno, colidido] }
      expect(await recusa(tx, async (sp) => {
        await inserirOperacao(sp, c)
        await inserirFatos(sp, falha)
      })).toBe('23505')
      expect(await tx`select ultimo::text from caixa_interno.contadores where dono=${A}::uuid`).toEqual(antes)
      expect(await tx`select id from public.operacoes_caixa where id=${c.operacao.id}::uuid`).toHaveLength(0)
      expect(await tx`select id from public.fatos_caixa where dono=${A}::uuid`).toHaveLength(1)
      await assumir(tx)
      expect(await aceitar(tx, c)).toBe('2')
    })
  })

  test('download pagina grupos completos com cursor textual e rejeita limites/cursores inválidos', async () => {
    await transacao(async (tx) => {
      const original = movimento(), g = grupo('registro', [original]), c = corrigir(original)
      const p1 = await aceitar(tx, g), p2 = await aceitar(tx, c)
      expect(await baixar(tx, '0', 1)).toEqual([{ recepcao: p1, grupo: g }])
      expect(await baixar(tx, p1, 1)).toEqual([{ recepcao: p2, grupo: c }])
      expect(await baixar(tx, p2)).toEqual([])
      for (const cursor of ['-1','0.5','9223372036854775808','texto']) {
        expect(await recusa(tx, (sp) => baixar(sp, cursor), 'caixa_cursor_invalido')).toBe('23514')
      }
      for (const limite of [0,501]) expect(await recusa(tx, (sp) => baixar(sp, '0', limite), 'caixa_cursor_invalido')).toBe('23514')
    })
  })

  test('upgrade/reversão vazia preservam histórico F1/F2/fotos; reversão com caixa recusa sem alteração', async () => {
    await transacao(async (tx) => {
      await tx.unsafe('reset role')
      const m = (await lerMigracoes()).find(({ nome }) => nome.startsWith('0008_'))
      if (!m) throw new Error('migration de caixa ausente')
      const tabelas = ['clientes','lancamentos','categorias','produtos','operacoes_estoque','movimentos_estoque','encerramentos_estoque',
        'fotos_interno.fotos','fotos_interno.copias','fotos_interno.protecoes']
      const fotografar = async (sp: SQL): Promise<unknown[]> => {
        const resultado: unknown[] = []
        for (const tabela of tabelas) {
          const nome = tabela.includes('.') ? tabela : `public.${tabela}`
          resultado.push(await sp.unsafe(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]') foto from ${nome} t`))
        }
        return resultado
      }
      const antes = await fotografar(tx)
      // O banco de ensaio acumulou caixa: exercitar também o caminho vazio sem excluir
      // esse histórico. Apenas os nomes qualificados dos objetos NOVOS são realocados.
      const sufixo = uuidv7().replaceAll('-', '')
      const esquema = `prova_caixa_${sufixo}`, interno = `prova_caixa_interno_${sufixo}`
      const realocar = (texto: string): string => texto.replaceAll('caixa_interno', interno)
        .replaceAll('public.operacoes_caixa', `${esquema}.operacoes_caixa`)
        .replaceAll('public.fatos_caixa', `${esquema}.fatos_caixa`)
        .replaceAll('public.aceitar_grupo_caixa', `${esquema}.aceitar_grupo_caixa`)
        .replaceAll('public.baixar_caixa', `${esquema}.baixar_caixa`)
      await tx.unsafe(`create schema ${esquema}`)
      await tx.unsafe(realocar(m.aplicar))
      expect(await fotografar(tx)).toEqual(antes)
      await tx.unsafe(realocar(m.reverter))
      expect(await tx<Documento[]>`select to_regclass(${`${esquema}.fatos_caixa`}) tabela`).toEqual([{ tabela: null }])
      expect(await fotografar(tx)).toEqual(antes)
      await tx.unsafe(realocar(m.aplicar))
      expect(await fotografar(tx)).toEqual(antes)
      const temDados = await tx<{ n: number }[]>`select count(*)::int n from public.operacoes_caixa`
      if (temDados[0]?.n === 0) {
        await tx.unsafe(m.reverter)
        expect(await tx<Documento[]>`select to_regclass('public.fatos_caixa') tabela`).toEqual([{ tabela: null }])
        expect(await fotografar(tx)).toEqual(antes)
        await tx.unsafe(m.aplicar)
        expect(await fotografar(tx)).toEqual(antes)
      } else {
        // O histórico de ensaios permanece: não limpar para forçar a reversão.
        expect(await recusa(tx, (sp) => sp.unsafe(m.reverter))).toBe('P0001')
        expect(await fotografar(tx)).toEqual(antes)
      }
      await assumir(tx)
      const g = grupo()
      await aceitar(tx, g)
      await tx.unsafe('set constraints all immediate')
      await tx.unsafe('reset role')
      expect(await recusa(tx, (sp) => sp.unsafe(m.reverter))).toBe('P0001')
      expect(await fotografar(tx)).toEqual(antes)
      await assumir(tx)
      expect((await baixar(tx)).map((r) => r['grupo'])).toEqual([g])
    })
  })

  test('duas conexões: primeiro commit vence correção/estorno, rollback libera e reenvio conserva posição', async () => {
    for (const [inversa,sqlDireto] of [[false,false],[true,false],[false,true],[true,true]]) {
      const conta = uuidv7(), original = movimento(), g = grupo('registro', [original])
      await sql.begin(async (tx) => { await assumir(tx, conta); await aceitar(tx, g) })
      const c1 = corrigir(original), c2 = corrigir(original, 'estorno')
      const primeiro = inversa ? c2 : c1, segundo = inversa ? c1 : c2
      expect(await disputar(conta, primeiro, segundo, false, sqlDireto)).toBe('23505')
      await sql.begin(async (tx) => {
        await assumir(tx, conta)
        expect((await baixar(tx)).map((r) => r['grupo'])).toEqual([g,primeiro])
      })
    }
    const conta = uuidv7(), g = grupo()
    expect(await disputar(conta, g, g, true)).toBe('aceita')
    expect(await disputar(conta, g, g)).toBe('aceita')
  })

  test('RPC/PostgREST real: resposta perdida, centavos textuais, recusa definitiva e grupo inteiro', async () => {
    const cliente = createClient(process.env.VITE_SUPABASE_URL ?? '', process.env.VITE_SUPABASE_ANON_KEY ?? '', {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    try {
      const login = await cliente.auth.signInWithPassword({ email: process.env.SUPABASE_TESTE_EMAIL ?? '', password: process.env.SUPABASE_TESTE_SENHA ?? '' })
      if (login.error) throw new Error('login fictício de E-32 falhou')
      const original = movimento({ valor: '9007199254740993' }), g = grupo('registro', [original]), c = corrigir(original)
      const primeira = await cliente.rpc('aceitar_grupo_caixa', { grupo: g })
      expect(primeira.error).toBeNull()
      expect(typeof primeira.data).toBe('string')
      expect((await cliente.rpc('aceitar_grupo_caixa', { grupo: g })).data).toBe(primeira.data)
      expect((await cliente.rpc('aceitar_grupo_caixa', { grupo: { ...g, fatos: [{ ...original, valor: '1' }] } })).error?.code).toBe('23514')
      expect((await cliente.rpc('aceitar_grupo_caixa', { grupo: c })).error).toBeNull()
      expect((await cliente.rpc('aceitar_grupo_caixa', { grupo: corrigir(original) })).error?.code).toBe('23505')
      const { data, error } = await cliente.rpc('baixar_caixa', { apos: '0', limite: 500 })
      expect(error).toBeNull()
      const linhas: Documento[] = data
      expect(linhas.map((r) => r['grupo'])).toContainEqual(g)
      expect(linhas.map((r) => r['grupo'])).toContainEqual(c)
      expect((await cliente.from('fatos_caixa').select('valor::text').eq('id', original.id).single()).data?.valor).toBe('9007199254740993')
    } finally { await cliente.auth.signOut() }
  })
})

/** Confere bloqueio real no Postgres antes de liberar o commit/rollback da primeira conexão. */
async function disputar(conta: string, primeiro: Grupo, segundo: Grupo, rollback = false, sqlDireto = false): Promise<string> {
  const c1 = conectar(), c2 = conectar()
  let liberar: () => void = () => undefined, notificar: () => void = () => undefined
  let informarPid: (pid: number) => void = () => undefined
  const liberacao = new Promise<void>((resolve) => { liberar = resolve })
  const pronta = new Promise<void>((resolve) => { notificar = resolve })
  const pidPronto = new Promise<number>((resolve) => { informarPid = resolve })
  let p1: Promise<unknown> | undefined, p2: Promise<string> | undefined
  const escrever = async (tx: SQL, g: Grupo): Promise<void> => {
    if (sqlDireto) {
      await tx.unsafe('reset role')
      await direto(tx, g, conta)
    } else await aceitar(tx, g)
  }
  try {
    p1 = c1.begin(async (tx) => {
      await assumir(tx, conta)
      await escrever(tx, primeiro)
      notificar()
      await liberacao
      if (rollback) throw new Revertida()
    }).catch((erro: unknown) => { if (!(erro instanceof Revertida)) throw erro })
    await Promise.race([pronta,p1.then(() => { throw new Error('primeira conexão terminou antes da disputa') })])
    p2 = c2.begin(async (tx) => {
      await assumir(tx, conta)
      const [r] = await tx<{ pid: number }[]>`select pg_backend_pid() pid`
      if (!r) throw new Error('sem pid')
      informarPid(r.pid)
      await escrever(tx, segundo)
      return 'aceita'
    }).catch((erro: unknown) => {
      if (!(erro instanceof SQL.PostgresError)) throw erro
      return erro.errno ?? erro.code
    })
    const pid = await Promise.race([pidPronto,p2.then(() => { throw new Error('segunda conexão terminou antes da disputa') })])
    const ate = Date.now() + 10_000
    let bloqueada = false
    while (Date.now() < ate) {
      const [r] = await sql<{ bloqueada: boolean }[]>`select cardinality(pg_blocking_pids(${pid}))>0 bloqueada`
      if (r?.bloqueada) { bloqueada = true; break }
      await Bun.sleep(20)
    }
    expect(bloqueada).toBe(true)
    liberar()
    await p1
    return await p2
  } finally {
    liberar()
    await Promise.allSettled([p1,p2])
    await Promise.all([c1.close(),c2.close()])
  }
}
