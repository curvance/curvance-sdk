import type { SetupConfigSnapshot } from "../setup";
import { chain_config } from "../chains";
import { address } from "../types";
import { fetchWithTimeout, validateApiUrl } from "../validation";
import { validateContractConfiguration, type ContractConfiguration } from '../contracts/registry';

export type IncentiveResponse = {
    market: address,
    type: string,
    rate: number,
    description: string,
    image: string,
    chain_network?: string,
};

export type MilestoneResponse = {
    market: address;
    tvl: number;
    multiplier: number;
    fail_multiplier: number;
    chain_network: string;
    start_date: string;
    end_date: string;
    duration_in_days: number;
}
export type Milestones = { [key: string]: MilestoneResponse };
export type Incentives = { [key: string]: Array<IncentiveResponse> };
type ApiRequestConfig = Pick<SetupConfigSnapshot, "chain" | "api_url"> & {
    chainId?: SetupConfigSnapshot["chainId"];
    services?: SetupConfigSnapshot["services"];
};

export type AssetPointResponse = {
    type: string;
    image: string;
    rate: number;
};

export type AssetResponse = {
    chain_id: number;
    token: address;
    symbol: string;
    token_image: string;
    market_address?: address;
    vault: boolean;
    percent_native_apy: number;
    points: AssetPointResponse[];
};

function isFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
    return isFiniteNumber(value) && value >= 0;
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

function isAssetPointResponse(value: unknown): value is AssetPointResponse {
    if (typeof value !== "object" || value == null) {
        return false;
    }

    const row = value as Partial<Record<keyof AssetPointResponse, unknown>>;
    return (
        isNonEmptyString(row.type) &&
        isNonEmptyString(row.image) &&
        isNonNegativeFiniteNumber(row.rate)
    );
}

function isAssetResponse(value: unknown): value is AssetResponse {
    if (typeof value !== "object" || value == null) {
        return false;
    }

    const row = value as Partial<Record<keyof AssetResponse, unknown>>;
    return (
        isFiniteNumber(row.chain_id) &&
        isNonEmptyString(row.token) &&
        isNonEmptyString(row.symbol) &&
        typeof row.token_image === 'string' &&
        (row.market_address == undefined || isNonEmptyString(row.market_address)) &&
        typeof row.vault === "boolean" &&
        isNonNegativeFiniteNumber(row.percent_native_apy) &&
        Array.isArray(row.points)
    );
}

function normalizeMarketKey(market: string): string {
    return market.toLowerCase();
}

function resolveCurvanceApiServices(config: ApiRequestConfig) {
    const services = config.services?.curvanceApi ?? chain_config[config.chain]?.services.curvanceApi;
    if (services == null) {
        throw new Error(`Chain configuration for ${config.chain} is missing Curvance API services.`);
    }
    return services;
}

function resolveDefaultSetupConfig(context: string): SetupConfigSnapshot {
    const config = (require("../setup") as typeof import("../setup")).setup_config;
    if (config == undefined) {
        throw new Error(
            `Setup config is not configured for ${context}. ` +
            `Pass config explicitly or initialize setupChain() first.`
        );
    }

    return config;
}

function resolveValidatedApiUrl(config: ApiRequestConfig, context: string): string {
    try {
        return validateApiUrl(config.api_url);
    } catch (error) {
        throw new Error(`${context}: ${(error as Error).message}`);
    }
}

function resolveChainId(config: ApiRequestConfig): number {
    return config.chainId ?? chain_config[config.chain].chainId;
}

const assetRequests = new WeakMap<object, Promise<AssetResponse[]>>();

export class Api {
    static async fetchContractConfiguration(config: ApiRequestConfig): Promise<ContractConfiguration> {
        const apiUrl = resolveValidatedApiUrl(config, 'Api.fetchContractConfiguration').replace(/\/+$/, '');
        const chainId = resolveChainId(config);
        for (let attempt = 0; attempt < 3; attempt++) {
            let response: Response;
            try {
                response = await fetchWithTimeout(`${apiUrl}/contracts/${chainId}`);
            } catch (error) {
                if (attempt === 2) throw error;
                await new Promise(resolve => setTimeout(resolve, 250 * 2 ** attempt));
                continue;
            }
            if (!response.ok) {
                if (attempt < 2 && (response.status === 429 || response.status >= 500)) {
                    await response.body?.cancel();
                    await new Promise(resolve => setTimeout(resolve, 250 * 2 ** attempt));
                    continue;
                }
                throw new Error(`Contract configuration request failed: ${response.status}`);
            }
            // Invalid JSON/configuration and other 4xx responses are not transient failures.
            return validateContractConfiguration(await response.json(), chainId);
        }
        throw new Error('Contract configuration request exhausted retries');
    }
    private url: string;
    
