// Optional preload for the host-side prover (prove-roundtrip.ts): pin the
// devnet.toonprotocol.dev hostnames to the live box IP, since public DNS may lag
// behind a box move. Keeps the hostname for HTTP Host / TLS SNI (nginx vhost
// routing on the box needs the right Host) while dialing the correct IP.
//
//   node --require ./dns-pin.js ...      (DEVNET_IP overrides the default)
//
// Not needed once devnet.toonprotocol.dev DNS points at the live box.
const dns = require('dns');
const IP = process.env.DEVNET_IP || '50.116.58.45';
const PINNED = new Set([
  'evm-rpc.devnet.toonprotocol.dev',
  'faucet.devnet.toonprotocol.dev',
  'relay-ws.devnet.toonprotocol.dev',
]);
const origLookup = dns.lookup;
dns.lookup = function (hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  if (PINNED.has(hostname)) {
    const all = options && options.all;
    return process.nextTick(() =>
      callback(null, all ? [{ address: IP, family: 4 }] : IP, all ? undefined : 4)
    );
  }
  return origLookup.call(dns, hostname, options, callback);
};
