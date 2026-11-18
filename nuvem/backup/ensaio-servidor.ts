import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium, type Browser } from '@playwright/test'
import { SQL } from 'bun'
import { createClient } from '@supabase/supabase-js'
import { exigirDestinoDeTeste } from '../ambiente-de-teste.ts'
import { conectar } from '../migrar.ts'
import { consultarAutorizacaoGoogle } from './cofre-google.ts'
import { criarRpcBackupSql } from './sql.ts'
import { executarBackupServidor, type ResultadoBackupServidor } from './servidor.ts'
import { criarDriveBackup, FalhaDrive } from './drive.ts'
import { renovarTokensGoogle } from './google.ts'
import { exigirCopia, objetoCopia, ErroCopia } from '../../src/dados/formato-copia.ts'
import { hashDaFoto } from '../../src/plataforma/fotos.ts'
import { criarNuvemSupabase } from '../../src/sincronizacao/nuvem.ts'
import { protecaoDaNuvem, type NuvemFotos } from '../../src/sincronizacao/nuvem-fotos.ts'

async function completarOriginaisFicticios(sql: SQL, transporte: NuvemFotos, conta: string, captura: string): Promise<number> {
  const bytes = new Uint8Array(await Bun.file('testes/arquivos/foto-teste.jpeg').arrayBuffer()), sha256 = await hashDaFoto(bytes)
  const faltantes = await sql<{ produto: string; foto: string; copia: string | null; caminho: string | null; valido: boolean }[]>`
    select p.id::text produto, f.id::text foto, c.id::text copia, c.caminho,
      coalesce(p.nome like 'BA-02 — foto fictícia %' and p.foto_id=f.id and c.foto_id=f.id and c.estado='pendente'
        and f.sha256=${sha256} and f.bytes=${bytes.byteLength} and f.largura=768 and f.altura=1024
        and not exists(select 1 from storage.objects o where o.bucket_id='fotos-produtos' and o.name=c.caminho),false) valido
    from backup_interno.capturas b cross join lateral jsonb_array_elements(b.documento->'fotos') r
    left join public.produtos p on p.dono=b.dono and p.id=(r->>'produtoId')::uuid
    left join fotos_interno.fotos f on f.dono=b.dono and f.id=(r->>'fotoId')::uuid
    left join fotos_interno.copias c on c.dono=b.dono and c.id=(r->>'copiaId')::uuid
    where b.dono=${conta}::uuid and b.id=${captura}::uuid and b.estado='aguardando' and r->>'disponivel' is distinct from 'true'`
  // Só completa o mesmo JPEG da semente interrompida, provado pelo hash já registrado.
  // Qualquer outra pendência recusa antes de enviar; nunca substitui um objeto existente.
  exigirCopia(faltantes.length > 0 && faltantes.every((f) => f.valido && f.caminho === `${conta}/${f.foto}/${f.copia}.jpeg`), 'foto')
  const aparelho_id = crypto.randomUUID(), geracao = crypto.randomUUID()
  for (const f of faltantes) {
    const r = await transporte.rpc('registrar_foto_fila', { documento: { fotoId: f.foto, copiaId: f.copia, sha256,
      bytes: bytes.byteLength, largura: 768, altura: 1024 }, aparelho_id, geracao })
    exigirCopia(r.ok, 'foto')
    const ref = protecaoDaNuvem(r.valor); exigirCopia(ref.caminho === f.caminho && ref.sha256 === sha256 && !ref.disponivel, 'foto')
    const envio = await transporte.enviar(ref.caminho, bytes); exigirCopia(envio.ok, 'foto')
    const lido = await transporte.baixar(ref.caminho); exigirCopia(lido.ok && lido.valor.byteLength === bytes.byteLength && await hashDaFoto(lido.valor) === sha256, 'foto')
    const confirmado = await transporte.rpc('confirmar_arquivo_foto', { copia_id: f.copia, sha256, produto_id: f.produto })
    exigirCopia(confirmado.ok && objetoCopia(confirmado.valor) && confirmado.valor['situacao'] === 'publicada', 'foto')
    const liberada = await transporte.rpc('liberar_protecao_foto', { aparelho_id, copia_id: f.copia, geracao }); exigirCopia(liberada.ok, 'foto')
  }
  return faltantes.length
}

