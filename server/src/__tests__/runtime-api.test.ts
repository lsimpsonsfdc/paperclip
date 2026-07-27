import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildRuntimeApiCandidateUrls,
  choosePrimaryRuntimeApiUrl,
  collectReachableInterfaceHosts,
  probeRuntimeApiReachability,
} from "../runtime-api.js";

describe("runtime API discovery", () => {
  // Regression coverage for SSO-17693: PAPERCLIP_RUNTIME_API_URL must always
  // be an in-process-reachable origin, never the public auth base URL agents
  // cannot (or should not) send their bearer run token to.
  it("prefers loopback over the public auth base URL on a wildcard bind host", () => {
    expect(
      choosePrimaryRuntimeApiUrl({
        allowedHostnames: ["198.51.100.10"],
        bindHost: "0.0.0.0",
        port: 3102,
      }),
    ).toBe("http://127.0.0.1:3102");
  });

  it("prefers loopback over a public base URL sitting behind an auth proxy", () => {
    // The public base URL is honoured for the browser-facing candidate list
    // (buildRuntimeApiCandidateUrls), but it must never be the primary value
    // agents receive — verified in production this yields a 302 to the auth
    // gateway rather than a JSON API response.
    expect(
      choosePrimaryRuntimeApiUrl({
        allowedHostnames: [],
        bindHost: "0.0.0.0",
        port: 3100,
      }),
    ).toBe("http://127.0.0.1:3100");
  });

  it("prefers an unset bind host toward loopback as well", () => {
    expect(
      choosePrimaryRuntimeApiUrl({
        allowedHostnames: [],
        bindHost: "",
        port: 3100,
      }),
    ).toBe("http://127.0.0.1:3100");
  });

  it("lets an explicit operator-set PAPERCLIP_API_URL win over everything else", () => {
    expect(
      choosePrimaryRuntimeApiUrl({
        explicitApiUrl: "https://agent-entry.example.test/base/path",
        allowedHostnames: ["198.51.100.10"],
        bindHost: "0.0.0.0",
        port: 3102,
      }),
    ).toBe("https://agent-entry.example.test");
  });

  it("prefers the loopback bind host over allowed hostnames for the primary runtime URL", () => {
    expect(
      choosePrimaryRuntimeApiUrl({
        allowedHostnames: ["192.168.1.50"],
        bindHost: "127.0.0.1",
        port: 3100,
      }),
    ).toBe("http://127.0.0.1:3100");
  });

  it("prefers an allowed hostname over the raw bind host when bound to one specific non-loopback interface", () => {
    expect(
      choosePrimaryRuntimeApiUrl({
        allowedHostnames: ["192.168.1.50"],
        bindHost: "192.168.1.5",
        port: 3100,
      }),
    ).toBe("http://192.168.1.50:3100");
  });

  it("falls back to the raw bind host when bound to one specific interface with no allowed hostnames", () => {
    expect(
      choosePrimaryRuntimeApiUrl({
        allowedHostnames: [],
        bindHost: "192.168.1.5",
        port: 3100,
      }),
    ).toBe("http://192.168.1.5:3100");
  });

  it("builds ordered callback candidates from explicit, allowed, bind, and interface hosts", () => {
    expect(
      buildRuntimeApiCandidateUrls({
        authPublicBaseUrl: null,
        allowedHostnames: ["198.51.100.10", "runtime-host.example.test", "203.0.113.42"],
        bindHost: "0.0.0.0",
        port: 3102,
        networkInterfacesMap: {
          en0: [
            {
              address: "203.0.113.42",
              family: "IPv4",
              internal: false,
              netmask: "255.255.255.0",
              cidr: "203.0.113.42/24",
              mac: "00:00:00:00:00:00",
            },
            {
              address: "fe80::1",
              family: "IPv6",
              internal: false,
              netmask: "ffff:ffff:ffff:ffff::",
              cidr: "fe80::1/64",
              mac: "00:00:00:00:00:00",
              scopeid: 1,
            },
          ],
          lo0: [
            {
              address: "127.0.0.1",
              family: "IPv4",
              internal: true,
              netmask: "255.0.0.0",
              cidr: "127.0.0.1/8",
              mac: "00:00:00:00:00:00",
            },
          ],
        },
      }),
    ).toEqual([
      "http://198.51.100.10:3102",
      "http://runtime-host.example.test:3102",
      "http://203.0.113.42:3102",
    ]);
  });

  it("tries the preferred API URL before derived callback candidates", () => {
    expect(
      buildRuntimeApiCandidateUrls({
        preferredApiUrl: "https://agent-entry.example.test/base/path",
        authPublicBaseUrl: "https://paperclip.example.test/app",
        allowedHostnames: ["198.51.100.10"],
        bindHost: "0.0.0.0",
        port: 3102,
        networkInterfacesMap: {},
      }),
    ).toEqual([
      "https://agent-entry.example.test",
      "https://paperclip.example.test",
      "https://198.51.100.10:3102",
    ]);
  });

  it("adds host.docker.internal when the explicit base URL is loopback", () => {
    expect(
      buildRuntimeApiCandidateUrls({
        authPublicBaseUrl: "http://127.0.0.1:3102",
        allowedHostnames: [],
        bindHost: "127.0.0.1",
        port: 3102,
        networkInterfacesMap: {},
      }),
    ).toEqual([
      "http://127.0.0.1:3102",
      "http://host.docker.internal:3102",
    ]);
  });

  it("prefers usable interface hosts and skips link-local addresses", () => {
    expect(
      collectReachableInterfaceHosts({
        networkInterfacesMap: {
          en0: [
            {
              address: "fe80::1",
              family: "IPv6",
              internal: false,
              netmask: "ffff:ffff:ffff:ffff::",
              cidr: "fe80::1/64",
              mac: "00:00:00:00:00:00",
              scopeid: 1,
            },
            {
              address: "192.168.6.178",
              family: "IPv4",
              internal: false,
              netmask: "255.255.252.0",
              cidr: "192.168.6.178/22",
              mac: "00:00:00:00:00:00",
            },
            {
              address: "fd7a:115c:a1e0::8a3a:a11d",
              family: "IPv6",
              internal: false,
              netmask: "ffff:ffff:ffff::",
              cidr: "fd7a:115c:a1e0::8a3a:a11d/48",
              mac: "00:00:00:00:00:00",
              scopeid: 0,
            },
          ],
          en1: [
            {
              address: "169.254.10.20",
              family: "IPv4",
              internal: false,
              netmask: "255.255.0.0",
              cidr: "169.254.10.20/16",
              mac: "00:00:00:00:00:00",
            },
          ],
        },
      }),
    ).toEqual([
      "192.168.6.178",
      "fd7a:115c:a1e0::8a3a:a11d",
    ]);
  });
});

describe("probeRuntimeApiReachability", () => {
  let server: http.Server | null = null;

  afterEach(async () => {
    if (!server) return;
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
  });

  it("resolves true when the origin answers", async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as AddressInfo).port;

    await expect(probeRuntimeApiReachability(`http://127.0.0.1:${port}`)).resolves.toBe(true);
  });

  it("resolves false when nothing is listening on the origin", async () => {
    // Bind a server, note the port, then close it so the port is refused.
    const closed = http.createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", () => resolve()));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));

    await expect(probeRuntimeApiReachability(`http://127.0.0.1:${port}`)).resolves.toBe(false);
  });

  it("resolves false for a malformed origin", async () => {
    await expect(probeRuntimeApiReachability("not-a-url")).resolves.toBe(false);
  });
});
