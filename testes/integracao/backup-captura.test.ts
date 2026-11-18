import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { SQL, type TransactionSQL } from 'bun'
import { exigirDestinoDeTeste } from '../../nuvem/ambiente-de-teste.ts'
import { conectar, executarReversao, lerMigracoes } from '../../nuvem/migrar.ts'
import { uuidv7 } from '../../src/dados/identidade.ts'

const LIGADA = process.env.INTEGRACAO === '1'
if (LIGADA) exigirDestinoDeTeste()
let sql: SQL
class Revertida extends Error {}
const SHA = 'a'.repeat(64), DESTINO = 'http://127.0.0.1:54321', AGORA = '2026-11-05T14:00:00.000Z'
beforeAll(() => { if (LIGADA) sql = conectar() })
afterAll(async () => { if (LIGADA) await sql.close() })
async function transacao(fn: (tx: TransactionSQL, conta: string) => Promise<void>) {
  try { await sql.begin(async (tx) => {
    const instalada = (await tx<{ existe: boolean }[]>`select exists(select 1 from pg_namespace where nspname='backup_interno') existe`)[0]?.existe
    if (!instalada) throw new Error('Migration BA-02 ausente; execute pelo runner do ambiente de teste.')
    const mutacao = process.env.MUTACAO_BACKUP
    if (mutacao && process.env.AMBIENTE_DE_TESTE !== 'local') throw new Error('Mutação de backup exige o banco local.')
    if (mutacao === 'dinheiro_numerico') {
      await tx.unsafe("create or replace function backup_interno.dinheiro_textual(v jsonb) returns jsonb language sql immutable set search_path='' as 'select v'")
    } else if (mutacao) {
      const alteracoes = new Map([
        ['foto_sem_protecao', ['public.autorizar_coleta_fotos(integer)', 'public.permitir_objeto_foto(text,text)']],
        ['retencao_sem_exclusivos', ['public.planejar_rotacao_backup(uuid)']],
        ['leitura_sem_dono', ['public.ler_captura_backup(uuid,uuid,text,integer,integer)']],
        ['confirmar_sem_hash', ['public.confirmar_backup(uuid,uuid,text,text,text)']],
      ])
      const assinaturas = alteracoes.get(mutacao)
      if (!assinaturas) throw new Error('Mutação desconhecida; nenhuma alteração aplicada')
      for (const assinatura of assinaturas) {
        const [r] = await tx<{ definicao: string }[]>`select pg_get_functiondef(${assinatura}::regprocedure) definicao`
        if (!r) throw new Error('Função ausente para a mutação')
        let alterada = r.definicao
        if (mutacao === 'foto_sem_protecao') alterada = alterada.replaceAll(/and not exists\(select 1 from backup_interno\.protecoes p where p\.dono=conta and p\.copia_id=(?:c|copias)\.id\)/g, '')
        if (mutacao === 'retencao_sem_exclusivos') alterada = alterada.replace('if cardinality(c.exclusivos)>0 and not coberta then', 'if false and cardinality(c.exclusivos)>0 and not coberta then')
        if (mutacao === 'leitura_sem_dono') alterada = alterada.replace('b.id=captura and b.dono=conta and b.estado', 'b.id=captura and b.estado')
        if (mutacao === 'confirmar_sem_hash') alterada = alterada.replace('and c.sha256=confirmar_backup.sha256', '')
        if (alterada === r.definicao) throw new Error('Mutação não encontrou a guarda; não contar como prova')
        await tx.unsafe(alterada)
      }
    }
    await fn(tx, uuidv7()); throw new Revertida()
  }) } catch (e) { if (!(e instanceof Revertida)) throw e }
}
async function capturar(tx: SQL, conta: string, captura = uuidv7(), agora = AGORA) {
  const [r] = await tx<{ r: { id: string; estado: string; dia: string } }[]>`select public.capturar_backup_servidor(${conta}::uuid,${captura}::uuid,${DESTINO},${agora}::timestamptz) r`
  if (!r) throw new Error('Sem captura')
  return r.r
}
async function pagina(tx: SQL, conta: string, id: string, tabela: string) {
  const [r] = await tx<{ r: { linhas: Record<string, unknown>[]; total: number } }[]>`select public.ler_captura_backup(${conta}::uuid,${id}::uuid,${tabela},0,250) r`
  if (!r) throw new Error('Sem página')
  return r.r
}
async function recusar(tx: TransactionSQL, operacao: (sp: SQL) => Promise<unknown>, codigo: string) {
  let recusou = false
  try { await tx.savepoint(operacao) } catch (e) {
    if (!(e instanceof SQL.PostgresError)) throw e
    expect(e.errno).toBe(codigo); recusou = true
  }
  expect(recusou).toBe(true)
}
async function assumir(tx: SQL, conta: string) { await tx`select set_config('request.jwt.claims',${JSON.stringify({ sub: conta, role: 'authenticated' })},true)` }