/** Prova real somente em D-050: escreve dados fictícios, preserva-os e não revela respostas/credenciais. */
export async function ensaiarBackupServidor(semear: boolean, interromper: boolean, completarFicticias = false, capturaPronta?: string): Promise<void> {
  let etapa: string = 'configuracao'
  const ambiente = exigirDestinoDeTeste(), sql = conectar(), destino = new URL(process.env.VITE_SUPABASE_URL ?? '').origin
  const cliente = createClient(destino, process.env.VITE_SUPABASE_ANON_KEY ?? '', { auth: { persistSession: false, autoRefreshToken: false } })
  try {
    const autorizacao = await consultarAutorizacaoGoogle(sql)
    exigirCopia(autorizacao && autorizacao.destino === destino && autorizacao.ambiente === ambiente, 'conta')
    const login = await cliente.auth.signInWithPassword({ email: process.env.SUPABASE_TESTE_EMAIL ?? '', password: process.env.SUPABASE_TESTE_SENHA ?? '' })
    exigirCopia(!login.error && login.data.user?.id === autorizacao.contaId, 'conta')
    const nuvem = criarNuvemSupabase(cliente, destino)
    if (semear) {
      etapa = 'dados_ficticios'
      const build = await Bun.build({ entrypoints: ['ferramentas/semear-backup-navegador.ts'], target: 'browser' })
      exigirCopia(build.success && build.outputs.length === 1 && login.data.session)
      const modulo = await build.outputs[0]?.text(); exigirCopia(modulo)
      const semente = Bun.serve({ hostname: '127.0.0.1', port: 0, development: false, fetch(req) {
        if (req.method !== 'GET') return new Response(null, { status: 405 })
        const rota = new URL(req.url).pathname
        if (rota === '/') return new Response('<!doctype html><title>Dados fictícios BA-02</title><script type="module" src="/semente.js"></script>', { headers: { 'content-type': 'text/html' } })
        if (rota === '/semente.js') return new Response(modulo, { headers: { 'content-type': 'text/javascript' } })
        if (rota === '/foto.jpeg') return new Response(Bun.file('testes/arquivos/foto-teste.jpeg'))
        return new Response(null, { status: 404 })
      } })
      let browser: Browser | undefined
      try {
        etapa = 'semente_abrir_navegador'
        browser = await chromium.launch({ headless: true })
        const pagina = await browser.newPage()
        etapa = 'semente_carregar'
        await pagina.goto(`http://127.0.0.1:${semente.port}`)
        etapa = 'semente_modulo'
        await pagina.waitForFunction(() => typeof window.semearBackupDeTeste === 'function')
        etapa = 'semente_sincronizar'
        const dados = await pagina.evaluate((e) => window.semearBackupDeTeste(e), { destino, chavePublica: process.env.VITE_SUPABASE_ANON_KEY ?? '',
          acesso: login.data.session.access_token, renovacao: login.data.session.refresh_token })
        console.log(JSON.stringify({ etapa: 'semente', ...dados, segredosImpressos: false }))
        exigirCopia(dados['sucesso'] === true)
      } finally { await browser?.close(); await semente.stop(true) }
    }
    const rpc = criarRpcBackupSql(sql)
    const portas = { rpc, destino, aoAvancar(fase: string) { etapa = fase },
      async baixarOriginal(ref: Readonly<Record<string, unknown>>) {
        exigirCopia(nuvem.fotos && typeof ref['caminho'] === 'string')
        const r = await nuvem.fotos.baixar(ref['caminho']); exigirCopia(r.ok, 'foto'); return r.valor
      } }
    const agora = new Date().toISOString()
    if (interromper) {
      let parcial = await executarBackupServidor(portas, agora, 1, 262144)
      exigirCopia(parcial.estado === 'pendente')
      let registro = await rpc('consultar_upload_backup', { conta: autorizacao.contaId, captura: parcial.capturaId })
      if (objetoCopia(registro) && registro['estado'] === 'aguardando') {
        const fotos = await sql`select coalesce(c.estado,'sem_copia') estado, (o.id is not null) objeto_existe,
          coalesce(p.nome like 'BA-02 — foto fictícia %',false) semente_do_ensaio,
          (o.metadata->>'mimetype'='image/jpeg') tipo_correto, (o.metadata->>'size'=r->>'bytes') tamanho_correto,
          count(*)::integer quantidade
          from backup_interno.capturas b cross join lateral jsonb_array_elements(b.documento->'fotos') r
          left join public.produtos p on p.dono=b.dono and p.id=(r->>'produtoId')::uuid
          left join fotos_interno.copias c on c.dono=b.dono and c.id=(r->>'copiaId')::uuid
          left join storage.objects o on o.bucket_id='fotos-produtos' and o.name=c.caminho
          where b.dono=${autorizacao.contaId}::uuid and b.id=${parcial.capturaId}::uuid and r->>'disponivel' is distinct from 'true'
          group by 1,2,3,4,5`
        console.log(JSON.stringify({ etapa: 'originais_aguardando', fotos, segredosImpressos: false }))
        if (completarFicticias) {
          etapa = 'completar_originais_ficticios'
          exigirCopia(nuvem.fotos && !semear)
          const completadas = await completarOriginaisFicticios(sql, nuvem.fotos, autorizacao.contaId, parcial.capturaId)
          console.log(JSON.stringify({ etapa, completadas, segredosImpressos: false }))
          const retomada = await executarBackupServidor(portas, agora, 1, 262144)
          exigirCopia(retomada.capturaId === parcial.capturaId && retomada.estado === 'pendente')
          parcial = retomada
          registro = await rpc('consultar_upload_backup', { conta: autorizacao.contaId, captura: parcial.capturaId })
        }
      }
      exigirCopia(objetoCopia(registro) && typeof registro['sessao'] === 'string' && typeof registro['tamanho'] === 'string')
      const tokens = await renovarTokensGoogle(autorizacao.cliente, autorizacao.renovacao)
      const drive = criarDriveBackup(tokens.acesso, autorizacao.contaGoogleId, destino, autorizacao.contaId)
      const recebidos = await drive.consultarPosicao(registro['sessao'], Number(registro['tamanho']))
      exigirCopia(recebidos !== null && recebidos > 0 && recebidos < Number(registro['tamanho']))
      console.log(JSON.stringify({ etapa: 'interrupcao_controlada', ...parcial, recebidos, segredosImpressos: false }))
    }
    let resultado: ResultadoBackupServidor
    let origem: 'servidor' | 'aparelho' = 'servidor'
    if (capturaPronta !== undefined) {
      etapa = 'captura_pronta'
      exigirCopia(!semear && !interromper && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(capturaPronta))
      const r = await rpc('consultar_upload_backup', { conta: autorizacao.contaId, captura: capturaPronta })
      exigirCopia(objetoCopia(r) && r['estado'] === 'pronta' && typeof r['arquivoId'] === 'string' && typeof r['tamanho'] === 'string')
      const [captura] = await sql<{ origem: 'servidor' | 'aparelho' }[]>`
        select origem from backup_interno.capturas where dono=${autorizacao.contaId}::uuid and id=${capturaPronta}::uuid and destino=${destino}`
      exigirCopia(captura)
      origem = captura.origem
      const bytes = Number(r['tamanho']); exigirCopia(Number.isSafeInteger(bytes) && bytes > 0)
      resultado = { estado: 'pronta', capturaId: capturaPronta, arquivoId: r['arquivoId'], bytes }
    } else {
      resultado = await executarBackupServidor(portas, agora)
      exigirCopia(resultado.estado === 'pronta' && resultado.arquivoId)
      // Repetir consulta/conclusão depois do commit não envia outro arquivo.
      const repetida = await executarBackupServidor(portas, agora)
      exigirCopia(repetida.estado === 'pronta' && repetida.arquivoId === resultado.arquivoId)
    }
    exigirCopia(resultado.estado === 'pronta' && resultado.arquivoId)
    etapa = 'download'
    const registro = await rpc('consultar_upload_backup', { conta: autorizacao.contaId, captura: resultado.capturaId })
    exigirCopia(objetoCopia(registro) && typeof registro['pastaId'] === 'string' && typeof registro['sha256'] === 'string')
    const tokens = await renovarTokensGoogle(autorizacao.cliente, autorizacao.renovacao)
    const drive = criarDriveBackup(tokens.acesso, autorizacao.contaGoogleId, destino, autorizacao.contaId)
    const arquivo = await drive.baixar(resultado.arquivoId, registro['pastaId'], resultado.capturaId)
    exigirCopia(await hashDaFoto(new Uint8Array(await arquivo.arrayBuffer())) === registro['sha256'])
    const pasta = resolve(origem === 'servidor' ? 'docs/evidencias/2026-11-05-backup-ba02-servidor' : 'docs/evidencias/2026-11-05-backup-ba03')
    await mkdir(pasta, { recursive: true })
    const caminho = resolve(pasta, `backup-drive-${resultado.capturaId}.zip`); await Bun.write(caminho, arquivo)
    const build = await Bun.build({ entrypoints: ['ferramentas/restaurar-backup-navegador.ts'], target: 'browser', minify: false })
    exigirCopia(build.success && build.outputs.length === 1)
    const modulo = await build.outputs[0]?.text(); exigirCopia(modulo)
    const servidor = Bun.serve({ hostname: '127.0.0.1', port: 0, development: false, fetch(req) {
      if (req.method !== 'GET') return new Response(null, { status: 405 })
      const rota = new URL(req.url).pathname
        if (rota === '/') return new Response('<!doctype html><title>Ensaio de restauração do backup</title><script type="module" src="/leitor.js"></script>', { headers: { 'content-type': 'text/html' } })
      if (rota === '/leitor.js') return new Response(modulo, { headers: { 'content-type': 'text/javascript' } })
      if (rota === '/copia.zip') return new Response(arquivo, { headers: { 'content-type': 'application/zip', 'cache-control': 'no-store' } })
      return new Response(null, { status: 404 })
    } })
    etapa = 'importacao_nativa'
    let browser: Browser | undefined
    try {
      browser = await chromium.launch({ headless: true })
      const pagina = await browser.newPage()
      await pagina.goto(`http://127.0.0.1:${servidor.port}`)
      await pagina.waitForFunction(() => typeof window.restaurarBackupDeTeste === 'function')
      const restauracao = await pagina.evaluate((v) => window.restaurarBackupDeTeste(v.vinculo, v.origem), {
        vinculo: { contaId: autorizacao.contaId, destino }, origem,
      })
      console.log(JSON.stringify({ ambiente, ...resultado, ...(capturaPronta ? { somenteRestauracao: true } : { repeticaoMesmoArquivo: true }), sha256: registro['sha256'], arquivoLocal: caminho,
        restauracao, segredosImpressos: false }))
    } finally { await browser?.close(); await servidor.stop(true) }
  } catch (e) {
    const codigo = e instanceof FalhaDrive ? `http_${e.status}` : e instanceof ErroCopia ? e.motivo : e instanceof SQL.PostgresError ? e.errno : 'interno'
    console.error(JSON.stringify({ etapa, codigo, segredosImpressos: false }))
    throw new Error('Prova não concluída')
  } finally { await sql.close(); await cliente.auth.signOut({ scope: 'local' }) }
}
if (import.meta.main) {
  try {
    const ensaio = process.argv[2] === 'ensaio'
    const captura = process.argv.find((v) => v.startsWith('--captura='))?.slice('--captura='.length)
    await ensaiarBackupServidor(ensaio && !process.argv.includes('--sem-semente'), ensaio, process.argv.includes('--completar-originais-ficticios'), captura)
  }
  catch { console.error('Ensaio de backup não concluído; credenciais e dados privados omitidos.'); process.exitCode = 1 }
}
