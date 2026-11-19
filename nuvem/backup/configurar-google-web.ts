import { createInterface } from 'node:readline/promises'
import { conectar } from '../migrar.ts'
import { conferirContaFichinhas, contaFichinhasDeTeste, lerArquivoClienteGoogle } from './configurar-google.ts'
import { exigirDestinoConfiguracaoBackup, validarContaBackup } from './destino.ts'
import { FalhaGoogle, PROJETO_GOOGLE_DE_PRODUCAO, PROJETO_GOOGLE_DE_TESTE, RETORNO_GOOGLE_PRODUCAO, RETORNO_GOOGLE_TESTE } from './google.ts'

/** Prepara só o cliente Web/conta permitida; a usuária escolhe seu Drive no app. */
export async function configurarGoogleWeb(caminho: string | undefined, producao?: { projeto: string; contaId: string }): Promise<void> {
  const ambiente = exigirDestinoConfiguracaoBackup(producao?.projeto)
  if (!caminho || !process.stdin.isTTY || !process.stdout.isTTY || process.platform !== 'win32') throw new FalhaGoogle('Configure o JSON Web no seu terminal Windows interativo.')
  const conta = producao ? validarContaBackup(producao.contaId) : await contaFichinhasDeTeste()
  const projeto = ambiente === 'producao' ? PROJETO_GOOGLE_DE_PRODUCAO : PROJETO_GOOGLE_DE_TESTE
  const cliente = await lerArquivoClienteGoogle(caminho, projeto, true)
  const destino = new URL(process.env.VITE_SUPABASE_URL ?? '').origin
  const retorno = ambiente === 'producao' ? RETORNO_GOOGLE_PRODUCAO : RETORNO_GOOGLE_TESTE
  const sql = conectar()
  try {
    const email = await conferirContaFichinhas(sql, conta)
    console.log(`Ambiente: ${ambiente}; conta Fichinhas permitida: ${email} — ${conta}.`)
    console.log('Isto prepara a conexão pelo app. A conta Google será escolhida pela usuária; autorizações e cópias anteriores ficam preservadas.')
    const entrada = createInterface({ input: process.stdin, output: process.stdout })
    try { if (await entrada.question('Confirma a conta Fichinhas e o ambiente? Digite CONFIRMAR: ') !== 'CONFIRMAR') throw new FalhaGoogle('Não confirmado; cliente Web não configurado.') }
    finally { entrada.close() }
    await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended('fichinhas-backup-cliente-web:'||${ambiente},2))`
      const [anterior] = await tx<{ dono: string; destino: string; retorno: string; igual: boolean }[]>`
        select w.dono::text,w.destino,w.retorno,s.decrypted_secret::jsonb=${cliente}::jsonb igual
        from backup_interno.clientes_web w join vault.decrypted_secrets s on s.id=w.segredo_id where w.ambiente=${ambiente}`
      if (anterior) {
        if (anterior.dono !== conta || anterior.destino !== destino || anterior.retorno !== retorno || !anterior.igual) throw new FalhaGoogle('Configuração Web existente divergente; preservada para conferência.')
        return
      }
      const [segredo] = await tx<{ id: string }[]>`select vault.create_secret(${JSON.stringify(cliente)},${`fichinhas-backup-cliente-web:${ambiente}`})::text id`
      if (!segredo) throw new FalhaGoogle('Cliente Web não preparado.')
      await tx`insert into backup_interno.clientes_web(ambiente,dono,destino,retorno,segredo_id)
        values(${ambiente},${conta}::uuid,${destino},${retorno},${segredo.id}::uuid)`
    })
    console.log(JSON.stringify({ ambiente, projetoGoogle: projeto, clienteWebConfigurado: true, driveEscolhido: false, arquivosEnviados: 0, segredosImpressos: false }))
  } finally { await sql.close() }
}

if (import.meta.main) {
  try { await configurarGoogleWeb(process.argv[2]) }
  catch (e) { console.error(e instanceof FalhaGoogle ? e.message : 'Configuração Web não concluída; detalhes sensíveis omitidos.'); process.exitCode = 1 }
}
