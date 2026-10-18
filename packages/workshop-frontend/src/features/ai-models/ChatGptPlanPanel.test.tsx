// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuthenticatedApi, ChatGptAccount } from '@gadgets/workshop-shared/api'
import { ChatGptPlanPanel } from './ChatGptPlanPanel'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ACCOUNT: ChatGptAccount = {
  id: 'account-1', label: 'user@example.test', planEnabled: true, needsReauthentication: false,
  connectedAt: 1, models: [{ id: 'gpt-test', name: 'GPT Test' }],
}

let root: Root | null = null
let container: HTMLDivElement | null = null
afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
})

const fixture = async (accounts: ChatGptAccount[] = [], canConnect = true) => {
  const methods = {
    listChatGptAccounts: vi.fn<AuthenticatedApi['listChatGptAccounts']>().mockResolvedValue(accounts),
    beginChatGptConnect: vi.fn<AuthenticatedApi['beginChatGptConnect']>().mockResolvedValue({
      connectUrl: `https://os.example/api/chatgpt/connect#user=${'a'.repeat(64)}&ticket=${'b'.repeat(64)}`,
    }),
    refreshChatGptModels: vi.fn<AuthenticatedApi['refreshChatGptModels']>().mockResolvedValue(undefined),
    disconnectChatGptAccount: vi.fn<AuthenticatedApi['disconnectChatGptAccount']>().mockResolvedValue({ revoked: true }),
  }
  const changed = vi.fn<() => void>()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root!.render(<ChatGptPlanPanel
    authenticatedApi={methods} canConnect={canConnect} onModelsChanged={changed} />))
  return { methods, changed }
}

const click = async (label: string, parent: ParentNode = document.body) => {
  const button = Array.from(parent.querySelectorAll('button')).find(element => element.textContent === label)
  if (!button) throw new Error(`Missing ${label} button`)
  await act(async () => button.click())
}

describe('ChatGptPlanPanel', () => {
  it('starts local sign-in and confirms ChatGPT plan use when connection completes', async () => {
    const { methods, changed } = await fixture()
    await click('Continue with ChatGPT')
    expect(methods.beginChatGptConnect).toHaveBeenCalledWith(undefined)
    expect(document.querySelector('code')!.textContent).toContain('pnpm chatgpt:login --connect')
    methods.listChatGptAccounts.mockResolvedValue([ACCOUNT])
    await click('Check connection')
    expect(document.querySelector('code')).toBeNull()
    expect(document.body.textContent).toContain("You're using your ChatGPT plan")
    expect(changed).toHaveBeenCalledOnce()
  })

  it('keeps same-email registrations distinct and reconnects the selected registration', async () => {
    const { methods } = await fixture([ACCOUNT, { ...ACCOUNT, id: 'account-2' }])
    const second = document.querySelectorAll('li')[1]
    await click('Reconnect', second)
    expect(methods.beginChatGptConnect).toHaveBeenCalledWith('account-2')
    expect(document.body.textContent).toContain('Registration account-1')
    expect(document.body.textContent).toContain('Registration account-2')
  })

  it('explains missing permission and respects disabled personal models', async () => {
    await fixture([{ ...ACCOUNT, planEnabled: false, models: [] }], false)
    expect(document.body.textContent).toContain('ChatGPT plan permission is required')
    expect(document.body.textContent).toContain('administrator has disabled personal AI providers')
    expect(document.body.textContent).not.toContain('Continue with ChatGPT')
    expect(document.body.textContent).not.toContain('Refresh models')
  })

  it('reports unconfirmed remote revocation after disconnecting locally', async () => {
    const { methods, changed } = await fixture([ACCOUNT])
    methods.disconnectChatGptAccount.mockResolvedValue({ revoked: false })
    methods.listChatGptAccounts.mockResolvedValue([])
    await click('Disconnect')
    expect(methods.disconnectChatGptAccount).toHaveBeenCalledWith('account-1')
    expect(document.querySelector('[role="status"]')!.textContent).toContain('Remote revocation was not confirmed')
    expect(document.body.textContent).not.toContain(ACCOUNT.label)
    expect(changed).toHaveBeenCalledOnce()
  })
})
