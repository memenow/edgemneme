import { describe, expect, it } from "vitest";

// @ts-expect-error The JavaScript CLI has no separate declaration file.
import * as triggerStateModule from "../scripts/gateway-trigger-state.mjs";
// @ts-expect-error The JavaScript CLI has no separate declaration file.
import * as listIntegrityModule from "../scripts/cloudflare-list-integrity.mjs";

const { observeGatewayTriggerState } = triggerStateModule;
const { validateSinglePageList } = listIntegrityModule;

const GATEWAY = "edgemneme-memory-gateway";

type Route = { id: string; pattern: string; script: string };

type Zone = {
  id: string;
  name: string;
  account: { id: string };
};

type ZonePage = {
  result: Zone[];
  result_info: Record<string, number>;
};

const environment = {
  CLOUDFLARE_ACCOUNT_ID: "account-one",
  CLOUDFLARE_API_TOKEN: "synthetic-token"
};

function paginationFetch(
  zonePages: Record<number, ZonePage>,
  routesByZone: Record<string, Route[]> = {},
  requests: string[] = []
): typeof fetch {
  return (async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    requests.push(`${method} ${url.pathname}`);

    if (method === "GET" && url.pathname === "/client/v4/zones") {
      expect(url.searchParams.get("account.id")).toBe("account-one");
      expect(url.searchParams.get("per_page")).toBe("50");
      expect(url.searchParams.get("type")).toBe(
        "full,partial,secondary,internal"
      );
      const requestedPage = Number(url.searchParams.get("page"));
      const page = zonePages[requestedPage];
      if (page === undefined) {
        throw new Error(`Unexpected synthetic zone page ${requestedPage}.`);
      }
      return Response.json({ success: true, ...page });
    }
    if (method === "GET" && url.pathname.endsWith("/workers/domains")) {
      return Response.json({ success: true, result: [] });
    }
    if (
      method === "GET" &&
      url.pathname.endsWith(`/workers/scripts/${GATEWAY}/subdomain`)
    ) {
      return Response.json({
        success: true,
        result: { enabled: true, previews_enabled: false }
      });
    }
    if (method === "GET" && url.pathname.endsWith("/workers/subdomain")) {
      return Response.json({ success: true, result: { subdomain: "account-workers" } });
    }
    const routeListMatch = url.pathname.match(
      /^\/client\/v4\/zones\/([^/]+)\/workers\/routes$/u
    );
    if (method === "GET" && routeListMatch?.[1] !== undefined) {
      const zoneId = decodeURIComponent(routeListMatch[1]);
      return Response.json({ success: true, result: routesByZone[zoneId] ?? [] });
    }
    throw new Error(`Unexpected Cloudflare request ${method} ${url.pathname}.`);
  }) as typeof fetch;
}

function zones(count: number): Zone[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `zone-${index + 1}`,
    name: `zone-${index + 1}.example.com`,
    account: { id: "account-one" }
  }));
}

describe("gateway trigger pagination", () => {
  it("honors the documented single-page domain metadata semantics", () => {
    const result = [{ id: "domain-one" }];
    expect(
      validateSinglePageList(
        {
          result,
          result_info: {
            count: 1,
            page: 1,
            per_page: 20,
            total_count: 2_000,
            total_pages: 100
          }
        },
        "Cloudflare custom domain list"
      )
    ).toBe(result);
    expect(() =>
      validateSinglePageList(
        {
          result,
          result_info: { count: 2 }
        },
        "Cloudflare custom domain list"
      )
    ).toThrow("single-page metadata is inconsistent");
  });

  it("rejects incomplete zone pagination metadata", async () => {
    await expect(
      observeGatewayTriggerState(
        environment,
        paginationFetch({
          1: {
            result: [],
            result_info: { page: 1, total_pages: 0 }
          }
        })
      )
    ).rejects.toThrow("result_info has an unsupported shape");
  });

  it("rejects a duplicate zone returned on a later page", async () => {
    const firstPageZones = zones(50);
    await expect(
      observeGatewayTriggerState(
        environment,
        paginationFetch({
          1: {
            result: firstPageZones,
            result_info: {
              page: 1,
              per_page: 50,
              count: 50,
              total_count: 51,
              total_pages: 2
            }
          },
          2: {
            result: [firstPageZones[0]!],
            result_info: {
              page: 2,
              per_page: 50,
              count: 1,
              total_count: 51,
              total_pages: 2
            }
          }
        })
      )
    ).rejects.toThrow("zone ID is duplicated");

    await expect(
      observeGatewayTriggerState(
        environment,
        paginationFetch({
          1: {
            result: firstPageZones,
            result_info: {
              page: 1,
              per_page: 50,
              count: 50,
              total_count: 51,
              total_pages: 2
            }
          },
          2: {
            result: [
              {
                id: "zone-51",
                name: firstPageZones[0]!.name,
                account: { id: "account-one" }
              }
            ],
            result_info: {
              page: 2,
              per_page: 50,
              count: 1,
              total_count: 51,
              total_pages: 2
            }
          }
        })
      )
    ).rejects.toThrow("zone name is duplicated");
  });

  it("rejects zone totals that drift between pages", async () => {
    const accountZones = zones(52);
    await expect(
      observeGatewayTriggerState(
        environment,
        paginationFetch({
          1: {
            result: accountZones.slice(0, 50),
            result_info: {
              page: 1,
              per_page: 50,
              count: 50,
              total_count: 51,
              total_pages: 2
            }
          },
          2: {
            result: accountZones.slice(50),
            result_info: {
              page: 2,
              per_page: 50,
              count: 2,
              total_count: 52,
              total_pages: 2
            }
          }
        })
      )
    ).rejects.toThrow("totals changed between pages");
  });

  it("rejects a response that repeats the requested page number", async () => {
    const accountZones = zones(51);
    await expect(
      observeGatewayTriggerState(
        environment,
        paginationFetch({
          1: {
            result: accountZones.slice(0, 50),
            result_info: {
              page: 1,
              per_page: 50,
              count: 50,
              total_count: 51,
              total_pages: 2
            }
          },
          2: {
            result: accountZones.slice(50),
            result_info: {
              page: 1,
              per_page: 50,
              count: 1,
              total_count: 51,
              total_pages: 2
            }
          }
        })
      )
    ).rejects.toThrow("pagination does not match the requested page");
  });

  it("scans routes for zones returned on the final page", async () => {
    const requests: string[] = [];
    const accountZones = zones(51);
    await expect(
      observeGatewayTriggerState(
        environment,
        paginationFetch(
          {
            1: {
              result: accountZones.slice(0, 50),
              result_info: {
                page: 1,
                per_page: 50,
                count: 50,
                total_count: 51,
                total_pages: 2
              }
            },
            2: {
              result: accountZones.slice(50),
              result_info: {
                page: 2,
                per_page: 50,
                count: 1,
                total_count: 51,
                total_pages: 2
              }
            }
          },
          {
            "zone-51": [
              { id: "gateway-route", pattern: "memory.example.com/*", script: GATEWAY }
            ]
          },
          requests
        )
      )
    ).rejects.toThrow("Zone routes are not supported");
    expect(requests).toContain("GET /client/v4/zones/zone-51/workers/routes");
  });
});
