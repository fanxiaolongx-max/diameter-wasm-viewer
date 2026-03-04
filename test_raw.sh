#!/bin/bash
time echo '{"jsonrpc":"2.0", "id":2, "method":"frames"}' | nc -U /var/run/sharkd.sock > /dev/null
