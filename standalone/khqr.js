/**
 * Bakong KHQR — EMV payload, MD5 payment check (Bakong Open API).
 * Register token: https://api-bakong.nbc.gov.kh/register
 */
;(function (global) {
  const KHR_PER_USD = 4100
  /** localStorage keys — do not put your JWT or account here */
  const TOKEN_KEY = 'dyna_bakong_token'
  const PROXY_KEY = 'dyna_bakong_proxy'
  const ACCOUNT_KEY = 'dyna_bakong_account'
  const EMAIL_KEY = 'dyna_bakong_email'
  const PENDING_KEY = 'dyna_pending_topup'
  const QR_EXPIRE_MS = 10 * 60 * 1000
  const DEMO_ACCOUNT = 'dynastore@bkrt'
  /** Bakong proxy (node server.mjs) — works from Cursor preview on any port */
  const PROXY_API = 'http://127.0.0.1:8787/api/check-md5'
  const PROXY_RENEW = 'http://127.0.0.1:8787/api/renew-token'
  const PROXY_HEALTH = 'http://127.0.0.1:8787/api/health'
  const PROXY_SET_EMAIL = 'http://127.0.0.1:8787/api/set-email'

  const MERCHANT = {
    name: 'DYNA STORE',
    city: 'PHNOM PENH',
    /** Your real Bakong ID, e.g. myshop@aba — must exist in Bakong */
    account: 'dynastore@bkrt',
    mcc: '5999',
    /** 840 = USD (matches $ prices in UI); use '116' for KHR-only */
    currency: '840',
    merchantDisplayName: 'Dyna Store',
    merchantCity: 'Phnom Penh',
  }

  const PAYMENT_CHECK = {
    apiBase: 'https://api-bakong.nbc.gov.kh',
    pollIntervalMs: 1500,
    maxPollMs: 10 * 60 * 1000,
    pendingMaxMs: 24 * 60 * 60 * 1000,
    demoWhenNoToken: false,
  }

  /** No JWT — Bakong MD5 API cannot verify payment */
  function useSimplePaymentFlow() {
    return !getToken()
  }

  function savePendingTopup() {
    if (!currentMd5 || !currentUsd) return
    localStorage.setItem(
      PENDING_KEY,
      JSON.stringify({ md5: currentMd5, usd: currentUsd, at: Date.now() }),
    )
  }

  function clearPendingTopup() {
    localStorage.removeItem(PENDING_KEY)
  }

  function applyTopupCredit(usd, md5, data) {
    const key = md5 || `manual-${usd}-${Date.now()}`
    if (creditedMd5.has(key)) return false
    creditedMd5.add(key)
    clearPendingTopup()
    global.Khqr?.onPaymentSuccess?.(Number(usd), data)
    global.showKhqrToast?.(`+${formatUsd(usd)} added to balance`)
    return true
  }

  async function resumePendingTopup() {
    const raw = localStorage.getItem(PENDING_KEY)
    if (!raw) return false

    let pending
    try {
      pending = JSON.parse(raw)
    } catch {
      clearPendingTopup()
      return false
    }

    if (Date.now() - pending.at > PAYMENT_CHECK.pendingMaxMs) {
      clearPendingTopup()
      return false
    }

    if (creditedMd5.has(pending.md5)) return false

    const proxy = resolveProxyUrl()
    if (!proxy) return false

    try {
      if (!(await isProxyOnline())) return false
    } catch {
      return false
    }

    try {
      const json = await checkTransactionByMd5(pending.md5)
      if (parsePaymentStatus(json) === 'paid') {
        return applyTopupCredit(pending.usd, pending.md5, json.data)
      }
    } catch {
      /* retry */
    }
    return false
  }

  function verifyKhqr(payload) {
    if (global.BakongKhqrLite?.verify) return global.BakongKhqrLite.verify(payload)
    return false
  }

  function configDefaults() {
    return global.DYNA_BAKONG_CONFIG || {}
  }

  function getBakongAccount() {
    const input = document.getElementById('bakongAccount')
    const fromConfig = configDefaults().account
    return (
      input?.value ||
      localStorage.getItem(ACCOUNT_KEY) ||
      fromConfig ||
      MERCHANT.account
    ).trim()
  }

  function isInvalidAccount(account) {
    return !account || account === DEMO_ACCOUNT || !/^[^\s@]+@[^\s@]+$/.test(account)
  }

  function buildKhqr(usdAmount) {
    const account = getBakongAccount()
    if (isInvalidAccount(account)) {
      throw new Error('INVALID_ACCOUNT')
    }

    if (!global.BakongKhqrLite) {
      throw new Error('KHQR generator missing')
    }

    const currency = MERCHANT.currency
    const amount =
      currency === '116'
        ? Math.round(Number(usdAmount) * KHR_PER_USD)
        : Number(usdAmount)

    const result = global.BakongKhqrLite.generateIndividual({
      bakongAccountID: account,
      merchantName: MERCHANT.merchantDisplayName || MERCHANT.name,
      merchantCity: MERCHANT.merchantCity || 'Phnom Penh',
      amount,
      currency,
    })

    return result.qr
  }

  function hashMd5(qrString) {
    if (typeof global.md5 !== 'function') return ''
    return global.md5(qrString)
  }

  function formatKhr(usd) {
    const khr = Math.round(Number(usd) * KHR_PER_USD)
    return '៛' + khr.toLocaleString('en-US')
  }

  function formatUsd(usd) {
    return '$' + Number(usd).toFixed(2)
  }

  function isRegisterCode(token) {
    const t = String(token || '').trim()
    return t.startsWith('rbk') && !t.startsWith('eyJ')
  }

  function getRegisterCode() {
    const cfg = configDefaults()
    if (isRegisterCode(cfg.registerToken)) return cfg.registerToken
    if (isRegisterCode(cfg.token)) return cfg.token
    return isRegisterCode(getTokenRaw()) ? getTokenRaw() : ''
  }

  function needsJwtActivation() {
    const jwt = getToken()
    return Boolean(getRegisterCode()) && !jwt.startsWith('eyJ')
  }

  function getTokenRaw() {
    const input = document.getElementById('bakongToken')
    const fromConfig = configDefaults().token
    return (input?.value || localStorage.getItem(TOKEN_KEY) || fromConfig || '').trim()
  }

  /** JWT only (eyJ…) — empty when only rbk register code is set */
  function getToken() {
    const raw = getTokenRaw()
    return isRegisterCode(raw) ? '' : raw
  }

  /** JWT only — rbk codes do not work for check_transaction_by_md5 */
  function getApiCredential() {
    return getToken()
  }

  function hasApiCredential() {
    return Boolean(getToken())
  }

  function getBakongEmail() {
    const input =
      document.getElementById('bakongEmail') ||
      document.querySelector('.bakong-email-sync')
    const fromConfig = configDefaults().email
    return (input?.value || localStorage.getItem(EMAIL_KEY) || fromConfig || '').trim()
  }

  function getProxyUrl() {
    const input = document.getElementById('bakongProxy')
    const fromConfig = configDefaults().proxy
    return (input?.value || localStorage.getItem(PROXY_KEY) || fromConfig || PROXY_API).trim()
  }

  /** Always use port 8787 proxy unless the page is already served from that server. */
  function resolveProxyUrl() {
    if (typeof location !== 'undefined' && location.port === '8787') {
      const raw = getProxyUrl()
      if (raw.startsWith('/')) return location.origin + raw
      if (raw.startsWith('http')) return raw
      return location.origin + '/api/check-md5'
    }
    return PROXY_API
  }

  async function isProxyOnline() {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 4000)
    try {
      const res = await fetch(PROXY_HEALTH, {
        method: 'GET',
        mode: 'cors',
        signal: ctrl.signal,
      })
      if (res.ok) {
        try {
          const health = await res.json()
          serverHasJwt = Boolean(health.hasJwt)
        } catch {
          serverHasJwt = Boolean(getToken())
        }
      }
      return res.ok
    } catch {
      try {
        const res = await fetch(PROXY_API, {
          method: 'POST',
          mode: 'cors',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ md5: '00000000000000000000000000000000' }),
          signal: ctrl.signal,
        })
        return true
      } catch {
        return false
      }
    } finally {
      clearTimeout(timer)
    }
  }

  async function renewBakongToken() {
    const email = getBakongEmail()
    if (!email) throw new Error('EMAIL_REQUIRED')

    const online = await isProxyOnline()
    if (!online) throw new Error('PROXY_OFFLINE')

    const cfg = configDefaults()
    const body = {
      email,
      organization: cfg.organization || 'Dyna Store',
      project: cfg.project || 'dyna_store',
    }
    const code = document.getElementById('bakongVerifyCode')?.value?.trim()
    if (code) body.code = code
    const rbk = getRegisterCode()
    if (rbk) body.registerToken = rbk

    const res = await fetch(PROXY_RENEW, {
      method: 'POST',
      mode: 'cors',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const json = await res.json()
    if (json.responseCode === 0 && json.data?.token) {
      const tokenEl = document.getElementById('bakongToken')
      if (tokenEl) tokenEl.value = json.data.token
      saveSettings()
      return json.data.token
    }
    if (json.errorCode === 10) {
      throw new Error('NOT_REGISTERED')
    }
    throw new Error(json.responseMessage || 'RENEW_FAILED')
  }

  async function syncEmailToServer(force = false) {
    const email = getBakongEmail()
    if (!email) return false

    await isProxyOnline()
    if (!force && serverHasJwt) return true
    if (!force && Date.now() - lastEmailSyncAt < EMAIL_SYNC_COOLDOWN_MS) return serverHasJwt

    const cfg = configDefaults()
    try {
      const res = await fetch(PROXY_SET_EMAIL, {
        method: 'POST',
        mode: 'cors',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          organization: cfg.organization || 'Dyna Store',
          project: cfg.project || 'dyna_store',
          forceRenew: Boolean(force),
        }),
      })
      const json = await res.json()
      serverHasJwt = Boolean(json.hasJwt)
      if (json.token?.startsWith('eyJ')) {
        localStorage.setItem(TOKEN_KEY, json.token)
        const tokenEl = document.getElementById('bakongToken')
        if (tokenEl) tokenEl.value = json.token
      }
      lastEmailSyncAt = Date.now()
      return json.hasJwt
    } catch {
      return false
    }
  }

  function saveSettings() {
    const token = document.getElementById('bakongToken')?.value?.trim()
    const proxy = document.getElementById('bakongProxy')?.value?.trim()
    const account = document.getElementById('bakongAccount')?.value?.trim()
    const email =
      document.getElementById('bakongEmail')?.value?.trim() ||
      document.querySelector('.bakong-email-sync')?.value?.trim()
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
    if (proxy) localStorage.setItem(PROXY_KEY, proxy)
    else localStorage.removeItem(PROXY_KEY)
    if (account) localStorage.setItem(ACCOUNT_KEY, account)
    else localStorage.removeItem(ACCOUNT_KEY)
    if (email) {
      localStorage.setItem(EMAIL_KEY, email)
      document.querySelectorAll('#bakongEmail, .bakong-email-sync').forEach((el) => {
        el.value = email
      })
    } else localStorage.removeItem(EMAIL_KEY)
  }

  function loadSettings() {
    const cfg = configDefaults()
    const tokenEl = document.getElementById('bakongToken')
    const proxyEl = document.getElementById('bakongProxy')
    const accountEl = document.getElementById('bakongAccount')
    const emailEl = document.getElementById('bakongEmail')
    if (tokenEl) {
      const jwt = cfg.token && !isRegisterCode(cfg.token) ? cfg.token : ''
      const rbk = getRegisterCode()
      tokenEl.value = localStorage.getItem(TOKEN_KEY) || jwt || rbk || ''
      if (jwt && !localStorage.getItem(TOKEN_KEY)) {
        localStorage.setItem(TOKEN_KEY, jwt)
      }
    }
    if (proxyEl) {
      let stored = localStorage.getItem(PROXY_KEY) || ''
      if (stored === '/api/check-md5' || stored.endsWith('/check-md5')) {
        stored = PROXY_API
        localStorage.setItem(PROXY_KEY, stored)
      }
      proxyEl.value = stored || cfg.proxy || PROXY_API
      if (!localStorage.getItem(PROXY_KEY)) {
        localStorage.setItem(PROXY_KEY, proxyEl.value)
      }
    }
    if (accountEl) {
      accountEl.value =
        localStorage.getItem(ACCOUNT_KEY) || cfg.account || MERCHANT.account
      if (cfg.account && !localStorage.getItem(ACCOUNT_KEY)) {
        localStorage.setItem(ACCOUNT_KEY, cfg.account)
      }
    }
    const storedEmail = localStorage.getItem(EMAIL_KEY) || cfg.email || ''
    document.querySelectorAll('#bakongEmail, .bakong-email-sync').forEach((el) => {
      el.value = storedEmail
    })
    if (storedEmail) localStorage.setItem(EMAIL_KEY, storedEmail)
  }

  /** Map Bakong check_transaction_by_md5 response to status */
  function parsePaymentStatus(json) {
    if (!json || typeof json !== 'object') return 'error'
    if (json.responseCode === 0 && json.data) {
      const d = json.data
      if (d.status === 'FAILED' || d.status === 'FAIL') return 'failed'
      if (d.status === 'NOT_FOUND') return 'pending'
      const st = String(d.status || '').toUpperCase()
      const paid =
        st === 'SUCCESS' ||
        st === 'PAID' ||
        st === 'COMPLETED' ||
        st === 'SUCCEEDED' ||
        Boolean(d.hash) ||
        Boolean(d.fromAccountId) ||
        Number(d.acknowledgedDateMs) > 0 ||
        (d.amount != null && Number(d.amount) > 0)
      if (paid) return 'paid'
    }
    if (json.responseCode === 1) {
      if (json.errorCode === 1) return 'pending'
      if (json.errorCode === 99) return 'no_token'
      if (json.errorCode === 6) return 'unauthorized'
      if (json.errorCode === 3) return 'failed'
      if (json.errorCode === 2) return 'failed'
    }
    return 'pending'
  }

  let currentPayload = ''
  let currentMd5 = ''
  let currentUsd = 0
  let pollTimer = null
  let pollStartedAt = 0
  let checking = false
  let paymentCredited = false
  let serverHasJwt = false
  let lastEmailSyncAt = 0
  const EMAIL_SYNC_COOLDOWN_MS = 30 * 60 * 1000
  const creditedMd5 = new Set()

  function userFacingMessage(msg) {
    if (!msg) return msg
    const s = String(msg).toLowerCase()
    if (s.includes('email') || s.includes('register') || s.includes('renew_token')) {
      return null
    }
    return msg
  }

  function setPaymentStatus(status, detail) {
    const wrap = document.getElementById('khqrStatus')
    const text = document.getElementById('khqrStatusText')
    if (!wrap || !text) return

    wrap.className = 'khqr-status khqr-status--' + status
    const labels = {
      pending: 'Waiting for payment…',
      checking: 'Checking payment (MD5)…',
      paid: 'Payment received',
      failed: 'Payment failed',
      expired: 'QR expired — generate a new one',
      error: 'Could not reach Bakong API',
      demo: 'Demo mode — simulating payment check',
    }
    text.textContent = userFacingMessage(detail) || labels[status] || status
  }

  function updateMd5Display() {
    const el = document.getElementById('khqrMd5')
    if (el) el.textContent = currentMd5 || '—'
  }

  async function checkTransactionByMd5(md5Hash) {
    const token = getApiCredential()
    const proxy = resolveProxyUrl()

    if (proxy) {
      const res = await fetch(proxy, {
        method: 'POST',
        mode: 'cors',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ md5: md5Hash, token }),
      })
      let json
      try {
        json = await res.json()
      } catch {
        if (!res.ok) throw new Error('PROXY_HTTP_' + res.status)
        throw new Error('PROXY_BAD_RESPONSE')
      }
      if (json.error && json.responseCode === undefined) {
        if (res.status === 401) throw new Error('NO_TOKEN')
        return {
          responseCode: 1,
          errorCode: 99,
          responseMessage: String(json.error),
          data: null,
        }
      }
      return json
    }

    if (!token) throw new Error('NO_TOKEN')

    const res = await fetch(`${PAYMENT_CHECK.apiBase}/v1/check_transaction_by_md5`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ md5: md5Hash }),
    })

    const json = await res.json()
    if (json.errorCode === 6) throw new Error('UNAUTHORIZED')
    if (res.status === 401) throw new Error('UNAUTHORIZED')
    return json
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
    checking = false
  }

  function creditWalletAfterPaid() {
    if (paymentCredited) return
    onPaymentPaid({ manualConfirm: true })
  }

  function onPaymentPaid(data) {
    if (paymentCredited) return
    paymentCredited = true
    stopPolling()
    setPaymentStatus('paid', 'Payment received — updating balance…')
    applyTopupCredit(currentUsd, currentMd5, data)
    document.getElementById('khqrCheckNow')?.setAttribute('disabled', 'true')
    setTimeout(() => closeKhqrModal(), 1500)
  }

  async function ensurePaymentWatcher() {
    const proxy = resolveProxyUrl()
    if (!proxy) return false
    await isProxyOnline()
    if (!serverHasJwt && !getToken()) await syncEmailToServer()
    return serverHasJwt || getToken()
  }

  async function runPaymentCheck() {
    if (!currentMd5 || checking) return
    checking = true
    setPaymentStatus('checking', 'Checking payment — balance updates automatically…')

    try {
      await ensurePaymentWatcher()

      const json = await checkTransactionByMd5(currentMd5)
      const status = parsePaymentStatus(json)
      if (status === 'paid') {
        onPaymentPaid(json.data)
        return
      }
      if (status === 'no_token') {
        setPaymentStatus('pending', 'Waiting for payment…')
        return
      }
      if (status === 'unauthorized') {
        setPaymentStatus('pending', 'Checking payment…')
        return
      }
      if (status === 'failed') {
        setPaymentStatus('failed')
        stopPolling()
        return
      }
      setPaymentStatus('pending')
    } catch (err) {
      if (err.message === 'NO_TOKEN') {
        setPaymentStatus('pending', 'Waiting for payment…')
        return
      }
      if (err.message === 'UNAUTHORIZED') {
        setPaymentStatus('pending', 'Checking payment…')
        return
      }
      if (err.message === 'Failed to fetch' || err.name === 'TypeError') {
        setPaymentStatus('error', 'Proxy offline — run start.bat or: node server.mjs')
        return
      }
      setPaymentStatus('error', userFacingMessage(err.message) || 'Payment check failed')
    } finally {
      checking = false
    }
  }

  async function startPolling() {
    stopPolling()
    pollStartedAt = Date.now()
    saveSettings()

    const proxy = resolveProxyUrl()
    paymentCredited = false

    document.getElementById('khqrCheckNow')?.removeAttribute('disabled')

    if (!proxy) {
      setPaymentStatus('error', 'Set proxy URL: http://127.0.0.1:8787/api/check-md5')
      return
    }

    if (!(await isProxyOnline())) {
      setPaymentStatus('error', 'Proxy offline — run start.bat or node server.mjs')
      return
    }

    await ensurePaymentWatcher()
    setPaymentStatus('pending', 'Scan & pay — balance updates automatically')
    runPaymentCheck()
    pollTimer = setInterval(() => {
      if (Date.now() - pollStartedAt > PAYMENT_CHECK.maxPollMs) {
        setPaymentStatus('expired')
        stopPolling()
        return
      }
      runPaymentCheck()
    }, PAYMENT_CHECK.pollIntervalMs)
  }

  function renderQr(container, payload) {
    container.innerHTML = ''
    if (typeof global.QRCode === 'undefined') {
      container.textContent = 'QR library missing'
      return
    }
    if (!verifyKhqr(payload)) {
      container.textContent = 'Invalid KHQR checksum'
      return
    }
    new global.QRCode(container, {
      text: payload,
      width: 240,
      height: 240,
      colorDark: '#000000',
      colorLight: '#ffffff',
      correctLevel: global.QRCode.CorrectLevel.H,
    })
  }

  function openKhqrModal(usdAmount) {
    const overlay = document.getElementById('khqrOverlay')
    if (!overlay) return

    saveSettings()
    loadSettings()

    const account = getBakongAccount()
    if (isInvalidAccount(account)) {
      global.showKhqrToast?.('Enter your real Bakong ID above (e.g. you@aba)')
      document.getElementById('bakongAccount')?.focus()
      return
    }

    try {
      currentUsd = Number(usdAmount)
      currentPayload = buildKhqr(usdAmount)
      currentMd5 = hashMd5(currentPayload)
    } catch (err) {
      global.showKhqrToast?.('Cannot build KHQR — check Bakong account')
      return
    }

    document.getElementById('khqrAmountUsd').textContent = formatUsd(usdAmount)
    document.getElementById('khqrAmountKhr').textContent = formatKhr(usdAmount)
    document.getElementById('khqrMerchant').textContent = MERCHANT.name
    document.getElementById('khqrAccount').textContent = account

    const warn = document.getElementById('khqrAccountWarn')
    if (warn) warn.classList.add('hidden')

    const expireEl = document.getElementById('khqrExpire')
    if (expireEl) {
      const cur = MERCHANT.currency === '116' ? '៛' + Math.round(currentUsd * KHR_PER_USD).toLocaleString('en-US') : formatUsd(currentUsd)
      expireEl.textContent = `QR valid 10 min · ${cur} · account must match your Bakong registration`
    }

    updateMd5Display()
    savePendingTopup()

    renderQr(document.getElementById('khqrQr'), currentPayload)
    overlay.classList.add('open')
    overlay.setAttribute('aria-hidden', 'false')
    document.body.style.overflow = 'hidden'

    paymentCredited = false
    document.getElementById('khqrAdvanced')?.classList.toggle('hidden', serverHasJwt || Boolean(getToken()))
    setPaymentStatus('pending', 'Scan & pay — balance updates automatically')
    isProxyOnline()
      .then(() => (serverHasJwt || getToken() ? true : syncEmailToServer()))
      .finally(() => startPolling())
  }

  async function tryAutoRenewToken() {
    await isProxyOnline()
    if (serverHasJwt || getToken()) return
    await syncEmailToServer()
  }

  function confirmPayment() {
    if (!currentUsd) return
    applyTopupCredit(currentUsd, currentMd5 || 'confirm', { manualConfirm: true })
    setPaymentStatus('paid')
    stopPolling()
    setTimeout(() => closeKhqrModal(), 800)
  }

  async function fixBakongToken() {
    if (!getBakongEmail()) throw new Error('CONFIG_REQUIRED')
    return renewBakongToken()
  }

  function closeKhqrModal() {
    stopPolling()
    const overlay = document.getElementById('khqrOverlay')
    if (!overlay) return
    overlay.classList.remove('open')
    overlay.setAttribute('aria-hidden', 'true')
    document.body.style.overflow = ''
  }

  function initKhqrModal() {
    const overlay = document.getElementById('khqrOverlay')
    if (!overlay) return

    loadSettings()
    isProxyOnline()
    resumePendingTopup()

    document.getElementById('khqrClose')?.addEventListener('click', closeKhqrModal)
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeKhqrModal()
    })

    document.getElementById('khqrCopy')?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(currentPayload)
        global.showKhqrToast?.('KHQR copied')
      } catch {
        global.showKhqrToast?.('Copy failed')
      }
    })

    document.getElementById('khqrCopyMd5')?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(currentMd5)
        global.showKhqrToast?.('MD5 copied')
      } catch {
        global.showKhqrToast?.('Copy failed')
      }
    })

    document.getElementById('khqrCheckNow')?.addEventListener('click', () => {
      saveSettings()
      runPaymentCheck()
    })

    document.getElementById('bakongToken')?.addEventListener('change', saveSettings)
    document.getElementById('bakongProxy')?.addEventListener('change', saveSettings)
    document.getElementById('bakongAccount')?.addEventListener('change', saveSettings)
    document.getElementById('bakongEmail')?.addEventListener('change', saveSettings)

    document.getElementById('bakongToken')?.addEventListener('input', () => {
      if (currentMd5 && !paymentCredited) runPaymentCheck()
    })

    document.getElementById('khqrCreditPaid')?.addEventListener('click', () => {
      confirmPayment()
    })

    document.getElementById('bakongFixToken')?.addEventListener('click', async () => {
      const btn = document.getElementById('bakongFixToken')
      const statusEl = document.getElementById('bakongRenewStatus')
      if (btn) btn.disabled = true
      if (statusEl) statusEl.textContent = 'Getting JWT…'
      try {
        saveSettings()
        await fixBakongToken()
        serverHasJwt = true
        if (statusEl) statusEl.textContent = 'JWT saved — MD5 check enabled'
        document.getElementById('khqrAdvanced')?.classList.add('hidden')
        if (pollTimer) stopPolling()
        startPolling()
        global.showKhqrToast?.('API token fixed')
        if (currentMd5) runPaymentCheck()
      } catch (err) {
        const msg =
          err.message === 'CONFIG_REQUIRED' || err.message === 'NOT_REGISTERED'
            ? 'Could not connect payment check — try again'
            : userFacingMessage(err.message) || 'Could not get token'
        if (statusEl) statusEl.textContent = msg
        if (msg) global.showKhqrToast?.(msg)
      } finally {
        if (btn) btn.disabled = false
      }
    })

    document.getElementById('bakongRenewToken')?.addEventListener('click', async () => {
      const btn = document.getElementById('bakongRenewToken')
      const statusEl = document.getElementById('bakongRenewStatus')
      if (btn) btn.disabled = true
      if (statusEl) statusEl.textContent = 'Requesting token…'
      try {
        saveSettings()
        await renewBakongToken()
        serverHasJwt = true
        if (statusEl) statusEl.textContent = 'New token saved — payment check enabled'
        document.getElementById('khqrAdvanced')?.classList.add('hidden')
        global.showKhqrToast?.('Bakong API token renewed')
        if (currentMd5) {
          setPaymentStatus('pending', 'Checking payment…')
          runPaymentCheck()
          if (!pollTimer) startPolling()
        }
      } catch (err) {
        const msg =
          err.message === 'EMAIL_REQUIRED' || err.message === 'NOT_REGISTERED'
            ? 'Could not connect payment check — try again'
            : err.message === 'PROXY_OFFLINE'
              ? 'Start server: node server.mjs or start.bat'
              : userFacingMessage(err.message) || 'Could not renew token'
        if (statusEl) statusEl.textContent = msg
        if (msg) global.showKhqrToast?.(msg)
      } finally {
        if (btn) btn.disabled = false
      }
    })

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && overlay.classList.contains('open')) closeKhqrModal()
    })
  }

  global.Khqr = {
    buildKhqr,
    verifyKhqr,
    isInvalidAccount,
    isProxyOnline,
    checkServerOnline: isProxyOnline,
    hashMd5,
    checkTransactionByMd5,
    renewBakongToken,
    fixBakongToken,
    tryAutoRenewToken,
    syncEmailToServer,
    confirmPayment,
    applyTopupCredit,
    resumePendingTopup,
    creditWalletAfterPaid,
    parsePaymentStatus,
    openKhqrModal,
    closeKhqrModal,
    initKhqrModal,
    loadSettings,
    saveSettings,
    formatKhr,
    formatUsd,
    KHR_PER_USD,
    MERCHANT,
    PAYMENT_CHECK,
    onPaymentSuccess: null,
  }
})(typeof window !== 'undefined' ? window : global)
