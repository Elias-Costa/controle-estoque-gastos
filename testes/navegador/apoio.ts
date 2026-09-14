import { expect, test, type Page } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import type { ClienteLocal } from '../../src/dados/banco.ts'
import type { Cliente, Lancamento } from '../../src/dominio/ficha.ts'
import { clienteDaNuvem, lancamentoDaNuvem } from '../../src/sincronizacao/borda.ts'
import { criarNuvemSupabase, type Nuvem, type Resposta } from '../../src/sincronizacao/nuvem.ts'
import type { EstadoDaSincronizacao } from '../../src/sincronizacao/sincronizacao.ts'

// O tipo de `window.laboratorio` vem do módulo que o declara (`declare global`); reexportá-lo é o
// que põe esse módulo na compilação dos testes e dá tipo aos `evaluate` abaixo.
export type { Laboratorio } from '../../src/plataforma/laboratorio.ts'

/**
 * O apoio da prova de offline (E-08, D-043): a mão do teste no `window.laboratorio` do build de
 * laboratório, e a mão do teste na nuvem **de fora** do navegador, pelo `supabase-js` em Node.
 *
 * Três regras atravessam este arquivo. **Toda conversão `bigint`↔texto acontece dentro do
 * `page.evaluate`**, do lado da página: o laboratório expõe os objetos como são, o teste monta
 * `BigInt('10000')` lá e traz `String(saldo)` de volta — nada de mapeamento no app. **Cada
 * callback de `evaluate` é autossuficiente**: o Playwright serializa a função e a roda na página,
 * então nada do escopo de fora existe lá — por isso a guarda do laboratório se repete em cada um.
 * E **o teste nunca "passa" sem sessão**: sem o usuário de teste em `.env.local`,
 * `pularSemUsuario()` pula a suíte dizendo por quê, como `testes/integracao/sincronizacao.test.ts`.
 */

const URL = process.env.VITE_SUPABASE_URL ?? ''
const CHAVE = process.env.VITE_SUPABASE_ANON_KEY ?? ''
const EMAIL = process.env.SUPABASE_TESTE_EMAIL ?? ''
const SENHA = process.env.SUPABASE_TESTE_SENHA ?? ''

/** Há tudo o que a prova precisa em `.env.local`. */
export const COM_USUARIO = URL !== '' && CHAVE !== '' && EMAIL !== '' && SENHA !== ''

/** O usuário de teste, para a prova de RF-27 digitar na tela de login (E-13). Só o processo do Playwright os vê. */
export const USUARIO_DE_TESTE = { email: EMAIL, senha: SENHA } as const

/** Pula o teste, dizendo o que falta, quando não há usuário de teste. Chamar no início de cada `test`. */
export function pularSemUsuario(): void {
  test.skip(
    !COM_USUARIO,
    'faltam VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, SUPABASE_TESTE_EMAIL ou SUPABASE_TESTE_SENHA em .env.local',
  )
}

/** A ficha como o teste a compara: saldo em texto e os ids na ordem do índice. */
export type ResumoDaFicha = { readonly saldo: string; readonly ids: readonly string[] }

/** Um item ou parcela como o teste os escreve: dinheiro em texto de centavos, convertido do lado da página. */
export type ItemEmTexto = { readonly descricao: string; readonly preco: string }
export type ParcelaEmTexto = { readonly vencimento: string; readonly valor: string }

/**
 * Abre o app pela primeira vez neste contexto e o deixa como um app instalado fica: service worker
 * instalado, precache completo e a página **controlada** por ele (a segunda carga, como
 * `docs/fatos-verificados.md` registra para o Chromium). Só depois disso um recarregamento
 * offline tem de onde vir (RT-07).
 */
export async function abrirApp(page: Page): Promise<void> {
  await page.goto('/')
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true))
  await page.reload()
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null && window.laboratorio !== undefined)
}

/** Recarrega e espera o laboratório voltar. Offline, é o service worker quem serve — ou o teste cai aqui. */
export async function recarregar(page: Page): Promise<void> {
  await page.reload()
  await page.waitForFunction(() => window.laboratorio !== undefined)
}

/** Entra com o usuário de teste pelo laboratório. Lança se a nuvem recusar. */
export async function entrar(page: Page): Promise<void> {
  await page.evaluate(
    ({ email, senha }) => {
      const lab = window.laboratorio
      if (!lab) throw new Error('sem window.laboratorio: não é o build de laboratório')
      return lab.entrar(email, senha)
    },
    { email: EMAIL, senha: SENHA },
  )
}

/** Sai da conta pelo laboratório (E-13): a sessão guardada some, a base fica. */
export async function sair(page: Page): Promise<void> {
  await page.evaluate(() => {
    const lab = window.laboratorio
    if (!lab) throw new Error('sem window.laboratorio: não é o build de laboratório')
    return lab.sair()
  })
}

