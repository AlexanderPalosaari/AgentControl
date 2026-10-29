// Stand-in for the claude CLI as the orchestrator: logs how it was started and answers with a tool use and a reply.
import { appendFileSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (prompt += d));
process.stdin.on('end', () => {
  const at = args.indexOf('--mcp-config');
  const mcp = at >= 0 ? JSON.parse(readFileSync(args[at + 1], 'utf8')) : null;
  if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, JSON.stringify({ args, cwd: process.cwd(), prompt, mcp }) + '\n');
  const resumeAt = args.indexOf('--resume');
  if (resumeAt >= 0 && args[resumeAt + 1] === 'gone-session') { // what the real CLI does: exit 0 with an error result
    const msg = 'No conversation found with session ID: gone-session';
    process.stderr.write(`${msg}\n`);
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 0, session_id: 'gone-session', total_cost_usd: 0, errors: [msg] }) + '\n');
    return;
  }
  if (prompt.includes('CRASH')) { process.stderr.write('simulated crash\n'); process.exit(1); }
  const session_id = resumeAt >= 0 ? args[resumeAt + 1] : `orch-${Date.now()}`;
  const out = (e) => process.stdout.write(JSON.stringify({ session_id, ...e }) + '\n');
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__board__board_overview', input: {} }] } });
  if (prompt.includes('BROKEN')) return out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'model overloaded' });
  if (prompt.includes('CONFIRM')) {
    const data = { tool: 'start_refinement', args: { id: 'c-b' }, confirm: true, blockedBy: { id: 'c-a', title: 'A', status: 'inbox' }, afterKind: 'done' };
    const result = [{ type: 'text', text: `NEEDS_CONFIRMATION ${JSON.stringify(data)}\nwaits for OK` }];
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: result }] } });
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: result }] } }); // asked twice: one popup
  }
  out({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.05, result: `Selvä: ${prompt.split('\n').at(-1)}` });
});
