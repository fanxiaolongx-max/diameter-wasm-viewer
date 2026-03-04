const { PromiseSocket } = require('promise-socket');
const JSONStream = require('JSONStream');

async function test_jsonstream() {
  const socket = new PromiseSocket();
  await socket.connect('/var/run/sharkd.sock');
  await socket.write('{"jsonrpc":"2.0","id":1,"method":"load","file":"/captures/GyMSCC4998Failed Test1.pcap"}\n');
  await readJSONStream(socket); // load response

  console.time('JSONStream');
  await socket.write('{"jsonrpc":"2.0","id":2,"method":"frames"}\n');
  let res = await readJSONStream(socket);
  console.timeEnd('JSONStream');
  socket.destroy();
}

function readJSONStream(socket) {
  return new Promise((resolve, reject) => {
    const stream = socket.stream;
    const parser = JSONStream.parse();
    const onData = (chunk) => parser.write(chunk);
    stream.on('data', onData);
    parser.on('data', (d) => {
      stream.removeListener('data', onData);
      resolve(d);
    });
  });
}

async function test_native() {
  const socket = new PromiseSocket();
  await socket.connect('/var/run/sharkd.sock');
  await socket.write('{"jsonrpc":"2.0","id":1,"method":"load","file":"/captures/GyMSCC4998Failed Test1.pcap"}\n');
  await readNative(socket);

  console.time('NativeParse');
  await socket.write('{"jsonrpc":"2.0","id":2,"method":"frames"}\n');
  let res = await readNative(socket);
  console.timeEnd('NativeParse');
  socket.destroy();
}

function readNative(socket) {
  return new Promise((resolve) => {
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      if (buf.endsWith('\n')) {
        socket.stream.removeListener('data', onData);
        resolve(JSON.parse(buf));
      }
    };
    socket.stream.on('data', onData);
  });
}

async function run() {
  try {
    await test_jsonstream();
    await test_native();
  } catch (e) { console.error(e) }
}
run();
