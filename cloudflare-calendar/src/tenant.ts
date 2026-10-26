/// <reference types="@cloudflare/workers-types" />
import type { HubBinding } from './hub'
import type { Locale } from './i18n'

export interface Env {
  CALENDAR_DB: D1Database
  ASSETS: Fetcher
  CRM_SERVICE?: Fetcher
  CALENDAR_ADMIN_PASSWORD: string
  SESSION_SECRET: string
  CALENDAR_SYNC_SECRET?: string
  CRM_WEBHOOK_URL?: string
  // Tenant configuration. Every value defaults to the original MiPolitico behavior.
  BRAND_NAME?: string
  SERVICE_NAME?: string
  CRM_HOST?: string
  LOCALE?: string
  TIMEZONE?: string
  AUTH_MODE?: string
  // Employee mode only.
  AUTH_PROVIDER?: string
  AUTH_DB?: D1Database
  WORKSPACE_ID?: string
  ADMIN_EMAILS?: string
  // Project-hub SSO (employee mode). HUB is a service binding to this project's own hub (entrypoint HubRpc).
  HUB?: HubBinding
  HUB_PROJECT?: string
  HUB_LOGIN_URL?: string
  LOCAL_LOGIN?: string
}

// Webhook destinations are pinned to this allowlist so a config typo can never ship events to another project's CRM.
export const ALLOWED_CRM_HOSTS: ReadonlySet<string> = new Set(['crm.mipolitico.com', 'crm.wcpr.pro', 'mozaico.xyz'])
export type AuthProvider = 'wcpr-employees' | 'mozaico-crm'

export const brandName = (env: Pick<Env, 'BRAND_NAME'>) => env.BRAND_NAME || 'MiPolitico'
export const serviceName = (env: Pick<Env, 'SERVICE_NAME'>) => env.SERVICE_NAME || 'mipolitico-calendar'
export const locale = (env: Pick<Env, 'LOCALE'>): Locale => (env.LOCALE === 'en' ? 'en' : 'es')
export const timezone = (env: Pick<Env, 'TIMEZONE'>) => env.TIMEZONE || 'America/New_York'
export const employeeMode = (env: Pick<Env, 'AUTH_MODE'>) => env.AUTH_MODE === 'employee'
export const isDefaultTenant = (env: Env) => !employeeMode(env) && locale(env) === 'es' && brandName(env) === 'MiPolitico' && timezone(env) === 'America/New_York'
export function crmHost(env: Pick<Env, 'CRM_HOST'>) { const host = env.CRM_HOST || 'crm.mipolitico.com'; if (!ALLOWED_CRM_HOSTS.has(host)) throw new Error('crm_host_not_allowed'); return host }
export function authProvider(env: Pick<Env, 'AUTH_PROVIDER'>): AuthProvider { if (env.AUTH_PROVIDER === 'wcpr-employees' || env.AUTH_PROVIDER === 'mozaico-crm') return env.AUTH_PROVIDER; throw new Error('auth_provider_not_configured') }
export function adminEmails(env: Pick<Env, 'ADMIN_EMAILS'>) { return new Set((env.ADMIN_EMAILS || '').split(',').map((email) => email.trim().toLowerCase()).filter(Boolean)) }
export function employeeWorkspace(env: Pick<Env, 'WORKSPACE_ID'>) { const id = env.WORKSPACE_ID || ''; if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(id)) throw new Error('workspace_not_configured'); return id }
