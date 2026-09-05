/*
 * Protótipo navegável de E-02 — clicável, com dados falsos, sem persistência.
 *
 * Existe para uma coisa só: medir EL-08 com a usuária antes de o produto existir. Recarregar
 * a página apaga tudo, e isso é de propósito — cada tarefa da sessão começa do mesmo estado.
 *
 * Fora de src/, fora dos tsconfig, descartado depois da sessão (D-023, emenda de 2026-09-05).
 *
 * **Dinheiro é bigint de centavos aqui também** (RI-01, D-022). Não porque o protótipo precise
 * ser correto — ele não vira produto —, mas porque escrever a versão errada por dois dias e a
 * certa depois é como um centavo de ponto flutuante entra num projeto.
 *
 * **O saldo é derivado das parcelas, nunca guardado** (RN-01). A primeira versão deste arquivo
 * guardava um campo `devendo` e mexia nele à mão: a confirmação dizia "ainda deve R$ 30,00" e a
 * fichinha, um toque depois, dizia "deve R$ 60,00" com a parcela recém-paga ainda vencida. Num
 * protótipo isso não é bug de produto — é **defeito de instrumento**, e teria produzido uma falha
 * falsa de EL-08 na única sessão que mede EL-08. É a mesma lição do botão de idempotência de E-00.
 */

// ---------------------------------------------------------------------------
// Dinheiro
// ---------------------------------------------------------------------------

/** Formata centavos em bigint como "R$ 1.234,56". Sem Intl e sem number, de propósito. */
function emReais(centavos) {
  const negativo = centavos < 0n
  const absoluto = negativo ? -centavos : centavos
  const inteiros = (absoluto / 100n).toString()
  const decimais = (absoluto % 100n).toString().padStart(2, '0')

  // Ponto de milhar da direita para a esquerda: 1234 -> 1.234
  const agrupado = inteiros.replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  return `${negativo ? '-' : ''}R$ ${agrupado},${decimais}`
}

/**
 * Lê o que ela digitou e devolve centavos em bigint.
 *
 * Aceita "30", "30,00", "30.00", "1.250" e "1.250,00" — porque não sabemos ainda como ela digita, e
 * recusar um formato no meio da tarefa cronometrada mediria o campo, não o fluxo.
 *
 * **Atenção, e é `D-034` (EM ABERTO):** aqui "3990" vira **R$ 3.990,00**, não R$ 39,90. Boa parte dos
 * aplicativos de dinheiro no celular preenche pela direita e faria o contrário. Nenhuma das duas
 * convenções foi escolhida por ninguém — este arquivo estava decidindo por omissão até a revisão de
 * 2026-09-05 —, e errar produz um valor **100× maior** na ficha de uma pessoa real.
 *
 * O protótipo deixa **de propósito** como está: a sessão de E-02 existe para ver o que ela digita
 * quando ninguém explicou nada. Corrigir aqui seria responder `D-034` sem perguntar a ela.
 *
 * **O que foi corrigido na revisão de 2026-09-05, e não é `D-034`:** "1.250" voltava R$ 1,25, porque
 * o último separador era tratado como decimal sempre. Isso não é convenção de digitação em aberto —
 * é gramática de pt-BR, onde "1.250" é mil duzentos e cinquenta —, e o erro era de **1000×**, na
 * direção contrária ao de `D-034`. A regra agora é assimétrica porque a língua é: **vírgula é sempre
 * decimal; ponto é decimal exceto quando vem seguido de exatamente três dígitos.** Nenhum dos casos
 * que `D-034` registra mudou de resultado.
 */
