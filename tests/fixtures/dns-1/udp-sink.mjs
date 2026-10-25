// DNS-1 fault injection (docs/test-plans/DNS-1.md F-SINK): a UDP "nameserver" that never answers.
// Binds UDP 0.0.0.0:53, logs `ready` once listening and `query <n> <bytes> from <addr>` for every datagram. It never
// calls send(), so a resolver that asks it waits for its full timeout.
import dgram from 'node:dgram';

const socket = dgram.createSocket('udp4');
let count = 0;
socket.on('message', (msg, rinfo) => {
	count++;
	process.stdout.write(`query ${count} ${msg.length} from ${rinfo.address}:${rinfo.port}\n`);
});
socket.on('error', error => {
	console.error(`sink error: ${error.message}`);
	process.exit(1);
});
socket.bind(53, '0.0.0.0', () => process.stdout.write('ready\n'));
