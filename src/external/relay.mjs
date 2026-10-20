// The `trustbench` stdio relay (docs/external/integration-contract.md): the only extension the external agent launches.
// It copies MCP messages byte for byte between the agent's stdio and the adapter's per-episode socket. It holds no
// token, key or configuration, so nothing secret enters the agent's process tree.
import net from "node:net";
const at = process.argv.indexOf("--socket");
const socketPath = at > 0 ? process.argv[at + 1] : null;
if (!socketPath) { process.stderr.write("usage: trustbench --node <node> --socket <path>\n"); process.exit(2); }
const socket = net.createConnection(socketPath);
socket.on("error", (e) => { process.stderr.write(`trustbench relay: ${e.message}\n`); process.exit(1); });
socket.on("close", () => process.exit(0));
process.stdin.pipe(socket);
socket.pipe(process.stdout);
process.stdin.on("end", () => socket.end());
