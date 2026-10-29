// The sandbox's one tool: a stdio MCP server (newline-delimited JSON-RPC, no dependencies) that the sandbox's claude
// process starts. propose_card never creates anything: it only answers NEEDS_CONFIRMATION, the sandbox turns that into
// a popup, and the card is made only when the person presses OK there. So the model cannot make a card on its own.
import { fileURLToPath } from 'node:url';

export const TOOLS = [
  {
    name: 'propose_card',
    description: 'Propose a card (a ticket for a coding agent) for an idea from this conversation that is ready to be built. The person gets a popup with an OK button: OK creates the card in the board\'s Inbox. Write the description so that someone who did not see this conversation understands what to build and why.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title, in Finnish' },
        description: { type: 'string', description: 'What to build and why, in Finnish' },
        attachCanvas: { type: 'boolean', description: 'Attach the drawing the person shared last to the card' },
      },
      required: ['title', 'description'],
      additionalProperties: false,
    },
  },
];

export function callTool(name, args = {}) {
  if (name !== 'propose_card') return { content: [{ type: 'text', text: `Unknown tool ${name}` }], isError: true };
  const title = typeof args?.title === 'string' ? args.title.trim().slice(0, 200) : '';
  if (!title) return { content: [{ type: 'text', text: 'Error: title is required' }], isError: true };
  const proposal = { title, description: typeof args.description === 'string' ? args.description.trim().slice(0, 8000) : '', attachCanvas: args.attachCanvas === true };
  // The first line is data for AgentControl (it shows the person an OK popup); the rest is for the model.
  const text = `NEEDS_CONFIRMATION ${JSON.stringify({ tool: 'propose_card', args: proposal })}\nThe person now gets a popup with an OK button for this card; pressing OK creates it. Do not ask in chat and do not call this again in this reply: just say that the card waits for their OK in the popup. If they later ask for it again, propose it again (the popup is shown only once).`;
  return { content: [{ type: 'text', text }] };
}

/** Answers one JSON-RPC message; null for notifications. */
export function handleMessage(msg) {
  const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
  switch (msg.method) {
    case 'initialize':
      return reply({ protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'agentcontrol-sandbox', version: '1.0.0' } });
    case 'ping': return reply({});
    case 'tools/list': return reply({ tools: TOOLS });
    case 'tools/call': return reply(callTool(msg.params?.name, msg.params?.arguments));
    default:
      if (msg.id === undefined) return null; // a notification such as notifications/initialized
      return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const out = handleMessage(msg);
      if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
    }
  });
  process.stdin.on('end', () => process.exit(0));
}
