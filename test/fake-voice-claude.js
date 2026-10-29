// Stand-in for the claude CLI answering voice interpretation: the reply is scripted from the transcript.
import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (prompt += d));
process.stdin.on('end', () => {
  if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, JSON.stringify({ args, cwd: process.cwd(), prompt }) + '\n');
  if (prompt.includes('FAIL')) {
    process.stderr.write('simulated crash\n');
    process.exit(1);
  }
  const replies = [
    [/avaa se bugikortti/, { action: 'open_card', id: 'c-2' }],
    [/oikeasti toinen kortti/, { action: 'open_card', id: 'c-does-not-exist' }],
    [/jotain outoa/, { action: 'delete_everything' }],
    [/kirjoita otsikoksi/, { action: 'set_title', text: 'Korjaa kirjautuminen' }],
    [/prioriteetti.*mahtava/, { action: 'set_priority', value: 'ultra' }],
    [/repot/, { action: 'set_repos', names: ['REPO-A', 'not-a-repo', '../evil'] }],
    [/lopeta tehtävä/, { action: 'stop' }],
    [/tee minulle projekti/, { action: 'new_project', name: 'Pörssi Botti', source: 'github', owner: 'bad owner!' }],
    [/arkistoi laskujuttu/, { action: 'move_card', id: 'c-1', status: 'archive' }],
    [/siirrä se jonnekin/, { action: 'move_card', id: 'c-1', status: 'nowhere' }],
    [/avaa se peliprojekti/, { action: 'open_project', name: 'RS3AI' }],
    [/se on peli-ai/, { action: 'describe_project', text: 'Peli-AI RuneScapeen' }],
  ];
  const hit = replies.find(([re]) => re.test(prompt));
  const structured_output = hit ? hit[1] : { action: 'none', say: 'Mitä tarkoitat?' };
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output }) + '\n');
});
