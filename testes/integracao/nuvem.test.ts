import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { SQL, type TransactionSQL } from 'bun'
import { conectar, lerMigracoes, type Migracao } from '../../nuvem/migrar.ts'
import { uuidv7 } from '../../src/dados/identidade.ts'

/**
 * A nuvem recusa o que o app não pode gravar (E-06, RI-09, D-041).
 *
 * Cada teste tenta violar uma invariante **direto no banco**, contornando o app: conexão
 * Postgres por `Bun.sql`, sem PostgREST, sem `supabase-js`, sem domínio. O critério de E-06 é
 * este — garantia que só existe no código do app não conta.
 *
 * Como não deixa rastro: cada teste roda dentro de `sql.begin` e termina lançando `Revertida`,
 * então a transação é desfeita; cada tentativa de violação vai num `savepoint`, para a
 * transação seguir viva depois do erro. Importa porque a imutabilidade impede o próprio teste
 * de apagar o que criou — e porque este é o banco **dela**, não um de laboratório.
 *
 * Contas: `auth.uid()` do Supabase lê `request.jwt.claims` e não consulta `auth.users`, então
 * duas contas de mentira bastam — dois `sub` diferentes com `set local role authenticated`.
 * O papel `postgres` (o da conexão) ignora RLS por atributo próprio; é usado aqui só para provar
 * que os gatilhos valem para **qualquer** papel.
 *
 * Só roda com `INTEGRACAO=1` (`bun run test:integracao`): precisa de rede e de
 * `SUPABASE_DB_URL` em `.env.local`. No `check` aparece como pulada, de propósito.
 */

const LIGADA = process.env.INTEGRACAO === '1'

/**
 * Verificação por mutação, sem tocar o banco de verdade: um DDL que tira uma garantia (ex.:
 * `drop trigger lancamentos_imutavel on public.lancamentos`), aplicado no início de cada
 * transação de teste e desfeito com ela. A suíte tem de ficar vermelha; se ficar verde, a
 * garantia não estava sendo provada. Uso: `MUTACAO="<sql>" bun run test:integracao`.
 */
const MUTACAO = process.env.MUTACAO

const CONTA_A = '00000000-0000-4000-8000-00000000000a'
const CONTA_B = '00000000-0000-4000-8000-00000000000b'
const HOJE = '2026-09-11'

/** Sinal de "desfaça tudo": a transação termina, o banco volta ao que era. */
class Revertida extends Error {}

/** O que o banco disse ao recusar: o SQLSTATE e, quando há, o nome da constraint ou do gatilho. */
type Recusa = { readonly code: string; readonly constraint: string | undefined }

let sql: SQL
let migracoes: Migracao[]

beforeAll(async () => {
  if (!LIGADA) return
  sql = conectar()
  migracoes = await lerMigracoes()
})

afterAll(async () => {
  if (LIGADA) await sql.close()
})

/** Roda `fn` numa transação e a desfaz no fim, aconteça o que acontecer. */
async function numaTransacao(fn: (tx: TransactionSQL) => Promise<void>): Promise<void> {
  try {
    await sql.begin(async (tx) => {
      if (MUTACAO !== undefined && MUTACAO !== '') await tx.unsafe(MUTACAO)
      await fn(tx)
      throw new Revertida()
    })
  } catch (erro) {
    if (!(erro instanceof Revertida)) throw erro
  }
}

/**
 * Tenta `fn` num savepoint e devolve a recusa do banco. Se o banco **aceitar**, o teste falha —
 * é o caso que importa. O savepoint desfeito também desfaz `set local role`.
 */
async function recusa(tx: TransactionSQL, fn: (sp: SQL) => Promise<unknown>): Promise<Recusa> {
  try {
    await tx.savepoint(async (sp) => {
      await fn(sp)
    })
  } catch (erro) {
    // No Bun, `code` é o genérico `ERR_POSTGRES_SERVER_ERROR`; o SQLSTATE do Postgres vem em `errno`.
    if (erro instanceof SQL.PostgresError) return { code: erro.errno ?? erro.code, constraint: erro.constraint }
    throw erro
  }
  throw new Error('o banco aceitou o que deveria recusar')
}

/** Passa a agir como uma conta do app, até o fim da transação (ou do savepoint). */
async function assumir(tx: SQL, conta: string): Promise<void> {
  const claims = JSON.stringify({ sub: conta, role: 'authenticated' })
  await tx`select set_config('request.jwt.claims', ${claims}, true)`
  await tx.unsafe('set local role authenticated')
}

/** Passa a agir como quem não tem sessão. */
async function anonimo(tx: SQL): Promise<void> {
  await tx.unsafe('set local role anon')
}

/** Volta ao papel da conexão (`postgres`), que ignora RLS. */
async function comoPostgres(tx: SQL): Promise<void> {
  await tx.unsafe('reset role')
}

