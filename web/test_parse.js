const { PromiseSocket } = require('promise-socket');
async function run() {
    const socket = new PromiseSocket();
    await socket.connect('/home/node/sharkd.sock');
    await socket.write('{"jsonrpc":"2.0","id":1,"method":"load","file":"/captures/GyMSCC4998Failed Test1.pcap"}\n');
    let d = await socket.read(); // read 1 chunk
    console.log("DUMP:");
    console.log(JSON.stringify(d.toString()));
    process.exit(0);
}
run();
