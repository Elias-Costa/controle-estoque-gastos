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
 *
 * **Tudo aqui é relativo ao relógio do aparelho, e isso é correção da revisão de 2026-09-05.**
 * As datas eram fixas em 05/09/2026. E-02 está bloqueada esperando o iPhone dela e a agenda dela
 * (`AGENTS.md` §6), então **o dia da sessão é desconhecido**: com datas fixas, no primeiro dia
 * seguinte a ficha passa a anunciar "Próxima: R$ 30,00 em 10/09" para uma data já vencida, os
 * lançamentos que ela criar durante a tarefa aparecem carimbados com um dia que não é hoje, e as
 * parcelas sugeridas de uma venda nova caem no passado. Nenhuma dessas três coisas é defeito do
 * produto — são defeitos do **instrumento**, do mesmo tipo do saldo guardado à mão que a revisão
 * anterior pegou, e produziriam falha falsa de EL-08 na única sessão que mede EL-08.
 */
const AGORA = new Date()

/** Uma data local vira "2026-09-05". Montada campo a campo, para não passar por fuso nenhum. */
function iso(data) {
  const mes = String(data.getMonth() + 1).padStart(2, '0')
  const dia = String(data.getDate()).padStart(2, '0')
  return `${data.getFullYear()}-${mes}-${dia}`
}

/** O ISO de N dias a partir de hoje. Negativo é passado. */
const emDias = (quantidade) => iso(new Date(AGORA.getFullYear(), AGORA.getMonth(), AGORA.getDate() + quantidade))

/**
 * O ISO de N meses a partir de hoje, preso ao último dia quando o mês é mais curto.
 *
 * Sem o grampo, uma venda feita em 31/01 sugeriria a parcela em 03/03 — o estouro natural do
 * `Date` —, e ela leria isso como erro do sistema no meio da tarefa.
 */
function emMeses(quantidade) {
  const alvo = new Date(AGORA.getFullYear(), AGORA.getMonth() + quantidade, 1)
  const ultimoDoMes = new Date(alvo.getFullYear(), alvo.getMonth() + 1, 0).getDate()
  alvo.setDate(AGORA.getDate() < ultimoDoMes ? AGORA.getDate() : ultimoDoMes)
  return iso(alvo)
}

/*
 * Só "Hoje" e "Ontem": é o que o protótipo consegue encenar sem mentir.
 *
 * Havia um terceiro botão, "Outro dia", e ele não abria seletor nenhum — carimbava o lançamento
 * seis dias atrás, em silêncio. Ela tocava, nada aparecia na tela, e a ficha passava a mostrar uma
 * data que ela não escolheu, bem no lugar onde ela vai conferir. Achado na revisão de 2026-09-05,
 * por execução.
 *
 * Escolher a data de um lançamento é RF-05 e escopo de E-10. Aqui a ausência é deliberada: se ela
 * procurar por outra data durante a sessão, isso é achado, e vale a exceção 1 da §3 do roteiro
 * ("isso eu ainda não fiz"). Data inventada em silêncio não é achado nenhum.
 */
const HOJE = emDias(0)
const ONTEM = emDias(-1)

