// Stand-in for the claude CLI in a project's sandbox: logs how it was started, can propose a card, and answers.
import { appendFileSync, readFileSync } from 'node:fs';
import { callTool } from '../lib/sandbox-mcp.js';

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
  const session_id = resumeAt >= 0 ? args[resumeAt + 1] : `sb-${Date.now()}`;
  const out = (e) => process.stdout.write(JSON.stringify({ session_id, ...e }) + '\n');
  if (prompt.includes('PROPOSE')) {
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__sandbox__propose_card', input: {} }] } });
    const r = callTool('propose_card', { title: 'Piirrosidea', description: 'Tehdään se', attachCanvas: true });
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: r.content }] } });
  }
  const drawing = prompt.match(/shared their canvas drawing: (.+?)\. Look/);
  const reply = drawing ? `Näen piirroksen (${readFileSync(drawing[1]).length} tavua)` : `Selvä: ${prompt.split('\n').at(-1)}`;
  out({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, result: reply });
});
