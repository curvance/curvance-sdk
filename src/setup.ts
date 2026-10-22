import { ChainRpcPrefix, getContractAddresses } from "./helpers";
import { Market } from "./classes/Market";
import { Optimizer } from "./classes/Optimizer";
import { address, curvance_provider, curvance_read_provider, curvance_signer } from './types';
import { ProtocolReader } from "./classes/ProtocolReader";
import { OracleManager } from "./classes/OracleManager";
import { getActiveRetryConfig, getRetryableProviderTarget, wrapProviderWithRetries } from "./retry-provider";
import { chain_config } from "./chains";
import { Api } from "./classes/Api";
import type { MilestoneResponse } from "./classes/Api";
import { validateApiUrl } from "./validation";
import { CURVANCE_FEE_BPS, FeePolicy, NO_FEE_POLICY, defaultFeePolicyForChain } from "./feePolicy";
import type IDexAgg from "./classes/DexAggregators/IDexAgg";
import type { DexAggContext } from "./classes/DexAggregators/IDexAgg";
import { deepFreeze, DeepReadonly } from "./immutability";
import type { ChainAssetConfig, ChainEnvironment, ChainServiceConfig } from "./chains";

export interface SetupConfigSnapshot {
    chain: ChainRpcPrefix;
    chainId: number;
    environment: ChainEnvironment;
    assets: DeepReadonly<ChainAssetConfig>;
    services: DeepReadonly<ChainServiceConfig>;
    contracts: DeepReadonly<ReturnType<typeof getContractAddresses>>;
    contractRevision?: string;
    readProvider: curvance_read_provider;
    signer: curvance_signer | null;
    account: address | null;
    /** @deprecated Prefer readProvider/signer/account. */
    provider: curvance_provider;
    api_url: string;
    feePolicy: FeePolicy;
}

export let setup_config: SetupConfigSnapshot;

export let all_markets: Market[] = [];
export let all_optimizers: Optimizer[] = [];
let latest_setup_invocation = 0;
let latest_published_setup_invocation = 0;
const pending_setup_invocations = new Set<number>();
const successful_setup_results = new Map<number, {
    setupConfig: SetupConfigSnapshot;
    markets: Market[];
    optimizers: Optimizer[];
}>();

export interface SetupChainOptions {
    /** Defaults to registry-backed configuration. Bundled mode is an explicit offline/legacy opt-in. */
    contractSource?: 'api' | 'bundled';
    /** Optional fee policy for SDK-initiated DEX swaps (zaps + leverage).
     *  Defaults to the chain's setup-resolved Curvance fee policy. */
    feePolicy?: FeePolicy;
    /** Optional dedicated account for user-specific reads when no signer is available. */
    account?: address | null;
    /** Optional dedicated read provider override. */
    readProvider?: curvance_read_provider | null;
}

export interface SetupChainResult {
    chain: ChainRpcPrefix;
    chainId: number;
    setupConfigSnapshot: Readonly<SetupConfigSnapshot>;
    markets: Market[];
    optimizers: Optimizer[];
    reader: ProtocolReader;
    dexAgg: IDexAgg;
    global_milestone: MilestoneResponse | null;
}

function createSetupConfig(
    chain: ChainRpcPrefix,
    readProvider: curvance_read_provider,
    signer: curvance_signer | null,
    account: address | null,
    api_url: string,
    feePolicy: FeePolicy,
    contracts: ReturnType<typeof getContractAddresses>,
    contractRevision: string,
): SetupConfigSnapshot {
    return Object.freeze({
        chain,
        chainId: chain_config[chain].chainId,
        environment: chain_config[chain].environment,
        assets: deepFreeze(cloneChainAssets(chain_config[chain])),
        services: deepFreeze(cloneChainServices(chain_config[chain].services)),
        readProvider,
        signer,
        account,
        provider: signer ?? readProvider,
        contracts: deepFreeze(contracts),
        contractRevision,
        api_url,
        feePolicy,
    }) as SetupConfigSnapshot;
}

