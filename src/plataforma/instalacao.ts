/**
 * Qual texto de instalação mostrar (E-13, RF-23, D-038, D-048).
 *
 * O iPhone não tem aviso nativo de instalação: o caminho é o Compartilhar do Safari. O Android
 * tem — o Chrome oferece sozinho — mas o menu dele também serve. O desktop não instala (RF-23:
 * funciona no navegador, sem instalação), e o app já instalado não precisa de instrução. Só o
 * `userAgent` decide a plataforma: é texto, não comportamento, e errar custa uma frase que não
 * se aplica — não um lançamento.
 */

/** O que a tela inicial lê do navegador, separado para o teste passar valores à mão. */
export interface SinaisDeInstalacao {
  readonly userAgent: string
  /** `display-mode: standalone` ou `navigator.standalone` do iOS: já está na tela de início. */
  readonly instalado: boolean
}

/** A plataforma da instrução, ou `null` quando não há o que instruir. */
export function plataformaDeInstalacao({ userAgent, instalado }: SinaisDeInstalacao): 'ios' | 'android' | null {
  if (instalado) return null
  if (/iPhone|iPad|iPod/.test(userAgent)) return 'ios'
  if (/Android/.test(userAgent)) return 'android'
  return null
}

/** Os sinais do navegador em que o app está rodando. */
export function sinaisDoNavegador(): SinaisDeInstalacao {
  // `navigator.standalone` é do Safari do iOS e não está tipado; `display-mode` é o padrão.
  const standaloneDoSafari: unknown = Reflect.get(navigator, 'standalone')
  const instalado = standaloneDoSafari === true || (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches)
  return { userAgent: navigator.userAgent, instalado }
}
