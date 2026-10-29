import { exigirDestinoDeTeste } from '../nuvem/ambiente-de-teste.ts'
import { conectar } from '../nuvem/migrar.ts'

/** D-077/D-050: configuração fictícia temporária das suítes, restaurada mesmo se o teste falhar. */
export async function comContatoFicticio(executar: () => Promise<void>): Promise<void> {
  exigirDestinoDeTeste()
  const sql = conectar()
  try {
    const anterior = (await sql<{ telefone: string }[]>`select telefone from public.contato_suporte where chave='mantenedor'`)[0]
    await sql`insert into public.contato_suporte(chave,telefone) values ('mantenedor','5511999999999')
      on conflict(chave) do update set telefone=excluded.telefone`
    try { await executar() }
    finally {
      if (anterior) await sql`update public.contato_suporte set telefone=${anterior.telefone} where chave='mantenedor'`
      else await sql`delete from public.contato_suporte where chave='mantenedor'`
    }
  } finally { await sql.close() }
}