function cloneChainAssets(config: ChainAssetConfig): ChainAssetConfig {
    return {
        native_symbol: config.native_symbol,
        native_name: config.native_name,
        wrapped_native: config.wrapped_native,
        native_vaults: config.native_vaults.map((vault) => ({ ...vault })),
        vaults: config.vaults.map((vault) => ({ ...vault })),
        excluded_zap_symbols: [...config.excluded_zap_symbols],
        excluded_zap_addresses: [...(config.excluded_zap_addresses ?? [])],
    };
}

function cloneChainServices(services: ChainServiceConfig): ChainServiceConfig {
    return {
        curvanceApi: {
            rewardsSlug: services.curvanceApi.rewardsSlug,
            rewardChainAliases: [...services.curvanceApi.rewardChainAliases],
            nativeYieldSlug: services.curvanceApi.nativeYieldSlug,
            suppressedNativeYieldSymbols: [...services.curvanceApi.suppressedNativeYieldSymbols],
        },
        dexAggregators: {
            kyberSwap: services.dexAggregators.kyberSwap == null
                ? null
                : { ...services.dexAggregators.kyberSwap },
        },
    };
}

function validateSetupConfig(config: SetupConfigSnapshot) {
    if(!("ProtocolReader" in config.contracts)) {
        throw new Error(`Chain configuration for ${config.chain} is missing ProtocolReader address.`);
    } else if (!("OracleManager" in config.contracts)) {
        throw new Error(`Chain configuration for ${config.chain} is missing OracleManager address.`);
    }

    const policyChain = config.feePolicy.chain;
    if (policyChain != undefined && policyChain !== "any" && policyChain !== config.chain) {
        throw new Error(
            `Fee policy for ${policyChain} cannot be used with setupChain('${config.chain}').`,
        );
    }
}

function validateCheckerFeePolicy(config: SetupConfigSnapshot, checkerDao: address | null) {
    if (config.services.dexAggregators.kyberSwap == null) {
        return;
    }
    if (checkerDao == null) {
        throw new Error(`KyberSwap checker validation for ${config.chain} requires the setup DAO address.`);
    }

    const checkerCompatibility = config.feePolicy.checkerCompatibility;
    if (checkerCompatibility == null) {
        throw new Error(
            `KyberSwap checker for ${config.chain} requires a checker-compatible fee policy ` +
            `with exact feeBps=${CURVANCE_FEE_BPS} and feeReceiver=${checkerDao}. ` +
            `Context-dependent policies are not allowed on checker-bound routes. ` +
            `Omit options.feePolicy to use the setup-resolved default or pass a policy ` +
            `that declares checkerCompatibility.`,
        );
    }

    const sampleFeeBps = config.feePolicy.getFeeBps({
        operation: "zap",
        inputToken: "0x0000000000000000000000000000000000000001" as address,
        outputToken: "0x0000000000000000000000000000000000000002" as address,
        inputAmount: 1n,
        currentLeverage: null,
        targetLeverage: null,
    });
    const feeReceiver = checkerCompatibility.feeReceiver;
    if (
        checkerCompatibility.exactFeeBpsForDexSwaps !== CURVANCE_FEE_BPS ||
        sampleFeeBps !== checkerCompatibility.exactFeeBpsForDexSwaps ||
        feeReceiver == null ||
        feeReceiver.toLowerCase() !== checkerDao.toLowerCase()
    ) {
        throw new Error(
            `KyberSwap checker for ${config.chain} requires feeBps=${CURVANCE_FEE_BPS} ` +
            `and feeReceiver=${checkerDao}; got ` +
            `feeBps=${checkerCompatibility.exactFeeBpsForDexSwaps} ` +
            `sampleFeeBps=${sampleFeeBps} feeReceiver=${feeReceiver ?? "undefined"}. ` +
            `Omit options.feePolicy to use the setup-resolved default or pass a checker-compatible policy.`,
        );
    }
}

function bindDexAggContext(dexAgg: IDexAgg, context: DexAggContext): IDexAgg {
    return dexAgg.withContext?.(context) ?? dexAgg;
}

