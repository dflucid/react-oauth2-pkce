/* eslint-disable @typescript-eslint/camelcase */
import { createPKCECodes, PKCECodePair } from './pkce'
import { toUrlEncoded } from './util'

import jwtDecode from 'jwt-decode'

export interface AuthServiceProps {
  clientId: string
  clientSecret?: string
  contentType?: string
  location: Location
  provider: string
  authorizeEndpoint?: string
  tokenEndpoint?: string
  logoutEndpoint?: string
  audience?: string
  redirectUri?: string
  scopes: string[]
  autoRefresh?: boolean
  refreshSlack?: number
}

export interface AuthTokens {
  id_token: string
  access_token: string
  refresh_token: string
  expires_in: number
  expires_at?: number // calculated on login
  token_type: string
}

export interface JWTIDToken {
  given_name: string
  family_name: string
  name: string
  email: string
}

export interface TokenRequestBody {
  clientId: string
  grantType: string
  redirectUri?: string
  refresh_token?: string
  clientSecret?: string
  code?: string
  codeVerifier?: string
}

export enum UXType {
  POPUP,
  REDIRECTION
}

export type AuthError = {
  message: string | null | unknown
}

type PromisedResponseError<R, E = AuthError> = Promise<{
  response?: R
  error?: E
}>

const POPUP_WIDTH = 400
const POPUP_HEIGHT = 426
const ACCESS_TOKEN_GREASE_BOSS_EVENT = 'ACCESS_TOKEN_GREASE_BOSS_EVENT'

export class AuthService<TIDToken = JWTIDToken> {
  props: AuthServiceProps
  timeout?: number

  constructor(props: AuthServiceProps) {
    this.props = props
  }

  getUser(): {} {
    const t = this.getAuthTokens()
    if (null === t) return {}
    const decoded = jwtDecode(t.id_token) as TIDToken
    return decoded
  }

  getCodeFromLocation(location: Location): string | null {
    const split = location.toString().split('?')
    if (split.length < 2) {
      return null
    }
    const pairs = split[1].split('&')
    for (const pair of pairs) {
      const [key, value] = pair.split('=')
      if (key === 'code') {
        return decodeURIComponent(value || '')
      }
    }
    return null
  }

  removeCodeFromLocation(): void {
    const [base, search] = window.location.href.split('?')
    if (!search) {
      return
    }
    const newSearch = search
      .split('&')
      .map((param) => param.split('='))
      .filter(([key]) => key !== 'code')
      .map((keyAndVal) => keyAndVal.join('='))
      .join('&')
    window.history.replaceState(
      window.history.state,
      'null',
      base + (newSearch.length ? `?${newSearch}` : '')
    )
  }

  getItem(key: string): string | null {
    return window.localStorage.getItem(key)
  }
  removeItem(key: string): void {
    window.localStorage.removeItem(key)
  }

  getPkce(): PKCECodePair {
    const pkce = window.localStorage.getItem('pkce')
    if (null === pkce) {
      throw new Error('PKCE pair not found in local storage')
    } else {
      return JSON.parse(pkce)
    }
  }

  setAuthTokens(auth: AuthTokens): void {
    const { refreshSlack = 5 } = this.props
    const now = new Date().getTime()
    auth.expires_at = now + (auth.expires_in + refreshSlack) * 1000
    window.localStorage.setItem('auth', JSON.stringify(auth))
  }

  getAuthTokens(): AuthTokens {
    return JSON.parse(window.localStorage.getItem('auth') || '{}')
  }

  isPending(): boolean {
    return (
      window.localStorage.getItem('pkce') !== null &&
      window.localStorage.getItem('auth') === null
    )
  }

  isAuthenticated(): boolean {
    return window.localStorage.getItem('auth') !== null
  }

  async logout(shouldEndSession = false): Promise<boolean> {
    this.removeItem('pkce')
    this.removeItem('auth')
    if (shouldEndSession) {
      const { clientId, provider, logoutEndpoint, redirectUri } = this.props
      const query = {
        client_id: clientId,
        post_logout_redirect_uri: redirectUri
      }
      const url = `${logoutEndpoint || `${provider}/logout`}?${toUrlEncoded(
        query
      )}`
      window.location.replace(url)
      return true
    } else {
      window.location.reload()
      return true
    }
  }

  async login(): Promise<void> {
    this.authorize()
  }

  getAuthorizeUri(): string {
    const {
      clientId,
      provider,
      authorizeEndpoint,
      redirectUri,
      scopes,
      audience
    } = this.props

    const pkce = createPKCECodes()
    window.localStorage.setItem('pkce', JSON.stringify(pkce))
    window.localStorage.setItem('preAuthUri', location.href)
    window.localStorage.removeItem('auth')
    const codeChallenge = pkce.codeChallenge

    const query = {
      clientId,
      scope: scopes.join(' '),
      responseType: 'code',
      redirectUri,
      ...(audience && { audience }),
      codeChallenge,
      codeChallengeMethod: 'S256'
    }
    // Responds with a 302 redirect
    const url = `${authorizeEndpoint || `${provider}/authorize`}?${toUrlEncoded(
      query
    )}`
    return url
  }

  // this will do a full page reload and to to the OAuth2 provider's login page and then redirect back to redirectUri
  authorize(): boolean {
    const url = this.getAuthorizeUri()
    window.location.replace(url)
    return true
  }

