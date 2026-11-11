import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { exigirDestinoDeTeste } from '../ambiente-de-teste.ts'
import { conectar } from '../migrar.ts'
import { criarRpcBackupSql } from './sql.ts'
import { carregarFontesBackup, dadosDaCaptura, lerCapturaServidor, materialDaCaptura, pacoteDaCaptura } from './captura.ts'
import { criarNuvemSupabase } from '../../src/sincronizacao/nuvem.ts'
import { exigirCopia } from '../../src/dados/formato-copia.ts'

async function hashArquivo(arquivo: Blob): Promise<string> {
  const hash = createHash('sha256')
  await arquivo.stream().pipeTo(new WritableStream({ write(parte) { hash.update(parte) } }))
  return hash.digest('hex')
}

/** BA-04: lê captura fictícia retida e mede o Bun; nunca envia ao Drive nem modifica a captura. */
export async function medirCapturaBackup(capturaId: string, referencia: boolean): Promise<void> {
  const ambiente = exigirDestinoDeTeste()
  exigirCopia(ambiente === 'homologacao' && /^[0-9a-f-]{36}$/.test(capturaId))
  const destino = new URL(process.env.VITE_SUPABASE_URL ?? '').origin, sql = conectar()
  const cliente = createClient(destino, process.env.VITE_SUPABASE_ANON_KEY ?? '', { auth: { persistSession: false, autoRefreshToken: false } })
  try {
    const login = await cliente.auth.signInWithPassword({ email: process.env.SUPABASE_TESTE_EMAIL ?? '', password: process.env.SUPABASE_TESTE_SENHA ?? '' })
    exigirCopia(!login.error && login.data.user)
    const conta = login.data.user.id
    const linhas = await sql`select id::text id, dia::text dia, capturado_em::text "capturadoEm",
      jsonb_build_object('contaId',dono,'destino',destino) vinculo
      from backup_interno.capturas where id=${capturaId}::uuid and dono=${conta}::uuid
      and destino=${destino} and origem='servidor' and estado in ('capturada','enviando','pronta')`
    exigirCopia(linhas.length === 1)
    const captura = lerCapturaServidor(linhas[0], { contaId: conta, destino })
    const fotos = criarNuvemSupabase(cliente, destino).fotos; exigirCopia(fotos)
    const pasta = resolve('docs/evidencias/2026-11-06-backup-cpu'), caminho = resolve(pasta, `${capturaId}-referencia.zip`)
    exigirCopia(referencia ? !await Bun.file(caminho).exists() : await Bun.file(caminho).exists())
    const medidas: { etapa: string; decorridoMs: number; cpuBunMs: number }[] = []
    let etapa = 'leitura', inicio = performance.now(), cpu = process.cpuUsage()
    function avancar(proxima: string) {
      const usado = process.cpuUsage(cpu)
      medidas.push({ etapa, decorridoMs: Math.round(performance.now() - inicio), cpuBunMs: Math.round((usado.user + usado.system) / 1000) })
      etapa = proxima; inicio = performance.now(); cpu = process.cpuUsage()
    }
    const fontes = await carregarFontesBackup(criarRpcBackupSql(sql), captura)
    avancar('reconstrucao')
    const dados = await dadosDaCaptura(captura, fontes, async (ref) => {
      exigirCopia(typeof ref['caminho'] === 'string')
      const r = await fotos.baixar(ref['caminho']); exigirCopia(r.ok, 'foto'); return r.valor
    }, () => avancar('originais'))
    avancar('material')
    const material = await materialDaCaptura(dados)
    const arquivo = await pacoteDaCaptura(captura, dados, avancar)
    avancar('hash_zip')
    const sha256 = await hashArquivo(arquivo)
    avancar('conferencia_local')
    await mkdir(pasta, { recursive: true })
    if (referencia) await Bun.write(caminho, arquivo)
    else exigirCopia(arquivo.size === Bun.file(caminho).size && sha256 === await hashArquivo(Bun.file(caminho)))
    const resultado = { ambiente, capturaId, referencia, bytes: arquivo.size, sha256, material: material.length, medidas,
      igualdadeReferencia: !referencia, instrumento: 'Windows/Bun; CPU não representa o Edge', arquivosEnviados: 0 }
    await Bun.write(resolve(pasta, `${capturaId}-${referencia ? 'antes' : 'depois'}.json`), JSON.stringify(resultado, null, 2))
    console.log(JSON.stringify(resultado))
  } finally { await sql.close(); await cliente.auth.signOut({ scope: 'local' }) }
}

if (import.meta.main) {
  try {
    const id = process.argv.find((v) => v.startsWith('--captura='))?.slice('--captura='.length) ?? ''
    await medirCapturaBackup(id, process.argv.includes('--referencia'))
  } catch { console.error('Perfil não concluído; dados e credenciais omitidos.'); process.exitCode = 1 }
}