    public constructor(config?: SetupConfigSnapshot) {
        this.url = resolveValidatedApiUrl(config ?? resolveDefaultSetupConfig("Api"), "Api");
    }

    static async fetchAssets(config?: ApiRequestConfig): Promise<AssetResponse[]> {
        const resolvedConfig = config ?? resolveDefaultSetupConfig("Api.fetchAssets");
        const apiUrl = resolveValidatedApiUrl(resolvedConfig, "Api.fetchAssets").replace(/\/+$/, "");
        const chainId = resolveChainId(resolvedConfig);
        const cached = assetRequests.get(resolvedConfig);
        if (cached != undefined) {
            return cached;
        }

        const request = (async () => {
            try {
                const response = await fetchWithTimeout(`${apiUrl}/asset/${chainId}`);
                if (!response.ok) {
                    throw new Error(`Assets request failed: ${response.status} ${response.statusText}`);
                }

                const payload = await response.json();
                if (!Array.isArray(payload)) {
                    throw new Error("Invalid assets response structure");
                }

                return payload
                    .filter(isAssetResponse)
                    .map(asset => ({
                        ...asset,
                        points: asset.points.filter(isAssetPointResponse),
                    }));
            } catch(error) {
                console.error("Failed to fetch asset metadata from API:", error);
                return [];
            }
        })();

        assetRequests.set(resolvedConfig, request);
        return request;
    }

    static async fetchNativeYields(config?: ApiRequestConfig): Promise<{ symbol: string, apy: number, token?: string }[]> {
        const resolvedConfig = config ?? resolveDefaultSetupConfig("Api.fetchNativeYields");
        if (resolveCurvanceApiServices(resolvedConfig).nativeYieldSlug == null) {
            return [];
        }
        const assets = await Api.fetchAssets(resolvedConfig);
        const yieldsByToken = new Map<string, { symbol: string; apy: number; token: string }>();

        for (const asset of assets) {
            const key = asset.token.toLowerCase();
            const existing = yieldsByToken.get(key);
            if (existing == undefined) {
                yieldsByToken.set(key, {
                    symbol: asset.symbol,
                    apy: asset.percent_native_apy,
                    token: key,
                });
                continue;
            }

            if (existing.apy !== asset.percent_native_apy) {
                console.warn(
                    `Conflicting native APY values for ${asset.token}; ` +
                    `using ${existing.apy} and ignoring ${asset.percent_native_apy}.`
                );
            }
        }

        return [...yieldsByToken.values()];
    }

    static async getRewards(config?: ApiRequestConfig) {
        const resolvedConfig = config ?? resolveDefaultSetupConfig("Api.getRewards");
        const assets = await Api.fetchAssets(resolvedConfig);
        const milestones: Milestones = {};
        const incentives: Incentives = {};
        const seenByMarket = new Map<string, Set<string>>();

        for (const asset of assets) {
            if (asset.market_address == undefined) {
                continue;
            }

            const market = normalizeMarketKey(asset.market_address);
            const marketIncentives = incentives[market] ?? [];
            const seen = seenByMarket.get(market) ?? new Set<string>();

            for (const point of asset.points) {
                const identity = `${point.type}\u0000${point.image}\u0000${point.rate}`;
                if (seen.has(identity)) {
                    continue;
                }

                seen.add(identity);
                marketIncentives.push({
                    market: asset.market_address,
                    type: point.type,
                    rate: point.rate,
                    description: point.type,
                    image: point.image,
                });
            }

            if (marketIncentives.length > 0) {
                incentives[market] = marketIncentives;
                seenByMarket.set(market, seen);
            }
        }

        return { milestones, incentives };
    }
}
