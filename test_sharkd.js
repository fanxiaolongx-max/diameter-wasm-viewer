const {PromiseSocket} = require('promise-socket');

async function test() {
  let s = new PromiseSocket();
  await s.connect('/var/run/sharkd.sock');
  
  console.time('load');
  await s.write('{"jsonrpc":"2.0","id":1,"method":"load","file":"/captures/GyMSCC4998Failed Test1.pcap"}\\n');
  let res = await s.readAll();
  console.log(res.length)
  console.timeEnd('load');

  console.time('frames');
  await s.write('{"jsonrpc":"2.0","id":2,"method":"frames"}\\n');
  res = await s.readAll();
  console.log(res.length)
  console.timeEnd('frames');
  process.exit(0);
}
test();
