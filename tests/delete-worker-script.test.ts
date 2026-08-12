import { describe, expect, it, vi } from "vitest";

// @ts-expect-error The JavaScript CLI has no separate declaration file.
import * as deleteWorkerModule from "../scripts/delete-worker-script.mjs";

const { deleteWorkerScript } = deleteWorkerModule;

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const TOKEN = "synthetic-cloudflare-token";
const GATEWAY = "edgemneme-memory-gateway";
const GITHUB_SYNC = "edgemneme-github-sync";
const environment = {
  CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
  CLOUDFLARE_API_TOKEN: TOKEN
};

type RecordedRequest = {
  url: URL;
  init: RequestInit | undefined;
};

function recordingFetch(
  responses: Array<Response | Error>,
  requests: RecordedRequest[]
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: new URL(String(input)), init });
    const response = responses.shift();
    if (response === undefined) {
      throw new Error("Unexpected request.");
    }
    if (response instanceof Error) {
      throw response;
    }
    return response;
  }) as typeof fetch;
}

function expectSecureCloudflareRequest(
  request: RecordedRequest,
  method: "DELETE" | "GET"
) {
  expect(request.url.origin).toBe("https://api.cloudflare.com");
  expect(request.init?.method).toBe(method);
  expect(request.init?.redirect).toBe("manual");
  expect(request.init?.signal).toBeInstanceOf(AbortSignal);
  const headers = new Headers(request.init?.headers);
  expect(headers.get("accept")).toBe("application/json");
  expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
}

describe("Cloudflare Worker script deletion", () => {
  it.each([GATEWAY, GITHUB_SYNC])(
    "sends an exact guarded deletion for the allowlisted Worker %s",
    async (workerName) => {
      const requests: RecordedRequest[] = [];
      const fetchImpl = recordingFetch([new Response(null, { status: 204 })], requests);

      await expect(deleteWorkerScript(workerName, environment, fetchImpl)).resolves.toEqual({
        workerName,
        state: "absent"
      });

      expect(requests).toHaveLength(1);
      const request = requests[0];
      expect(request).toBeDefined();
      if (request === undefined) return;
      expectSecureCloudflareRequest(request, "DELETE");
      expect(request.url.pathname).toBe(
        `/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/${workerName}`
      );
      expect(request.url.search).toBe("");
    }
  );

  it("accepts a successful Cloudflare envelope without a follow-up probe", async () => {
    const requests: RecordedRequest[] = [];
    const fetchImpl = recordingFetch([
      Response.json({ success: true, result: null })
    ], requests);

    await expect(deleteWorkerScript(GATEWAY, environment, fetchImpl)).resolves.toMatchObject({
      state: "absent"
    });
    expect(requests).toHaveLength(1);
  });

  it("accepts an immediate 404 as an already absent Worker", async () => {
    const requests: RecordedRequest[] = [];
    const fetchImpl = recordingFetch([new Response(null, { status: 404 })], requests);

    await expect(deleteWorkerScript(GATEWAY, environment, fetchImpl)).resolves.toMatchObject({
      state: "absent"
    });
    expect(requests).toHaveLength(1);
  });

  it("verifies exact deployment absence after the deletion response is lost", async () => {
    const requests: RecordedRequest[] = [];
    const fetchImpl = recordingFetch([
      new TypeError("connection closed"),
      new Response(null, { status: 404 })
    ], requests);

    await expect(deleteWorkerScript(GATEWAY, environment, fetchImpl)).resolves.toMatchObject({
      state: "absent"
    });
    expect(requests).toHaveLength(2);
    const deleteRequest = requests[0];
    const probeRequest = requests[1];
    expect(deleteRequest).toBeDefined();
    expect(probeRequest).toBeDefined();
    if (deleteRequest === undefined || probeRequest === undefined) return;
    expectSecureCloudflareRequest(deleteRequest, "DELETE");
    expectSecureCloudflareRequest(probeRequest, "GET");
    expect(probeRequest.url.pathname).toBe(
      `/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/${GATEWAY}/deployments`
    );
    expect(probeRequest.url.search).toBe("");
  });

  it("verifies exact deployment absence after an invalid successful response", async () => {
    const requests: RecordedRequest[] = [];
    const fetchImpl = recordingFetch([
      new Response("not-json", { status: 200 }),
      new Response(null, { status: 404 })
    ], requests);

    await expect(deleteWorkerScript(GATEWAY, environment, fetchImpl)).resolves.toMatchObject({
      state: "absent"
    });
    expect(requests).toHaveLength(2);
  });

  it("fails closed when deletion is forbidden and deployments still exist", async () => {
    const requests: RecordedRequest[] = [];
    const fetchImpl = recordingFetch([
      Response.json({ success: false, errors: [{ code: 10_000 }] }, { status: 403 }),
      Response.json({
        success: true,
        result: { deployments: [{ id: "deployment-one" }] }
      })
    ], requests);

    await expect(deleteWorkerScript(GATEWAY, environment, fetchImpl)).rejects.toThrow(
      /deletion could not be confirmed/iu
    );
    expect(requests).toHaveLength(2);
    expect(requests[1]?.url.pathname).toMatch(/\/deployments$/u);
  });

  it("does not follow redirects and fails closed while the Worker still exists", async () => {
    const requests: RecordedRequest[] = [];
    const fetchImpl = recordingFetch([
      new Response(null, {
        status: 302,
        headers: { Location: "https://example.invalid/untrusted" }
      }),
      Response.json({ success: true, result: { deployments: [] } })
    ], requests);

    await expect(deleteWorkerScript(GITHUB_SYNC, environment, fetchImpl)).rejects.toThrow(
      /deletion could not be confirmed/iu
    );
    expect(requests).toHaveLength(2);
    expect(requests.every(({ url }) => url.origin === "https://api.cloudflare.com")).toBe(true);
    expect(requests[0]?.init?.redirect).toBe("manual");
  });

  it.each([
    "edgemneme-memory-orchestrator",
    "edgemneme-memory-gateway ",
    "../edgemneme-memory-gateway",
    ""
  ])("rejects the non-allowlisted Worker name %j before any request", async (workerName) => {
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(deleteWorkerScript(workerName, environment, fetchImpl)).rejects.toThrow(
      /must be exactly/iu
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("requires both Cloudflare credentials without including their values in errors", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      deleteWorkerScript(GATEWAY, { CLOUDFLARE_API_TOKEN: TOKEN }, fetchImpl)
    ).rejects.toThrow("Required deployment input CLOUDFLARE_ACCOUNT_ID is missing.");
    await expect(
      deleteWorkerScript(GATEWAY, { CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID }, fetchImpl)
    ).rejects.toThrow("Required deployment input CLOUDFLARE_API_TOKEN is missing.");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
