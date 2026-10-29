// Stand-in for the claude CLI in the project planner tests: returns a plan and tasks as structured output.
import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (prompt += d));
process.stdin.on('end', () => {
  const resumeAt = args.indexOf('--resume');
  const session_id = resumeAt >= 0 ? args[resumeAt + 1] : 'plan-session';
  if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, JSON.stringify({ args, cwd: process.cwd(), prompt }) + '\n');

  if (prompt.includes('FAIL')) {
    process.stderr.write('simulated crash\n');
    process.exit(1);
  }

  const out = (e) => process.stdout.write(JSON.stringify({ session_id, ...e }) + '\n');
  const updated = prompt.includes('Feedback on the plan');
  let structured_output = {
    summary: 'Tilausportaali',
    plan: updated ? '# Suunnitelma v2\nPostgreSQL.' : '# Suunnitelma\nSQLite.',
    tasks: [
      { title: 'Runko', brief: 'Build, testit ja README', priority: 'high', ...(prompt.includes('Repositories (read') ? { repos: ['web', 'nonexistent'] } : {}) },
      { title: 'Tilaukset', brief: 'Tilaus-API', priority: 'normal', after: 0 },
      ...(updated ? [] : [{ title: '', brief: 'dropped: no title', priority: 'low' }]),
      { title: 'Raportit', brief: 'Raporttisivu', priority: 'low', after: 1 },
    ],
  };
  const schema = args[args.indexOf('--json-schema') + 1] ?? '';
  if (schema.includes('"contracts"')) structured_output = { contracts: 'web calls the backend orders API' };
  else if (schema.includes('"findings"')) { // the vulnerability audit
    structured_output = {
      summary: 'Two problems',
      findings: [
        { severity: 'low', category: 'config', title: 'Debug flag on', description: 'x' },
        { severity: 'high', category: 'code', repo: 'solo', file: 'app.txt', line: 3, title: 'SQL injection', description: 'query built from input', fix: 'use parameters' },
        { severity: 'high', category: 'code', title: '', description: 'dropped: no title' },
      ],
    };
  } else if (schema.includes('removedAreas')) { // the explorer
    const repo = prompt.match(/^Repository "([^"]+)"/m)?.[1] ?? 'repo';
    const again = prompt.includes('Previous overview');
    structured_output = {
      overview: again ? `Overview v2 of ${repo}` : `Overview v1 of ${repo}`,
      areas: again ? [{ slug: 'api', title: 'API', content: 'API notes v2' }] : [{ slug: 'core', title: 'Core', content: 'Core notes' }, { slug: 'api', title: 'API', content: 'API notes v1' }],
    };
  }
  const finish = () => {
    out({ type: 'system', subtype: 'init' });
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'README.md' } }] } });
    out({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.02, structured_output });
  };
  if (prompt.includes('SLOW')) setTimeout(finish, 500);
  else finish();
});
