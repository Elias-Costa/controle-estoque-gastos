import { exigirDestinoDeTeste } from '../nuvem/ambiente-de-teste.ts'
import { conectar } from '../nuvem/migrar.ts'
import { uuidv7 } from '../src/dados/identidade.ts'

/** Conta nova só nos destinos D-050, sem e-mail; conserva as rodadas anteriores para inspeção. */
export async function criarContaFicticia(): Promise<string> {
  exigirDestinoDeTeste()
  const id = uuidv7(), email = `ensaio-${id}@example.invalid`, sql = conectar()
  try {
    await sql.begin(async (tx) => {
      // Reutiliza só a credencial fictícia configurada, no servidor. O hash não sai do banco.
      const r = await tx`insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,
        raw_app_meta_data,raw_user_meta_data,confirmation_token,recovery_token,email_change_token_new,email_change,created_at,updated_at)
        select instance_id,${id}::uuid,aud,role,${email},encrypted_password,now(),
        raw_app_meta_data,'{}'::jsonb,'','','','',now(),now() from auth.users where email=${process.env.SUPABASE_TESTE_EMAIL ?? ''}
        returning id`
      if (r.length !== 1) throw new Error('Conta fictícia de origem ausente no destino de teste')
      await tx`insert into auth.identities(id,user_id,provider_id,identity_data,provider,created_at,updated_at)
        values(${uuidv7()}::uuid,${id}::uuid,${id},${ { sub: id, email, email_verified: true } }::jsonb,'email',now(),now())`
    })
  } finally { await sql.close() }
  return email
}
