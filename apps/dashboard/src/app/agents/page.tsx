import { apiGet, formatDateTime } from '@/lib/api';
import type { AgentRow } from '@/lib/types';
import { ApiFailure, Card, Empty, Status } from '@/components/ui';

export const dynamic = 'force-dynamic';

const SENSITIVE = new Set([
  'modify_mandate', 'delete_audit_event', 'export_all_users', 'generate_compliance_report',
]);

/**
 * Agent registry.
 *
 * The "Know Your Agent" view: who built it, which model, which version, and —
 * the part that matters — exactly which tools it may call.
 *
 * A sensitive tool appearing in any row is an ALARM, so it renders red. On a
 * healthy deployment this screen should contain no red at all, which makes the
 * exception findable without reading a single label.
 */
export default async function AgentsPage() {
  let agents: AgentRow[];
  try {
    agents = (await apiGet<{ agents: AgentRow[] }>('/v1/console/agents')).agents;
  } catch (error) {
    return <ApiFailure error={error} />;
  }

  return (
    <>
      <header className="page-header">
        <h1 className="page-title">Agent registry</h1>
        <p className="page-sub">
          Every registered agent, its build, its credentials and its granted
          tools. An action can always be attributed to a specific agent build.
        </p>
      </header>

      <Card hint={`${agents.length} agents`}>
        {agents.length === 0 ? (
          <Empty title="No agents registered" hint={<>Run <code>npm run seed -w apps/api</code>.</>} />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Status</th><th>Agent</th><th>Vendor / model</th>
                  <th className="num">Keys</th>
                  <th className="num">Decisions</th><th className="num">Blocked</th>
                  <th>Granted tools</th><th className="num">Registered</th>
                </tr>
              </thead>
              <tbody>
                {agents.map((agent) => (
                  <tr key={agent.id}>
                    <td><Status value={agent.status} /></td>
                    <td>
                      <div className="mono nowrap">{agent.id}</div>
                      <div className="faint" style={{ fontSize: 12 }}>
                        {agent.displayName} · v{agent.agentVersion}
                      </div>
                    </td>
                    <td className="faint" style={{ fontSize: 12 }}>
                      {agent.vendor}
                      {agent.modelId !== null && <div className="mono">{agent.modelId}</div>}
                    </td>
                    <td className="num">{agent.activeCredentials}</td>
                    <td className="num">{agent.decisions}</td>
                    <td className="num">
                      {agent.blocks > 0
                        ? <span className="pill pill-block">{agent.blocks}</span>
                        : <span className="faint">0</span>}
                    </td>
                    <td style={{ maxWidth: 340 }}>
                      {agent.tools.length === 0
                        ? <span className="faint">none</span>
                        : (
                          <div className="row" style={{ gap: 4 }}>
                            {agent.tools.map((tool) => (
                              <span
                                key={tool}
                                className={`pill ${SENSITIVE.has(tool) ? 'pill-block' : 'pill-skip'}`}
                              >
                                {tool}
                              </span>
                            ))}
                          </div>
                        )}
                    </td>
                    <td className="num faint nowrap">{formatDateTime(agent.registeredAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="caveat">
        <strong>Sensitive tools are granted to nobody</strong> —{' '}
        <code>modify_mandate</code>, <code>delete_audit_event</code>,{' '}
        <code>export_all_users</code>. They exist in the catalogue so refusal is
        demonstrable: a tool-level authorization demo with nothing dangerous in
        it proves nothing. Any red pill above is an alarm.
        <br /><br />
        <code>execute_payment</code> <em>is</em> granted, and is safe to grant:
        it cannot move money without a voucher, and only the policy engine mints
        vouchers. Granting it makes the agent useful; the voucher makes it safe.
      </div>
    </>
  );
}
