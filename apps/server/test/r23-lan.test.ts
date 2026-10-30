import assert from "node:assert/strict";
import type { networkInterfaces } from "node:os";
import { test } from "node:test";
import { bootBanner, lanAddresses, selectLanAddress } from "../src/server.ts";

const entry = (address: string, internal = false): NonNullable<ReturnType<typeof networkInterfaces>[string]>[number] => ({
  address, internal, family: "IPv4", cidr: `${address}/24`, netmask: "255.255.255.0", mac: "02:00:00:00:00:01",
});

test("R23: print every usable LAN URL, private ranges first, never link-local or loopback", (t) => {
  const interfaces: ReturnType<typeof networkInterfaces> = {
    link: [entry("169.254.1.1")],
    wifi: [entry("192.168.1.5"), entry("192.168.1.5")],
    hotspot: [entry("10.0.0.7")],
    bridge: [entry("172.31.9.8"), entry("172.16.0.2")],
    outside: [entry("172.15.0.1"), entry("172.32.0.1")],
    loop: [entry("127.0.0.2"), entry("10.0.0.8", true)],
    ipv6: [{ ...entry("fe80::1"), family: "IPv6", scopeid: 0 }],
    other: [entry("8.8.8.8")],
  };
  const expected = ["192.168.1.5", "10.0.0.7", "172.16.0.2", "172.31.9.8", "8.8.8.8", "172.15.0.1", "172.32.0.1"];
  assert.deepEqual(lanAddresses(interfaces), expected);
  assert.equal(selectLanAddress(interfaces), expected[0], "QR selection agrees with the printed preference order");
  const output: string[] = [];
  t.mock.method(console, "log", (...args: unknown[]) => { output.push(args.join(" ")); });
  t.mock.method(console, "warn", (...args: unknown[]) => { output.push(args.join(" ")); });
  bootBanner(3001, "0.0.0.0", interfaces);
  const urls = output.flatMap((line) => line.match(/^LAN:\s+(http:\/\/\S+)$/)?.slice(1) ?? []);
  assert.deepEqual(urls, expected.map((address) => `http://${address}:3001`));
  assert.ok(!output.join("\n").includes("169.254."));
  assert.ok(!output.join("\n").includes("127.0.0.2"));
});

test("R23: the requested three-interface example prints both usable addresses in order", (t) => {
  const interfaces: ReturnType<typeof networkInterfaces> = {
    link: [entry("169.254.1.1")], wifi: [entry("192.168.1.5")], hotspot: [entry("10.0.0.7")],
  };
  assert.deepEqual(lanAddresses(interfaces), ["192.168.1.5", "10.0.0.7"]);
  const output: string[] = [];
  t.mock.method(console, "log", (...args: unknown[]) => { output.push(args.join(" ")); });
  bootBanner(3001, "0.0.0.0", interfaces);
  assert.deepEqual(output.filter((line) => line.startsWith("LAN:")), [
    "LAN:   http://192.168.1.5:3001", "LAN:   http://10.0.0.7:3001",
  ]);
});
