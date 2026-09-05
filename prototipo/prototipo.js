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
 * Aceita "30", "30,00", "30.00" e "1.250,00" — porque não sabemos ainda como ela digita, e
 * recusar um formato no meio da tarefa cronometrada mediria o campo, não o fluxo. Como ela
 * digita valor é justamente um dos pontos de observação da sessão.
 */
function centavosDeTexto(texto) {
  const limpo = String(texto).replace(/[^\d,.]/g, '')
  // O último separador é o decimal; os anteriores são milhar.
  const ultimaVirgula = Math.max(limpo.lastIndexOf(','), limpo.lastIndexOf('.'))
  const parteInteira = (ultimaVirgula === -1 ? limpo : limpo.slice(0, ultimaVirgula)).replace(/\D/g, '')
  const parteDecimal = ultimaVirgula === -1 ? '' : limpo.slice(ultimaVirgula + 1).replace(/\D/g, '')
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
// Dados falsos
// ---------------------------------------------------------------------------

/*
 * Nomes e valores inventados. Os totais dividem exato nas parcelas mostradas, para que a
 * ficha não encene por acidente uma decisão que ainda não foi tomada (D-012, D-030).
 * "Hoje" é 05/09 para efeito das datas abaixo — uma parcela vencida e as outras a vencer,
 * porque RF-02 exige que parcela vencida seja visualmente distinta.
 */
const FICHAS = [
  {
    id: 'rosa',
    nome: 'Dona Rosa',
    referencia: 'vizinha do 302',
    devendo: 9000n,
    proxima: { valor: 3000n, data: '10/09', vencida: false },
    historico: [
      { data: '10/09', descricao: 'Parcela 2 de 3', valor: 3000n, tipo: 'a-vencer' },
      { data: '10/10', descricao: 'Parcela 3 de 3', valor: 3000n, tipo: 'a-vencer' },
      { data: '28/08', descricao: 'Pagou no Pix', valor: -3000n, tipo: 'recebimento' },
      { data: '10/08', descricao: 'Levou 3 coisas', valor: 12000n, tipo: 'venda' },
    ],
  },
  {
    id: 'claudia',
    nome: 'Cláudia',
    referencia: 'do salão',
    devendo: 6000n,
    proxima: { valor: 3000n, data: '28/08', vencida: true },
    historico: [
      { data: '28/09', descricao: 'Parcela 2 de 2', valor: 3000n, tipo: 'a-vencer' },
      { data: '28/08', descricao: 'Parcela 1 de 2', valor: 3000n, tipo: 'vencida' },
      { data: '28/07', descricao: 'Levou 2 coisas', valor: 6000n, tipo: 'venda' },
    ],
  },
  {
    id: 'vera',
    nome: 'Vera',
    referencia: 'irmã da Sandra',
    devendo: 4500n,
    proxima: { valor: 4500n, data: '15/09', vencida: false },
    historico: [
      { data: '15/09', descricao: 'Parcela única', valor: 4500n, tipo: 'a-vencer' },
      { data: '15/08', descricao: 'Levou 1 coisa', valor: 4500n, tipo: 'venda' },
    ],
  },
  {
    id: 'marlene',
    nome: 'Marlene',
    referencia: 'da igreja',
    devendo: 0n,
    proxima: null,
    historico: [
      { data: '30/08', descricao: 'Pagou tudo, em dinheiro', valor: -8000n, tipo: 'recebimento' },
      { data: '02/08', descricao: 'Levou 2 coisas', valor: 8000n, tipo: 'venda' },
    ],
  },
  {
    id: 'ivone',
    nome: 'Ivone',
    referencia: 'do trabalho do Zé',
    devendo: 12000n,
    proxima: { valor: 4000n, data: '12/09', vencida: false },
    historico: [
      { data: '12/09', descricao: 'Parcela 1 de 3', valor: 4000n, tipo: 'a-vencer' },
      { data: '12/10', descricao: 'Parcela 2 de 3', valor: 4000n, tipo: 'a-vencer' },
      { data: '12/11', descricao: 'Parcela 3 de 3', valor: 4000n, tipo: 'a-vencer' },
      { data: '20/08', descricao: 'Levou 4 coisas', valor: 12000n, tipo: 'venda' },
    ],
  },
]

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

/** Troca a tela visível. Não há rota nem histórico: o protótipo é um baralho de cartas. */
function mostrarTela(id) {
  for (const tela of document.querySelectorAll('.tela')) {
    tela.hidden = tela.id !== id
  }
  window.scrollTo(0, 0)
}

// ---------------------------------------------------------------------------
// Tela inicial
// ---------------------------------------------------------------------------

/**
 * Desenha a lista de fichinhas, opcionalmente filtrada pela busca.
 *
 * `aoEscolher` muda conforme a origem: da tela inicial a escolha abre a ficha; da tela de nova
 * venda ela escolhe para quem é a venda.
 */
function desenharLista(alvo, filtro, aoEscolher) {
  const termo = filtro.trim().toLowerCase()
  const visiveis = FICHAS.filter(
    (f) => f.nome.toLowerCase().includes(termo) || f.referencia.toLowerCase().includes(termo),
  )

  alvo.replaceChildren()
  for (const ficha of visiveis) {
    const atrasada = ficha.proxima !== null && ficha.proxima.vencida
    const linha = document.createElement('li')
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
    quanto.textContent = ficha.devendo === 0n ? 'em dia' : emReais(ficha.devendo)
    if (atrasada) {
      const aviso = document.createElement('span')
      aviso.className = 'aviso-atraso'
      aviso.textContent = 'atrasada'
      quanto.append(aviso)
    }

    botao.append(quem, quanto)
    botao.addEventListener('click', () => aoEscolher(ficha))
    linha.append(botao)
    alvo.append(linha)
  }
}

// ---------------------------------------------------------------------------
// Ficha
// ---------------------------------------------------------------------------

/** Abre a ficha de uma cliente: saldo e próxima parcela no topo, histórico abaixo (RF-02). */
function abrirFicha(ficha) {
  estado.fichaAberta = ficha
  elemento('ficha-nome').textContent = ficha.nome
  elemento('ficha-saldo').textContent = ficha.devendo === 0n ? 'Nada' : emReais(ficha.devendo)

  const proxima = elemento('ficha-proxima')
  proxima.classList.toggle('vencida', ficha.proxima !== null && ficha.proxima.vencida)
  if (ficha.proxima === null) {
    proxima.textContent = 'Está tudo pago'
  } else if (ficha.proxima.vencida) {
    proxima.textContent = `${emReais(ficha.proxima.valor)} venceu em ${ficha.proxima.data}`
  } else {
    proxima.textContent = `Próxima: ${emReais(ficha.proxima.valor)} em ${ficha.proxima.data}`
  }

  // O botão some quando não há o que receber: oferecer uma ação impossível é ruído.
  elemento('botao-recebi').hidden = ficha.proxima === null
  elemento('botao-recebi').textContent =
    ficha.proxima === null ? 'Recebi' : `Recebi ${emReais(ficha.proxima.valor)}`

  const historico = elemento('ficha-historico')
  historico.replaceChildren()
  for (const linha of ficha.historico) {
    const item = document.createElement('li')
    if (linha.tipo === 'vencida') item.classList.add('vencida')
    if (linha.tipo === 'recebimento') item.classList.add('paga')

    const data = document.createElement('span')
    data.className = 'data'
    data.textContent = linha.data
    const descricao = document.createElement('span')
    descricao.className = 'descricao'
    descricao.textContent = linha.descricao
    const cifra = document.createElement('span')
    cifra.className = 'cifra'
    cifra.textContent = emReais(linha.valor < 0n ? -linha.valor : linha.valor)

    item.append(data, descricao, cifra)
    historico.append(item)
  }

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
  if (ficha === null || ficha.proxima === null) return
  elemento('recebimento-titulo').textContent = `Recebi da ${ficha.nome}`
  elemento('recebimento-valor').value = emReais(ficha.proxima.valor).replace('R$ ', '')
  mostrarTela('tela-recebimento')
}

/** Confirma o recebimento: abate o saldo em memória e mostra quanto ficou faltando. */
function confirmarRecebimento() {
  const ficha = estado.fichaAberta
  if (ficha === null) return
  const pago = centavosDeTexto(elemento('recebimento-valor').value)
  const restante = ficha.devendo - pago

  ficha.devendo = restante
  ficha.historico.unshift({ data: 'hoje', descricao: 'Pagou', valor: -pago, tipo: 'recebimento' })
  // Encenação simples: no produto, o abatimento percorre as parcelas em aberto (RN-02).
  ficha.proxima = restante > 0n ? ficha.proxima : null

  elemento('recebido-linha').textContent = `Recebeu ${emReais(pago)} da ${ficha.nome}`
  elemento('recebido-saldo').textContent =
    restante > 0n ? `Ainda deve ${emReais(restante)}` : 'Ela não deve mais nada'
  mostrarTela('tela-recebido')
}

// ---------------------------------------------------------------------------
// Nova venda
// ---------------------------------------------------------------------------

/** Soma o que foi digitado nos itens. Total é sempre derivado do que está na tela. */
function totalDaVenda() {
  let total = 0n
  for (const item of estado.itens) {
    total += centavosDeTexto(item.preco)
  }
  return total
}

/** Redesenha total e parcelas a cada tecla, para ela conferir sem precisar concluir nada. */
function atualizarVenda() {
  const total = totalDaVenda()
  elemento('venda-total').textContent = emReais(total)

  const fiado = document.querySelector('input[name="pagamento"]:checked').value === 'fiado'
  elemento('bloco-parcelas').hidden = !fiado

  const lista = elemento('venda-parcelas')
  lista.replaceChildren()
  if (!fiado || total === 0n) return

  // Datas encenadas: a primeira em 30 dias, as demais de mês em mês (RF-05).
  const diasDoMes = ['05/10', '05/11', '05/12', '05/01']
  repartirEmParcelas(total, estado.vezes).forEach((valor, indice) => {
    const linha = document.createElement('li')
    const quando = document.createElement('span')
    quando.className = 'quando'
    quando.textContent = `${indice + 1}ª em ${diasDoMes[indice]}`
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
    const linha = document.createElement('li')

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

/** Fecha a venda: soma no que ela já devia e mostra o novo saldo. */
function salvarVenda() {
  const ficha = estado.fichaAberta
  if (ficha === null) return
  const total = totalDaVenda()
  const fiado = document.querySelector('input[name="pagamento"]:checked').value === 'fiado'
  const parcelas = repartirEmParcelas(total, estado.vezes)

  if (fiado) {
    ficha.devendo += total
    ficha.proxima = { valor: parcelas[0], data: '05/10', vencida: false }
  }
  ficha.historico.unshift({
    data: 'hoje',
    descricao: fiado ? `Levou ${estado.itens.length} coisas` : 'Levou e pagou na hora',
    valor: total,
    tipo: 'venda',
  })

  elemento('vendido-linha').textContent = fiado
    ? `Anotado na fichinha da ${ficha.nome}`
    : `${ficha.nome} levou e pagou ${emReais(total)}`
  elemento('vendido-saldo').textContent = fiado
    ? `Agora ela deve ${emReais(ficha.devendo)}`
    : 'Ela não deve nada'
  mostrarTela('tela-vendido')
}

// ---------------------------------------------------------------------------
// Ligações
// ---------------------------------------------------------------------------

for (const botao of document.querySelectorAll('[data-ir]')) {
  botao.addEventListener('click', () => mostrarTela(botao.dataset.ir))
}

elemento('busca').addEventListener('input', (evento) => {
  desenharLista(elemento('lista-fichas'), evento.target.value, abrirFicha)
})
elemento('busca-venda').addEventListener('input', (evento) => {
  desenharLista(elemento('lista-venda'), evento.target.value, abrirVenda)
})

elemento('botao-recebi').addEventListener('click', abrirRecebimento)
elemento('botao-confirmar-recebimento').addEventListener('click', confirmarRecebimento)
elemento('botao-venda-daqui').addEventListener('click', () => abrirVenda(estado.fichaAberta))
elemento('botao-salvar-venda').addEventListener('click', salvarVenda)

elemento('botao-mais-item').addEventListener('click', () => {
  estado.itens.push({ descricao: '', preco: '' })
  desenharItens()
})

// Cliente nova: no protótipo o cadastro não existe ainda (RF-01 é escopo de E-09). O botão
// está aqui porque a sessão precisa mostrar se ela procura por ele — se procurar, o cadastro
// tem que caber no caminho da venda, e isso é achado, não suposição.
elemento('botao-cliente-nova').addEventListener('click', () => {
  abrirVenda({ id: 'nova', nome: 'cliente nova', referencia: '', devendo: 0n, proxima: null, historico: [] })
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

desenharLista(elemento('lista-fichas'), '', abrirFicha)
desenharLista(elemento('lista-venda'), '', abrirVenda)
