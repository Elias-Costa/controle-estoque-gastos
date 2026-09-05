import { useCallback, useEffect, useState } from 'react'
import { procurarAtualizacao } from './atualizacao'
import { SQL_TABELA_SONDA, nuvem } from './nuvem'
import {
  enfileirarEscrita,
  inspecionarNuvem,
  rodarVerificacoes,
  sincronizar,
  zerarTeste,
  type Resultado,
} from './verificacoes'

const SIMBOLO: Record<Resultado['situacao'], string> = {
  ok: '✓',
  falhou: '✗',
  indisponivel: '—',
}

/**
 * Painel do spike E-00.
 *
 * Não é uma tela do produto e não deve parecer uma: é um relatório de
 * verificação, feito para ser lido no iPhone e para dizer, sem ambiguidade,
 * quais decisões continuam de pé. Some em E-01.
 */
export function PainelSpike() {
  const [resultados, setResultados] = useState<Resultado[]>([])
  // Começa ocupado: a primeira rodada dispara no efeito de montagem.
  const [ocupado, setOcupado] = useState(true)
  const [registro, setRegistro] = useState<string[]>([])
  const [online, setOnline] = useState(navigator.onLine)

  const anotar = useCallback((linha: string) => {
    const hora = new Date().toLocaleTimeString('pt-BR')
    setRegistro((atual) => [`${hora} · ${linha}`, ...atual].slice(0, 12))
  }, [])

  const atualizar = useCallback(async () => {
    setOcupado(true)
    try {
      setResultados(await rodarVerificacoes())
    } finally {
      setOcupado(false)
    }
  }, [])

  useEffect(() => {
    let montado = true
    // Sem setState síncrono aqui: a primeira rodada resolve fora do render.
    void rodarVerificacoes().then((iniciais) => {
      if (!montado) return
      setResultados(iniciais)
      setOcupado(false)
    })

    const mudouRede = () => { setOnline(navigator.onLine) }
    window.addEventListener('online', mudouRede)
    window.addEventListener('offline', mudouRede)
    return () => {
      montado = false
      window.removeEventListener('online', mudouRede)
      window.removeEventListener('offline', mudouRede)
    }
  }, [])

  const aoEnfileirar = async () => {
    const id = await enfileirarEscrita()
    // Mostra 18 caracteres de propósito: nos UUIDv7 os 8 primeiros são os bits altos
    // do instante e só mudam a cada ~65 s, então um prefixo curto faz ids distintos
    // parecerem repetidos (D-029).
    anotar(`escrita enfileirada (${id.slice(0, 18)}) — sem tocar na rede`)
    await atualizar()
  }

  const aoSincronizar = async (vezes: number) => {
    setOcupado(true)
    try {
      const { enviados, erro } = await sincronizar(vezes)
      anotar(
        erro
          ? `erro — ${erro} · a fila continua intacta`
          : `${enviados} item(ns) enviado(s) ${vezes}×`,
      )
      const nuvemAgora = await inspecionarNuvem()
      if (nuvemAgora) {
        const { total, distintos } = nuvemAgora
        // O veredito de EL-04 é esta comparação, e não o total: duplicata é
        // linha a mais para o mesmo id.
        anotar(
          total === distintos
            ? `nuvem: ${total} linha(s), ${distintos} id(s) distinto(s) — SEM duplicata`
            : `nuvem: ${total} linha(s) para ${distintos} id(s) — DUPLICOU (EL-04)`,
        )
      }
      await atualizar()
    } finally {
      setOcupado(false)
    }
  }

  const falhas = resultados.filter((r) => r.situacao === 'falhou')

  return (
    <main className="painel">
      <header>
        <p className="etiqueta">Spike E-00 · build {__BUILD_ID__}</p>
        <h1>Verificação de viabilidade</h1>
        <p className="resumo">
          Rede {online ? 'disponível' : 'ausente'}
          {falhas.length > 0 && ` · ${falhas.length} verificação(ões) falhando`}
        </p>
      </header>

      <section>
        <ul className="lista">
          {resultados.map((r) => (
            <li key={r.id} className={`item ${r.situacao}`}>
              <span className="simbolo" aria-hidden>{SIMBOLO[r.situacao]}</span>
              <div>
                <p className="titulo">{r.titulo}</p>
                <p className="detalhe">{r.detalhe}</p>
                <p className="origem">{r.origem}</p>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="acoes">
        <button type="button" onClick={() => void atualizar()} disabled={ocupado}>
          Rodar verificações
        </button>
        <button type="button" onClick={() => void aoEnfileirar()} disabled={ocupado}>
          Escrever offline
        </button>
        <button type="button" onClick={() => void aoSincronizar(1)} disabled={ocupado || !nuvem}>
          Sincronizar
        </button>
        <button type="button" onClick={() => void aoSincronizar(2)} disabled={ocupado || !nuvem}>
          Sincronizar 2× (prova EL-04)
        </button>
        <button
          type="button"
          onClick={() => { void procurarAtualizacao().then(anotar) }}
          disabled={ocupado}
        >
          Procurar atualização
        </button>
        <button
          type="button"
          onClick={() => { void zerarTeste().then(anotar).then(() => atualizar()) }}
          disabled={ocupado}
        >
          Zerar teste
        </button>
      </section>

      {registro.length > 0 && (
        <section>
          <h2>Registro</h2>
          <ul className="registro">
            {registro.map((linha, i) => (
              <li key={i}>{linha}</li>
            ))}
          </ul>
        </section>
      )}

      {!nuvem && (
        <section className="aviso">
          <h2>Supabase não configurado</h2>
          <p>
            Crie um projeto, copie a URL e a chave <code>anon</code> para um arquivo{' '}
            <code>.env.local</code>, e rode este SQL no editor do Supabase:
          </p>
          <pre>{SQL_TABELA_SONDA}</pre>
        </section>
      )}

      <footer>
        <p>
          Roteiro no iPhone: instalar na tela de início → modo avião → “Escrever offline” três vezes →
          reiniciar o aparelho → reabrir → conferir a sobrevivência → ligar a rede → “Sincronizar 2×”.
        </p>
      </footer>
    </main>
  )
}
