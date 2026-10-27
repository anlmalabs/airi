import type { ElectronAcpRuntimeStatus, ElectronAcpSessionStatus } from '../../../../shared/eventa'

import z from 'zod'

import { useElectronEventaInvoke } from '@proj-airi/electron-vueuse'
import { tool } from '@xsai/tool'

import {
  electronAcpCancel,
  electronAcpCreateSession,
  electronAcpGetRuntimeStatus,
  electronAcpListSessions,
  electronAcpPrompt,
} from '../../../../shared/eventa'

// NOTE: invoke handles created lazily inside execute to respect setup timing.
export async function acpTools() {
  const getRuntimeStatus = useElectronEventaInvoke(electronAcpGetRuntimeStatus)
  const createSession = useElectronEventaInvoke(electronAcpCreateSession)
  const prompt = useElectronEventaInvoke(electronAcpPrompt)
  const cancel = useElectronEventaInvoke(electronAcpCancel)
  const listSessions = useElectronEventaInvoke(electronAcpListSessions)

  const tools = [
    tool({
      name: 'acp_list_agents',
      description: 'List ACP agents and their runtime status.',
      execute: async () => {
        const status = await getRuntimeStatus() as ElectronAcpRuntimeStatus
        return status
      },
      parameters: z.object({}).strict(),
    }),
    tool({
      name: 'acp_create_session',
      description: 'Create an ACP session with a named agent.',
      execute: async ({ agentName, cwd }) => {
        const session = await createSession({ agentName, cwd }) as ElectronAcpSessionStatus
        return session
      },
      parameters: z.object({
        agentName: z.string(),
        cwd: z.string().optional(),
      }).strict(),
    }),
    tool({
      name: 'acp_prompt',
      description: 'Send a prompt to an ACP session and await completion.',
      execute: async ({ sessionId, text }) => {
        const result = await prompt({ sessionId, text })
        return result
      },
      parameters: z.object({
        sessionId: z.string(),
        text: z.string(),
      }).strict(),
    }),
    tool({
      name: 'acp_cancel',
      description: 'Cancel the current turn in an ACP session.',
      execute: async ({ sessionId }) => {
        await cancel({ sessionId })
        return { ok: true }
      },
      parameters: z.object({ sessionId: z.string() }).strict(),
    }),
    tool({
      name: 'acp_list_sessions',
      description: 'List active ACP sessions.',
      execute: async () => {
        const sessions = await listSessions() as ElectronAcpSessionStatus[]
        return sessions
      },
      parameters: z.object({}).strict(),
    }),
  ]

  return Promise.all(tools)
}
