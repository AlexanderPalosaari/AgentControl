// Stand-in for the claude CLI: speaks just enough stream-json for the refiner tests.
import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (prompt += d));
process.stdin.on('end', () => {
  const resumeAt = args.indexOf('--resume');
  const resume = resumeAt >= 0 ? args[resumeAt + 1] : null;
  if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, JSON.stringify({ args, cwd: process.cwd(), prompt }) + '\n');

  if (prompt.includes('FAIL')) {
    process.stderr.write('simulated crash\n');
    process.exit(1);
  }

  const session_id = resume ?? 'fake-session';
  const out = (e) => process.stdout.write(JSON.stringify({ session_id, ...e }) + '\n');
  out({ type: 'system', subtype: 'init' });
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'src/app.js' } }] } });
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Reading the code' }] } });

  const answered = prompt.includes('Answers to your questions');
  const structured_output = answered
    ? { summary: 'Add login', questions: [], plan: 'Final plan', ready: true }
    : {
        summary: 'Add login',
        questions: [{ id: 'q1', text: 'Which provider?', options: [{ label: 'A' }, { label: 'B' }], recommended: 'A' }],
        plan: 'Draft plan',
        ready: true, // the refiner must still force ready=false while questions are open
      };
  out({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, structured_output });
});