async function validateProviderChain(chain: ChainRpcPrefix, provider: curvance_read_provider, label: string) {
    const expectedChainId = BigInt(chain_config[chain].chainId);
    const providerTarget = getRetryableProviderTarget(provider);
    const timeoutMs = getActiveRetryConfig().timeoutMs;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const network = timeoutMs <= 0
        ? await providerTarget.getNetwork()
        : await Promise.race([
            providerTarget.getNetwork(),
            new Promise<never>((_, reject) => {
                timeoutHandle = setTimeout(() => {
                    reject(new Error(`[rpc] ${label} getNetwork: timeout after ${timeoutMs}ms`));
                }, timeoutMs);
            }),
        ]).finally(() => {
            if (timeoutHandle != null) {
                clearTimeout(timeoutHandle);
            }
        });
    const actualChainId = BigInt(network.chainId);

    if (actualChainId !== expectedChainId) {
        throw new Error(
            `${label} is connected to chainId ${actualChainId} but setupChain('${chain}') expects ${expectedChainId}.`,
        );
    }
}

async function validateSignerProviderChain(chain: ChainRpcPrefix, signer: curvance_signer | null) {
    if (signer?.provider == null) {
        return;
    }

    await validateProviderChain(chain, signer.provider as curvance_read_provider, "Signer provider");
}

function publishLatestSuccessfulSetup() {
    let candidateInvocation = 0;
    let candidate:
        | {
              setupConfig: SetupConfigSnapshot;
              markets: Market[];
              optimizers: Optimizer[];
          }
        | undefined;

    for (const [invocation, result] of successful_setup_results.entries()) {
        if (
            invocation > latest_published_setup_invocation &&
            invocation > candidateInvocation
        ) {
            candidateInvocation = invocation;
            candidate = result;
        }
    }

    if (candidate == undefined) {
        return;
    }

    latest_published_setup_invocation = candidateInvocation;
    setup_config = candidate.setupConfig;
    all_markets = candidate.markets;
    all_optimizers = candidate.optimizers;

    for (const invocation of [...successful_setup_results.keys()]) {
        if (invocation <= latest_published_setup_invocation) {
            successful_setup_results.delete(invocation);
        }
    }
}

