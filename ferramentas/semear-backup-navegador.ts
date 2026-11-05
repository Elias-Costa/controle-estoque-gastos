import { createClient } from '@supabase/supabase-js'
import { BancoLocal } from '../src/dados/banco.ts'
import { uuidv7 } from '../src/dados/identidade.ts'
import { criarRepositorioLocal } from '../src/dados/repositorio.ts'
import { cadastrarCliente, lancarVendaFiado } from '../src/dados/operacoes.ts'
import { criarRepositorioEstoque } from '../src/dados/repositorio-estoque.ts'
import { criarOperacoesEstoque } from '../src/dados/operacoes-estoque.ts'
import { criarRepositorioCaixa } from '../src/dados/repositorio-caixa.ts'
import { criarOperacoesCaixa } from '../src/dados/operacoes-caixa.ts'
import { criarNuvemSupabase } from '../src/sincronizacao/nuvem.ts'
import { iniciarSincronizacao } from '../src/sincronizacao/sincronizacao.ts'
import { hashDaFoto, miniaturaDaFoto } from '../src/plataforma/fotos.ts'
import { exigirCopia } from '../src/dados/formato-copia.ts'

type Entrada = { destino: string; chavePublica: string; acesso: string; renovacao: string }
declare global { interface Window { semearBackupDeTeste: (entrada: Entrada) => Promise<Record<string, unknown>> } }
function ok<T>(r: { ok: true; valor: T } | { ok: false; motivo: string }): T {
  if (!r.ok) throw new Error('Fixture recusada')
  return r.valor
}

// Apenas o instrumento de loopback importa este módulo; a sessão fica em memória.
window.semearBackupDeTeste = async (e) => {
  let etapa = 'sessao'
  const cliente = createClient(e.destino, e.chavePublica, { auth: { persistSession: false, autoRefreshToken: false } })
  const sessao = await cliente.auth.setSession({ access_token: e.acesso, refresh_token: e.renovacao })
  exigirCopia(!sessao.error)
  const banco = new BancoLocal(`semente-backup-${uuidv7()}`)
  try {
    const repo = criarRepositorioLocal(banco), estoque = criarOperacoesEstoque(criarRepositorioEstoque(banco)), dia = new Date().toISOString().slice(0, 10)
    etapa = 'cliente'
    const c = ok(await cadastrarCliente(repo, { nome: 'BA-02 — cliente fictícia do ensaio Drive' }))
    etapa = 'venda'
    ok(await lancarVendaFiado(repo, { clienteId: c.id, data: dia, itens: [{ descricao: 'Fictício do backup', preco: 9007199254740993n }],
      parcelas: [{ vencimento: dia, valor: 9007199254740993n }] }))
    etapa = 'categoria'
    const categoria = ok(await estoque.cadastrarCategoria('BA-02 — categoria fictícia'))
    etapa = 'foto_nativa'
    const binario = new Uint8Array(await (await fetch('/foto.jpeg')).arrayBuffer()), miniatura = await miniaturaDaFoto(binario)
    for (let i = 0; i < 20; i++) {
      etapa = 'produto'
      const p = ok(await estoque.cadastrarProduto({ nome: `BA-02 — foto fictícia ${i + 1}`, categoriaId: categoria.id, classificacao: 'unissex' },
        { binario, miniatura, sha256: await hashDaFoto(binario), largura: 768, altura: 1024 }))
      etapa = 'compra'
      ok(await estoque.registrarMovimento({ tipo: 'compra', produtoId: p.id, data: dia, quantidade: 7, custoUnitario: 10000n }))
    }
    etapa = 'caixa'
    ok(await criarOperacoesCaixa(criarRepositorioCaixa(banco)).registrar({ tipo: 'despesa', data: dia, valor: 10000n, categoria: 'BA-02 fictícia', classificacao: 'negocio', mercadoria: false }))
    const motor = iniciarSincronizacao({ banco, nuvem: criarNuvemSupabase(cliente, e.destino), janela: null, documento: null, agendar: () => () => undefined })
    etapa = 'motor'
    try {
      for (let rodada = 0; rodada < 5 && (await banco.fila.count() > 0 || !motor.estado().ultimoSucessoEm); rodada++) await motor.sincronizar()
      const estado = motor.estado(), fila = await banco.fila.toArray()
      const porTabela: Record<string, number> = {}
      for (const item of fila) porTabela[item.tabela] = (porTabela[item.tabela] ?? 0) + 1
      return { sucesso: fila.length === 0 && estado.ultimoSucessoEm !== null, etapa,
        pendentes: estado.pendentes, comProblema: estado.comProblema, ultimaFalha: estado.ultimaFalha, porTabela }
    } finally { motor.parar() }
  } catch {
    return { sucesso: false, etapa }
  } finally { banco.close() }
}
