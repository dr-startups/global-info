#!/bin/sh
set -e
getent hosts dp-postgres || true
node - <<'NODE'
const net = require("net");
const s = net.connect(5432, "dp-postgres", () => {
  console.log("tcp_ok");
  s.end();
  process.exit(0);
});
s.on("error", (e) => {
  console.log("tcp_err", e.message);
  process.exit(1);
});
setTimeout(() => {
  console.log("tcp_timeout");
  process.exit(1);
}, 3000);
NODE
