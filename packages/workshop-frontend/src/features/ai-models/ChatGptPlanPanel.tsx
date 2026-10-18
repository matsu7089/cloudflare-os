import { useEffect, useState } from 'react'
import { Button, Dialog } from '@cloudflare/kumo'
import type { AuthenticatedApi, ChatGptAccount } from '@gadgets/workshop-shared/api'

type ChatGptPlanPanelProps = {
  authenticatedApi: Pick<AuthenticatedApi, 'listChatGptAccounts' | 'beginChatGptConnect' |
    'refreshChatGptModels' | 'disconnectChatGptAccount'>
  canConnect: boolean
  onModelsChanged: () => void
}

const USAGE_URL = 'https://chatgpt.com/settings/usage'

export const ChatGptPlanPanel = ({ authenticatedApi, canConnect, onModelsChanged }: ChatGptPlanPanelProps) => {
  const [accounts, setAccounts] = useState<ChatGptAccount[]>([])
  const [command, setCommand] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [welcome, setWelcome] = useState(false)

  useEffect(() => {
    let current = true
    authenticatedApi.listChatGptAccounts().then(result => {
      if (current) setAccounts(result)
    }).catch(() => {
      if (current) setError('Could not load ChatGPT accounts. Try Check connection.')
    })
    return () => { current = false }
  }, [authenticatedApi])

  const connect = async (accountId?: string) => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const { connectUrl } = await authenticatedApi.beginChatGptConnect(accountId)
      setCommand(`pnpm chatgpt:login --connect '${connectUrl.replaceAll("'", "'\\''")}'`)
    } catch {
      setError('Could not start ChatGPT sign-in. Check the deployment configuration and try again.')
    } finally {
      setBusy(false)
    }
  }

  const checkConnection = async () => {
    setBusy(true)
    setError(null)
    try {
      const next = await authenticatedApi.listChatGptAccounts()
      const connected = next.find(account => !accounts.some(previous =>
        previous.id === account.id && previous.connectedAt === account.connectedAt))
      if (command && connected) {
        if (connected.planEnabled && accounts.length === 0) setWelcome(true)
        else setNotice(connected.planEnabled ? 'ChatGPT reconnected.' :
          'Signed in. Reconnect and approve ChatGPT plan access to use AI.')
        setCommand(null)
      }
      setAccounts(next)
      onModelsChanged()
    } catch {
      setError('Could not check the ChatGPT connection. Try again.')
    } finally {
      setBusy(false)
    }
  }

  const refreshModels = async (accountId: string) => {
    setBusy(true)
    setError(null)
    try {
      await authenticatedApi.refreshChatGptModels(accountId)
      setAccounts(await authenticatedApi.listChatGptAccounts())
      onModelsChanged()
    } catch {
      setError('Could not refresh ChatGPT models. Reconnect if your session expired or access was revoked.')
    } finally {
      setBusy(false)
    }
  }

  const disconnect = async (accountId: string) => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const { revoked } = await authenticatedApi.disconnectChatGptAccount(accountId)
      setAccounts(await authenticatedApi.listChatGptAccounts())
      setCommand(null)
      onModelsChanged()
      if (!revoked) setNotice('Disconnected here. Remote revocation was not confirmed; remove the app in ChatGPT Settings.')
    } catch {
      setError('Could not disconnect ChatGPT. Check connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-label="ChatGPT plan" className="mx-3 mb-4 rounded-xl border border-kumo-line bg-kumo-base p-4">
      <h2 className="text-sm font-medium text-kumo-default">Use your ChatGPT plan</h2>
      <p className="mt-1 text-sm text-kumo-subtle">
        Eligible AI requests use your ChatGPT plan or credits balance. Usage limits are shared with other apps.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {canConnect && <Button disabled={busy} onClick={() => connect()}>Continue with ChatGPT</Button>}
        <Button variant="secondary" disabled={busy} onClick={checkConnection}>Check connection</Button>
        <a href={USAGE_URL} target="_blank" rel="noreferrer" className="text-sm text-kumo-link underline">Manage usage</a>
      </div>
      {!canConnect && <p className="mt-2 text-sm text-kumo-subtle">Your administrator has disabled personal AI providers.</p>}
      {command && <div className="mt-3 space-y-2">
        <p className="text-sm text-kumo-subtle">
          In a local checkout of cloudflare-os, run this command on the computer with your browser (Node.js 24+).
          Complete sign-in, then select Check connection. This command expires after ten minutes; keep it private.
        </p>
        <pre className="overflow-x-auto rounded-lg bg-kumo-tint p-3 text-xs text-kumo-default"><code>{command}</code></pre>
        <Button variant="secondary" onClick={async () => {
          try { await navigator.clipboard.writeText(command); setNotice('Command copied.') }
          catch { setError('Could not copy. Select and copy the command above.') }
        }}>Copy sign-in command</Button>
      </div>}
      {error && <p role="alert" className="mt-3 text-sm text-kumo-danger">{error}</p>}
      {notice && <p role="status" className="mt-3 text-sm text-kumo-subtle">{notice}</p>}
      {accounts.length > 0 && <ul className="mt-3 space-y-3">
        {accounts.map(account => <li key={account.id} className="border-t border-kumo-line pt-3">
          <p className="text-sm font-medium text-kumo-default">{account.label}</p>
          <p className="text-xs text-kumo-subtle">Registration {account.id}</p>
          <p className="mt-1 text-sm text-kumo-subtle">{account.needsReauthentication
            ? 'Session expired. Reconnect to continue.'
            : !account.planEnabled ? 'Signed in. ChatGPT plan permission is required to use AI.'
              : `Using ChatGPT plan · ${account.models.length} available models`}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {canConnect && <>
              <Button variant="secondary" disabled={busy} onClick={() => connect(account.id)}>Reconnect</Button>
              {account.planEnabled && <Button variant="secondary" disabled={busy}
                onClick={() => refreshModels(account.id)}>Refresh models</Button>}
            </>}
            <Button variant="secondary" disabled={busy} onClick={() => disconnect(account.id)}>Disconnect</Button>
          </div>
        </li>)}
      </ul>}
      <Dialog.Root open={welcome} onOpenChange={setWelcome}>
        <Dialog className="max-w-md p-6">
          <Dialog.Title>You're using your ChatGPT plan</Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-kumo-subtle">
            Eligible AI requests in Cloudflare OS use your ChatGPT plan. Manage usage in your ChatGPT settings.
          </Dialog.Description>
          <Button className="mt-4" onClick={() => setWelcome(false)}>Got it</Button>
        </Dialog>
      </Dialog.Root>
    </section>
  )
}