async function criarCliente(tx: SQL, id: string, nome = 'Vera'): Promise<void> {
  await tx`insert into public.clientes (id, nome) values (${id}::uuid, ${nome})`
}

/**
 * Uma linha de lançamento como E-07 vai mandar: dinheiro como texto de centavos; itens e parcelas
 * como o objeto JS, não como texto JSON — o `Bun.sql` tipa o parâmetro pelo que o Postgres infere,
 * e um texto em `${texto}::jsonb` vira um jsonb **string**, não o documento (verificado em E-06).
 */
type Linha = {
  readonly id?: string
  readonly clienteId: string
  readonly data?: string
  readonly tipo: string
  readonly pagamento?: string
  readonly forma?: string
  readonly itens?: unknown
  readonly desconto?: string
  readonly parcelas?: unknown
  readonly valor?: string
  readonly observacao?: string
  readonly estornaId?: string
  readonly motivo?: string
}

async function inserir(tx: SQL, linha: Linha): Promise<string> {
  const id = linha.id ?? uuidv7()
  await tx`insert into public.lancamentos
    (id, cliente_id, data, tipo, pagamento, forma, itens, desconto, parcelas, valor, observacao, estorna_id, motivo)
    values (${id}::uuid, ${linha.clienteId}::uuid, ${linha.data ?? HOJE}::date, ${linha.tipo},
      ${linha.pagamento ?? null}, ${linha.forma ?? null}, ${linha.itens ?? null}::jsonb, ${linha.desconto ?? null}::bigint,
      ${linha.parcelas ?? null}::jsonb, ${linha.valor ?? null}::bigint, ${linha.observacao ?? null},
      ${linha.estornaId ?? null}::uuid, ${linha.motivo ?? null})`
  return id
}

function parcela(valor: string, vencimento = '2026-10-11', id = uuidv7()): { id: string; vencimento: string; valor: string } {
  return { id, vencimento, valor }
}

/** Uma venda fiado de R$ 39,90 + R$ 25,00, sem desconto, em 2× de R$ 32,45. */
function vendaFiado(clienteId: string): Linha {
  return {
    clienteId,
    tipo: 'venda',
    pagamento: 'fiado',
    itens: [{ descricao: 'Perfume', preco: '3990' }, { descricao: 'Batom', preco: '2500' }],
    desconto: '0',
    parcelas: [parcela('3245', '2026-10-11'), parcela('3245', '2026-11-11')],
  }
}

function recebimento(clienteId: string, valor = '3000'): Linha {
  return { clienteId, tipo: 'recebimento', valor, forma: 'dinheiro' }
}

/** Quantas linhas e quantos ids distintos: é o par que prova ausência de duplicata (E-00). */
async function contagem(tx: SQL): Promise<{ linhas: number; ids: number }> {
  const [linha] = await tx<{ linhas: number; ids: number }[]>`
    select count(*)::int as linhas, count(distinct id)::int as ids from public.lancamentos`
  if (linha === undefined) throw new Error('sem contagem')
  return linha
}