function centavosDeTexto(texto) {
  const limpo = String(texto).replace(/[^\d,.]/g, '')
  const virgula = limpo.lastIndexOf(',')
  const ponto = limpo.lastIndexOf('.')
  // Três dígitos depois do ponto é milhar, nunca centavo: dinheiro não tem três casas decimais.
  // A vírgula não passa por essa peneira — "39,900" continua R$ 39,90, que é o erro de digitação
  // mais provável no teclado dela; "1.250" vira R$ 1.250,00.
  const pontoEhDecimal = ponto !== -1 && limpo.length - ponto - 1 !== 3
  const separador = virgula !== -1 ? virgula : pontoEhDecimal ? ponto : -1
  const parteInteira = (separador === -1 ? limpo : limpo.slice(0, separador)).replace(/\D/g, '')
  const parteDecimal = separador === -1 ? '' : limpo.slice(separador + 1).replace(/\D/g, '')
  const centavos = (parteDecimal + '00').slice(0, 2)
  return BigInt(parteInteira || '0') * 100n + BigInt(centavos)
}

/**
 * Reparte um total em N parcelas sem perder centavo: a soma volta sempre igual ao total.
 *
 * A sobra vai na **primeira** parcela, que é a recomendação registrada em D-012 — e D-012
 * continua **EM ABERTO**. O protótipo precisava mostrar alguma divisão na tela, e mostrar a
 * recomendação é mais honesto que inventar uma terceira. Se ela reparar na diferença durante a
 * sessão, isso é evidência para fechar D-012; está no roteiro como ponto de observação.
 * D-030 (parcela em múltiplo de 5 centavos) também segue em aberto e NÃO está encenada aqui.
 */
function repartirEmParcelas(totalCentavos, vezes) {
  const quantidade = BigInt(vezes)
  const base = totalCentavos / quantidade
  const sobra = totalCentavos - base * quantidade
  const parcelas = []
  for (let i = 0; i < vezes; i += 1) {
    parcelas.push(i === 0 ? base + sobra : base)
  }
  return parcelas
}

// ---------------------------------------------------------------------------
// Datas
// ---------------------------------------------------------------------------

/*
 * Datas em ISO por dentro e "dd/mm" na tela. O ISO existe por um motivo prático: ordenar o
 * histórico em ordem cronológica inversa (RF-02) e decidir o que está vencido são comparações
 * de texto, sem biblioteca e sem fuso.
 */
const HOJE = '2026-09-05'
const ONTEM = '2026-09-04'
const OUTRO_DIA = '2026-08-30'