  async authenticate(): Promise<PromisedResponseError<string | null>> {
    try {
      const response = await this.authenticateUsingOAuth(UXType.POPUP)
      if (!response) {
        throw 'No message received'
      }
      if (response !== null) {
        this.fetchToken(response)
          .then(() => {
            this.restoreUri()
          })
          .catch((e) => {
            this.removeItem('pkce')
            this.removeItem('auth')
            this.removeCodeFromLocation()
            console.warn({ e })
          })
      } else if (this.props.autoRefresh) {
        this.startTimer()
      }
      return { response }
    } catch (e) {
      return { error: { message: e } }
    }
  }

  async authenticateUsingOAuth(uxType: UXType): Promise<string | void> {
    switch (uxType) {
      case UXType.POPUP: {
        this.launchPopup()
        return new Promise<string>((resolve, reject) => {
          this.listenToMessageEvent(resolve, reject)
        })
      }
      default:
        return Promise.reject('Wrong UXType passed')
    }
  }

  // this happens after a full page reload. Read the code from localstorage
  async fetchToken(code: string, isRefresh = false): Promise<AuthTokens> {
    const {
      clientId,
      clientSecret,
      contentType,
      provider,
      tokenEndpoint,
      redirectUri,
      autoRefresh = true
    } = this.props
    const grantType = 'authorization_code'

    let payload: TokenRequestBody = {
      clientId,
      ...(clientSecret ? { clientSecret } : {}),
      redirectUri,
      grantType
    }
    if (isRefresh) {
      payload = {
        ...payload,
        grantType: 'refresh_token',
        refresh_token: code
      }
    } else {
      const pkce: PKCECodePair = this.getPkce()
      const codeVerifier = pkce.codeVerifier
      payload = {
        ...payload,
        code,
        codeVerifier
      }
    }

    const response = await fetch(`${tokenEndpoint || `${provider}/token`}`, {
      headers: {
        'Content-Type': contentType || 'application/x-www-form-urlencoded'
      },
      method: 'POST',
      body: toUrlEncoded(payload)
    })
    this.removeItem('pkce')
    const json = await response.json()
    if (isRefresh && !json.refresh_token) {
      json.refresh_token = payload.refresh_token
    }
    this.setAuthTokens(json as AuthTokens)
    if (autoRefresh) {
      this.startTimer()
    }
    return this.getAuthTokens()
  }

  armRefreshTimer(refreshToken: string, timeoutDuration: number): void {
    if (this.timeout) {
      clearTimeout(this.timeout)
    }
    this.timeout = window.setTimeout(() => {
      this.fetchToken(refreshToken, true)
        .then(({ refresh_token: newRefreshToken, expires_at: expiresAt }) => {
          if (!expiresAt) return
          const now = new Date().getTime()
          const timeout = expiresAt - now
          if (timeout > 0) {
            this.armRefreshTimer(newRefreshToken, timeout)
          } else {
            this.removeItem('auth')
            this.removeCodeFromLocation()
          }
        })
        .catch((e) => {
          this.removeItem('auth')
          this.removeCodeFromLocation()
          console.warn({ e })
        })
    }, timeoutDuration)
  }

  startTimer(): void {
    const authTokens = this.getAuthTokens()
    if (!authTokens) {
      return
    }
    const { refresh_token: refreshToken, expires_at: expiresAt } = authTokens
    if (!expiresAt || !refreshToken) {
      return
    }
    const now = new Date().getTime()
    const timeout = expiresAt - now
    if (timeout > 0) {
      this.armRefreshTimer(refreshToken, timeout)
    } else {
      this.removeItem('auth')
      this.removeCodeFromLocation()
    }
  }

  restoreUri(): void {
    window.location.replace('/')
  }

  launchPopup(): void {
    const left = window.screen.width / 2 - POPUP_WIDTH / 2
    const top = window.screen.height / 2 - POPUP_HEIGHT / 2
    const win = window.open(
      this.getAuthorizeUri(),
      'Swiggy Login',
      'resizable=no,scrollbars=no,status=no, width=' +
        POPUP_WIDTH +
        ', height=' +
        POPUP_HEIGHT +
        ', top=' +
        top +
        ', left=' +
        left
    )
    if (win) {
      win.opener = window
      const timer = setInterval(() => {
        try {
          const a = win.document.createElement('a')
          a.href = win.document.URL
          if (a.hostname === window.location.hostname) {
            this.onLocationChangeHandler(win)
            timer && clearInterval(timer)
          }
        } catch (e) {
          console.log('timer host name checking error: ', e)
        }
      }, 100)
    }
  }

  onLocationChangeHandler(window: Window): void {
    const code = this.getCodeFromLocation(window.location)
    if (!window.opener) {
      return
    }
    if (!code) {
      window.opener.postMessage(
        {
          type: 'error',
          message: 'No Authorization Code Found.'
        },
        window.location.origin
      )
      window.close()
      return
    }

    window.opener.postMessage(
      {
        type: ACCESS_TOKEN_GREASE_BOSS_EVENT,
        authorization_code: code
      },
      window.location.origin
    )
    window.close()
  }

  listenToMessageEvent(resolve: any, reject: any): void {
    const windowEventHandler = (event: MessageEvent): void => {
      const hash = event.data
      // eslint-disable-next-line no-console
      if (hash.type === ACCESS_TOKEN_GREASE_BOSS_EVENT) {
        const code = hash.authorization_code
        resolve(code)
      } else if (hash.type == 'error') {
        console.error(hash.message)
        reject(hash.message)
      }
      window.removeEventListener('message', windowEventHandler)
    }
    window.addEventListener('message', windowEventHandler, false)
  }
}