/** Cadastra e devolve o id. */
export async function cadastrar(page: Page, nome: string, telefone: string): Promise<string> {
  return page.evaluate(
    async ({ nome, telefone }) => {
      const lab = window.laboratorio
      if (!lab) throw new Error('sem window.laboratorio: não é o build de laboratório')
      const resultado = await lab.cadastrarCliente({ nome, telefone })
      if (!resultado.ok) throw new Error(`cadastro recusado: ${resultado.motivo}`)
      return resultado.valor.id
    },
    { nome, telefone },
  )
}

/** Lança uma venda fiado e devolve o id. Itens e parcelas chegam em texto e viram `bigint` na página. */
export async function vender(
  page: Page,
  entrada: { readonly clienteId: string; readonly data: string; readonly itens: readonly ItemEmTexto[]; readonly parcelas: readonly ParcelaEmTexto[] },
): Promise<string> {
  return page.evaluate(async ({ clienteId, data, itens, parcelas }) => {
    const lab = window.laboratorio
    if (!lab) throw new Error('sem window.laboratorio: não é o build de laboratório')
    const resultado = await lab.lancarVendaFiado({
      clienteId,
      data,
      itens: itens.map((item) => ({ descricao: item.descricao, preco: BigInt(item.preco) })),
      parcelas: parcelas.map((parcela) => ({ vencimento: parcela.vencimento, valor: BigInt(parcela.valor) })),
    })
    if (!resultado.ok) throw new Error(`venda recusada: ${resultado.motivo}`)
    return resultado.valor.id
  }, entrada)
}

/** Registra um recebimento em dinheiro e devolve o id. */
export async function receberValor(page: Page, clienteId: string, data: string, valor: string): Promise<string> {
  return page.evaluate(
    async ({ clienteId, data, valor }) => {
      const lab = window.laboratorio
      if (!lab) throw new Error('sem window.laboratorio: não é o build de laboratório')
      const resultado = await lab.receber({ clienteId, data, valor: BigInt(valor), forma: 'dinheiro' })
      if (!resultado.ok) throw new Error(`recebimento recusado: ${resultado.motivo}`)
      return resultado.valor.recebimento.id
    },
    { clienteId, data, valor },
  )
}

/** O saldo (em texto) e os ids da ficha, na ordem do índice. */
export async function lerFicha(page: Page, clienteId: string): Promise<ResumoDaFicha> {
  return page.evaluate(async (clienteId) => {
    const lab = window.laboratorio
    if (!lab) throw new Error('sem window.laboratorio: não é o build de laboratório')
    const ficha = await lab.repositorio.lerFicha(clienteId)
    return { saldo: String(lab.saldo(ficha)), ids: ficha.map((lancamento) => lancamento.id) }
  }, clienteId)
}

/** A ficha inteira, com todo `bigint` em texto — para comparar antes e depois de apagar a base (RT-10). */
export async function lerFichaInteira(page: Page, clienteId: string): Promise<unknown> {
  return page.evaluate(async (clienteId) => {
    const lab = window.laboratorio
    if (!lab) throw new Error('sem window.laboratorio: não é o build de laboratório')
    const ficha = await lab.repositorio.lerFicha(clienteId)
    return JSON.parse(JSON.stringify(ficha, (_chave, valor: unknown) => (typeof valor === 'bigint' ? valor.toString() : valor)))
  }, clienteId)
}

/** O cliente como está na base local, ou `undefined`. */
export async function lerCliente(page: Page, clienteId: string): Promise<Cliente | undefined> {
  return page.evaluate((clienteId) => {
    const lab = window.laboratorio
    if (!lab) throw new Error('sem window.laboratorio: não é o build de laboratório')
    return lab.repositorio.lerCliente(clienteId)
  }, clienteId)
}

/** Regrava o cadastro pelo repositório (é o que a tela de E-09 vai chamar): último-que-escreve, D-010. */
export async function regravarCliente(page: Page, cliente: Cliente): Promise<void> {
  await page.evaluate((cliente) => {
    const lab = window.laboratorio
    if (!lab) throw new Error('sem window.laboratorio: não é o build de laboratório')
    return lab.repositorio.gravarCliente(cliente)
  }, cliente)
}

/**
 * Grava um lançamento **pronto** pelo repositório. O dinheiro atravessa o `evaluate` como texto
 * (aqui vira texto; lá vira `bigint` de novo) — só `valor`, `preco` e `desconto` são dinheiro
 * (D-022). É o caminho de RT-08: o mesmo id que a nuvem já tem, com o mesmo conteúdo ou com outro.
 */
