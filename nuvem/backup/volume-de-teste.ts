import { createHash } from 'node:crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { clienteParaNuvem, lancamentoParaNuvem } from '../../src/sincronizacao/borda.ts'
import { COLUNAS_PRODUTO, documentoProduto, produtoDaNuvem } from '../../src/sincronizacao/borda-estoque.ts'
import { criarNuvemFotos, protecaoDaNuvem } from '../../src/sincronizacao/nuvem-fotos.ts'
import { hashDaFoto } from '../../src/plataforma/fotos.ts'
import { exigirCopia, objetoCopia } from '../../src/dados/formato-copia.ts'
import { exigirDestinoDeTeste } from '../ambiente-de-teste.ts'
import { conectar } from '../migrar.ts'
import { consultarAutorizacaoGoogle } from './cofre-google.ts'

const ROTULO = 'BA-04 fictício'
const CARIMBO = '2026-11-05T12:00:00.000Z'

// Identidades da fixture estáveis por conta para poder retomar lotes sem duplicar fatos.
function id(conta: string, tipo: string, indice = 0): string {
  const h = createHash('sha256').update(`${ROTULO}:${conta}:${tipo}:${indice}`).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`
}

async function semearFichas(cliente: SupabaseClient, conta: string, amostra: boolean, variacao: boolean): Promise<void> {
  const clientes = Array.from({ length: amostra ? 2 : 150 }, (_, i) => clienteParaNuvem({
    id: id(conta, 'cliente', i), nome: `${ROTULO} — ficha ${i + 1}`, atualizadoEm: CARIMBO,
  }))
  if (!variacao) {
    const cadastro = await cliente.from('clientes').upsert(clientes, { onConflict: 'id' })
    exigirCopia(!cadastro.error)
  }
  const base = amostra ? 2 : 2400
  const vendas = variacao ? (amostra ? 1 : 480) : base
  const primeira = variacao ? base : 0, fim = primeira + vendas
  // Agrupa no transporte, mantendo constraints, RLS e a borda de centavos em texto.
  for (let inicio = primeira; inicio < fim; inicio += 100) {
    const linhas = []
    for (let i = inicio; i < Math.min(inicio + 100, fim); i++) {
      const ficha = clientes[i % clientes.length]; exigirCopia(ficha)
      const data = `${2021 + Math.floor(i / 480)}-${String(Math.floor(i / 40) % 12 + 1).padStart(2, '0')}-01`
      const parcelas = Array.from({ length: 6 }, (_, n) => ({ id: id(conta, 'parcela', i * 6 + n), vencimento: data, valor: 200n }))
      linhas.push(lancamentoParaNuvem({ id: id(conta, 'venda', i), clienteId: ficha.id, data, tipo: 'venda', pagamento: 'fiado',
        itens: [{ descricao: ROTULO, preco: 1200n }], parcelas, desconto: 0n }))
      for (let n = 0; n < 6; n++) linhas.push(lancamentoParaNuvem({ id: id(conta, 'recebimento', i * 6 + n), clienteId: ficha.id, data,
        tipo: 'recebimento', forma: 'dinheiro', valor: 200n }))
    }
    const envio = await cliente.from('lancamentos').upsert(linhas, { onConflict: 'id' })
    exigirCopia(!envio.error)
  }
  console.log(JSON.stringify({ clientes: clientes.length, vendas, recebimentos: vendas * 6 }))
}

async function semearOriginais(cliente: SupabaseClient, conta: string, quantidade: number, variacao: boolean): Promise<void> {
  const categoriaId = id(conta, 'categoria'), aparelho_id = id(conta, 'aparelho')
  if (!variacao) {
    const categoria = await cliente.rpc('gravar_categoria_estoque', { cadastro: { id: categoriaId, nome: ROTULO } })
    exigirCopia(!categoria.error)
  }
  const fotos = criarNuvemFotos(cliente), geracao = crypto.randomUUID()
  const jpeg = new Uint8Array(await Bun.file('testes/arquivos/foto-teste.jpeg').arrayBuffer())
  exigirCopia(jpeg.byteLength < 204800)
  async function publicar(i: number): Promise<void> {
    const produtoId = id(conta, 'produto', i), nome = `${ROTULO} — produto ${i + 1}`
    const fotoAnterior = id(conta, 'foto', i)
    const fotoId = variacao ? id(conta, 'foto-alterada', i) : fotoAnterior
    const copiaId = id(conta, variacao ? 'copia-alterada' : 'copia', i)
    let produto = { id: produtoId, nome, categoriaId, fotoId, atualizadoEm: CARIMBO }
    if (variacao) {
      const atual = await cliente.from('produtos').select(COLUNAS_PRODUTO).eq('id', produtoId).single()
      exigirCopia(!atual.error, 'foto')
      const anterior = produtoDaNuvem(atual.data)
      exigirCopia(anterior.nome === nome && anterior.categoriaId === categoriaId &&
        (anterior.fotoId === fotoAnterior || anterior.fotoId === fotoId), 'foto')
      produto = { ...anterior, fotoId, atualizadoEm: anterior.fotoId === fotoId ? anterior.atualizadoEm : new Date().toISOString() }
    }
    const binario = new Uint8Array(204800)
    binario.set(jpeg)
    // Sufixo após o JPEG, como no ensaio de BA-01. Cada objeto tem bytes/hash próprios.
    new DataView(binario.buffer).setUint32(binario.byteLength - 4, variacao ? 0xffffffff : i)
    const sha256 = await hashDaFoto(binario)
    const r = await fotos.rpc('registrar_foto_fila', { documento: { fotoId, copiaId, sha256, bytes: binario.byteLength,
      largura: 768, altura: 1024 }, aparelho_id, geracao })
    exigirCopia(r.ok, 'foto')
    const ref = protecaoDaNuvem(r.valor)
    exigirCopia(ref.caminho === `${conta}/${fotoId}/${copiaId}.jpeg` && ref.sha256 === sha256, 'foto')
    if (!ref.disponivel) {
      // Mesmo com resposta perdida no envio, só aponta o produto para os bytes já conferidos.
      await fotos.enviar(ref.caminho, binario)
      const lido = await fotos.baixar(ref.caminho)
      exigirCopia(lido.ok && await hashDaFoto(lido.valor) === sha256, 'foto')
    }
    const cadastro = await cliente.rpc('gravar_produto_estoque', { cadastro: documentoProduto(produto) })
    exigirCopia(!cadastro.error, 'foto')
    if (!ref.disponivel || variacao) {
      const confirmado = await fotos.rpc('confirmar_arquivo_foto', { copia_id: copiaId, sha256, produto_id: produtoId })
      exigirCopia(confirmado.ok && objetoCopia(confirmado.valor) && confirmado.valor['situacao'] === 'publicada', 'foto')
    }
    exigirCopia((await fotos.rpc('liberar_protecao_foto', { aparelho_id, copia_id: copiaId, geracao })).ok, 'foto')
    if (variacao) console.log(JSON.stringify({ produtoId, fotoAnterior, fotoId, sha256, bytes: binario.byteLength }))
  }
  if (variacao) { await publicar(0); return }
  for (let inicio = 0; inicio < quantidade; inicio += 4) {
    const lote = await Promise.allSettled(Array.from({ length: Math.min(4, quantidade - inicio) }, (_, i) => publicar(inicio + i)))
    if (lote.some((r) => r.status === 'rejected')) throw new Error(`Lote de fotos interrompido a partir do índice ${inicio}.`)
    if ((inicio + 4) % 40 === 0) console.log(JSON.stringify({ originaisConfirmados: inicio + 4 }))
  }
  console.log(JSON.stringify({ originaisConfirmados: quantidade, bytesOriginais: quantidade * 204800 }))
}

if (import.meta.main) {
  let etapa = 'configuracao'
  try {
    const ambiente = exigirDestinoDeTeste(), amostra = ambiente === 'local'
    const variacao = process.argv.includes('--variacao')
    const destino = new URL(process.env.VITE_SUPABASE_URL ?? '').origin
    const cliente = createClient(destino, process.env.VITE_SUPABASE_ANON_KEY ?? '', { auth: { persistSession: false, autoRefreshToken: false } })
    try {
      const login = await cliente.auth.signInWithPassword({ email: process.env.SUPABASE_TESTE_EMAIL ?? '',
        password: process.env.SUPABASE_TESTE_SENHA ?? '' })
      exigirCopia(!login.error && login.data.user, 'conta')
      const conta = login.data.user.id
      if (!amostra) {
        const sql = conectar()
        try {
          const autorizacao = await consultarAutorizacaoGoogle(sql)
          exigirCopia(autorizacao?.ambiente === ambiente && autorizacao.destino === destino && autorizacao.contaId === conta, 'conta')
        } finally { await sql.close() }
      }
      etapa = 'fichas'
      await semearFichas(cliente, conta, amostra, variacao)
      etapa = 'originais'
      await semearOriginais(cliente, conta, amostra ? 2 : 400, variacao)
      console.log(JSON.stringify({ ambiente, amostra, variacao, segredosImpressos: false }))
    } finally { await cliente.auth.signOut({ scope: 'local' }) }
  } catch {
    console.error(`Carga fictícia interrompida em ${etapa}. A reexecução conserva as identidades.`)
    process.exitCode = 1
  }
}