/** "2026-09-28" -> "28/09". */
const comoEla = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`

/** Vencida é a parcela cuja data já passou. Comparação de texto ISO, que ordena igual à data. */
const estaVencida = (parcela) => parcela.restante > 0n && parcela.data < HOJE

/**
 * Há quantos dias a parcela venceu — é o que RF-10 pede na linha da lista.
 *
 * As duas datas são medidas ao meio-dia de propósito: na virada do horário de verão o dia tem 23
 * ou 25 horas, e a divisão por 24 h a partir da meia-noite erraria um dia inteiro.
 */
function diasDeAtraso(parcela) {
  const meioDia = (data) => new Date(`${data}T12:00:00`).getTime()
  return Math.round((meioDia(HOJE) - meioDia(parcela.data)) / 86400000)
}

/** Datas sugeridas para parcelas novas: de mês em mês (RF-05). */
const DATAS_SUGERIDAS = [emMeses(1), emMeses(2), emMeses(3), emMeses(4)]

// ---------------------------------------------------------------------------
// Dados falsos
// ---------------------------------------------------------------------------

/*
 * Nomes e valores inventados. **As datas são deslocamentos em dias a partir de hoje**, e não datas
 * fixas: o que precisa valer no dia da sessão não é "28/08", é que **a Cláudia esteja vencida** —
 * RF-02 exige que parcela vencida apareça distinta, e a tarefa 1 do roteiro é justamente ela.
 *
 * Cada ficha existe para encenar um caso: Rosa está em dia e já pagou uma parcela; Cláudia está
 * atrasada; Vera tem parcela única a vencer (é a cliente da tarefa 2); Marlene não deve nada;
 * Ivone tem três parcelas em aberto. Mexer nos números muda o que a sessão consegue observar.
 *
 * `parcelas` está sempre em ordem de vencimento — é o que faz o abatimento de RN-02 percorrer da
 * mais antiga para a mais nova sem precisar reordenar nada.
 */
const FICHAS = [
  {
    // Em dia: comprou há 26 dias em 4×, já pagou a primeira, a próxima vence daqui a 5 dias.
    id: 'rosa',
    nome: 'Dona Rosa',
    referencia: 'vizinha do 302',
    parcelas: [
      { valor: 3000n, restante: 0n, data: emDias(-26), ordem: 1, de: 4 },
      { valor: 3000n, restante: 3000n, data: emDias(5), ordem: 2, de: 4 },
      { valor: 3000n, restante: 3000n, data: emDias(35), ordem: 3, de: 4 },
      { valor: 3000n, restante: 3000n, data: emDias(66), ordem: 4, de: 4 },
    ],
    eventos: [
      { data: emDias(-8), descricao: 'Pagou no Pix', valor: -3000n, tipo: 'recebimento' },
      { data: emDias(-26), descricao: 'Creme, perfume e sabonete', valor: 12000n, tipo: 'venda' },
    ],
  },
  {
    // A cliente da tarefa 1 (roteiro §4). A primeira parcela está **vencida há 8 dias**, e é ela
    // que o botão "Recebi R$ 30,00" propõe abater. Deve R$ 60,00 no total: depois do recebimento
    // da tarefa, a confirmação diz "ainda deve R$ 30,00" — que é o que ela vai conferir na ficha.
    id: 'claudia',
    nome: 'Cláudia',
    referencia: 'do salão',
    parcelas: [
      { valor: 3000n, restante: 3000n, data: emDias(-8), ordem: 1, de: 2 },
      { valor: 3000n, restante: 3000n, data: emDias(23), ordem: 2, de: 2 },
    ],
    eventos: [{ data: emDias(-39), descricao: 'Shampoo e condicionador', valor: 6000n, tipo: 'venda' }],
  },
  {
    // A cliente da tarefa 2 (roteiro §5): parcela única a vencer, ficha curta, nada atrasado.
    id: 'vera',
    nome: 'Vera',
    referencia: 'irmã da Sandra',
    parcelas: [{ valor: 4500n, restante: 4500n, data: emDias(10), ordem: 1, de: 1 }],
    eventos: [{ data: emDias(-21), descricao: 'Kit de maquiagem', valor: 4500n, tipo: 'venda' }],
  },
  {
    // Quitada: a lista precisa ter alguém "em dia" para o vermelho das outras significar alguma coisa.
    id: 'marlene',
    nome: 'Marlene',
    referencia: 'da igreja',
    parcelas: [{ valor: 8000n, restante: 0n, data: emDias(-6), ordem: 1, de: 1 }],
    eventos: [
      { data: emDias(-6), descricao: 'Pagou tudo, em dinheiro', valor: -8000n, tipo: 'recebimento' },
      { data: emDias(-34), descricao: 'Hidratante e batom', valor: 8000n, tipo: 'venda' },
    ],
  },
  {
    id: 'ivone',
    nome: 'Ivone',
    referencia: 'do trabalho do Zé',
    parcelas: [
      { valor: 4000n, restante: 4000n, data: emDias(7), ordem: 1, de: 3 },
      { valor: 4000n, restante: 4000n, data: emDias(37), ordem: 2, de: 3 },
      { valor: 4000n, restante: 4000n, data: emDias(68), ordem: 3, de: 3 },
    ],
    eventos: [{ data: emDias(-16), descricao: 'Quatro coisas do catálogo', valor: 12000n, tipo: 'venda' }],
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
  /*
   * Para onde o "voltar" da tela de venda leva.
   *
   * A tela de venda tem duas portas de entrada — a lista "Para quem?" e o botão "Vender fiado para
   * ela", dentro da ficha —, e o botão de voltar apontava fixo para a primeira. Quem entrava pela
   * ficha e desistia caía numa tela que **nunca tinha visto**, procurando o caminho de volta para a
   * ficha da cliente. Achado na revisão de 2026-09-05, por execução.
   */
  voltarDaVenda: 'tela-venda-cliente',
}

const elemento = (id) => document.getElementById(id)
const escolhido = (nome) => document.querySelector(`input[name="${nome}"]:checked`).value

/**
 * Devolve um grupo de rádio à opção que o HTML declara `checked`.
 *
 * Existe porque **nenhum grupo de rádio se reinicializava** entre uma entrada e outra na mesma
 * carga da página: o que ela escolheu num lançamento continuava marcado no seguinte, sem ela
 * escolher de novo. Achado na revisão de 2026-09-05, por execução.
 *
 * Só quem chama decide o que reinicializar — "Como" (Pix/Dinheiro) fica de fora de propósito,
 * por decisão do mantenedor: forma de pagamento não é data, e a confirmação já diz em voz alta
 * "Pagou em dinheiro", então ela enxerga o que ficou marcado.
 */
function marcar(nome, valor) {
  document.querySelector(`input[name="${nome}"][value="${valor}"]`).checked = true
}

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
      // "há quantos dias" é literal de RF-10, e não enfeite: é o que ordena a cobrança dela na
      // rua. A versão anterior dizia só "atrasada", que não distingue um dia de dois meses.
      const dias = diasDeAtraso(proxima)
      const aviso = document.createElement('span')
      aviso.className = 'aviso-atraso'
      aviso.textContent = dias === 1 ? 'atrasada há 1 dia' : `atrasada há ${dias} dias`
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
  // Todo recebimento nasce como "Hoje". Sem isto o "Ontem" de um lançamento anterior seguia
  // marcado e o seguinte era carimbado com uma data que ela não escolheu **para ele** — a mesma
  // classe do botão "Outro dia" que a revisão anterior retirou (RF-05, escopo de E-10).
  marcar('quando-recebi', 'hoje')
  atualizarRecebimento()
  mostrarTela('tela-recebimento')
}

/**
 * Mantém "Confirmar" indisponível enquanto não há valor digitado.
 *
 * Mesma correção do lado da venda, pelo mesmo motivo: a guarda de `confirmarRecebimento` já
 * recusava o valor zero, mas o botão ficava **morto e mudo** — e os segundos que ela gastasse
 * diante dele entrariam no tempo de RT-14 como se fossem do desenho, e não do instrumento.
 * Achado na revisão de 2026-09-05, por execução.
 */
function atualizarRecebimento() {
  elemento('botao-confirmar-recebimento').disabled = centavosDeTexto(elemento('recebimento-valor').value) === 0n
}

/** Confirma o recebimento: abate as parcelas e mostra o saldo novo, que é o que ela confere em voz alta. */
function confirmarRecebimento() {
  const ficha = estado.fichaAberta
  if (ficha === null) return

  const pago = centavosDeTexto(elemento('recebimento-valor').value)
  if (pago === 0n) return // Guarda de instrumento: sem valor não há o que confirmar.

  const forma = escolhido('forma')
  const quando = { hoje: HOJE, ontem: ONTEM }[escolhido('quando-recebi')]
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

  // Indisponível **antes** do toque, e não mudo depois dele. A guarda de `salvarVenda` já recusava
  // o total zero, mas em silêncio: ela tocava "Pronto", nada acontecia e nada era dito. Ver o
  // comentário de `salvarVenda` — a regra é a mesma, esta linha só a torna visível.
  elemento('botao-salvar-venda').disabled = total === 0n

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

/**
 * Abre a venda para uma cliente já escolhida.
 *
 * `origem` é a tela para onde o botão de voltar leva — ver `estado.voltarDaVenda`. O padrão serve
 * a chamada que vem da lista, que é a que `desenharLista` faz com um argumento só.
 */
function abrirVenda(ficha, origem = 'tela-venda-cliente') {
  estado.fichaAberta = ficha
  estado.voltarDaVenda = origem
  estado.vezes = 1
  estado.itens = [
    { descricao: '', preco: '' },
    { descricao: '', preco: '' },
  ]
  elemento('venda-titulo').textContent = `O que a ${ficha.nome} levou`
  /*
   * Toda venda nasce **fiado** e **hoje** — as duas opções que o HTML declara `checked`.
   *
   * Os rádios não se reinicializavam: depois de uma venda à vista, entrar de novo por "Vender
   * fiado para ela" abria a tela com "À vista" marcado e o bloco "Em quantas vezes" **oculto**.
   * O botão que ela acabou de tocar dizia fiado e a tela entregava o contrário, sem parcela
   * nenhuma. "Quando foi" tinha o mesmo problema do recebimento — ver `abrirRecebimento`.
   * Achado na revisão de 2026-09-05, por execução.
   *
   * Precisa vir antes de `atualizarVenda()`, que lê estes dois rádios para decidir o que mostrar.
   */
  marcar('pagamento', 'fiado')
  marcar('quando-venda', 'hoje')
  for (const botao of document.querySelectorAll('#venda-vezes .vez')) {
    botao.classList.toggle('ativa', botao.dataset.vezes === '1')
  }
  desenharItens()
  atualizarVenda()
  mostrarTela('tela-venda')
}

/**
 * Junta o que ela digitou numa frase para o histórico: "Hidratante e Batom".
 *
 * O texto sai como ela escreveu. A versão anterior passava só o último item para minúscula, e o
 * resultado era "Creme, Perfume e sabonete" — uma inconsistência visível na tela dela, produzida
 * pelo protótipo e não por ela.
 */
function descricaoDosItens() {
  const nomes = estado.itens.map((i) => i.descricao.trim()).filter((d) => d !== '')
  if (nomes.length === 0) return `Levou ${estado.itens.length} coisas`
  if (nomes.length === 1) return nomes[0]
  return `${nomes.slice(0, -1).join(', ')} e ${nomes[nomes.length - 1]}`
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
  const quando = { hoje: HOJE, ontem: ONTEM }[escolhido('quando-venda')]

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

  /*
   * O número da confirmação é sempre o saldo derivado das parcelas (RN-01) — inclusive na venda
   * à vista, e é aí que estava o defeito. A ramificação à vista dizia "Ela não deve nada" fixo, e
   * para qualquer cliente que já devesse alguma coisa a confirmação contradizia a ficha um toque
   * depois: "Ela não deve nada" contra "Deve R$ 45,00". É a mesma classe de defeito que a revisão
   * anterior corrigiu no saldo guardado à mão, na ramificação que a correção não alcançou —
   * conferir a fichinha depois é exatamente o que ela faz, e isto produziria falha falsa de EL-08.
   * Achado na revisão de 2026-09-05, por execução.
   *
   * "Ainda deve" é a frase que a confirmação do recebimento já usa: nenhuma palavra nova entra na
   * tela dela por causa desta correção (RI-07).
   */
  elemento('vendido-saldo').textContent =
    saldo === 0n
      ? 'Ela não deve nada'
      : fiado
        ? `Agora ela deve ${emReais(saldo)}`
        : `Ainda deve ${emReais(saldo)}`
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
elemento('recebimento-valor').addEventListener('input', atualizarRecebimento)
elemento('botao-confirmar-recebimento').addEventListener('click', confirmarRecebimento)
elemento('botao-salvar-venda').addEventListener('click', salvarVenda)
elemento('botao-venda-daqui').addEventListener('click', () => {
  // Entrou pela ficha, então o voltar devolve à ficha — e não à lista "Para quem?", que ela
  // não chegou a ver por este caminho.
  if (estado.fichaAberta !== null) abrirVenda(estado.fichaAberta, 'tela-ficha')
})

elemento('botao-voltar-venda').addEventListener('click', () => mostrarTela(estado.voltarDaVenda))

elemento('botao-mais-item').addEventListener('click', () => {
  estado.itens.push({ descricao: '', preco: '' })
  desenharItens()
})

/*
 * Cliente nova: o cadastro de verdade é RF-01 e escopo de E-09. O botão está aqui porque a sessão
 * precisa mostrar **se ela procura por ele** durante a venda — se procurar, o cadastro tem que
 * caber no caminho da venda, e isso é achado, não suposição. A ficha criada entra na lista para
 * que o resto do fluxo continue coerente.
 *
 * O nome vem do que ela **já digitou na busca**: quem toca neste botão acabou de procurar alguém e
 * não achou, e o nome está na tela. Sem isso o protótipo batizava a ficha de "Cliente nova" e as
 * telas seguintes falavam de uma pessoa que não existe — a observação morria no primeiro toque,
 * que é justamente o que o botão foi posto ali para enxergar. Nome é o único campo obrigatório de
 * RF-01; o resto do cadastro continua fora do protótipo, e continua sendo E-09.
 */
elemento('botao-cliente-nova').addEventListener('click', () => {
  const digitado = elemento('busca-venda').value.trim()
  const nova = {
    id: `nova-${FICHAS.length}`,
    nome: digitado === '' ? 'Cliente nova' : digitado,
    referencia: '',
    parcelas: [],
    eventos: [],
  }
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
