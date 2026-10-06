#!/bin/sh
set -eu

# Run before RootlessKit enters its network namespace. Its port driver preserves
# the client's source IP, so a nested bridge must not claim an outer client IP.
routes=$(ip -4 route show scope link)
pool=$(printf '%s\n' "$routes" | awk '
function invalid() { failed = 1; exit 1 }
function range(cidr, values, octets, count, address, size, i) {
  count = split(cidr, values, "/")
  if (count != 2 || values[2] !~ /^[0-9]+$/ || values[2] > 32) invalid()
  if (split(values[1], octets, ".") != 4) invalid()
  address = 0
  for (i = 1; i <= 4; i++) {
    if (octets[i] !~ /^[0-9]+$/ || octets[i] > 255) invalid()
    address = address * 256 + octets[i]
  }
  size = 2 ^ (32 - values[2])
  first = int(address / size) * size
  last = first + size - 1
}
BEGIN {
  pools[1] = "10.240.0.0/16"
  pools[2] = "172.30.0.0/16"
  pools[3] = "192.168.0.0/16"
}
NF {
  route = $1 == "default" ? "0.0.0.0/0" : $1
  if (route !~ /\//) route = route "/32"
  range(route)
  start = first
  end = last
  for (candidate = 1; candidate <= 3; candidate++) {
    range(pools[candidate])
    if (first <= end && start <= last) blocked[candidate] = 1
  }
}
END {
  if (failed) exit 1
  for (candidate = 1; candidate <= 3; candidate++) {
    if (!blocked[candidate]) { print pools[candidate]; exit }
  }
  exit 1
}') || {
  echo 'No non-overlapping private Docker address pool is available.' >&2
  exit 1
}
bridge="${pool%0.0/16}0.1/24"
exec dockerd-entrypoint.sh "$@" \
  "--bip=$bridge" "--default-address-pool=base=$pool,size=24"
