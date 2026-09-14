import { expect, test, type Page } from '@playwright/test'
import { abrirApp, cadastrar, esperarIndicador, lerFicha, nuvemDeFora, pularSemUsuario, recarregar, sair, sincronizado, sincronizar, USUARIO_DE_TESTE, vender } from './apoio.ts'

/**
 * RF-27 de ponta a ponta (E-13, D-005, D-048): o login é uma tela como as outras e nunca a
 * primeira; sem sessão guardada a inicial mostra "Entrar ›"; a base local **não é perdida entre
 * um login e outro** — sair, lançar, recarregar e entrar de novo deixam a ficha inteira e a fila
 * sobe. Contra o build de laboratório (`D-043`), com o usuário de teste; deixa linhas na nuvem.
 * Chromium de desktop: nada aqui é afirmação sobre o iPhone dela.
 */

const HOJE = '2026-09-14'

/** A linha "Entrar ›" da tela inicial (a classe é o gancho do teste, como `.indicador`). */
const linhaDeEntrar = (page: Page) => page.locator('.entrar')

/** Entra pela tela: a linha, os dois campos, o botão. */
async function entrarPelaTela(page: Page, senha: string): Promise<void> {
  await linhaDeEntrar(page).click()
  await page.getByLabel('E-mail').fill(USUARIO_DE_TESTE.email)
  await page.getByLabel('Senha').fill(senha)
  await page.getByRole('button', { name: 'Entrar', exact: true }).click()
}

test('RF-27 — entrar pela tela, sair, recarregar: a base fica, a fila espera, entrar de novo sobe', async ({ page }) => {
  pularSemUsuario()
  await abrirApp(page)

  // Sem sessão guardada: a inicial abre com a lista e a linha "Entrar ›" — nunca uma tela de login.
  await expect(page.locator('.indicador')).toBeVisible()
  await expect(linhaDeEntrar(page)).toBeVisible()
  // Desktop não instala: sem instrução de instalação (RF-23).
  await expect(page.getByText('Para ter na tela de início')).toHaveCount(0)

  // Senha errada é uma frase, não uma tela de erro; a certa volta ao início e a linha some.
  await entrarPelaTela(page, 'senha-errada')
  await expect(page.getByText('E-mail ou senha errados.')).toBeVisible()
  await page.getByLabel('Senha').fill(USUARIO_DE_TESTE.senha)
  await page.getByRole('button', { name: 'Entrar', exact: true }).click()
  await expect(page.locator('.indicador')).toBeVisible()
  await expect(linhaDeEntrar(page)).toHaveCount(0)

  // Com sessão: lança e sobe.
  const clienteId = await cadastrar(page, 'Sônia (E-13 RF-27)', '(11) 9 3333-3333')
  const primeira = await vender(page, {
    clienteId,
    data: HOJE,
    itens: [{ descricao: 'perfume', preco: '10000' }],
    parcelas: [{ vencimento: '2026-10-14', valor: '10000' }],
  })
  // Um ciclo inteiro, e não só o indicador: "Enviando…" com a contagem antiga passaria por "tudo em dia".
  await sincronizar(page)
  await esperarIndicador(page, { pendentes: 0, comProblema: 0 })
  expect(await sincronizado(page, primeira)).toBe(true)

  // A sessão some (o único `signOut` está no laboratório): a linha volta, a base fica, a venda
  // seguinte espera o login — nada vira "com problema" (D-042 item 3).
  await sair(page)
  await expect(linhaDeEntrar(page)).toBeVisible()
  const segunda = await vender(page, {
    clienteId,
    data: HOJE,
    itens: [{ descricao: 'creme', preco: '3990' }],
    parcelas: [{ vencimento: '2026-10-14', valor: '3990' }],
  })
  await esperarIndicador(page, { pendentes: 1, comProblema: 0 })
  const esperada = { saldo: '13990', ids: [primeira, segunda] }
  expect(await lerFicha(page, clienteId)).toEqual(esperada)

  // Recarregar sem sessão: tudo igual — a ficha inteira, a fila esperando, a linha lá.
  await recarregar(page)
  await expect(linhaDeEntrar(page)).toBeVisible()
  await esperarIndicador(page, { pendentes: 1, comProblema: 0 })
  expect(await lerFicha(page, clienteId)).toEqual(esperada)

  // Entrar de novo, pela tela: a fila sobe sozinha, a ficha continua inteira, a nuvem tem as duas.
  await entrarPelaTela(page, USUARIO_DE_TESTE.senha)
  await expect(linhaDeEntrar(page)).toHaveCount(0)
  await esperarIndicador(page, { pendentes: 0, comProblema: 0 })
  expect(await lerFicha(page, clienteId)).toEqual(esperada)
  const deFora = await nuvemDeFora()
  try {
    expect((await deFora.lancamentosPorId(primeira)).length).toBe(1)
    expect((await deFora.lancamentosPorId(segunda)).length).toBe(1)
  } finally {
    await deFora.sair()
  }
})