/** "2026-09-28" -> "28/09". */
const comoEla = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`

/** Vencida é a parcela cuja data já passou. Comparação de texto ISO, que ordena igual à data. */
const estaVencida = (parcela) => parcela.restante > 0n && parcela.data < HOJE

/** Datas sugeridas para parcelas novas: de mês em mês (RF-05). */
const DATAS_SUGERIDAS = ['2026-10-05', '2026-11-05', '2026-12-05', '2027-01-05']

// ---------------------------------------------------------------------------
// Dados falsos
// ---------------------------------------------------------------------------

/*
 * Nomes e valores inventados, montados em torno de HOJE = 05/09: a Cláudia tem parcela vencida
 * (RF-02 exige que vencida seja visualmente distinta) e as demais estão a vencer.
 *
 * `parcelas` está sempre em ordem de vencimento — é o que faz o abatimento de RN-02 percorrer da
 * mais antiga para a mais nova sem precisar reordenar nada.
 */
const FICHAS = [
  {
    id: 'rosa',
    nome: 'Dona Rosa',
    referencia: 'vizinha do 302',
    parcelas: [
      { valor: 3000n, restante: 0n, data: '2026-08-10', ordem: 1, de: 4 },
      { valor: 3000n, restante: 3000n, data: '2026-09-10', ordem: 2, de: 4 },
      { valor: 3000n, restante: 3000n, data: '2026-10-10', ordem: 3, de: 4 },
      { valor: 3000n, restante: 3000n, data: '2026-11-10', ordem: 4, de: 4 },
    ],
    eventos: [
      { data: '2026-08-28', descricao: 'Pagou no Pix', valor: -3000n, tipo: 'recebimento' },
      { data: '2026-08-10', descricao: 'Creme, perfume e sabonete', valor: 12000n, tipo: 'venda' },
    ],
  },
  {
    id: 'claudia',
    nome: 'Cláudia',
    referencia: 'do salão',
    parcelas: [
      { valor: 3000n, restante: 3000n, data: '2026-08-28', ordem: 1, de: 2 },
      { valor: 3000n, restante: 3000n, data: '2026-09-28', ordem: 2, de: 2 },
    ],
    eventos: [{ data: '2026-07-28', descricao: 'Shampoo e condicionador', valor: 6000n, tipo: 'venda' }],
  },
  {
    id: 'vera',
    nome: 'Vera',
    referencia: 'irmã da Sandra',
    parcelas: [{ valor: 4500n, restante: 4500n, data: '2026-09-15', ordem: 1, de: 1 }],
    eventos: [{ data: '2026-08-15', descricao: 'Kit de maquiagem', valor: 4500n, tipo: 'venda' }],
  },
  {
    id: 'marlene',
    nome: 'Marlene',
    referencia: 'da igreja',
    parcelas: [{ valor: 8000n, restante: 0n, data: '2026-08-30', ordem: 1, de: 1 }],
    eventos: [
      { data: '2026-08-30', descricao: 'Pagou tudo, em dinheiro', valor: -8000n, tipo: 'recebimento' },
      { data: '2026-08-02', descricao: 'Hidratante e batom', valor: 8000n, tipo: 'venda' },
    ],
  },
  {
    id: 'ivone',
    nome: 'Ivone',
    referencia: 'do trabalho do Zé',
    parcelas: [
      { valor: 4000n, restante: 4000n, data: '2026-09-12', ordem: 1, de: 3 },
      { valor: 4000n, restante: 4000n, data: '2026-10-12', ordem: 2, de: 3 },
      { valor: 4000n, restante: 4000n, data: '2026-11-12', ordem: 3, de: 3 },
    ],
    eventos: [{ data: '2026-08-20', descricao: 'Quatro coisas do catálogo', valor: 12000n, tipo: 'venda' }],
  },
]

// ---------------------------------------------------------------------------
// Regras derivadas
// ---------------------------------------------------------------------------

/** Quanto a cliente deve: soma do que falta em cada parcela. Derivado, nunca guardado (RN-01). */
function saldoDe(ficha) {
  let total = 0n
  for (const parcela of ficha.parcelas) total += parcela.restante
  return total
}

/** A próxima parcela em aberto — a mais antiga que ainda tem saldo. `undefined` se está tudo pago. */
const proximaParcelaDe = (ficha) => ficha.parcelas.find((p) => p.restante > 0n)

/**
 * Abate o recebimento na parcela em aberto mais antiga, com o excedente escorrendo para as
 * seguintes (RN-02, D-006). Nenhuma decisão sobre onde abater é pedida a ela (RI-08).
 *
 * Devolve o que sobrou depois de quitar tudo. **O que fazer com essa sobra é D-016, EM ABERTO** —
 * o protótipo apenas informa o fato na confirmação e não inventa a regra (nem crédito, nem recusa,
 * nem saldo negativo). Se ela pagar a mais durante a sessão, a reação dela é o dado.
 */
function receber(ficha, valorPago) {
  let restanteDoPagamento = valorPago
  for (const parcela of ficha.parcelas) {
    if (restanteDoPagamento === 0n) break
    if (parcela.restante === 0n) continue
    const abate = restanteDoPagamento < parcela.restante ? restanteDoPagamento : parcela.restante
    parcela.restante -= abate
    restanteDoPagamento -= abate
  }
  return restanteDoPagamento
}

/**
 * As linhas do histórico da ficha, em ordem cronológica inversa (RF-02).
 *
 * Entram as parcelas **em aberto** e os eventos já acontecidos (o que ela levou, o que pagou).
 * Parcela quitada não vira linha própria: quem a representa é o recebimento correspondente, e
 * mostrar as duas encheria a ficha de linhas repetidas.
 */
function linhasDaFicha(ficha) {
  const deParcelas = ficha.parcelas
    .filter((p) => p.restante > 0n)
    .map((p) => ({
      data: p.data,
      // "N de M" é dentro da venda que gerou a parcela, nunca sobre a lista inteira da ficha:
      // uma cliente com duas compras tem duas contagens, e somá-las mostraria "Parcela 1 de 4"
      // para uma compra que foi paga de uma vez só.
      descricao: p.de === 1 ? 'Parcela' : `Parcela ${p.ordem} de ${p.de}`,
      valor: p.restante,
      tipo: estaVencida(p) ? 'vencida' : 'a-vencer',
    }))

  return [...deParcelas, ...ficha.eventos].sort((a, b) => (a.data < b.data ? 1 : a.data > b.data ? -1 : 0))
}

// ---------------------------------------------------------------------------
// Estado da sessão (em memória — recarregar reinicia)
// ---------------------------------------------------------------------------

const estado = {
  fichaAberta: null,
  vezes: 1,
  itens: [
    { descricao: '', preco: '' },
    { descricao: '', preco: '' },
  ],
}

const elemento = (id) => document.getElementById(id)
const escolhido = (nome) => document.querySelector(`input[name="${nome}"]:checked`).value

/**
 * Troca a tela visível **e redesenha o que ela mostra**.
 *
 * O redesenho mora aqui, e não em cada botão, por causa do defeito que a primeira versão tinha:
 * `data-ir="tela-ficha"` só reexibia a ficha antiga, e ela via a confirmação dizer uma coisa e a
 * fichinha dizer outra. Toda porta de entrada de uma tela passa por aqui, então nenhuma pode
 * esquecer de redesenhar.
 */
function mostrarTela(id) {
  if (id === 'tela-inicio') desenharLista(elemento('lista-fichas'), elemento('busca').value, abrirFicha)
  if (id === 'tela-venda-cliente') desenharLista(elemento('lista-venda'), elemento('busca-venda').value, abrirVenda)
  if (id === 'tela-ficha' && estado.fichaAberta !== null) desenharFicha(estado.fichaAberta)

  for (const tela of document.querySelectorAll('.tela')) {
    tela.hidden = tela.id !== id
  }
  window.scrollTo(0, 0)
}

// ---------------------------------------------------------------------------
// Tela inicial e escolha de cliente
// ---------------------------------------------------------------------------

/**
 * Deixa o texto comparável: minúsculas e sem acento.
 *
 * Sem isto, "cla" não encontra "Cláudia" e "salao" não encontra "do salão" — e a lista volta **vazia**
 * no meio de uma tarefa cronometrada, o que ela leria como "essa cliente não está aqui". Ninguém digita
 * acento correndo, muito menos no teclado do iPhone. Achado na revisão de 2026-09-05, por teste.
 *
 * A faixa \u0300-\u036f é a dos diacríticos combinantes que o NFD separa da
 * letra base. Escapada de propósito: os caracteres literais são invisíveis num editor, e
 * ninguém revisa o que não enxerga.
 */
const semAcento = (texto) => texto.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')

/**
 * Desenha a lista de fichinhas, filtrada pela busca.
 *
 * `aoEscolher` muda conforme a origem: da tela inicial a escolha abre a ficha; da tela de nova
 * venda ela escolhe para quem é a venda.
 */
function desenharLista(alvo, filtro, aoEscolher) {
  const termo = semAcento(filtro.trim())
  const visiveis = FICHAS.filter((f) => semAcento(f.nome).includes(termo) || semAcento(f.referencia).includes(termo))

  alvo.replaceChildren()
  for (const ficha of visiveis) {
    const saldo = saldoDe(ficha)
    const proxima = proximaParcelaDe(ficha)
    const atrasada = proxima !== undefined && estaVencida(proxima)

    const botao = document.createElement('button')
    botao.type = 'button'
    if (atrasada) botao.classList.add('em-atraso')

    const quem = document.createElement('span')
    quem.className = 'nome'
    quem.textContent = ficha.nome
    const referencia = document.createElement('span')
    referencia.className = 'referencia'
    referencia.textContent = ficha.referencia
    quem.append(referencia)

    const quanto = document.createElement('span')
    quanto.className = 'quanto'
    quanto.textContent = saldo === 0n ? 'em dia' : emReais(saldo)
    if (atrasada) {
      const aviso = document.createElement('span')
      aviso.className = 'aviso-atraso'
      aviso.textContent = 'atrasada'
      quanto.append(aviso)
    }

    botao.append(quem, quanto)
    botao.addEventListener('click', () => aoEscolher(ficha))

    const linha = document.createElement('li')
    linha.append(botao)
    alvo.append(linha)
  }
}

// ---------------------------------------------------------------------------
// Ficha
// ---------------------------------------------------------------------------

/** Desenha a ficha: saldo e próxima parcela no topo, histórico abaixo (RF-02). */
function desenharFicha(ficha) {
  const saldo = saldoDe(ficha)
  const proxima = proximaParcelaDe(ficha)

  elemento('ficha-nome').textContent = ficha.nome
  elemento('ficha-saldo').textContent = saldo === 0n ? 'Nada' : emReais(saldo)

  const linhaProxima = elemento('ficha-proxima')
  linhaProxima.classList.toggle('vencida', proxima !== undefined && estaVencida(proxima))
  if (proxima === undefined) {
    linhaProxima.textContent = 'Está tudo pago'
  } else if (estaVencida(proxima)) {
    linhaProxima.textContent = `${emReais(proxima.restante)} venceu em ${comoEla(proxima.data)}`
  } else {
    linhaProxima.textContent = `Próxima: ${emReais(proxima.restante)} em ${comoEla(proxima.data)}`
  }

  // O botão some quando não há o que receber: oferecer uma ação impossível é ruído.
  const botao = elemento('botao-recebi')
  botao.hidden = proxima === undefined
  botao.textContent = proxima === undefined ? 'Recebi' : `Recebi ${emReais(proxima.restante)}`

  const historico = elemento('ficha-historico')
  historico.replaceChildren()
  for (const linha of linhasDaFicha(ficha)) {
    const item = document.createElement('li')
    if (linha.tipo === 'vencida') item.classList.add('vencida')
    if (linha.tipo === 'recebimento') item.classList.add('paga')

    const data = document.createElement('span')
    data.className = 'data'
    data.textContent = comoEla(linha.data)
    const descricao = document.createElement('span')
    descricao.className = 'descricao'
    descricao.textContent = linha.descricao
    const cifra = document.createElement('span')
    cifra.className = 'cifra'
    cifra.textContent = emReais(linha.valor < 0n ? -linha.valor : linha.valor)

    item.append(data, descricao, cifra)
    historico.append(item)
  }
}

/** Abre a ficha de uma cliente. */
function abrirFicha(ficha) {
  estado.fichaAberta = ficha
  mostrarTela('tela-ficha')
}

// ---------------------------------------------------------------------------
// Recebimento
// ---------------------------------------------------------------------------

/**
 * Abre a tela de recebimento com o valor da parcela já preenchido (D-006, RI-08).
 *
 * O caminho projetado é de três toques a partir da tela inicial — cliente, "Recebi", "Confirmar" —,
 * com um toque de folga contra os quatro de RNF-02 para quando o valor for outro. É hipótese:
 * quem mede é ela, com cronômetro (RT-14).
 */
function abrirRecebimento() {
  const ficha = estado.fichaAberta
  if (ficha === null) return
  const proxima = proximaParcelaDe(ficha)
  if (proxima === undefined) return

  elemento('recebimento-titulo').textContent = `Recebi da ${ficha.nome}`
  elemento('recebimento-valor').value = emReais(proxima.restante).replace('R$ ', '')
  mostrarTela('tela-recebimento')
}

/** Confirma o recebimento: abate as parcelas e mostra o saldo novo, que é o que ela confere em voz alta. */
function confirmarRecebimento() {
  const ficha = estado.fichaAberta
  if (ficha === null) return

  const pago = centavosDeTexto(elemento('recebimento-valor').value)
  if (pago === 0n) return // Guarda de instrumento: sem valor não há o que confirmar.

  const forma = escolhido('forma')
  const quando = { hoje: HOJE, ontem: ONTEM, outro: OUTRO_DIA }[escolhido('quando-recebi')]
  const sobra = receber(ficha, pago)

  ficha.eventos.unshift({
    data: quando,
    descricao: forma === 'Pix' ? 'Pagou no Pix' : 'Pagou em dinheiro',
    valor: -pago,
    tipo: 'recebimento',
  })

  const saldo = saldoDe(ficha)
  elemento('recebido-linha').textContent = `Anotado: ${emReais(pago)} da ${ficha.nome}`
  if (saldo > 0n) {
    elemento('recebido-saldo').textContent = `Ainda deve ${emReais(saldo)}`
  } else if (sobra > 0n) {
    // D-016 EM ABERTO: a tela informa o fato e não decide se vira crédito, troco ou recusa.
    elemento('recebido-saldo').textContent = `Pagou ${emReais(sobra)} a mais`
  } else {
    elemento('recebido-saldo').textContent = 'Ela não deve mais nada'
  }

  mostrarTela('tela-recebido')
}

// ---------------------------------------------------------------------------
// Nova venda
// ---------------------------------------------------------------------------

/** Soma o que foi digitado nos itens. O total é sempre derivado do que está na tela. */
function totalDaVenda() {
  let total = 0n
  for (const item of estado.itens) total += centavosDeTexto(item.preco)
  return total
}

/** Redesenha total e parcelas a cada tecla, para ela conferir sem precisar concluir nada. */
function atualizarVenda() {
  const total = totalDaVenda()
  elemento('venda-total').textContent = emReais(total)

  const fiado = escolhido('pagamento') === 'fiado'
  elemento('bloco-parcelas').hidden = !fiado

  const lista = elemento('venda-parcelas')
  lista.replaceChildren()
  if (!fiado || total === 0n) return

  repartirEmParcelas(total, estado.vezes).forEach((valor, indice) => {
    const linha = document.createElement('li')
    const quando = document.createElement('span')
    quando.className = 'quando'
    quando.textContent = `${indice + 1}ª em ${comoEla(DATAS_SUGERIDAS[indice])}`
    const quanto = document.createElement('span')
    quanto.textContent = emReais(valor)
    linha.append(quando, quanto)
    lista.append(linha)
  })
}

/** Desenha os campos de item. Dois já nascem em branco: a tarefa cronometrada tem dois itens. */
function desenharItens() {
  const lista = elemento('venda-itens')
  lista.replaceChildren()

  estado.itens.forEach((item, indice) => {
    const descricao = document.createElement('input')
    descricao.type = 'text'
    descricao.className = 'texto-item'
    descricao.placeholder = 'O que ela levou'
    descricao.value = item.descricao
    descricao.addEventListener('input', () => {
      estado.itens[indice].descricao = descricao.value
    })

    const preco = document.createElement('input')
    preco.type = 'text'
    preco.className = 'texto-item preco'
    preco.inputMode = 'decimal'
    preco.placeholder = 'R$'
    preco.value = item.preco
    preco.addEventListener('input', () => {
      estado.itens[indice].preco = preco.value
      atualizarVenda()
    })

    const linha = document.createElement('li')
    linha.append(descricao, preco)
    lista.append(linha)
  })
}

/** Abre a venda para uma cliente já escolhida. */
function abrirVenda(ficha) {
  estado.fichaAberta = ficha
  estado.vezes = 1
  estado.itens = [
    { descricao: '', preco: '' },
    { descricao: '', preco: '' },
  ]
  elemento('venda-titulo').textContent = `O que a ${ficha.nome} levou`
  for (const botao of document.querySelectorAll('#venda-vezes .vez')) {
    botao.classList.toggle('ativa', botao.dataset.vezes === '1')
  }
  desenharItens()
  atualizarVenda()
  mostrarTela('tela-venda')
}

/** Junta o que ela digitou numa frase para o histórico: "Hidratante e batom". */
function descricaoDosItens() {
  const nomes = estado.itens.map((i) => i.descricao.trim()).filter((d) => d !== '')
  if (nomes.length === 0) return `Levou ${estado.itens.length} coisas`
  if (nomes.length === 1) return nomes[0]
  return `${nomes.slice(0, -1).join(', ')} e ${nomes[nomes.length - 1].toLowerCase()}`
}

/** Fecha a venda: cria as parcelas, lança o evento e mostra o saldo novo. */
function salvarVenda() {
  const ficha = estado.fichaAberta
  if (ficha === null) return

  const total = totalDaVenda()
  // Guarda de instrumento, não regra de produto: sem valor não há venda, e avançar mostraria
  // uma confirmação de R$ 0,00 que ela leria como "pronto" no meio da tarefa cronometrada.
  if (total === 0n) return

  const fiado = escolhido('pagamento') === 'fiado'
  const quando = { hoje: HOJE, ontem: ONTEM, outro: OUTRO_DIA }[escolhido('quando-venda')]

  if (fiado) {
    repartirEmParcelas(total, estado.vezes).forEach((valor, indice) => {
      ficha.parcelas.push({ valor, restante: valor, data: DATAS_SUGERIDAS[indice], ordem: indice + 1, de: estado.vezes })
    })
    // Parcelas ficam em ordem de vencimento: é o que faz o abatimento de RN-02 funcionar.
    ficha.parcelas.sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : 0))
  }

  ficha.eventos.unshift({ data: quando, descricao: descricaoDosItens(), valor: total, tipo: 'venda' })

  const saldo = saldoDe(ficha)
  elemento('vendido-linha').textContent = fiado
    ? `Anotado na fichinha da ${ficha.nome}`
    : `${ficha.nome} levou e pagou ${emReais(total)}`
  elemento('vendido-saldo').textContent = fiado ? `Agora ela deve ${emReais(saldo)}` : 'Ela não deve nada'
  mostrarTela('tela-vendido')
}

// ---------------------------------------------------------------------------
// Ligações
// ---------------------------------------------------------------------------

for (const botao of document.querySelectorAll('[data-ir]')) {
  botao.addEventListener('click', () => mostrarTela(botao.dataset.ir))
}

// Só a lista é redesenhada, e não a tela inteira: `mostrarTela` rola ao topo, e rolar a cada tecla
// com o teclado do iPhone aberto é tremido o bastante para atrapalhar a tarefa cronometrada.
elemento('busca').addEventListener('input', () => {
  desenharLista(elemento('lista-fichas'), elemento('busca').value, abrirFicha)
})
elemento('busca-venda').addEventListener('input', () => {
  desenharLista(elemento('lista-venda'), elemento('busca-venda').value, abrirVenda)
})

elemento('botao-recebi').addEventListener('click', abrirRecebimento)
elemento('botao-confirmar-recebimento').addEventListener('click', confirmarRecebimento)
elemento('botao-salvar-venda').addEventListener('click', salvarVenda)
elemento('botao-venda-daqui').addEventListener('click', () => {
  if (estado.fichaAberta !== null) abrirVenda(estado.fichaAberta)
})

elemento('botao-mais-item').addEventListener('click', () => {
  estado.itens.push({ descricao: '', preco: '' })
  desenharItens()
})

/*
 * Cliente nova: o cadastro de verdade é RF-01 e escopo de E-09. O botão está aqui porque a sessão
 * precisa mostrar **se ela procura por ele** durante a venda — se procurar, o cadastro tem que
 * caber no caminho da venda, e isso é achado, não suposição. A ficha criada entra na lista para
 * que o resto do fluxo continue coerente.
 */
elemento('botao-cliente-nova').addEventListener('click', () => {
  const nova = { id: `nova-${FICHAS.length}`, nome: 'Cliente nova', referencia: '', parcelas: [], eventos: [] }
  FICHAS.push(nova)
  abrirVenda(nova)
})

for (const botao of document.querySelectorAll('#venda-vezes .vez')) {
  botao.addEventListener('click', () => {
    estado.vezes = Number(botao.dataset.vezes)
    for (const outro of document.querySelectorAll('#venda-vezes .vez')) {
      outro.classList.toggle('ativa', outro === botao)
    }
    atualizarVenda()
  })
}

for (const opcao of document.querySelectorAll('input[name="pagamento"]')) {
  opcao.addEventListener('change', atualizarVenda)
}

mostrarTela('tela-inicio')
