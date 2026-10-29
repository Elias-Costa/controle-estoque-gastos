import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { SQL } from 'bun'
import { exigirDestinoDeTeste } from '../../nuvem/ambiente-de-teste.ts'
import { conectar, lerMigracoes } from '../../nuvem/migrar.ts'
import { uuidv7 } from '../../src/dados/identidade.ts'
import { MODELOS_ORIGINAIS } from '../../src/dados/modelos-whatsapp.ts'

const LIGADA = process.env.INTEGRACAO === '1'
if (LIGADA) exigirDestinoDeTeste()
let sql: SQL
class Revertida extends Error {}
beforeAll(() => { if (LIGADA) sql = conectar() })
afterAll(async () => { if (LIGADA) await sql.close() })

describe.skipIf(!LIGADA)('E-28D: migrations em ordem de chegada, SQL real isolado em rollback', () => {
  for (const caminho of ['F2.1 → F3', 'F3 → melhoria']) test(`${caminho} preenchida conserva dados e permite caixa, modelos e identidade`, async () => {
    try {
      await sql.begin(async (tx) => {
        const conta = uuidv7(), prefixo = `e28d_${uuidv7().replaceAll('-', '')}`
        await tx`select set_config('request.jwt.claims',${JSON.stringify({ sub: conta, role: 'authenticated' })},true)`
        const realocar = (texto: string) => texto.replaceAll('public.', `${prefixo}.`)
          .replaceAll('estoque_interno', `${prefixo}_estoque`).replaceAll('fotos_interno', `${prefixo}_fotos`)
          .replaceAll('caixa_interno', `${prefixo}_caixa`).replaceAll('fotos_objetos_', `${prefixo}_objetos_`)
        const migracoes = await lerMigracoes()
        await tx.unsafe(`create schema ${prefixo}; grant usage on schema ${prefixo} to authenticated`)
        for (const m of migracoes.filter((m) => m.nome < '0008')) await tx.unsafe(realocar(m.aplicar))
        const f21 = migracoes.filter((m) => m.nome >= '0010'), f3 = migracoes.filter((m) => m.nome >= '0008' && m.nome < '0010')
        expect(f21).toHaveLength(3); expect(f3).toHaveLength(2)
        for (const m of caminho === 'F2.1 → F3' ? f21 : f3) await tx.unsafe(realocar(m.aplicar))
        const categoriaId = uuidv7(), produtoId = uuidv7(), clienteId = uuidv7()
        await tx.unsafe(`select ${prefixo}.gravar_categoria_estoque($1::jsonb)`, [{ id: categoriaId, nome: 'Categoria anterior à união' }])
        const cadastro = { id: produtoId, categoriaId, nome: 'Produto anterior à união', atualizadoEm: '2026-10-29T12:00:00.000Z',
          custoManual: '9007199254740993', ...(caminho === 'F2.1 → F3' ? { classificacao: 'unissex' } : {}) }
        await tx.unsafe(`select ${prefixo}.gravar_produto_estoque($1::jsonb)`, [cadastro])
        await tx.unsafe(`insert into ${prefixo}.clientes(id,nome) values($1,'Ficha preservada')`, [clienteId])
        await tx.unsafe(`insert into ${prefixo}.lancamentos(id,cliente_id,data,tipo,pagamento,itens,desconto,parcelas)
          values($1,$2,'2026-10-29','venda','fiado',$3::jsonb,0,$4::jsonb)`,
        [uuidv7(), clienteId, [{ descricao: 'Item preservado', preco: '5000' }], [{ id: uuidv7(), vencimento: '2026-11-29', valor: '5000' }]])
        const op = uuidv7(), movimentoId = uuidv7()
        await tx.unsafe(`select ${prefixo}.aceitar_grupo_estoque($1::jsonb)`, [{
          operacao: { id: op, revisao: 1, formato: 1, tipo: 'movimento', lancamentos: [], movimentos: [{ id: movimentoId, revisao: 1 }], dependencias: [] },
          lancamentos: [], movimentos: [{ id: movimentoId, revisao: 1, operacaoId: op, produtoId, data: '2026-10-29', tipo: 'compra',
            quantidade: 3, custoUnitario: '9007199254740993', ordemCadastro: '123', conhecidos: [] }],
        }])
        async function guardarCaixaEModelos() {
          const id = uuidv7(), fatoId = uuidv7()
          await tx.unsafe(`select ${prefixo}.aceitar_grupo_caixa($1::jsonb)`, [{
            operacao: { id, revisao: 1, formato: 1, tipo: 'registro', fatos: [{ id: fatoId, revisao: 1 }] },
            fatos: [{ id: fatoId, revisao: 1, tipo: 'despesa', data: '2026-10-29', valor: '9007199254740993',
              categoria: 'Anterior à união', classificacao: 'negocio', mercadoria: true }],
          }])
          await tx.unsafe(`insert into ${prefixo}.modelos_whatsapp(chave,id,modelos,atualizado_em) values('whatsapp',$1,$2::jsonb,now())`, [uuidv7(), MODELOS_ORIGINAIS])
        }
        async function guardarIdentidade() {
          await tx.unsafe(`insert into ${prefixo}.identidades_loja(dono,chave,id,identidade,atualizado_em)
            values($1,'loja',$2,$3::jsonb,now())`, [conta, uuidv7(), { nome: 'Identidade preservada', descricao: 'Anterior à união' }])
          await tx.unsafe(`insert into ${prefixo}.contato_suporte(chave,telefone) values('mantenedor','5500000000000')`)
        }
        if (caminho === 'F3 → melhoria') await guardarCaixaEModelos()
        else await guardarIdentidade()
        const existentes = await tx<{ tablename: string }[]>`select tablename from pg_tables where schemaname=${prefixo} order by tablename`
        const antes = new Map<string, unknown>()
        for (const { tablename } of existentes) {
          antes.set(tablename, await tx.unsafe(`select to_jsonb(t) linha from ${prefixo}.${tablename} t order by to_jsonb(t)::text`))
        }
        // Aplica literalmente 0008/0009 depois de 0010/0011/0012, ou a melhoria depois da F3.
        for (const m of caminho === 'F2.1 → F3' ? f3 : f21) await tx.unsafe(realocar(m.aplicar))
        for (const { tablename } of existentes) {
          const projecao = tablename === 'produtos' && caminho === 'F3 → melhoria' ? "to_jsonb(t)-'classificacao'" : 'to_jsonb(t)'
          expect<unknown>(await tx.unsafe(`select ${projecao} linha from ${prefixo}.${tablename} t order by to_jsonb(t)::text`)).toEqual(antes.get(tablename))
        }
        if (caminho === 'F2.1 → F3') await guardarCaixaEModelos()
        else await guardarIdentidade()
        expect((await tx.unsafe(`select valor::text valor from ${prefixo}.fatos_caixa where tipo='despesa'`))[0]?.valor).toBe('9007199254740993')
        expect((await tx.unsafe(`select classificacao from ${prefixo}.produtos where id=$1`, [produtoId]))[0]?.classificacao).toBe(caminho === 'F2.1 → F3' ? 'unissex' : null)
        expect(await tx.unsafe(`select id from ${prefixo}.modelos_whatsapp`)).toHaveLength(1)
        expect(await tx.unsafe(`select id from ${prefixo}.identidades_loja`)).toHaveLength(1)
        throw new Revertida()
      })
    } catch (erro) { if (!(erro instanceof Revertida)) throw erro }
  }, 120_000)
})
