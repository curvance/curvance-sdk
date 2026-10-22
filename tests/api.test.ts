import assert from "node:assert/strict";
import test from "node:test";
import { Api, type AssetResponse } from "../src/classes/Api";
import { chain_config } from "../src/chains";
import type { ChainRpcPrefix } from "../src/helpers";

const originalFetch = globalThis.fetch;
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;
const API_URL = "https://api.curvance.test";
const MARKET = "0x00000000000000000000000000000000000000AA";

function createApiConfig(chain: ChainRpcPrefix = "monad-mainnet") {
    return {
        chain,
        chainId: chain_config[chain].chainId,
        api_url: API_URL,
    };
}

function createAsset(overrides: Partial<AssetResponse> = {}): AssetResponse {
    return {
        chain_id: 143,
        token: "0x00000000000000000000000000000000000000BB",
        symbol: "WMON",
        token_image: "wmon.svg",
        market_address: MARKET,
        vault: false,
        percent_native_apy: 4.25,
        points: [],
        ...overrides,
    };
}

function mockJsonResponse(payload: unknown, options: { ok?: boolean; status?: number; statusText?: string } = {}) {
    globalThis.fetch = (async () => ({
        ok: options.ok ?? true,
        status: options.status ?? 200,
        statusText: options.statusText ?? "OK",
        json: async () => payload,
    })) as unknown as typeof fetch;
}

test.afterEach(() => {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
    console.warn = originalConsoleWarn;
});

test("Api.fetchAssets loads API2 asset metadata for the configured chain", async () => {
    let requestedUrl = "";
    globalThis.fetch = (async (input: string | URL | Request) => {
        requestedUrl =
            typeof input === "string"
                ? input
                : input instanceof URL
                    ? input.toString()
                    : input.url;
        return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => [createAsset()],
        } as Response;
    }) as typeof fetch;

    const assets = await Api.fetchAssets(createApiConfig());

    assert.equal(requestedUrl, `${API_URL}/asset/143`);
    assert.deepEqual(assets, [createAsset()]);
});

test("Api.fetchAssets resolves chainId for minimal public configs", async () => {
    let requestedUrl = "";
    globalThis.fetch = (async (input: string | URL | Request) => {
        requestedUrl = String(input);
        return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => [],
        } as Response;
    }) as typeof fetch;

    await Api.fetchAssets({
        chain: "arb-sepolia",
        api_url: API_URL,
    });

    assert.equal(requestedUrl, `${API_URL}/asset/${chain_config["arb-sepolia"].chainId}`);
});

test("Api.fetchAssets filters malformed assets and nested point rows", async () => {
    mockJsonResponse([
        createAsset({
            points: [
                { type: "shMON", image: "shmon.svg", rate: 5 },
                { type: "", image: "broken.svg", rate: 2 },
                { type: "negative", image: "broken.svg", rate: -1 },
            ],
        }),
        { broken: true },
        { ...createAsset(), token: "", symbol: "BROKEN" },
    ]);

    const assets = await Api.fetchAssets(createApiConfig());

    assert.deepEqual(assets, [
        createAsset({
            points: [{ type: "shMON", image: "shmon.svg", rate: 5 }],
        }),
    ]);
});

test("Api.fetchAssets degrades malformed and non-OK responses to an empty list", async () => {
    console.error = () => {};
    mockJsonResponse({ assets: [] });
    assert.deepEqual(await Api.fetchAssets(createApiConfig()), []);

    mockJsonResponse([createAsset()], {
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
    });
    assert.deepEqual(await Api.fetchAssets(createApiConfig()), []);
});

test("Api.fetchAssets rejects insecure remote URLs before fetch", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
        fetchCalls += 1;
        return {} as Response;
    }) as typeof fetch;

    await assert.rejects(
        () => Api.fetchAssets({
            chain: "monad-mainnet",
            api_url: "http://api.curvance.test",
        }),
        /Api\.fetchAssets: api_url must use HTTPS/i,
    );
    assert.equal(fetchCalls, 0);
});

test("Api.fetchNativeYields keeps native APY attached to each cToken", async () => {
    mockJsonResponse([
        createAsset(),
        createAsset({
            token: "0x00000000000000000000000000000000000000CC",
            market_address: "0x00000000000000000000000000000000000000DD",
            symbol: "wmon",
        }),
        createAsset({
            token: "0x00000000000000000000000000000000000000EE",
            symbol: "USDC",
            percent_native_apy: 0,
        }),
    ]);

    const yields = await Api.fetchNativeYields(createApiConfig());

    assert.deepEqual(yields, [
        { symbol: "WMON", apy: 4.25, token: '0x00000000000000000000000000000000000000bb' },
        { symbol: "wmon", apy: 4.25, token: '0x00000000000000000000000000000000000000cc' },
        { symbol: "USDC", apy: 0, token: '0x00000000000000000000000000000000000000ee' },
    ]);
});

test("Api.fetchNativeYields preserves unresolved APY differences for tokens with the same symbol", async () => {
    const warnings: string[] = [];
    console.warn = (message?: unknown) => warnings.push(String(message));
    mockJsonResponse([
        createAsset(),
        createAsset({
            token: "0x00000000000000000000000000000000000000CC",
            market_address: "0x00000000000000000000000000000000000000DD",
            percent_native_apy: 5,
        }),
    ]);

    const yields = await Api.fetchNativeYields(createApiConfig());

    assert.deepEqual(yields, [
        { symbol: "WMON", apy: 4.25, token: '0x00000000000000000000000000000000000000bb' },
        { symbol: "WMON", apy: 5, token: '0x00000000000000000000000000000000000000cc' },
    ]);
    assert.equal(warnings.length, 0);
});

test("Api.getRewards maps API2 asset points to legacy market incentives", async () => {
    mockJsonResponse([
        createAsset({
            points: [
                { type: "shMON", image: "shmon.svg", rate: 5 },
                { type: "bytes", image: "bytes.svg", rate: 2 },
            ],
        }),
    ]);

    const rewards = await Api.getRewards(createApiConfig());

    assert.deepEqual(rewards, {
        milestones: {},
        incentives: {
            [MARKET.toLowerCase()]: [
                {
                    market: MARKET,
                    type: "shMON",
                    rate: 5,
                    description: "shMON",
                    image: "shmon.svg",
                },
                {
                    market: MARKET,
                    type: "bytes",
                    rate: 2,
                    description: "bytes",
                    image: "bytes.svg",
                },
            ],
        },
    });
});

test("Api.getRewards deduplicates identical points and skips standalone vaults", async () => {
    const point = { type: "shMON", image: "shmon.svg", rate: 5 };
    const standaloneVault = createAsset({
        token: "0x00000000000000000000000000000000000000DD",
        vault: true,
        points: [point],
    });
    delete standaloneVault.market_address;
    mockJsonResponse([
        createAsset({ points: [point] }),
        createAsset({
            token: "0x00000000000000000000000000000000000000CC",
            points: [point],
        }),
        standaloneVault,
    ]);

    const rewards = await Api.getRewards(createApiConfig());

    assert.equal(rewards.incentives[MARKET.toLowerCase()]?.length, 1);
    assert.deepEqual(rewards.milestones, {});
});

test("Api.getRewards degrades an unavailable API2 asset endpoint", async () => {
    console.error = () => {};
    globalThis.fetch = (async () => {
        throw new TypeError("Failed to fetch");
    }) as typeof fetch;

    assert.deepEqual(await Api.getRewards(createApiConfig()), {
        milestones: {},
        incentives: {},
    });
});