describe.skipIf(!LIGADA)('BA-02 captura/retencao SQL — somente dados fictícios e rollback', () => {
  test('reversão vazia preserva fotos/ACLs; captura/configuração existente recusa antes do DDL', () => transacao(async (tx, conta) => {
    const reverter = await Bun.file('nuvem/migracoes/0014_backup-automatico.reverter.sql').text()
    const [vazia] = await tx<{ n: number }[]>`select (select count(*) from backup_interno.capturas)::integer+(select count(*) from backup_interno.destinos)::integer n`
    if (vazia?.n === 0 && exigirDestinoDeTeste() === 'local') {
      // D-041: a reversão histórica também precisa respeitar a ordem das dependências.
      const posteriores = (await lerMigracoes()).filter((m) => m.nome > '0014_backup-automatico')
      for (const versao of posteriores.toReversed()) await executarReversao(tx, versao)
      await tx.unsafe(reverter)
      await tx.unsafe(await Bun.file('nuvem/migracoes/0014_backup-automatico.sql').text())
      for (const versao of posteriores) await tx.unsafe(versao.aplicar)
    }
    await capturar(tx, conta)
    await recusar(tx, (sp) => sp.unsafe(reverter), '23514')
    expect((await tx<{ existe: boolean }[]>`select exists(select 1 from storage.buckets where id='fotos-produtos') existe`)[0]?.existe).toBe(true)
  }))
  test('papéis do app não leem captura/estado/sessão; service_role usa somente RPC', () => transacao(async (tx, conta) => {
    const c = await capturar(tx, conta)
    for (const papel of ['anon', 'authenticated', 'service_role']) {
      await recusar(tx, async (sp) => { await sp.unsafe(`set local role ${papel}`); await sp`select * from backup_interno.capturas` }, '42501')
      if (papel !== 'service_role') await recusar(tx, async (sp) => { await sp.unsafe(`set local role ${papel}`); await pagina(sp, conta, c.id, 'clientes') }, '42501')
    }
    await tx.unsafe('set local role service_role')
    expect((await pagina(tx, conta, c.id, 'clientes')).total).toBe(0)
    await tx.unsafe('reset role')
    await recusar(tx, (sp) => pagina(sp, uuidv7(), c.id, 'clientes'), '23514')
    for (const papel of ['anon', 'authenticated']) {
      const [p] = await tx<{ pode: boolean }[]>`select has_function_privilege(${papel},'public.obter_autorizacao_backup()','execute') pode`
      expect(p?.pode).toBe(false)
    }
  }))
  test('pasta reservada é estável e não troca de destino; espera atrasada não bloqueia captura já pronta para envio', () => transacao(async (tx, conta) => {
    expect((await tx<{ r: string }[]>`select public.reservar_pasta_backup(${conta}::uuid,${DESTINO},'pasta-reservada') r`)[0]?.r).toBe('pasta-reservada')
    expect((await tx<{ r: string }[]>`select public.reservar_pasta_backup(${conta}::uuid,${DESTINO},'outra-pasta') r`)[0]?.r).toBe('pasta-reservada')
    await recusar(tx, (sp) => sp`select public.reservar_pasta_backup(${conta}::uuid,'https://outro.supabase.co','outra-pasta')`, '23514')
    const c = await capturar(tx, conta)
    expect((await tx<{ r: { id: string } }[]>`select public.proxima_captura_backup(${conta}::uuid) r`)[0]?.r.id).toBe(c.id)
    const outra = uuidv7()
    await tx`insert into backup_interno.capturas(id,dono,destino,origem,dia,capturado_em,estado,tentado_em) values
      (${outra}::uuid,${conta}::uuid,${DESTINO},'servidor','2026-11-01','2026-11-01T14:00:00Z','aguardando','2026-11-01T14:00:00Z')`
    expect((await tx<{ r: { id: string } }[]>`select public.proxima_captura_backup(${conta}::uuid) r`)[0]?.r.id).toBe(c.id)
  }))
  test('centavos numéricos legados saem como texto exato; repetição não relê cadastro/histórico', () => transacao(async (tx, conta) => {
    const cliente = uuidv7(), parcela = uuidv7(), lancamento = uuidv7()
    await tx`insert into public.clientes(id,dono,nome,atualizado_em) values(${cliente}::uuid,${conta}::uuid,'Nome congelado',${AGORA}::timestamptz)`
    await tx`insert into public.lancamentos(id,dono,cliente_id,data,tipo,parcelas) values(${lancamento}::uuid,${conta}::uuid,${cliente}::uuid,'2026-11-05','saldo-anterior',
      jsonb_build_array(jsonb_build_object('id',${parcela}::text,'vencimento','2026-11-05','valor',9007199254740993::bigint)))`
    const c = await capturar(tx, conta)
    expect(c.estado).toBe('capturada')
    expect((await pagina(tx, conta, c.id, 'lancamentos')).linhas[0]?.['parcelas']).toEqual([{ id: parcela, vencimento: '2026-11-05', valor: '9007199254740993' }])
    await tx`update public.clientes set nome='Nome posterior',atualizado_em='2026-11-05T15:00:00Z' where id=${cliente}::uuid`
    expect((await capturar(tx, conta)).id).toBe(c.id)
    expect((await pagina(tx, conta, c.id, 'clientes')).linhas[0]?.['nome']).toBe('Nome congelado')
    expect((await capturar(tx, conta, uuidv7(), '2026-11-06T02:59:59Z')).id).toBe(c.id)
    expect((await capturar(tx, conta, uuidv7(), '2026-11-06T03:00:00Z')).dia).toBe('2026-11-06')
  }))
  test('duas conexões: cadastro e recebimento concorrentes entram juntos na visão capturada', () => transacao(async (tx, conta) => {
    // D-042: a conexão concorrente precisa enxergar a base. Somente estas linhas fictícias
    // são commitadas; captura/DDL continuam em rollback, sem limpeza de histórico financeiro.
    const cliente = uuidv7(), saldo = uuidv7(), parcela = uuidv7()
    const concorrente = conectar()
    try {
    await concorrente.begin(async (w) => {
      await w`insert into public.clientes(id,dono,nome,atualizado_em) values(${cliente}::uuid,${conta}::uuid,'Antes do recebimento','2026-11-05T14:00:00Z')`
      await w`insert into public.lancamentos(id,dono,cliente_id,data,tipo,parcelas) values(${saldo}::uuid,${conta}::uuid,${cliente}::uuid,'2026-11-05','saldo-anterior',
        jsonb_build_array(jsonb_build_object('id',${parcela}::text,'vencimento','2026-11-05','valor','10000')))`
    })
    const pronta = Promise.withResolvers<void>(), liberar = Promise.withResolvers<void>()
    const escrita = concorrente.begin(async (w) => {
      await w`update public.clientes set nome='Depois do recebimento',atualizado_em='2026-11-05T15:00:00Z' where id=${cliente}::uuid`
      await w`insert into public.lancamentos(id,dono,cliente_id,data,tipo,valor,forma)
        values(${uuidv7()}::uuid,${conta}::uuid,${cliente}::uuid,'2026-11-05','recebimento',1000,'pix')`
      pronta.resolve(); await liberar.promise
    }).catch((e: unknown) => { pronta.reject(e); throw e })
    void escrita.catch(() => {})
    try {
      await pronta.promise
      const antes = await capturar(tx, conta)
      expect((await pagina(tx, conta, antes.id, 'clientes')).linhas[0]?.['nome']).toBe('Antes do recebimento')
      expect((await pagina(tx, conta, antes.id, 'lancamentos')).total).toBe(1)
      liberar.resolve()
      const [durante] = await Promise.all([capturar(tx, conta, uuidv7(), '2026-11-06T14:00:00Z'), escrita])
      const nome = (await pagina(tx, conta, durante.id, 'clientes')).linhas[0]?.['nome'], n = (await pagina(tx, conta, durante.id, 'lancamentos')).total
      expect(nome === 'Antes do recebimento' && n === 1 || nome === 'Depois do recebimento' && n === 2).toBe(true)
      const depois = await capturar(tx, conta, uuidv7(), '2026-11-07T14:00:00Z')
      expect((await pagina(tx, conta, depois.id, 'clientes')).linhas[0]?.['nome']).toBe('Depois do recebimento')
      expect((await pagina(tx, conta, depois.id, 'lancamentos')).total).toBe(2)
    } finally { liberar.resolve(); await escrita }
    } finally { await concorrente.close() }
  }))
  test('foto atrasada mantém captura/financeiro; a proteção própria impede coleta mesmo após remover do produto', () => transacao(async (tx, conta) => {
    await assumir(tx, conta)
    const categoria = uuidv7(), produto = uuidv7(), foto = uuidv7(), copia = uuidv7(), aparelho = uuidv7(), geracao = uuidv7(), cliente = uuidv7()
    await tx`insert into public.clientes(id,dono,nome,atualizado_em) values(${cliente}::uuid,${conta}::uuid,'Antes da imagem',${AGORA}::timestamptz)`
    await tx`select public.gravar_categoria_estoque(${{ id: categoria, nome: 'Foto BA-02' }}::jsonb)`
    await tx`select public.registrar_foto_fila(${{ fotoId: foto, copiaId: copia, sha256: SHA, bytes: 4, largura: 1, altura: 1 }}::jsonb,${aparelho}::uuid,${geracao}::uuid)`
    await tx`select public.gravar_produto_estoque(${{ id: produto, categoriaId: categoria, nome: 'Imagem atrasada', fotoId: foto, atualizadoEm: AGORA }}::jsonb)`
    const c = await capturar(tx, conta)
    expect(c.estado).toBe('aguardando')
    await tx`update public.clientes set nome='Depois da imagem',atualizado_em='2026-11-05T15:00:00Z' where id=${cliente}::uuid`
    const caminho = `${conta}/${foto}/${copia}.jpeg`
    await tx`insert into storage.objects(bucket_id,name,metadata) values('fotos-produtos',${caminho},${{ size: 4, mimetype: 'image/jpeg' }}::jsonb)`
    await tx`select public.confirmar_arquivo_foto(${copia}::uuid,${SHA},${produto}::uuid)`
    expect((await capturar(tx, conta)).estado).toBe('capturada')
    expect((await pagina(tx, conta, c.id, 'clientes')).linhas[0]?.['nome']).toBe('Antes da imagem')
    await tx`select public.gravar_produto_estoque(${{ id: produto, categoriaId: categoria, nome: 'Sem imagem', atualizadoEm: '2026-11-05T16:00:00Z' }}::jsonb)`
    await tx`select public.liberar_protecao_foto(${aparelho}::uuid,${copia}::uuid,${geracao}::uuid)`
    expect((await tx<{ r: unknown[] }[]>`select public.autorizar_coleta_fotos(100) r`)[0]?.r).toEqual([])
    await tx`update fotos_interno.copias set estado='coleta' where id=${copia}::uuid`
    expect((await tx<{ r: boolean }[]>`select public.permitir_objeto_foto(${caminho},'apagar') r`)[0]?.r).toBe(false)
    await tx`select public.cancelar_captura_backup(${conta}::uuid,${c.id}::uuid)`
    expect((await tx<{ r: boolean }[]>`select public.permitir_objeto_foto(${caminho},'apagar') r`)[0]?.r).toBe(true)
  }))
  test('conferência divergente não publica, muda snapshot ou libera antes de confirmar; identidade do upload é estável', () => transacao(async (tx, conta) => {
    const c = await capturar(tx, conta)
    await tx`select public.registrar_upload_backup(${conta}::uuid,${c.id}::uuid,'arquivo','pasta',null,'100',${SHA},${tx.array([SHA], 'TEXT')})`
    await recusar(tx, (sp) => sp`select public.registrar_upload_backup(${conta}::uuid,${c.id}::uuid,'outro','pasta',null,'100',${SHA},${sp.array([SHA], 'TEXT')})`, '23514')
    await recusar(tx, (sp) => sp`select public.confirmar_backup(${conta}::uuid,${c.id}::uuid,'arquivo','99',${SHA})`, '23514')
    await recusar(tx, (sp) => sp`select public.confirmar_backup(${conta}::uuid,${c.id}::uuid,'arquivo','100',${'b'.repeat(64)})`, '23514')
    expect((await pagina(tx, conta, c.id, 'clientes')).total).toBe(0)
    await tx`select public.confirmar_backup(${conta}::uuid,${c.id}::uuid,'arquivo','100',${SHA})`
    await tx`select public.confirmar_backup(${conta}::uuid,${c.id}::uuid,'arquivo','100',${SHA})`
    await recusar(tx, (sp) => pagina(sp, conta, c.id, 'clientes'), '23514')
    expect((await tx<{ estado: string }[]>`select estado from backup_interno.capturas where id=${c.id}::uuid`)[0]?.estado).toBe('pronta')
  }))
  test('três datas/origens e pendência exclusiva protegida até outra íntegra cobrir o mesmo material', () => transacao(async (tx, conta) => {
    async function pronta(dia: string, origem = 'servidor', material: string[] = [], exclusivos: string[] = []) {
      const id = uuidv7()
      await tx`insert into backup_interno.capturas(id,dono,destino,origem,aparelho_id,dia,capturado_em,estado,arquivo_id,pasta_id,tamanho,sha256,material,exclusivos,confirmado_em)
        values(${id}::uuid,${conta}::uuid,${DESTINO},${origem},${origem === 'aparelho' ? uuidv7() : null}::uuid,${dia}::date,
        ${dia + 'T14:00:00Z'}::timestamptz,'pronta',${id},'pasta',100,${SHA},${tx.array(material, 'TEXT')},${tx.array(exclusivos, 'TEXT')},clock_timestamp())`
      return id
    }
    const exclusiva = await pronta('2026-10-30', 'aparelho', [SHA], [SHA])
    const velha = await pronta('2026-11-01')
    await pronta('2026-11-02'); await pronta('2026-11-03'); await pronta('2026-11-04'); await pronta('2026-11-05')
    await pronta('2026-11-05', 'aparelho')
    const [p] = await tx<{ r: { id: string }[] }[]>`select public.planejar_rotacao_backup(${conta}::uuid) r`
    expect(p?.r.some((r) => r.id === velha)).toBe(true); expect(p?.r.some((r) => r.id === exclusiva)).toBe(false)
    expect((await tx<{ n: number }[]>`select count(*)::integer n from backup_interno.capturas where dono=${conta}::uuid and estado='pronta'`)[0]?.n).toBe(5)
    await pronta('2026-11-06', 'servidor', [SHA])
    const [p2] = await tx<{ r: { id: string }[] }[]>`select public.planejar_rotacao_backup(${conta}::uuid) r`
    expect(p2?.r.some((r) => r.id === exclusiva)).toBe(true)
    await recusar(tx, (sp) => sp`select public.concluir_rotacao_backup(${uuidv7()}::uuid,${exclusiva}::uuid,${exclusiva})`, '23514')
    await tx`select public.concluir_rotacao_backup(${conta}::uuid,${exclusiva}::uuid,${exclusiva})`
  }))
  test('foto/captura indisponível e dia incompleto não autorizam rotação da única válida', () => transacao(async (tx, conta) => {
    const c = await capturar(tx, conta)
    await tx`select public.registrar_upload_backup(${conta}::uuid,${c.id}::uuid,'arquivo','pasta',null,'100',${SHA},${tx.array([], 'TEXT')})`
    await tx`select public.confirmar_backup(${conta}::uuid,${c.id}::uuid,'arquivo','100',${SHA})`
    await capturar(tx, conta, uuidv7(), '2026-11-06T14:00:00Z')
    expect((await tx<{ r: unknown[] }[]>`select public.planejar_rotacao_backup(${conta}::uuid) r`)[0]?.r).toEqual([])
    await recusar(tx, (sp) => sp`select public.concluir_rotacao_backup(${conta}::uuid,${c.id}::uuid,'arquivo')`, '23514')
    await recusar(tx, (sp) => pagina(sp, conta, c.id, 'inscricoes'), '23514')
  }))
  test('BA-03 separa a candidata do Cron e limita reserva, retomada e leitura ao aparelho e conta', () => transacao(async (tx, conta) => {
    const id = uuidv7(), aparelho = uuidv7()
    const instante = new Date(Date.now() - 86_400_000).toISOString()
    const sessao = 'https://www.googleapis.com/upload/drive/v3/files?upload_id=ficcao'
    await tx`select public.reservar_pasta_backup(${conta}::uuid,${DESTINO},'pasta-ba03')`
    const reservar = (sp: SQL, captura = id, dono = conta, hash = SHA, arquivo = 'arquivo-ba03') => sp<{ r: Record<string, unknown> }[]>`
      select public.reservar_backup_aparelho(${dono}::uuid,${captura}::uuid,${aparelho}::uuid,${DESTINO},${instante}::timestamptz,
        ${arquivo},'pasta-ba03','100',${hash},${sp.array([SHA], 'TEXT')},${sp.array([SHA], 'TEXT')}) r`
    const consultar = (sp: SQL, dono = conta, dispositivo = aparelho, destino = DESTINO) => sp<{ r: unknown }[]>`
      select public.consultar_backup_aparelho(${dono}::uuid,${id}::uuid,${dispositivo}::uuid,${destino}) r`
    expect((await reservar(tx))[0]?.r).toMatchObject({ estado: 'enviando', arquivoId: 'arquivo-ba03', sessao: null })
    expect((await reservar(tx, id, conta, SHA, 'id-de-outra-aba'))[0]?.r['arquivoId']).toBe('arquivo-ba03')
    expect((await tx<{ r: unknown }[]>`select public.proxima_captura_backup(${conta}::uuid) r`)[0]?.r).toBeNull()
    expect((await consultar(tx, uuidv7()))[0]?.r).toBeNull()
    expect((await consultar(tx, conta, uuidv7()))[0]?.r).toBeNull()
    expect((await consultar(tx, conta, aparelho, 'https://outro.supabase.co'))[0]?.r).toBeNull()
    await recusar(tx, (sp) => reservar(sp, id, uuidv7()), '23514')
    await recusar(tx, (sp) => reservar(sp, id, conta, 'b'.repeat(64)), '23514')
    await recusar(tx, (sp) => reservar(sp, uuidv7()), '23505')
    await recusar(tx, async (sp) => { await sp.unsafe('set local role authenticated'); await consultar(sp) }, '42501')
    await tx`select public.trocar_sessao_backup_aparelho(${conta}::uuid,${id}::uuid,${aparelho}::uuid,${DESTINO},null,${sessao})`
    await tx`select public.trocar_sessao_backup_aparelho(${conta}::uuid,${id}::uuid,${aparelho}::uuid,${DESTINO},null,${sessao + '-atrasada'})`
    expect((await consultar(tx))[0]?.r).toMatchObject({ sessao })
    expect((await tx<{ r: unknown }[]>`select public.ultimo_backup_confirmado(${conta}::uuid,${DESTINO}) r`)[0]?.r).toBeNull()
    await tx`select public.confirmar_backup(${conta}::uuid,${id}::uuid,'arquivo-ba03','100',${SHA})`
    expect((await consultar(tx))[0]?.r).toMatchObject({ estado: 'pronta', sessao: null })
    expect((await tx<{ r: unknown }[]>`select public.ultimo_backup_confirmado(${conta}::uuid,${DESTINO}) r`)[0]?.r).toMatchObject({ origem: 'aparelho' })
  }))
})