export function setupChain(
    chain: ChainRpcPrefix,
    provider?: curvance_provider | null,
    api_url?: string,
    options?: SetupChainOptions,
): Promise<SetupChainResult>;
export async function setupChain(
    chain: ChainRpcPrefix,
    provider: curvance_provider | null = null,
    api_url: string = "https://api2.curvance.com",
    options: SetupChainOptions = {},
) {
    if(!(chain in chain_config)) {
        throw new Error("Chain does not have a corresponding config");
    }

    // Validate api_url scheme before any network calls
    validateApiUrl(api_url);

    const setupInvocation = ++latest_setup_invocation;
    pending_setup_invocations.add(setupInvocation);

    try {
        const chainReadProvider = chain_config[chain].provider;
        const readFallbacks = chain_config[chain].fallbackProviders;
        let signer: curvance_signer | null = null;
        let readProviderOverride = options.readProvider ?? null;
        let readProviderOverrideValidated = false;

        if(provider != null) {
            if("address" in provider) {
                signer = provider as curvance_signer;
                await validateSignerProviderChain(chain, signer);
                // Wallet-primary for reads: when a wallet is connected, its own
                // provider is the primary read source. chainReadProvider + chain
                // fallbacks become the fallback chain via wrapProviderWithRetries
                // below. This distributes read load across users' wallet RPCs
                // instead of funneling every Curvance session through one origin,
                // and matches the pre-`358d46b` architecture the original author
                // designed (explicitly citing Rabby as the unreliable-wallet case).
                // Explicit `options.readProvider` wins if set.
                if(!readProviderOverride && signer.provider) {
                    readProviderOverride = signer.provider as curvance_read_provider;
                    readProviderOverrideValidated = true;
                }
            } else {
                readProviderOverride = provider as curvance_read_provider;
            }
        }

        if (readProviderOverride && !readProviderOverrideValidated) {
            await validateProviderChain(chain, readProviderOverride, "Read provider");
        }

        const readProvider = wrapProviderWithRetries(
            readProviderOverride ?? chainReadProvider,
            readProviderOverride ? [chainReadProvider, ...readFallbacks] : readFallbacks,
        );
        const signerAccount = (signer?.address as address | undefined) ?? null;
        const requestedAccount = options.account ?? null;
        if (
            signerAccount != null &&
            requestedAccount != null &&
            signerAccount.toLowerCase() !== requestedAccount.toLowerCase()
        ) {
            throw new Error(
                `setupChain('${chain}') cannot boot with signer ${signerAccount} and read account ${requestedAccount}. ` +
                `Pass a matching account or omit options.account when a signer is connected.`,
            );
        }
        const account = requestedAccount ?? signerAccount;
        const registry = options.contractSource === 'bundled'
            ? { contracts: getContractAddresses(chain), revision: 'bundled' }
            : await Api.fetchContractConfiguration({ chain, chainId: chain_config[chain].chainId, api_url });

        let nextSetupConfig = createSetupConfig(
            chain,
            readProvider,
            signer,
            account,
            api_url,
            options.feePolicy ?? NO_FEE_POLICY,
            registry.contracts,
            registry.revision,
        );
        validateSetupConfig(nextSetupConfig);

        const reader = new ProtocolReader(
            nextSetupConfig.contracts.ProtocolReader as address,
            nextSetupConfig.readProvider,
            nextSetupConfig.chain,
        );
        const requiresCheckerPolicy = nextSetupConfig.services.dexAggregators.kyberSwap != null;
        const setupDaoAddress = options.feePolicy == null || requiresCheckerPolicy
            ? await reader.getDaoAddress()
            : null;
        const feePolicy = options.feePolicy ?? defaultFeePolicyForChain(
            chain,
            setupDaoAddress as address,
        );
        nextSetupConfig = createSetupConfig(
            chain,
            readProvider,
            signer,
            account,
            api_url,
            feePolicy,
            registry.contracts,
            registry.revision,
        );
        validateSetupConfig(nextSetupConfig);
        validateCheckerFeePolicy(nextSetupConfig, setupDaoAddress);

        const { milestones, incentives } = await Api.getRewards(nextSetupConfig);
        const oracle_manager = new OracleManager(
            nextSetupConfig.contracts.OracleManager as address,
            nextSetupConfig.readProvider,
        );
        const optimizers = Optimizer.getAll(nextSetupConfig, oracle_manager);
        const markets = await Market.getAll(
            reader,
            oracle_manager,
            nextSetupConfig.readProvider,
            nextSetupConfig.signer,
            nextSetupConfig.account,
            milestones,
            incentives,
            nextSetupConfig,
        );
        const dexAgg = bindDexAggContext(chain_config[chain].dexAgg, {
            markets,
            feePolicy: nextSetupConfig.feePolicy,
            checkerDao: setupDaoAddress ?? undefined,
        });
        for (const market of markets) {
            market.dexAgg = dexAgg;
            for (const token of market.tokens ?? []) {
                token.refreshRouteCapabilities?.();
            }
        }

        pending_setup_invocations.delete(setupInvocation);
        successful_setup_results.set(setupInvocation, {
            setupConfig: nextSetupConfig,
            markets,
            optimizers,
        });
        publishLatestSuccessfulSetup();

        return {
            chain,
            chainId: nextSetupConfig.chainId,
            setupConfigSnapshot: nextSetupConfig,
            markets,
            optimizers,
            reader,
            dexAgg,
            global_milestone: milestones['global'] ?? null
        };
    } catch (error) {
        pending_setup_invocations.delete(setupInvocation);
        publishLatestSuccessfulSetup();
        throw error;
    }
}

export function getActiveUserMarkets(markets: Market[] = all_markets): Market[] {
    return Market.getActiveUserMarkets(markets);
}

export async function refreshActiveUserMarkets(
    account: address,
    markets: Market[] = all_markets,
): Promise<Market[]> {
    const refreshed = await Market.reloadUserMarkets(markets, account);
    return Market.getActiveUserMarkets(refreshed);
}

export async function refreshActiveUserMarketSummaries(
    account: address,
    markets: Market[] = all_markets,
): Promise<Market[]> {
    return Market.reloadUserMarketSummaries(markets, account);
}
