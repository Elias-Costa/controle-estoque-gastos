/**
 * O runner de migrations da nuvem (E-06, D-041 item 3): aplica o que falta, ou reverte a última.
 *
 *   bun run migrar            aplica, em ordem, toda migration ainda não registrada
 *   bun run migrar:reverter   roda o `.reverter.sql` da última aplicada e apaga o registro
 *
 * É código próprio, não a CLI do Supabase, por uma razão que cabe numa frase: um mecanismo só
 * para ir e voltar, sem binário e sem dependência, legível inteiro por quem mantém sozinho.
 * O que ele faz: lê `nuvem/migracoes/NNNN_nome.sql` em ordem de nome, roda cada uma dentro de
 * uma transação (DDL é transacional no Postgres: ou entra tudo, ou nada) e registra o nome em
 * `public.migracoes`. Reverter é o mesmo caminho ao contrário, com o `NNNN_nome.reverter.sql`.
 *
 * Toda migration tem reverter — `lerMigracoes` recusa uma sem par. Nunca se edita uma migration
 * já aplicada; acrescenta-se a próxima (`nuvem/LEIA-ME.md`).
 *
 * A conexão vem de `SUPABASE_DB_URL` em `.env.local` (session pooler, porta 5432 — o modo
 * transação não aceita `set local`, e a suíte de integração precisa dele). O valor é segredo:
 * nunca é impresso, e este arquivo é o único, junto com a suíte, que o lê. `Bun.sql` é o cliente
 * Postgres embutido no Bun — nada a instalar.
 */

import { SQL } from 'bun'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

/** Uma migration: o nome que vai para o registro e os dois SQL, o de ir e o de voltar. */
export type Migracao = {
  readonly nome: string
  readonly aplicar: string
  readonly reverter: string
}

/** `NNNN_nome.sql` — o `.reverter.sql` não casa, porque o nome não admite ponto. */
const FORMATO = /^\d{4}_[a-z0-9-]+\.sql$/

const PASTA_PADRAO = join(import.meta.dir, 'migracoes')

/** Lê a pasta de migrations, em ordem de nome. Falha se alguma estiver sem o `.reverter.sql`. */
export async function lerMigracoes(pasta: string = PASTA_PADRAO): Promise<Migracao[]> {
  const arquivos = (await readdir(pasta)).filter((arquivo) => FORMATO.test(arquivo)).sort()
  const migracoes: Migracao[] = []
  for (const arquivo of arquivos) {
    const nome = arquivo.slice(0, -'.sql'.length)
    const reverter = Bun.file(join(pasta, `${nome}.reverter.sql`))
    if (!(await reverter.exists())) {
      throw new Error(`${arquivo} não tem ${nome}.reverter.sql — toda migration é reversível (D-041)`)
    }
    migracoes.push({ nome, aplicar: await Bun.file(join(pasta, arquivo)).text(), reverter: await reverter.text() })
  }
  return migracoes
}

/**
 * A tabela de registro. Fica fora das migrations porque é o runner que precisa dela para saber
 * o que rodar. Sem política de linha e sem privilégio para os papéis do app: só o runner a lê.
 */
export async function garantirRegistro(sql: SQL): Promise<void> {
  await sql.unsafe(`
    create table if not exists public.migracoes (
      nome text primary key,
      aplicada_em timestamptz not null default now()
    );
    alter table public.migracoes enable row level security;
    revoke all on public.migracoes from anon, authenticated;
  `)
}

/** Nomes já registrados, em ordem. */
export async function aplicadas(sql: SQL): Promise<string[]> {
  const linhas = await sql<{ nome: string }[]>`select nome from public.migracoes order by nome`
  return linhas.map((linha) => linha.nome)
}

/** Aplica, uma transação por migration, tudo que ainda não está no registro. Devolve os nomes. */
export async function aplicarPendentes(sql: SQL, migracoes: readonly Migracao[]): Promise<string[]> {
  const feitas = new Set(await aplicadas(sql))
  const novas: string[] = []
  for (const migracao of migracoes) {
    if (feitas.has(migracao.nome)) continue
    await sql.begin(async (tx) => {
      await tx.unsafe(migracao.aplicar)
      await tx`insert into public.migracoes (nome) values (${migracao.nome})`
    })
    novas.push(migracao.nome)
  }
  return novas
}

/** Reverte a última registrada, numa transação. Devolve o nome, ou `null` se não havia nenhuma. */
export async function reverterUltima(sql: SQL, migracoes: readonly Migracao[]): Promise<string | null> {
  const ultima = (await aplicadas(sql)).at(-1)
  if (ultima === undefined) return null
  const migracao = migracoes.find((candidata) => candidata.nome === ultima)
  if (migracao === undefined) {
    throw new Error(`${ultima} está registrada no banco mas não existe em nuvem/migracoes/ — não há como reverter`)
  }
  await sql.begin(async (tx) => {
    await tx.unsafe(migracao.reverter)
    await tx`delete from public.migracoes where nome = ${migracao.nome}`
  })
  return migracao.nome
}

/** A conexão do runner e da suíte. Lê o segredo do ambiente; nunca o devolve nem imprime. */
export function conectar(): SQL {
  const url = process.env.SUPABASE_DB_URL
  if (url === undefined || url === '') {
    throw new Error('Defina SUPABASE_DB_URL em .env.local (Supabase → Connect → Session pooler, porta 5432).')
  }
  return new SQL(url, { max: 1, tls: 'require' })
}

if (import.meta.main) {
  const modo = process.argv[2]
  if (modo !== undefined && modo !== 'reverter') {
    console.error(`modo desconhecido: ${modo}. Use sem argumento (aplicar) ou "reverter".`)
    process.exit(2)
  }
  let sql: SQL | null = null
  try {
    sql = conectar()
    const migracoes = await lerMigracoes()
    await garantirRegistro(sql)
    if (modo === 'reverter') {
      const nome = await reverterUltima(sql, migracoes)
      console.log(nome === null ? 'nada a reverter' : `revertida: ${nome}`)
    } else {
      const novas = await aplicarPendentes(sql, migracoes)
      console.log(novas.length === 0 ? 'nada a aplicar' : novas.map((nome) => `aplicada: ${nome}`).join('\n'))
    }
    console.log(`registro: ${(await aplicadas(sql)).join(', ') || '(vazio)'}`)
  } catch (erro) {
    console.error(erro instanceof Error ? erro.message : String(erro))
    process.exitCode = 1
  } finally {
    await sql?.close()
  }
}
