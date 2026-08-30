import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAppData } from '../lib/app-context'
import { supabase } from '../lib/supabaseClient'

const REDIRECT_URL = new URL(
  import.meta.env.BASE_URL,
  window.location.origin,
).toString()

function LoginPage() {
  const navigate = useNavigate()
  const { session, canUseCloud, authWarning, dataSource, setDataSource } =
    useAppData()
  const [email, setEmail] = useState('')
  const [status, setStatus] = useState<
    | {
        type: 'success' | 'error'
        message: string
      }
    | null
  >(null)
  const [sending, setSending] = useState(false)
  const [resendSeconds, setResendSeconds] = useState(0)

  const canResend = resendSeconds === 0
  const trimmedEmail = useMemo(() => email.trim(), [email])

  useEffect(() => {
    if (session) {
      navigate('/', { replace: true })
    }
  }, [navigate, session])

  useEffect(() => {
    if (resendSeconds === 0) return
    const timer = window.setInterval(() => {
      setResendSeconds((prev) => Math.max(0, prev - 1))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [resendSeconds])

  const formatAuthError = (message: string) => {
    const lower = message.toLowerCase()
    if (lower.includes('expired')) {
      return '登录链接已过期，请重新获取。'
    }
    if (lower.includes('invalid')) {
      return '登录链接无效，请重新获取。'
    }
    if (lower.includes('too many') || lower.includes('rate')) {
      return '请求过于频繁，请稍后再试。'
    }
    return '操作失败，请稍后再试。'
  }

  const handleSendLink = async () => {
    if (!supabase || !canUseCloud) {
      setStatus({
        type: 'error',
        message: '尚未配置云端服务，请先补充环境变量。',
      })
      return
    }

    if (!trimmedEmail) {
      setStatus({ type: 'error', message: '请输入有效的邮箱地址。' })
      return
    }

    setSending(true)
    setStatus(null)

    try {
      const { error } = await supabase.auth.signInWithOtp({
        email: trimmedEmail,
        options: {
          emailRedirectTo: REDIRECT_URL,
          shouldCreateUser: true,
        },
      })

      if (error) {
        setStatus({
          type: 'error',
          message: formatAuthError(error.message),
        })
        return
      }

      setStatus({
        type: 'success',
        message: '登录邮件已发送，请点击邮件中的链接完成登录。',
      })
      setResendSeconds(60)
    } catch {
      setStatus({ type: 'error', message: '发送失败，请稍后重试。' })
    } finally {
      setSending(false)
    }
  }

  const handleSwitchToLocal = () => {
    setDataSource('local')
    navigate('/', { replace: true })
  }

  return (
    <section className="stack">
      <div>
        <h2>邮箱登录</h2>
        <p className="muted">
          我们将向邮箱发送登录链接，点击邮件中的按钮即可进入。
        </p>
      </div>

      <div className="card stack">
        <label className="field">
          <span>邮箱地址</span>
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="name@example.com"
          />
        </label>
        <button
          className="button primary"
          type="button"
          onClick={handleSendLink}
          disabled={sending || !canUseCloud || !canResend}
        >
          {sending
            ? '发送中...'
            : canResend
              ? '发送登录链接'
              : '重新发送 (' + resendSeconds + 's)'}
        </button>
        {status ? (
          <p className={'notice ' + status.type}>{status.message}</p>
        ) : null}
        {authWarning ? (
          <p className="notice warning">{authWarning}</p>
        ) : null}
      </div>

      {dataSource === 'cloud' ? (
        <button
          className="button ghost"
          type="button"
          onClick={handleSwitchToLocal}
        >
          返回本地模式
        </button>
      ) : null}
    </section>
  )
}

export default LoginPage