export async function gravarLancamentoPronto(page: Page, lancamento: Lancamento | Record<string, unknown>): Promise<void> {
  const emTexto: unknown = JSON.parse(JSON.stringify(lancamento, (_chave, valor: unknown) => (typeof valor === 'bigint' ? valor.toString() : valor)))
  await page.evaluate(async (emTexto) => {
    const lab = window.laboratorio
    if (!lab) throw new Error('sem window.laboratorio: não é o build de laboratório')
    const reviver = (chave: string, valor: unknown): unknown =>
      (chave === 'valor' || chave === 'preco' || chave === 'desconto') && typeof valor === 'string' ? BigInt(valor) : valor
    const pronto: Lancamento = JSON.parse(JSON.stringify(emTexto), reviver)
    await lab.repositorio.gravarLancamento(pronto)
  }, emTexto)
}

/** "Já subiu?" (D-013), como a tela de E-10 vai perguntar. */
export async function sincronizado(page: Page, id: string): Promise<boolean> {
  return page.evaluate((id) => {
    const lab = window.laboratorio
    if (!lab) throw new Error('sem window.laboratorio: não é o build de laboratório')
    return lab.repositorio.sincronizado(id)
  }, id)
}

/**
 * Roda ciclos até um terminar sem falha de rede nem de sessão, e devolve o estado. Tenta poucas
 * vezes: um ciclo que já estava no ar ao voltar a rede pode terminar em `rede`, e o seguinte é o
 * que vale. Cinco falhas seguidas é defeito, não azar — o erro traz o estado.
 */
export async function sincronizar(page: Page): Promise<EstadoDaSincronizacao> {
  return page.evaluate(async () => {
    const lab = window.laboratorio
    if (!lab) throw new Error('sem window.laboratorio: não é o build de laboratório')
    let estado = lab.sincronizacao.estado()
    for (let tentativa = 1; tentativa <= 5; tentativa += 1) {
      await lab.sincronizacao.sincronizar()
      estado = lab.sincronizacao.estado()
      if (estado.ultimaFalha === null) return estado
      await new Promise((resolver) => setTimeout(resolver, 500))
    }
    throw new Error(`a sincronização não completou um ciclo: ${JSON.stringify(estado)}`)
  })
}

/** Apaga a base local pelo Dexie (fecha e apaga) e confirma que ela sumiu do IndexedDB. */
export async function apagarBase(page: Page): Promise<void> {
  const restantes = await page.evaluate(async () => {
    const lab = window.laboratorio
    if (!lab) throw new Error('sem window.laboratorio: não é o build de laboratório')
    const nome = lab.banco.name
    await lab.banco.delete()
    const bases = await indexedDB.databases()
    return bases.filter((base) => base.name === nome).length
  })
  expect(restantes, 'a base local ainda existe depois de banco.delete()').toBe(0)
}

/** O indicador de RF-25, como a ferramenta o lê: `data-pendentes` e `data-com-problema`. Espera até bater. */
export async function esperarIndicador(page: Page, esperado: { readonly pendentes: number; readonly comProblema: number }): Promise<void> {
  const indicador = page.locator('.indicador')
  await expect(indicador).toHaveAttribute('data-pendentes', String(esperado.pendentes))
  await expect(indicador).toHaveAttribute('data-com-problema', String(esperado.comProblema))
}

/** A nuvem vista **de fora** do navegador: o mesmo usuário de teste, pelo `supabase-js` em Node. */
export type NuvemDeFora = {
  readonly nuvem: Nuvem
  readonly clientePorId: (id: string) => Promise<ClienteLocal | undefined>
  /** Todas as linhas com esse id — RT-08 espera exatamente uma. */
  readonly lancamentosPorId: (id: string) => Promise<Lancamento[]>
  readonly sair: () => Promise<void>
}

/** O valor de uma resposta da nuvem, ou um erro com a falha inteira. */
export function esperarOk<T>(resposta: Resposta<T>): T {
  if (!resposta.ok) throw new Error(`a nuvem falhou: ${JSON.stringify(resposta.falha)}`)
  return resposta.valor
}

/** Um instante um pouco antes de agora, no relógio deste computador: o `desde` das buscas. */
function haPouco(): string {
  return new Date(Date.now() - 10 * 60_000).toISOString()
}

export async function nuvemDeFora(): Promise<NuvemDeFora> {
  const supabase = createClient(URL, CHAVE, { auth: { persistSession: false, autoRefreshToken: false } })
  const { error } = await supabase.auth.signInWithPassword({ email: EMAIL, password: SENHA })
  if (error) throw new Error(`login do usuário de teste (de fora) falhou: ${error.message}`)
  const nuvem = criarNuvemSupabase(supabase)
  return {
    nuvem,
    clientePorId: async (id) => {
      const linha = esperarOk(await nuvem.buscarClientes(haPouco())).find((candidata) => candidata.id === id)
      return linha === undefined ? undefined : clienteDaNuvem(linha)
    },
    lancamentosPorId: async (id) =>
      esperarOk(await nuvem.buscarLancamentos(haPouco()))
        .filter((linha) => linha.id === id)
        .map(lancamentoDaNuvem),
    sair: async () => {
      await supabase.auth.signOut()
    },
  }
}