describe.skipIf(!LIGADA)('a nuvem recusa o que o app não pode gravar (E-06, RI-09, D-041)', () => {
  test('a migration está aplicada e registrada', async () => {
    const registro = await sql<{ nome: string }[]>`select nome from public.migracoes order by nome`
    expect(registro.map((linha) => linha.nome)).toEqual(migracoes.map((migracao) => migracao.nome))
    const [tabelas] = await sql<{ n: number }[]>`
      select count(*)::int as n from pg_tables where schemaname = 'public' and tablename in ('clientes', 'lancamentos')`
    expect(tabelas?.n).toBe(2)
  })

  describe('isolamento por conta (RNF-07): política de linha, não consulta do app', () => {
    test('a outra conta não lê, não altera e não grava na conta dela; sem sessão, nada', async () => {
      await numaTransacao(async (tx) => {
        await assumir(tx, CONTA_A)
        const clienteId = uuidv7()
        await criarCliente(tx, clienteId)
        const lancamentoId = await inserir(tx, recebimento(clienteId))
        expect(await contagem(tx)).toEqual({ linhas: 1, ids: 1 })

        // A conta B vê uma base vazia — e um update dela toca zero linhas, sem erro (é RLS, não gatilho).
        await assumir(tx, CONTA_B)
        expect(await contagem(tx)).toEqual({ linhas: 0, ids: 0 })
        expect(await tx`select id from public.clientes`).toHaveLength(0)
        const tocadas = await tx`update public.clientes set nome = 'Outra' where id = ${clienteId}::uuid returning id`
        expect(tocadas).toHaveLength(0)

        // B não consegue gravar em nome de A: o `with check` da política recusa.
        const emNomeDeA = await recusa(tx, (sp) =>
          sp`insert into public.clientes (id, dono, nome) values (${uuidv7()}::uuid, ${CONTA_A}::uuid, 'Intrusa')`,
        )
        expect(emNomeDeA.code).toBe('42501')

        // B não consegue lançar na ficha de A nem sabendo o id do cliente: a FK é composta com o dono.
        const naFichaDeA = await recusa(tx, (sp) => inserir(sp, recebimento(clienteId)))
        expect(naFichaDeA).toEqual({ code: '23503', constraint: 'lancamentos_cliente' })

        // B não estorna o lançamento de A: mesma FK composta, agora no alvo do estorno.
        const clienteDeB = uuidv7()
        await criarCliente(tx, clienteDeB, 'Cliente de B')
        const estornoAlheio = await recusa(tx, (sp) =>
          inserir(sp, { clienteId: clienteDeB, tipo: 'estorno', estornaId: lancamentoId }),
        )
        expect(estornoAlheio).toEqual({ code: '23503', constraint: 'lancamentos_estorno_alvo' })

        // Sem sessão: nem ler, nem gravar. É privilégio negado, antes mesmo de chegar à política.
        const semSessaoLe = await recusa(tx, async (sp) => {
          await anonimo(sp)
          await sp`select count(*) from public.lancamentos`
        })
        expect(semSessaoLe.code).toBe('42501')
        const semSessaoGrava = await recusa(tx, async (sp) => {
          await anonimo(sp)
          await sp`insert into public.clientes (id, nome) values (${uuidv7()}::uuid, 'Anônima')`
        })
        expect(semSessaoGrava.code).toBe('42501')

        // A continua vendo o que gravou.
        await assumir(tx, CONTA_A)
        expect(await contagem(tx)).toEqual({ linhas: 1, ids: 1 })
      })
    })

    test('o dono é carimbado pelo banco: o app não envia, e a linha nasce da conta que a gravou', async () => {
      await numaTransacao(async (tx) => {
        await assumir(tx, CONTA_A)
        const clienteId = uuidv7()
        await criarCliente(tx, clienteId)
        const [cliente] = await tx<{ dono: string }[]>`select dono from public.clientes where id = ${clienteId}::uuid`
        expect(cliente?.dono).toBe(CONTA_A)
      })
    })
  })

  describe('idempotência (RI-05, EL-04): reenviar não duplica, e reenviar diferente não passa em silêncio', () => {
    test('o mesmo upsert duas vezes é uma linha e um id; um insert repetido é violação de unicidade', async () => {
      await numaTransacao(async (tx) => {
        await assumir(tx, CONTA_A)
        const clienteId = uuidv7()
        await criarCliente(tx, clienteId)
        const id = uuidv7()
        const upsert = (sp: SQL) => sp`insert into public.lancamentos (id, cliente_id, data, tipo, valor, forma)
          values (${id}::uuid, ${clienteId}::uuid, ${HOJE}::date, 'recebimento', ${'3000'}::bigint, 'pix')
          on conflict (id) do update set cliente_id = excluded.cliente_id, data = excluded.data,
            tipo = excluded.tipo, valor = excluded.valor, forma = excluded.forma`
        await upsert(tx)
        await upsert(tx)
        expect(await contagem(tx)).toEqual({ linhas: 1, ids: 1 })

        const repetido = await recusa(tx, (sp) => inserir(sp, { ...recebimento(clienteId), id }))
        expect(repetido).toEqual({ code: '23505', constraint: 'lancamentos_pkey' })
      })
    })

    test('upsert com conteúdo diferente para um id que já existe é erro, não sobrescrita (D-041, item 2)', async () => {
      await numaTransacao(async (tx) => {
        await assumir(tx, CONTA_A)
        const clienteId = uuidv7()
        await criarCliente(tx, clienteId)
        const id = await inserir(tx, recebimento(clienteId, '3000'))
        const diferente = await recusa(tx, (sp) => sp`insert into public.lancamentos (id, cliente_id, data, tipo, valor, forma)
          values (${id}::uuid, ${clienteId}::uuid, ${HOJE}::date, 'recebimento', ${'3500'}::bigint, 'dinheiro')
          on conflict (id) do update set valor = excluded.valor, forma = excluded.forma`)
        expect(diferente).toEqual({ code: '23000', constraint: 'lancamentos_imutavel' })
        const [linha] = await tx<{ valor: string }[]>`select valor::text as valor from public.lancamentos where id = ${id}::uuid`
        expect(linha?.valor).toBe('3000')
      })
    })
  })

  describe('imutabilidade (RI-03, D-010): lançamento não se altera nem se apaga — por nenhum papel', () => {
    test('update que muda valor, cliente ou data é recusado; delete é recusado; como postgres também', async () => {
      await numaTransacao(async (tx) => {
        await assumir(tx, CONTA_A)
        const clienteId = uuidv7()
        const outroCliente = uuidv7()
        await criarCliente(tx, clienteId)
        await criarCliente(tx, outroCliente, 'Outra')
        const id = await inserir(tx, recebimento(clienteId))

        for (const alterar of [
          (sp: SQL) => sp`update public.lancamentos set valor = 1 where id = ${id}::uuid`,
          (sp: SQL) => sp`update public.lancamentos set cliente_id = ${outroCliente}::uuid where id = ${id}::uuid`,
          (sp: SQL) => sp`update public.lancamentos set data = '2026-01-01' where id = ${id}::uuid`,
        ]) {
          expect(await recusa(tx, alterar)).toEqual({ code: '23000', constraint: 'lancamentos_imutavel' })
        }

        // Update sem mudança passa: é o reenvio idêntico (o mesmo caminho do upsert).
        const iguais = await tx`update public.lancamentos set valor = valor where id = ${id}::uuid returning id`
        expect(iguais).toHaveLength(1)

        // Para o papel do app, delete é "0 linhas" em silêncio: sem política de delete, a linha nem
        // chega ao gatilho. Não é erro — e é por isso que o gatilho é provado abaixo com `postgres`.
        const apagadas = await tx`delete from public.lancamentos where id = ${id}::uuid returning id`
        expect(apagadas).toHaveLength(0)
        expect(await contagem(tx)).toEqual({ linhas: 1, ids: 1 })

        // O papel da conexão ignora RLS, e mesmo assim o gatilho recusa: a regra é do banco, não do papel.
        await comoPostgres(tx)
        expect(await recusa(tx, (sp) => sp`delete from public.lancamentos where id = ${id}::uuid`)).toEqual({
          code: '23000',
          constraint: 'lancamentos_imutavel',
        })
        expect(await recusa(tx, (sp) => sp`update public.lancamentos set valor = 1 where id = ${id}::uuid`)).toEqual({
          code: '23000',
          constraint: 'lancamentos_imutavel',
        })
        expect(await recusa(tx, (sp) => sp`delete from public.clientes where id = ${clienteId}::uuid`)).toEqual({
          code: '23000',
          constraint: 'clientes_nao_se_apaga',
        })
      })
    })

    test('cadastro de cliente pode ser alterado pelo dono (último-que-escreve, D-010), mas não apagado', async () => {
      await numaTransacao(async (tx) => {
        await assumir(tx, CONTA_A)
        const clienteId = uuidv7()
        await criarCliente(tx, clienteId)
        const alterada = await tx`update public.clientes set telefone = '11 99999-0000' where id = ${clienteId}::uuid returning id`
        expect(alterada).toHaveLength(1)
        // Como dono: 0 linhas, sem erro (RLS sem política de delete). Como postgres: o gatilho.
        const apagadas = await tx`delete from public.clientes where id = ${clienteId}::uuid returning id`
        expect(apagadas).toHaveLength(0)
        await comoPostgres(tx)
        expect(await recusa(tx, (sp) => sp`delete from public.clientes where id = ${clienteId}::uuid`)).toEqual({
          code: '23000',
          constraint: 'clientes_nao_se_apaga',
        })
      })
    })
  })

  describe('não-negatividade e inteiro (RN-10, RI-01, EL-03)', () => {
    test('recebimento zero ou negativo, quitação acima de R$ 0,10, e ponto flutuante em qualquer lugar', async () => {
      await numaTransacao(async (tx) => {
        await assumir(tx, CONTA_A)
        const clienteId = uuidv7()
        await criarCliente(tx, clienteId)

        expect(await recusa(tx, (sp) => inserir(sp, recebimento(clienteId, '0')))).toEqual({
          code: '23514',
          constraint: 'lancamentos_valor_invalido',
        })
        expect(await recusa(tx, (sp) => inserir(sp, recebimento(clienteId, '-1')))).toEqual({
          code: '23514',
          constraint: 'lancamentos_valor_invalido',
        })
        expect(await recusa(tx, (sp) => inserir(sp, { clienteId, tipo: 'desconto-quitacao', valor: '11' }))).toEqual({
          code: '23514',
          constraint: 'lancamentos_acima_do_limite_de_quitacao',
        })
        await inserir(tx, { clienteId, tipo: 'desconto-quitacao', valor: '10' })

        // `39.9` numa coluna bigint morre no tipo, antes de qualquer constraint (22P02).
        expect((await recusa(tx, (sp) => inserir(sp, recebimento(clienteId, '39.9')))).code).toBe('22P02')

        // Dentro do jsonb, é a função de validação que recusa: número com casa decimal, negativo, texto.
        for (const valor of ['39.9', '-1', 'abc', '']) {
          const venda = { ...vendaFiado(clienteId), parcelas: [parcela('3245'), parcela(valor)] }
          expect(await recusa(tx, (sp) => inserir(sp, venda))).toEqual({ code: '23514', constraint: 'lancamentos_sem_parcelas' })
        }
        for (const preco of ['39.9', '-1', 'abc']) {
          const venda = { ...vendaFiado(clienteId), itens: [{ descricao: 'Perfume', preco }] }
          expect(await recusa(tx, (sp) => inserir(sp, venda))).toEqual({ code: '23514', constraint: 'lancamentos_sem_itens' })
        }
        // Número JSON inteiro também passa: o banco aceita as duas formas (D-041).
        const comNumero = {
          ...vendaFiado(clienteId),
          itens: [{ descricao: 'Perfume', preco: 6490 }],
          parcelas: [parcela('6490')],
        }
        await inserir(tx, comNumero)
      })
    })

    test('desconto negativo ou acima da soma dos itens (RF-03)', async () => {
      await numaTransacao(async (tx) => {
        await assumir(tx, CONTA_A)
        const clienteId = uuidv7()
        await criarCliente(tx, clienteId)
        const fiado = vendaFiado(clienteId)
        const avista: Linha = { clienteId, tipo: 'venda', pagamento: 'avista', forma: 'pix', itens: fiado.itens, desconto: '0' }
        // Negativo, com parcelas que fechariam (64,90 + 0,01): só o desconto está errado.
        expect(await recusa(tx, (sp) => inserir(sp, { ...fiado, desconto: '-1', parcelas: [parcela('3245'), parcela('3246')] }))).toEqual({
          code: '23514',
          constraint: 'lancamentos_desconto_invalido',
        })
        // Acima da soma, à vista: não há parcela para acusar outra coisa.
        expect(await recusa(tx, (sp) => inserir(sp, { ...avista, desconto: '6491' }))).toEqual({
          code: '23514',
          constraint: 'lancamentos_desconto_invalido',
        })
        // Desconto igual à soma é o limite: aceito — à vista, e fiado com parcela zero (o domínio faz o mesmo).
        await inserir(tx, { ...avista, desconto: '6490' })
        await inserir(tx, { ...fiado, desconto: '6490', parcelas: [parcela('0')] })
      })
    })
  })

  describe('soma das parcelas = total da venda (RF-05, D-012, D-039)', () => {
    test('venda fiado que não fecha é recusada; a que fecha, aceita; saldo anterior não passa pela regra', async () => {
      await numaTransacao(async (tx) => {
        await assumir(tx, CONTA_A)
        const clienteId = uuidv7()
        await criarCliente(tx, clienteId)
        const base = vendaFiado(clienteId)

        // R$ 64,90 em parcelas que somam R$ 64,89 e R$ 64,91: um centavo para cada lado.
        for (const parcelas of [[parcela('3245'), parcela('3244')], [parcela('3245'), parcela('3246')]]) {
          expect(await recusa(tx, (sp) => inserir(sp, { ...base, parcelas }))).toEqual({
            code: '23514',
            constraint: 'lancamentos_parcelas_nao_fecham',
          })
        }
        // Com desconto: 64,90 − 4,90 = 60,00 em 3× de 20,00.
        await inserir(tx, {
          ...base,
          desconto: '490',
          parcelas: [parcela('2000', '2026-10-11'), parcela('2000', '2026-11-11'), parcela('2000', '2026-12-11')],
        })
        await inserir(tx, base)
        // Saldo anterior tem parcelas e não tem itens: não há total com que fechar (RF-07, D-039).
        await inserir(tx, { clienteId, tipo: 'saldo-anterior', parcelas: [parcela('4703')] })
        expect(await contagem(tx)).toEqual({ linhas: 3, ids: 3 })
      })
    })
  })

  describe('chaves estrangeiras: cliente e alvo do estorno existem, na mesma conta e na mesma ficha', () => {
    test('cliente inexistente, alvo inexistente, alvo de outra ficha, estorno de estorno, segundo estorno', async () => {
      await numaTransacao(async (tx) => {
        await assumir(tx, CONTA_A)
        const clienteId = uuidv7()
        const outraFicha = uuidv7()
        await criarCliente(tx, clienteId)
        await criarCliente(tx, outraFicha, 'Outra')

        expect(await recusa(tx, (sp) => inserir(sp, recebimento(uuidv7())))).toEqual({
          code: '23503',
          constraint: 'lancamentos_cliente',
        })
        expect(await recusa(tx, (sp) => inserir(sp, { clienteId, tipo: 'estorno', estornaId: uuidv7() }))).toEqual({
          code: '23503',
          constraint: 'lancamentos_estorno_alvo',
        })

        const alvo = await inserir(tx, recebimento(clienteId))
        expect(await recusa(tx, (sp) => inserir(sp, { clienteId: outraFicha, tipo: 'estorno', estornaId: alvo }))).toEqual({
          code: '23503',
          constraint: 'lancamentos_estorno_alvo',
        })

        const estorno = await inserir(tx, { clienteId, tipo: 'estorno', estornaId: alvo, motivo: 'lancei errado' })
        expect(await recusa(tx, (sp) => inserir(sp, { clienteId, tipo: 'estorno', estornaId: estorno }))).toEqual({
          code: '23000',
          constraint: 'lancamentos_alvo_e_estorno',
        })
        expect(await recusa(tx, (sp) => inserir(sp, { clienteId, tipo: 'estorno', estornaId: alvo }))).toEqual({
          code: '23505',
          constraint: 'lancamentos_um_estorno_por_alvo',
        })
      })
    })
  })

  describe('a forma de cada tipo (D-039): as colunas do tipo, e só elas', () => {
    test('coluna de outro tipo, coluna obrigatória faltando, tipo desconhecido, sem id, nome vazio', async () => {
      await numaTransacao(async (tx) => {
        await assumir(tx, CONTA_A)
        const clienteId = uuidv7()
        await criarCliente(tx, clienteId)
        const fiado = vendaFiado(clienteId)
        const semParcelas: Linha = { clienteId, tipo: 'venda', pagamento: 'fiado', itens: fiado.itens, desconto: '0' }

        const formas: Linha[] = [
          { ...recebimento(clienteId), itens: [{ descricao: 'x', preco: '1' }] },
          semParcelas,
          { ...fiado, forma: 'pix' },
          { ...semParcelas, pagamento: 'avista' },
          { ...semParcelas, pagamento: 'avista', forma: 'pix', parcelas: [parcela('6490')] },
          { ...fiado, itens: undefined },
          { clienteId, tipo: 'saldo-anterior', parcelas: [parcela('100')], itens: [{ descricao: 'x', preco: '1' }] },
          { clienteId, tipo: 'recebimento', valor: '100' },
          { clienteId, tipo: 'desconto-quitacao', valor: '5', forma: 'pix' },
          { clienteId, tipo: 'estorno' },
        ]
        for (const forma of formas) {
          expect(await recusa(tx, (sp) => inserir(sp, forma))).toEqual({ code: '23514', constraint: 'lancamentos_forma_por_tipo' })
        }
        expect(await recusa(tx, (sp) => inserir(sp, { clienteId, tipo: 'devolucao', valor: '1' }))).toEqual({
          code: '23514',
          constraint: 'lancamentos_tipo_conhecido',
        })
        expect(await recusa(tx, (sp) => inserir(sp, { ...fiado, pagamento: 'cartao' }))).toEqual({
          code: '23514',
          constraint: 'lancamentos_pagamento_conhecido',
        })
        expect(await recusa(tx, (sp) => inserir(sp, { ...recebimento(clienteId), forma: 'cheque' }))).toEqual({
          code: '23514',
          constraint: 'lancamentos_forma_conhecida',
        })

        // O id nasce no dispositivo (RI-04): sem id, sem linha.
        const semId = await recusa(tx, (sp) => sp`insert into public.lancamentos (cliente_id, data, tipo, valor, forma)
          values (${clienteId}::uuid, ${HOJE}::date, 'recebimento', 1, 'pix')`)
        expect(semId.code).toBe('23502')
        const clienteSemId = await recusa(tx, (sp) => sp`insert into public.clientes (nome) values ('Sem id')`)
        expect(clienteSemId.code).toBe('23502')

        expect(await recusa(tx, (sp) => criarCliente(sp, uuidv7(), ''))).toEqual({
          code: '23514',
          constraint: 'clientes_nome_obrigatorio',
        })

        // Data que não existe no calendário: `date` recusa o que o domínio só confere pelo formato.
        expect((await recusa(tx, (sp) => inserir(sp, { ...recebimento(clienteId), data: '2026-02-30' }))).code).toBe('22008')
        expect(await recusa(tx, (sp) => inserir(sp, { ...fiado, parcelas: [parcela('6490', '2026-02-30')] }))).toEqual({
          code: '23514',
          constraint: 'lancamentos_sem_parcelas',
        })

        // A venda à vista completa passa: um lançamento só (D-039).
        await inserir(tx, { ...semParcelas, pagamento: 'avista', forma: 'pix' })
      })
    })
  })

  describe('as funções de validação do jsonb, nos casos de borda', () => {
    test('parcelas_validas e itens_validos', async () => {
      const id1 = '00000000-0000-7000-8000-000000000001'
      const id2 = '00000000-0000-7000-8000-000000000002'
      const casos: [unknown, boolean][] = [
        [[], false],
        [{}, false],
        ['texto', false],
        [[1], false],
        [[{ id: 'x', vencimento: '2026-10-11', valor: '1' }], false],
        [[{ id: id1, vencimento: '2026-13-11', valor: '1' }], false],
        [[{ id: id1, vencimento: '2026-02-30', valor: '1' }], false],
        [[{ id: id1, vencimento: '11/10/2026', valor: '1' }], false],
        [[{ id: id1, vencimento: '2026-10-11', valor: '1.5' }], false],
        [[{ id: id1, vencimento: '2026-10-11', valor: 1.5 }], false],
        [[{ id: id1, vencimento: '2026-10-11', valor: -1 }], false],
        [[{ id: id1, vencimento: '2026-10-11' }], false],
        [
          [
            { id: id1, vencimento: '2026-10-11', valor: '1' },
            { id: id1, vencimento: '2026-11-11', valor: '1' },
          ],
          false,
        ],
        [[{ id: id1, vencimento: '2026-10-11', valor: 0 }], true],
        [
          [
            { id: id1, vencimento: '2026-10-11', valor: '3245' },
            { id: id2, vencimento: '2026-11-11', valor: 3245 },
          ],
          true,
        ],
      ]
      for (const [entrada, esperado] of casos) {
        const [linha] = await sql<{ ok: boolean }[]>`select public.parcelas_validas(${entrada}::jsonb) as ok`
        expect(linha?.ok, JSON.stringify(entrada)).toBe(esperado)
      }
      const itens: [unknown, boolean][] = [
        [[], false],
        [[{ descricao: '', preco: '1' }], false],
        [[{ descricao: 'Perfume' }], false],
        [[{ descricao: 'Perfume', preco: '-1' }], false],
        [[{ descricao: 'Perfume', preco: 39.9 }], false],
        [[{ descricao: 'Perfume', preco: '3990' }, { descricao: 'Batom', preco: 2500 }], true],
      ]
      for (const [entrada, esperado] of itens) {
        const [linha] = await sql<{ ok: boolean }[]>`select public.itens_validos(${entrada}::jsonb) as ok`
        expect(linha?.ok, JSON.stringify(entrada)).toBe(esperado)
      }
      // As somas: exatas em bigint, e `null` para lista inválida — a soma "não existe".
      const [somas] = await sql<{ itens: string; parcelas: string | null }[]>`
        select public.soma_itens(${[{ descricao: 'a', preco: '3990' }, { descricao: 'b', preco: 2500 }]}::jsonb)::text as itens,
               public.soma_parcelas(${[]}::jsonb)::text as parcelas`
      expect(somas).toEqual({ itens: '6490', parcelas: null })
    })
  })

  describe('reversibilidade (E-06): o reverter desfaz, a migration refaz', () => {
    test('reverter todas, da última à primeira → tabelas somem → aplicar todas → voltam, numa transação desfeita no fim', async () => {
      if (migracoes.length === 0) throw new Error('sem migration')
      const existe = async (tx: SQL, tabela: string): Promise<boolean> => {
        const [linha] = await tx<{ existe: boolean }[]>`select to_regclass(${`public.${tabela}`}) is not null as existe`
        return linha?.existe === true
      }
      const coluna = async (tx: SQL, tabela: string, nome: string): Promise<boolean> => {
        const [linha] = await tx<{ existe: boolean }[]>`select exists (
          select 1 from information_schema.columns
          where table_schema = 'public' and table_name = ${tabela} and column_name = ${nome}) as existe`
        return linha?.existe === true
      }
      await numaTransacao(async (tx) => {
        expect(await existe(tx, 'lancamentos')).toBe(true)
        expect(await coluna(tx, 'clientes', 'atualizado_em')).toBe(true)
        // Cada reverter desfaz só a sua migration: depois da 0002, a 0001 ainda está lá.
        for (const migracao of [...migracoes].reverse()) await tx.unsafe(migracao.reverter)
        expect(await existe(tx, 'lancamentos')).toBe(false)
        expect(await existe(tx, 'clientes')).toBe(false)
        for (const migracao of migracoes) await tx.unsafe(migracao.aplicar)
        expect(await existe(tx, 'lancamentos')).toBe(true)
        expect(await existe(tx, 'clientes')).toBe(true)
        expect(await coluna(tx, 'clientes', 'atualizado_em')).toBe(true)
        expect(await coluna(tx, 'clientes', 'recebido_em')).toBe(true)
        expect(await existe(tx, 'spike_sondas')).toBe(false)
      })
    })

    test('a 0002 sozinha: reverter tira as colunas e o gatilho e deixa a 0001 de pé; aplicar devolve', async () => {
      const segunda = migracoes.find((migracao) => migracao.nome.startsWith('0002_'))
      if (segunda === undefined) throw new Error('sem 0002')
      await numaTransacao(async (tx) => {
        await tx.unsafe(segunda.reverter)
        const [colunas] = await tx<{ n: number }[]>`select count(*)::int as n from information_schema.columns
          where table_schema = 'public' and table_name = 'clientes' and column_name in ('atualizado_em', 'recebido_em')`
        expect(colunas?.n).toBe(0)
        const [gatilhos] = await tx<{ n: number }[]>`select count(*)::int as n from pg_trigger where tgname = 'clientes_ultimo_que_escreve'`
        expect(gatilhos?.n).toBe(0)
        // A 0001 continua inteira: dá para inserir um cliente e um lançamento.
        await assumir(tx, CONTA_A)
        const clienteId = uuidv7()
        await criarCliente(tx, clienteId)
        await inserir(tx, recebimento(clienteId))
        expect(await contagem(tx)).toEqual({ linhas: 1, ids: 1 })
        await comoPostgres(tx)
        await tx.unsafe(segunda.aplicar)
        const [depois] = await tx<{ n: number }[]>`select count(*)::int as n from information_schema.columns
          where table_schema = 'public' and table_name = 'clientes' and column_name in ('atualizado_em', 'recebido_em')`
        expect(depois?.n).toBe(2)
      })
    })
  })

  describe('último-que-escreve de cadastro (D-010, D-042, migration 0002)', () => {
    /** O `atualizado_em` e o `recebido_em` de um cliente, como ISO. */
    async function carimbos(tx: SQL, id: string): Promise<{ atualizado: string; recebido: string }> {
      const [linha] = await tx<{ atualizado: string; recebido: string }[]>`
        select to_char(atualizado_em at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as atualizado,
               to_char(recebido_em at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as recebido
        from public.clientes where id = ${id}::uuid`
      if (linha === undefined) throw new Error('cliente não encontrado')
      return linha
    }

    /** O upsert que a fila de E-07 manda para um cliente, com o carimbo do aparelho. */
    async function enviarCliente(tx: SQL, id: string, nome: string, atualizadoEm: string): Promise<number> {
      const linhas = await tx`insert into public.clientes (id, nome, atualizado_em)
        values (${id}::uuid, ${nome}, ${atualizadoEm}::timestamptz)
        on conflict (id) do update set nome = excluded.nome, atualizado_em = excluded.atualizado_em
        returning id`
      return linhas.length
    }

    test('a versão mais antiga é descartada em silêncio; a mais nova e a igual passam; recebido_em é do servidor', async () => {
      await numaTransacao(async (tx) => {
        await assumir(tx, CONTA_A)
        const id = uuidv7()
        expect(await enviarCliente(tx, id, 'Vera', '2026-09-12T10:05:00.000Z')).toBe(1)
        const primeiro = await carimbos(tx, id)
        expect(primeiro.atualizado).toBe('2026-09-12T10:05:00.000Z')
        // `recebido_em` é `now()` do servidor — não é o carimbo do aparelho, e é de hoje, não de 10h05.
        expect(primeiro.recebido).not.toBe(primeiro.atualizado)

        // O iPhone que editou ANTES (10h00) e só chegou agora: sucesso sem erro, zero linhas, nada muda.
        expect(await enviarCliente(tx, id, 'Vera (do iPhone)', '2026-09-12T10:00:00.000Z')).toBe(0)
        const depoisDoAntigo = await carimbos(tx, id)
        expect(depoisDoAntigo).toEqual(primeiro)
        const [nome] = await tx<{ nome: string }[]>`select nome from public.clientes where id = ${id}::uuid`
        expect(nome?.nome).toBe('Vera')

        // O reenvio idempotente (RI-05): mesmo carimbo, mesmo conteúdo — passa, e `recebido_em` anda.
        expect(await enviarCliente(tx, id, 'Vera', '2026-09-12T10:05:00.000Z')).toBe(1)
        expect((await carimbos(tx, id)).atualizado).toBe('2026-09-12T10:05:00.000Z')

        // A edição mais nova vence.
        expect(await enviarCliente(tx, id, 'Vera Lúcia', '2026-09-12T10:10:00.000Z')).toBe(1)
        const [novo] = await tx<{ nome: string }[]>`select nome from public.clientes where id = ${id}::uuid`
        expect(novo?.nome).toBe('Vera Lúcia')
        expect((await carimbos(tx, id)).atualizado).toBe('2026-09-12T10:10:00.000Z')
      })
    })

    test('o gatilho vale para qualquer papel, e os índices do download existem', async () => {
      await numaTransacao(async (tx) => {
        // A linha nasce como conta (`dono` vem de `auth.uid()`); o descarte é provado como `postgres`.
        await assumir(tx, CONTA_A)
        const id = uuidv7()
        expect(await enviarCliente(tx, id, 'Como conta', '2026-09-12T12:00:00.000Z')).toBe(1)
        await comoPostgres(tx)
        expect(await enviarCliente(tx, id, 'Mais antigo, como postgres', '2026-09-12T11:00:00.000Z')).toBe(0)
        const indices = await tx<{ indexname: string }[]>`select indexname from pg_indexes
          where schemaname = 'public' and indexname in ('clientes_por_chegada', 'lancamentos_por_chegada') order by indexname`
        expect(indices.map((indice) => indice.indexname)).toEqual(['clientes_por_chegada', 'lancamentos_por_chegada'])
      })
    })
  })
})
