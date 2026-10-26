#!/usr/bin/env node
// Issues one calendar API token per department agent listed in a seed file.
// Plaintext tokens go ONLY to the (gitignored) vault file; the SQL file holds SHA-256 hashes; nothing is printed.
// Usage: node scripts/issue-agent-tokens.mjs seeds/wcpr.sql ~/projects/wcpr-inbox-vault/Credentials.local.md /tmp/out.sql
// Then:  npx wrangler d1 execute <db> --remote -c <config> --file /tmp/out.sql
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'

const [seedPath, vaultPath, sqlPath] = process.argv.slice(2)
if (!seedPath || !vaultPath || !sqlPath) { console.error('usage: issue-agent-tokens.mjs <seed.sql> <vault.md> <out.sql>'); process.exit(2) }
const agents = [...readFileSync(seedPath, 'utf8').matchAll(/\('([a-z][a-z0-9-]*)', '[^']*', '([a-z0-9-]+)', '([^']*)'/gu)].map(([, department, agentKey, agentName]) => ({ department, agentKey, agentName }))
if (agents.length === 0) { console.error('no agents found in seed'); process.exit(1) }
const now = new Date().toISOString(); const quote = (value) => `'${value.replaceAll("'", "''")}'`
const sql = []; const vault = [`\n## Calendar agent API tokens (${seedPath.split('/').pop()}, issued ${now})\n`, 'Use as `Authorization: Bearer <token>` against /api/events. Scoped to one department, operator role. Issuing again revokes the previous token.\n', '| Department | Agent key | Token |', '|---|---|---|']
for (const agent of agents) {
  const token = `calagt_${randomBytes(32).toString('base64url')}`; const hash = createHash('sha256').update(token).digest('hex')
  sql.push(`UPDATE calendar_agent_tokens SET revoked_at = ${quote(now)} WHERE department_key = ${quote(agent.department)} AND revoked_at IS NULL;`)
  sql.push(`INSERT INTO calendar_agent_tokens (id, department_key, agent_key, token_hash, role, created_at) VALUES (${quote(randomUUID())}, ${quote(agent.department)}, ${quote(agent.agentKey)}, ${quote(hash)}, 'operator', ${quote(now)});`)
  vault.push(`| ${agent.department} | ${agent.agentKey} | \`${token}\` |`)
}
writeFileSync(sqlPath, `${sql.join('\n')}\n`, { mode: 0o600 }); appendFileSync(vaultPath, `${vault.join('\n')}\n`, { mode: 0o600 })
console.log(`issued ${agents.length} agent tokens; hashes -> ${sqlPath}; plaintext -> vault`)
