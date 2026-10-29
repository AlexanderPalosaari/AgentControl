// Stand-in for `claude --bg`, `claude agents --json --all` and `claude stop`.
// Jobs live in $FAKE_STATE/jobs.json; tests flip their status/state directly.
import { randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.env.FAKE_STATE;
const jobsFile = join(dir, 'jobs.json');
const args = process.argv.slice(2);
appendFileSync(join(dir, 'calls.log'), JSON.stringify({ args, cwd: process.cwd() }) + '\n');

const jobs = existsSync(jobsFile) ? JSON.parse(readFileSync(jobsFile, 'utf8')) : [];
const save = () => writeFileSync(jobsFile, JSON.stringify(jobs));
const newJob = (extra) => {
  const job = { pid: 1, id: randomBytes(4).toString('hex'), cwd: process.cwd(), kind: 'background', startedAt: Date.now(), sessionId: randomUUID(), status: 'busy', state: 'working', ...extra };
  jobs.push(job);
  return job;
};

if (args[0] === 'agents') {
  const decoy = { pid: 2, cwd: 'C:\\somewhere', kind: 'interactive', sessionId: randomUUID(), name: 'my own session', status: 'busy' };
  console.log(JSON.stringify([decoy, ...jobs]));
} else if (args[0] === 'stop') {
  const job = jobs.find((j) => j.id === args[1]);
  if (!job) { console.error('no such job'); process.exit(1); }
  delete job.status;
  job.state = 'done';
  save();
  console.log(`stopped ${job.id}`);
} else if (args[0] === '--bg' && args.includes('--resume')) {
  const sid = args[args.indexOf('--resume') + 1];
  const job = jobs.find((j) => j.sessionId === sid);
  if (!job) { console.error('no such session'); process.exit(1); }
  const hasFlags = args.some((a) => a.startsWith('--') && a !== '--bg' && a !== '--resume');
  if (hasFlags || job.status) {
    const copy = newJob({ copyOf: job.id });
    save();
    console.log(`note: started a copy as ${copy.id}\nbackgrounded · ${copy.id}`);
  } else {
    job.status = 'busy';
    job.state = 'working';
    job.wakes = (job.wakes ?? 0) + 1;
    save();
    console.log(`note: woke session ${job.id} with its saved options\nbackgrounded · ${job.id} · fake`);
  }
} else if (args[0] === '--bg') {
  const job = newJob({ prompt: args[1] });
  save();
  console.log(`Starting background service…\nbackgrounded · ${job.id}\n  claude agents   list sessions`);
} else {
  console.error(`fake claude: unsupported ${args.join(' ')}`);
  process.exit(2);
}
