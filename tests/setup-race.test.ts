import assert from "node:assert/strict";
import test from "node:test";
import Decimal from "decimal.js";
import { Interface, JsonRpcProvider } from "ethers";
import { Api } from "../src/classes/Api";
import { ERC20 } from "../src/classes/ERC20";
import { LendingOptimizer } from "../src/classes/LendingOptimizer";
import { Market } from "../src/classes/Market";
import { OracleManager } from "../src/classes/OracleManager";
import { OptimizerReader } from "../src/classes/OptimizerReader";
import { PositionManager } from "../src/classes/PositionManager";
import { ProtocolReader } from "../src/classes/ProtocolReader";
import { chain_config, getChainRpcConfig } from "../src/chains";
import { UnsupportedDexAgg } from "../src/classes/DexAggregators/UnsupportedDexAgg";
import { MultiDexAgg } from "../src/classes/DexAggregators/MultiDexAgg";
import { Zapper } from "../src/classes/Zapper";
import { CURVANCE_FEE_BPS, NO_FEE_POLICY, flatFeePolicy } from "../src/feePolicy";
import { EMPTY_ADDRESS, getContractAddresses, NATIVE_ADDRESS } from "../src/helpers";
// Existing boot/race cases use a deterministic registry snapshot; registry transport has separate coverage.
test.beforeEach(t => {
    if (!('mock' in t)) return;
    t.mock.method(Api, 'fetchContractConfiguration', async (config: { chain: keyof typeof chain_config }) => ({
        schema_version: 1 as const, chain_id: chain_config[config.chain].chainId,
        revision: 'a'.repeat(64), contracts: getContractAddresses(config.chain),
    }));
});
import { takePortfolioSnapshot } from "../src/integrations/snapshot";
import {
    configureRetries,
    DEFAULT_RETRY_CONFIG,
    getRpcDebugSnapshot,
    isRetryableReadProvider,
    resetRpcDebugState,
    wrapProviderWithRetries,
} from "../src/retry-provider";
import {
    all_markets,
    refreshActiveUserMarkets,
    refreshActiveUserMarketSummaries,
    setup_config,
    setupChain,
} from "../src/setup";
import { validateAddress } from "../src/validation";
import type { address, bytes } from "../src/types";
import {
    ARB_SEPOLIA_BOOT_FIXTURE,
    BOOT_DAO_ADDRESS,
    MONAD_MAINNET_BOOT_FIXTURE,
    createBootDynamicMarket,
    createBootStaticMarket,
    createBootUserMarket,
    createDecimalsReadProvider,
    installSetupChainBootHarness,
} from "./support/setup-chain-boot-harness";

const DECIMALS_SELECTOR = "0x313ce567";
const MONAD_TEST_TOKEN = "0x0000000000000000000000000000000000000101" as address;
const MONAD_TEST_OUTPUT_TOKEN = "0x0000000000000000000000000000000000000102" as address;
const MONAD_NATIVE_VAULT_CTOKEN = "0x0000000000000000000000000000000000000103" as address;
const MONAD_VAULT_CTOKEN = "0x0000000000000000000000000000000000000104" as address;
const MONAD_SHMON_MARKET = "0xE1C24B2E93230FBe33d32Ba38ECA3218284143e2" as address;
const MONAD_SHMON_CTOKEN = "0x926C101Cf0a3dE8725Eb24a93E980f9FE34d6230" as address;
const MONAD_SHMON_WMON_CTOKEN = "0x0fcEd51b526BfA5619F83d97b54a57e3327eB183" as address;
const MONAD_SAUSD_MARKET = "0xBBE7A3c45aDBb16F6490767b663428c34aA341Eb" as address;
const MONAD_SAUSD_CTOKEN = "0x84C5aF20b58818631164Bb7d798E457fcFACD9Ac" as address;
const MONAD_AUSD_CTOKEN = "0xfD493ce1A0ae986e09d17004B7E748817a47d73c" as address;
const ARB_TEST_TOKEN = "0x0000000000000000000000000000000000000202" as address;
const OPTIMIZER_TEST_ADDRESS = "0x0000000000000000000000000000000000000303" as address;
const {
    account: ARB_ACCOUNT,
    stableMarket: ARB_STABLE_MARKET,
    usdcCToken: ARB_USDC_CTOKEN,
    ausdCToken: ARB_AUSD_CTOKEN,
    unknownMarket: ARB_UNKNOWN_MARKET,
    unknownToken: ARB_UNKNOWN_TOKEN,
} = ARB_SEPOLIA_BOOT_FIXTURE;
const {
    account: MONAD_ACCOUNT,
    market: MONAD_MARKET,
    wmonCToken: MONAD_WMON_CTOKEN,
    usdcCToken: MONAD_USDC_CTOKEN,
    wrappedNative: MONAD_WRAPPED_NATIVE,
    usdcAsset: MONAD_USDC_ASSET,
} = MONAD_MAINNET_BOOT_FIXTURE;

const BOOT_DAO_FEE_RECEIVER = BOOT_DAO_ADDRESS;
const CHECKSUM_BOOT_DAO_FEE_RECEIVER = validateAddress(
    BOOT_DAO_FEE_RECEIVER,
    "setup-race boot DAO fee receiver",
);
const originalGetDaoAddress = ProtocolReader.prototype.getDaoAddress;
ProtocolReader.prototype.getDaoAddress = async () => BOOT_DAO_FEE_RECEIVER;
test.after(() => {
    ProtocolReader.prototype.getDaoAddress = originalGetDaoAddress;
});

function defer<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });

    return { promise, resolve, reject };
}

function ignoreMutationError(run: () => void) {
    try {
        run();
    } catch {
        // Frozen objects throw in strict mode; silent failure is also acceptable.
    }
}

function createZapMarket(name: string, symbol: string, tokenAddress: address) {
    return {
        name,
        symbol,
        setup: null,
        tokens: [
            {
                name,
                symbol,
                getAsset: () => ({
                    address: tokenAddress,
                    symbol,
                }),
            },
        ],
    };
}

function createDecimalsProvider(decimals: bigint = 18n) {
    return {
        async call(tx: { data?: string }) {
            if ((tx.data ?? "").slice(0, 10) !== DECIMALS_SELECTOR) {
                throw new Error(`Unexpected provider call: ${JSON.stringify(tx)}`);
            }

            return `0x${decimals.toString(16).padStart(64, "0")}`;
        },
        async getNetwork() {
            return { chainId: 143n, name: "monad-mainnet" };
        },
        async resolveName(name: string) {
            return name;
        },
    };
}

function summarizeDepositTokens(tokens: Awaited<ReturnType<Market["tokens"][number]["getDepositTokens"]>>) {
    return tokens.map((token) => ({
        type: token.type,
        address: token.interface.address.toLowerCase(),
        quoteable: typeof token.quote === "function",
    }));
}

function getMonadExcludedZapMarketFixtures() {
    const excludedSymbols = new Set(
        chain_config["monad-mainnet"].excluded_zap_symbols.map((symbol) => symbol.toLowerCase()),
    );
    const directAssetsBySymbol = new Map(
        [
            ...chain_config["monad-mainnet"].native_vaults.map((vault) => [
                vault.name.toLowerCase(),
                vault.contract,
            ] as const),
            ...chain_config["monad-mainnet"].vaults.map((vault) => [
                vault.name.toLowerCase(),
                vault.contract,
            ] as const),
        ],
    );
    const contracts = getContractAddresses("monad-mainnet") as any;
    const fixtures: Array<{
        market: address;
        symbol: string;
        cToken: address;
        asset: address;
    }> = [];

    for (const marketData of Object.values(contracts.markets) as any[]) {
        for (const [symbol, cToken] of Object.entries(marketData.tokens ?? {})) {
            if (excludedSymbols.has(symbol.toLowerCase())) {
                const syntheticAsset = `0x${(fixtures.length + 0x5000).toString(16).padStart(40, "0")}` as address;
                fixtures.push({
                    market: marketData.address as address,
                    symbol,
                    cToken: cToken as address,
                    asset: directAssetsBySymbol.get(symbol.toLowerCase()) ?? syntheticAsset,
                });
            }
        }
    }

    return fixtures;
}

test("setupChain only publishes the latest invocation", async (t) => {
    const rewardsA = defer<{ milestones: Record<string, any>; incentives: Record<string, any> }>();
    const rewardsB = defer<{ milestones: Record<string, any>; incentives: Record<string, any> }>();

    const originalGetRewards = Api.getRewards;
    const originalGetAll = Market.getAll;

    let rewardsCall = 0;

    Api.getRewards = (async () => {
        rewardsCall += 1;
        return rewardsCall === 1 ? rewardsA.promise : rewardsB.promise;
    }) as typeof Api.getRewards;

    Market.getAll = (async (_reader, _oracleManager, _provider, _signer, _account, _milestones, _incentives, setup) => {
        const activeSetup = setup!;
        return [{ marker: activeSetup.api_url }] as any;
    }) as typeof Market.getAll;

    t.after(() => {
        Api.getRewards = originalGetRewards;
        Market.getAll = originalGetAll;
    });

    const olderSetup = setupChain("monad-mainnet", null, "https://api.older.example");
    const newerSetup = setupChain("monad-mainnet", null, "https://api.newer.example");

    rewardsB.resolve({ milestones: {}, incentives: {} });
    const newerResult = await newerSetup;

    rewardsA.resolve({ milestones: {}, incentives: {} });
    const olderResult = await olderSetup;

    assert.equal(setup_config.api_url, "https://api.newer.example");
    assert.equal(setup_config.signer, null);
    assert.equal(setup_config.account, null);
    assert.equal(setup_config.provider, setup_config.readProvider);
    assert.deepEqual(all_markets, newerResult.markets);
    assert.notDeepEqual(all_markets, olderResult.markets);
    assert.equal((newerResult.markets[0] as any).marker, "https://api.newer.example");
    assert.equal((olderResult.markets[0] as any).marker, "https://api.older.example");
});

test("setupChain returns chain provenance and immutable setup snapshot", async (t) => {
    const originalGetRewards = Api.getRewards;
    const originalGetAll = Market.getAll;

    Api.getRewards = (async () => ({ milestones: {}, incentives: {} })) as typeof Api.getRewards;
    Market.getAll = (async (_reader, _oracleManager, _provider, _signer, _account, _milestones, _incentives, setup) => {
        return [{ setup }] as any;
    }) as typeof Market.getAll;

    t.after(() => {
        Api.getRewards = originalGetRewards;
        Market.getAll = originalGetAll;
    });

    const monad = await setupChain("monad-mainnet", null, "https://api.monad.example");
    assert.equal(monad.chain, "monad-mainnet");
    assert.equal(monad.chainId, 143);
    assert.equal(monad.setupConfigSnapshot.chain, "monad-mainnet");
    assert.equal(monad.setupConfigSnapshot.chainId, 143);
    assert.equal(monad.setupConfigSnapshot.environment, "production-mainnet");
    assert.equal((monad.markets[0] as any).setup, monad.setupConfigSnapshot);
    assert.equal((monad.markets[0] as any).setup.chain, monad.chain);
    assert.equal(Object.isFrozen(monad.setupConfigSnapshot), true);
    assert.equal(Object.isFrozen(monad.setupConfigSnapshot.contracts), true);
    assert.equal(Object.isFrozen(monad.setupConfigSnapshot.assets), true);
    assert.equal(Object.isFrozen(monad.setupConfigSnapshot.assets.native_vaults), true);
    assert.equal(Object.isFrozen(monad.setupConfigSnapshot.assets.excluded_zap_symbols), true);
    assert.equal(Object.isFrozen(monad.setupConfigSnapshot.assets.excluded_zap_addresses), true);
    assert.equal(Object.isFrozen(monad.setupConfigSnapshot.services), true);
    assert.equal(Object.isFrozen(monad.setupConfigSnapshot.services.curvanceApi.rewardChainAliases), true);
    assert.equal(Object.isFrozen(monad.setupConfigSnapshot.services.dexAggregators), true);
    assert.equal(Object.isFrozen(monad.setupConfigSnapshot.services.dexAggregators.kyberSwap), true);
    assert.notEqual(monad.setupConfigSnapshot.assets, chain_config["monad-mainnet"]);
    assert.notEqual(monad.setupConfigSnapshot.assets.native_vaults, chain_config["monad-mainnet"].native_vaults);
    assert.notEqual(monad.setupConfigSnapshot.assets.excluded_zap_symbols, chain_config["monad-mainnet"].excluded_zap_symbols);
    assert.notEqual(monad.setupConfigSnapshot.assets.excluded_zap_addresses, chain_config["monad-mainnet"].excluded_zap_addresses);
    assert.notEqual(monad.setupConfigSnapshot.services, chain_config["monad-mainnet"].services);
    assert.notEqual(
        monad.setupConfigSnapshot.services.curvanceApi.rewardChainAliases,
        chain_config["monad-mainnet"].services.curvanceApi.rewardChainAliases,
    );
    assert.notEqual(
        monad.setupConfigSnapshot.services.dexAggregators.kyberSwap,
        chain_config["monad-mainnet"].services.dexAggregators.kyberSwap,
    );

    const originalProtocolReader = monad.setupConfigSnapshot.contracts.ProtocolReader;
    const originalWrappedNative = chain_config["monad-mainnet"].wrapped_native;
    const originalNativeVaults = chain_config["monad-mainnet"].native_vaults.map((vault) => ({ ...vault }));
    const originalVaults = chain_config["monad-mainnet"].vaults.map((vault) => ({ ...vault }));
    const originalExcludedZapSymbols = [...chain_config["monad-mainnet"].excluded_zap_symbols];
    const originalExcludedZapAddresses = [...(chain_config["monad-mainnet"].excluded_zap_addresses ?? [])];
    const originalRewardsSlug = monad.setupConfigSnapshot.services.curvanceApi.rewardsSlug;
    const originalNativeYieldSlug = monad.setupConfigSnapshot.services.curvanceApi.nativeYieldSlug;
    const originalRewardAliases = [...chain_config["monad-mainnet"].services.curvanceApi.rewardChainAliases];
    const originalKyberRouter = monad.setupConfigSnapshot.services.dexAggregators.kyberSwap?.router;
    const originalExportedKyberRouter = chain_config["monad-mainnet"].services.dexAggregators.kyberSwap?.router;
    t.after(() => {
        (chain_config["monad-mainnet"] as any).wrapped_native = originalWrappedNative;
        chain_config["monad-mainnet"].native_vaults.splice(
            0,
            chain_config["monad-mainnet"].native_vaults.length,
            ...originalNativeVaults,
        );
        chain_config["monad-mainnet"].vaults.splice(
            0,
            chain_config["monad-mainnet"].vaults.length,
            ...originalVaults,
        );
        chain_config["monad-mainnet"].excluded_zap_symbols.splice(
            0,
            chain_config["monad-mainnet"].excluded_zap_symbols.length,
            ...originalExcludedZapSymbols,
        );
        chain_config["monad-mainnet"].excluded_zap_addresses?.splice(
            0,
            chain_config["monad-mainnet"].excluded_zap_addresses.length,
            ...originalExcludedZapAddresses,
        );
        chain_config["monad-mainnet"].services.curvanceApi.rewardChainAliases.splice(
            0,
            chain_config["monad-mainnet"].services.curvanceApi.rewardChainAliases.length,
            ...originalRewardAliases,
        );
        if (chain_config["monad-mainnet"].services.dexAggregators.kyberSwap != null && originalExportedKyberRouter != null) {
            chain_config["monad-mainnet"].services.dexAggregators.kyberSwap.router = originalExportedKyberRouter;
        }
    });
    ignoreMutationError(() => {
        (monad.setupConfigSnapshot as any).chain = "arb-sepolia";
    });
    ignoreMutationError(() => {
        (monad.setupConfigSnapshot.contracts as any).ProtocolReader = "0x0000000000000000000000000000000000000001";
    });
    ignoreMutationError(() => {
        (monad.setupConfigSnapshot.assets as any).wrapped_native = "0x0000000000000000000000000000000000000003";
    });
    ignoreMutationError(() => {
        (monad.setupConfigSnapshot.assets.excluded_zap_symbols as any).push("wrong");
    });
    ignoreMutationError(() => {
        (monad.setupConfigSnapshot.assets.excluded_zap_addresses as any).push("0x0000000000000000000000000000000000000008");
    });
    ignoreMutationError(() => {
        (monad.setupConfigSnapshot.services.curvanceApi as any).rewardsSlug = "wrong";
    });
    ignoreMutationError(() => {
        (monad.setupConfigSnapshot.services.curvanceApi as any).nativeYieldSlug = "wrong";
    });
    ignoreMutationError(() => {
        (monad.setupConfigSnapshot.services.dexAggregators.kyberSwap as any).router = "0x0000000000000000000000000000000000000006";
    });
    (chain_config["monad-mainnet"] as any).wrapped_native = "0x0000000000000000000000000000000000000004";
    chain_config["monad-mainnet"].native_vaults.push({
        name: "Wrong Native Vault",
        contract: "0x0000000000000000000000000000000000000005" as any,
    });
    chain_config["monad-mainnet"].excluded_zap_symbols.push("wrong-symbol");
    chain_config["monad-mainnet"].excluded_zap_addresses?.push("0x0000000000000000000000000000000000000009" as any);
    chain_config["monad-mainnet"].services.curvanceApi.rewardChainAliases.push("wrong-alias");
    if (chain_config["monad-mainnet"].services.dexAggregators.kyberSwap != null) {
        chain_config["monad-mainnet"].services.dexAggregators.kyberSwap.router =
            "0x0000000000000000000000000000000000000007" as any;
    }
    assert.equal(monad.setupConfigSnapshot.chain, "monad-mainnet");
    assert.equal(monad.setupConfigSnapshot.contracts.ProtocolReader, originalProtocolReader);
    assert.equal(monad.setupConfigSnapshot.assets.wrapped_native, originalWrappedNative);
    assert.deepEqual(monad.setupConfigSnapshot.assets.native_vaults, originalNativeVaults);
    assert.deepEqual(monad.setupConfigSnapshot.assets.excluded_zap_symbols, originalExcludedZapSymbols);
    assert.deepEqual(monad.setupConfigSnapshot.assets.excluded_zap_addresses, originalExcludedZapAddresses);
    assert.equal(monad.setupConfigSnapshot.services.curvanceApi.rewardsSlug, originalRewardsSlug);
    assert.equal(monad.setupConfigSnapshot.services.curvanceApi.nativeYieldSlug, originalNativeYieldSlug);
    assert.deepEqual(monad.setupConfigSnapshot.services.curvanceApi.rewardChainAliases, originalRewardAliases);
    assert.equal(monad.setupConfigSnapshot.services.dexAggregators.kyberSwap?.router, originalKyberRouter);
    assert.equal(
        monad.setupConfigSnapshot.feePolicy.getFeeBps({
            operation: "zap",
            inputToken: NATIVE_ADDRESS,
            outputToken: originalWrappedNative,
            inputAmount: 1n,
            currentLeverage: null,
            targetLeverage: null,
        }),
        0n,
    );
    assert.equal(
        monad.setupConfigSnapshot.feePolicy.getFeeBps({
            operation: "zap",
            inputToken: NATIVE_ADDRESS,
            outputToken: chain_config["monad-mainnet"].wrapped_native,
            inputAmount: 1n,
            currentLeverage: null,
            targetLeverage: null,
        }),
        CURVANCE_FEE_BPS,
    );
    if (chain_config["monad-mainnet"].services.dexAggregators.kyberSwap != null && originalExportedKyberRouter != null) {
        chain_config["monad-mainnet"].services.dexAggregators.kyberSwap.router = originalExportedKyberRouter;
    }

    const mutableContractsCopy = getContractAddresses("monad-mainnet") as any;
    mutableContractsCopy.ProtocolReader = "0x0000000000000000000000000000000000000002";
    const nextMonad = await setupChain("monad-mainnet", null, "https://api.monad-next.example");
    assert.equal(nextMonad.setupConfigSnapshot.contracts.ProtocolReader, originalProtocolReader);
});

test("setupChain boots non-Monad chains successfully with result provenance", async (t) => {
    const originalGetRewards = Api.getRewards;
    const originalGetAll = Market.getAll;

    Api.getRewards = (async () => ({ milestones: {}, incentives: {} })) as typeof Api.getRewards;
    Market.getAll = (async (_reader, _oracleManager, _provider, _signer, _account, _milestones, _incentives, setup) => {
        return [{ setup }] as any;
    }) as typeof Market.getAll;

    t.after(() => {
        Api.getRewards = originalGetRewards;
        Market.getAll = originalGetAll;
    });

    const result = await setupChain("arb-sepolia", null, "https://api.arb.example");

    assert.equal(result.chain, "arb-sepolia");
    assert.equal(result.chainId, 421614);
    assert.equal(result.setupConfigSnapshot.chain, "arb-sepolia");
    assert.equal(result.setupConfigSnapshot.chainId, 421614);
    assert.ok(result.dexAgg instanceof UnsupportedDexAgg);
    assert.equal(setup_config.chain, "arb-sepolia");
    assert.equal((result.markets[0] as any).setup.chain, "arb-sepolia");
    assert.equal(result.setupConfigSnapshot.feePolicy.getFeeBps({
        operation: "zap",
        inputToken: "0x0000000000000000000000000000000000000001" as any,
        outputToken: "0x0000000000000000000000000000000000000002" as any,
        inputAmount: 1n,
        currentLeverage: null,
        targetLeverage: null,
    }), CURVANCE_FEE_BPS);
    assert.equal(result.setupConfigSnapshot.feePolicy.feeReceiver, BOOT_DAO_FEE_RECEIVER);
});

test("setupChain boots arb-sepolia through Market.getAll with chain-scoped enrichment", async (t) => {
    const milestone = {
        market: ARB_STABLE_MARKET,
        tvl: 123,
        multiplier: 1,
        fail_multiplier: 0,
        chain_network: "arb-sepolia",
        start_date: "2026-01-01",
        end_date: "2026-01-02",
        duration_in_days: 1,
    };
    const incentive = {
        market: ARB_STABLE_MARKET,
        type: "supply",
        rate: 1,
        description: "Arbitrum setup boot incentive",
        image: "",
    };

    const harness = installSetupChainBootHarness(t, {
        rewards: () => ({
            milestones: { [ARB_STABLE_MARKET.toUpperCase()]: milestone },
            incentives: { [ARB_STABLE_MARKET.toUpperCase()]: [incentive] },
        }),
        marketData: () => ({
            staticMarket: [
                createBootStaticMarket(ARB_UNKNOWN_MARKET, [{ cToken: ARB_UNKNOWN_TOKEN, symbol: "SKIP" }]),
                createBootStaticMarket(ARB_STABLE_MARKET, [
                    { cToken: ARB_USDC_CTOKEN, symbol: "USDC" },
                    { cToken: ARB_AUSD_CTOKEN, symbol: "AUSD" },
                ]),
            ],
            dynamicMarket: [
                createBootDynamicMarket(ARB_UNKNOWN_MARKET, [ARB_UNKNOWN_TOKEN]),
                createBootDynamicMarket(ARB_STABLE_MARKET, [ARB_USDC_CTOKEN, ARB_AUSD_CTOKEN]),
            ],
            userData: {
                locks: [],
                markets: [
                    createBootUserMarket(ARB_UNKNOWN_MARKET, [ARB_UNKNOWN_TOKEN]),
                    createBootUserMarket(ARB_STABLE_MARKET, [ARB_USDC_CTOKEN, ARB_AUSD_CTOKEN]),
                ],
            },
        }),
        merkl: () => [
            {
                identifier: ARB_STABLE_MARKET,
                apr: 21,
                name: "arb lend",
                type: "merkl",
                action: "LEND",
                tokens: [{ address: ARB_USDC_CTOKEN, symbol: "cUSDC" }],
            },
            {
                identifier: ARB_AUSD_CTOKEN,
                apr: 7,
                name: "arb borrow",
                type: "merkl",
                action: "BORROW",
                tokens: [],
            },
        ],
    });

    const result = await setupChain("arb-sepolia", null, "https://api.arb-e2e.example", {
        account: ARB_ACCOUNT,
    });

    assert.deepEqual(harness.rewardsConfigs, [{ chain: "arb-sepolia", apiUrl: "https://api.arb-e2e.example" }]);
    assert.equal(result.chain, "arb-sepolia");
    assert.equal(result.chainId, 421614);
    assert.equal(result.setupConfigSnapshot.chain, "arb-sepolia");
    assert.equal(setup_config.chain, "arb-sepolia");
    assert.equal(all_markets, result.markets);

    assert.equal(harness.readerContexts.length, 1);
    const readerContext = harness.readerContexts[0];
    assert.ok(readerContext);
    assert.equal(readerContext.account, ARB_ACCOUNT);
    assert.equal(readerContext.address.toLowerCase(), String(result.setupConfigSnapshot.contracts.ProtocolReader).toLowerCase());
    assert.equal(readerContext.batchKey, result.reader.batchKey);
    assert.match(readerContext.batchKey ?? "", /^arb-sepolia:/);

    assert.deepEqual(harness.merklCalls, [
        { action: undefined, chainId: 421614 },
    ]);
    assert.deepEqual(harness.externalFetchCalls, [], "arb-sepolia native-yield path should not make an HTTP request");
    assert.ok(
        harness.warnings.some((message) => message.includes(ARB_UNKNOWN_MARKET)),
        "testnet setup should warn and skip reader markets that lack deployment metadata",
    );

    assert.equal(result.markets.length, 1);
    const market = result.markets[0];
    assert.ok(market);
    assert.equal(market.name, "Stable Market");
    assert.equal(market.address, ARB_STABLE_MARKET);
    assert.equal(market.setup, result.setupConfigSnapshot);
    assert.equal(market.setup.chain, "arb-sepolia");
    assert.equal(market.reader, result.reader);
    assert.equal(market.milestone, milestone);
    assert.deepEqual(market.incentives, [incentive]);

    const tokensByAddress = new Map(market.tokens.map((token) => [token.address.toLowerCase(), token]));
    const usdc = tokensByAddress.get(ARB_USDC_CTOKEN.toLowerCase())!;
    const ausd = tokensByAddress.get(ARB_AUSD_CTOKEN.toLowerCase())!;
    assert.ok(usdc);
    assert.ok(ausd);

    assert.equal(usdc.incentiveSupplyApy.toString(), "0.21");
    assert.equal(usdc.nativeApy.toString(), "0");
    assert.equal(ausd.incentiveBorrowApy.toString(), "0.07");
    assert.equal(ausd.nativeApy.toString(), "0");
    assert.equal(usdc.canZap, false);
    assert.deepEqual(usdc.zapTypes, []);
    assert.deepEqual((await usdc.getDepositTokens()).map((token) => token.type), ["none"]);
    assert.equal(usdc.canLeverage, false);
    assert.deepEqual(usdc.leverageTypes, []);
    assert.equal(ausd.canZap, false);
    assert.deepEqual(ausd.zapTypes, []);
    assert.deepEqual((await ausd.getDepositTokens()).map((token) => token.type), ["none"]);

    assert.ok(result.dexAgg instanceof UnsupportedDexAgg);
    assert.deepEqual(
        await result.dexAgg.getAvailableTokens(result.setupConfigSnapshot.readProvider, null, ARB_ACCOUNT),
        [],
    );
    await assert.rejects(
        () => result.dexAgg.quote(ARB_ACCOUNT, ARB_USDC_CTOKEN, ARB_AUSD_CTOKEN, 1n, 50n),
        /DEX aggregation is not configured for arb-sepolia\./,
    );
});

test("setupChain hydrates API2 asset points while keeping removed milestones empty", async (t) => {
    const correctMilestone = {
        market: MONAD_MARKET,
        tvl: 123,
        multiplier: 2,
        fail_multiplier: 0,
        chain_network: "monad-mainnet",
        start_date: "2026-01-01",
        end_date: "2026-01-02",
        duration_in_days: 1,
    };
    const wrongChainMilestone = {
        market: MONAD_MARKET,
        tvl: 999,
        multiplier: 99,
        fail_multiplier: 0,
        chain_network: "Arbitrum Sepolia",
        start_date: "2026-01-01",
        end_date: "2026-01-02",
        duration_in_days: 1,
    };
    const correctGlobalMilestone = {
        market: "global",
        tvl: 456,
        multiplier: 3,
        fail_multiplier: 0,
        chain_network: "monad",
        start_date: "2026-01-01",
        end_date: "2026-01-02",
        duration_in_days: 1,
    };
    const wrongChainGlobalMilestone = {
        market: "global",
        tvl: 999,
        multiplier: 99,
        fail_multiplier: 0,
        chain_network: "Arbitrum Sepolia",
        start_date: "2026-01-01",
        end_date: "2026-01-02",
        duration_in_days: 1,
    };
    const legacyIncentive = {
        market: MONAD_MARKET,
        type: "supply",
        rate: 1,
        description: "legacy no-chain incentive",
        image: "stars-rewards",
    };
    const correctIncentive = {
        market: MONAD_MARKET,
        type: "supply",
        rate: 2,
        description: "monad incentive",
        image: "stars-rewards",
        chain_network: "Monad Mainnet",
    };
    const wrongChainIncentive = {
        market: MONAD_MARKET,
        type: "supply",
        rate: 99,
        description: "ethereum incentive",
        image: "stars-rewards",
        chain_network: "Ethereum",
    };

    const harness = installSetupChainBootHarness(t, {
        rewards: false,
        marketData: (context) => {
            assert.match(context.batchKey ?? "", /^monad-mainnet:/);
            return {
                staticMarket: [
                    createBootStaticMarket(MONAD_MARKET, [
                        { cToken: MONAD_WMON_CTOKEN, symbol: "WMON", asset: MONAD_WRAPPED_NATIVE },
                        { cToken: MONAD_USDC_CTOKEN, symbol: "USDC", asset: MONAD_USDC_ASSET },
                    ]),
                ],
                dynamicMarket: [
                    createBootDynamicMarket(MONAD_MARKET, [MONAD_WMON_CTOKEN, MONAD_USDC_CTOKEN]),
                ],
                userData: {
                    locks: [],
                    markets: [
                        createBootUserMarket(MONAD_MARKET, [MONAD_WMON_CTOKEN, MONAD_USDC_CTOKEN]),
                    ],
                },
            };
        },
        fetch: async (url) => {
            if (url === "https://api.monad-rewards.example/asset/143") {
                return {
                    ok: true,
                    json: async () => [{
                        chain_id: 143,
                        token: MONAD_WRAPPED_NATIVE,
                        symbol: "WMON",
                        token_image: "wmon.svg",
                        market_address: MONAD_MARKET,
                        vault: false,
                        percent_native_apy: 0,
                        points: [
                            { type: "legacy", rate: 1, image: "stars-rewards" },
                            { type: "monad", rate: 2, image: "stars-rewards" },
                        ],
                    }],
                };
            }

            throw new Error(`Unexpected fetch URL: ${url}`);
        },
    });

    const result = await setupChain("monad-mainnet", null, "https://api.monad-rewards.example", {
        account: MONAD_ACCOUNT,
        readProvider: createDecimalsReadProvider(143n) as any,
    });
    const market = result.markets[0];

    assert.ok(market);
    assert.equal(market.milestone, null);
    assert.equal(result.global_milestone, null);
    assert.deepEqual(
        market.incentives.map((incentive) => incentive.description),
        ["legacy", "monad"],
    );
    assert.deepEqual(harness.externalFetchCalls, [
        "https://api.monad-rewards.example/asset/143",
    ]);
});

test("setupChain hydrates Merkl APY through the real chain-filtered opportunity fetch", async (t) => {
    const harness = installSetupChainBootHarness(t, {
        rewards: () => ({ milestones: {}, incentives: {} }),
        merkl: false,
        marketData: () => ({
            staticMarket: [
                createBootStaticMarket(MONAD_MARKET, [
                    { cToken: MONAD_WMON_CTOKEN, symbol: "WMON", asset: MONAD_WRAPPED_NATIVE },
                    { cToken: MONAD_USDC_CTOKEN, symbol: "USDC", asset: MONAD_USDC_ASSET },
                ]),
            ],
            dynamicMarket: [
                createBootDynamicMarket(MONAD_MARKET, [MONAD_WMON_CTOKEN, MONAD_USDC_CTOKEN]),
            ],
            userData: {
                locks: [],
                markets: [
                    createBootUserMarket(MONAD_MARKET, [MONAD_WMON_CTOKEN, MONAD_USDC_CTOKEN]),
                ],
            },
        }),
        fetch: async (urlString) => {
            const url = new URL(urlString);

            if (urlString === "https://api.monad-merkl.example/v1/monad/native_apy") {
                return {
                    ok: true,
                    json: async () => ({ native_apy: [] }),
                };
            }

            let merklUrl: URL | null = null;
            if (url.origin === "https://api2.curvance.com" && url.pathname === "/merkl/proxy") {
                const proxiedUrl = url.searchParams.get("url");
                assert.ok(proxiedUrl);
                merklUrl = new URL(proxiedUrl);
            }

            if (merklUrl?.origin === "https://api.merkl.xyz" && merklUrl.pathname === "/v4/opportunities") {
                assert.equal(merklUrl.searchParams.get("mainProtocolId"), "curvance");
                assert.equal(merklUrl.searchParams.get("chainId"), "143");
                assert.equal(merklUrl.searchParams.get("action"), null);
                return {
                    ok: true,
                    json: async () => [
                        {
                            identifier: "setup-monad-lend",
                            apr: 10,
                            name: "setup monad lend",
                            type: "merkl",
                            action: "LEND",
                            chain: { id: 143, name: "Monad" },
                            chainId: 143,
                            computeChainId: 143,
                            distributionChainId: 143,
                            tokens: [{ address: MONAD_WMON_CTOKEN, symbol: "cWMON" }],
                        },
                        {
                            identifier: MONAD_WMON_CTOKEN,
                            apr: 5,
                            name: "setup metadata-less lend",
                            type: "merkl",
                            tokens: [],
                        },
                        {
                            identifier: "setup conflicting lend",
                            apr: 100,
                            name: "setup conflicting lend",
                            type: "merkl",
                            action: "LEND",
                            chain: { id: 143, name: "Monad" },
                            distributionChainId: 421614,
                            tokens: [{ address: MONAD_WMON_CTOKEN, symbol: "cWMON" }],
                        },
                        {
                            identifier: "setup malformed lend",
                            apr: 200,
                            name: "setup malformed lend",
                            type: "merkl",
                            action: "LEND",
                            chainId: "143",
                            tokens: [{ address: MONAD_WMON_CTOKEN, symbol: "cWMON" }],
                        },
                        {
                            identifier: "setup wrong-action lend",
                            apr: 300,
                            name: "setup wrong-action lend",
                            type: "merkl",
                            action: "BORROW",
                            chainId: 143,
                            tokens: [{ address: MONAD_WMON_CTOKEN, symbol: "cWMON" }],
                        },
                        {
                            identifier: MONAD_USDC_CTOKEN,
                            apr: 2,
                            name: "setup monad borrow",
                            type: "merkl",
                            action: "BORROW",
                            chainId: 143,
                            computeChainId: 143,
                            distributionChainId: 143,
                            tokens: [],
                        },
                        {
                            identifier: MONAD_USDC_CTOKEN.toUpperCase(),
                            apr: 3,
                            name: "setup metadata-less borrow",
                            type: "merkl",
                            action: "BORROW",
                            tokens: [],
                        },
                        {
                            identifier: MONAD_USDC_CTOKEN,
                            apr: 100,
                            name: "setup wrong-chain borrow",
                            type: "merkl",
                            action: "BORROW",
                            chainId: 421614,
                            tokens: [],
                        },
                        {
                            identifier: MONAD_USDC_CTOKEN,
                            apr: 200,
                            name: "setup conflicting borrow",
                            type: "merkl",
                            action: "BORROW",
                            chainId: 143,
                            computeChainId: 421614,
                            tokens: [],
                        },
                        {
                            identifier: MONAD_USDC_CTOKEN,
                            apr: 300,
                            name: "setup malformed borrow",
                            type: "merkl",
                            action: "BORROW",
                            distributionChainId: "143",
                            tokens: [],
                        },
                        {
                            identifier: "setup wrong-action borrow",
                            apr: 300,
                            name: "setup wrong-action borrow",
                            type: "merkl",
                            action: "LEND",
                            chainId: 143,
                            tokens: [],
                        },
                    ],
                };
            }

            throw new Error(`Unexpected fetch URL: ${urlString}`);
        },
    });

    const result = await setupChain("monad-mainnet", null, "https://api.monad-merkl.example", {
        account: MONAD_ACCOUNT,
        readProvider: createDecimalsReadProvider(143n) as any,
    });

    assert.deepEqual(harness.merklCalls, [], "test should exercise the real Merkl fetch helper");
    assert.equal(harness.externalFetchCalls.length, 2);

    const market = result.markets[0];
    assert.ok(market);
    const tokensByAddress = new Map(market.tokens.map((token) => [token.address.toLowerCase(), token]));
    const wmon = tokensByAddress.get(MONAD_WMON_CTOKEN.toLowerCase());
    const usdc = tokensByAddress.get(MONAD_USDC_CTOKEN.toLowerCase());
    assert.ok(wmon);
    assert.ok(usdc);
    assert.equal(wmon.incentiveSupplyApy.toString(), "0.15");
    assert.equal(usdc.incentiveBorrowApy.toString(), "0.05");
});

test("setupChain keeps market token DEX routes bound after a later chain boot moves the singleton", async (t) => {
    const harness = installSetupChainBootHarness(t, {
        marketData: (context) => {
            if (context.batchKey?.startsWith("monad-mainnet:")) {
                return {
                    staticMarket: [
                        createBootStaticMarket(MONAD_MARKET, [
                            { cToken: MONAD_WMON_CTOKEN, symbol: "WMON", asset: MONAD_WRAPPED_NATIVE },
                            { cToken: MONAD_USDC_CTOKEN, symbol: "USDC", asset: MONAD_USDC_ASSET },
                        ]),
                    ],
                    dynamicMarket: [
                        createBootDynamicMarket(MONAD_MARKET, [MONAD_WMON_CTOKEN, MONAD_USDC_CTOKEN]),
                    ],
                    userData: {
                        locks: [],
                        markets: [
                            createBootUserMarket(MONAD_MARKET, [MONAD_WMON_CTOKEN, MONAD_USDC_CTOKEN]),
                        ],
                    },
                };
            }

            if (context.batchKey?.startsWith("arb-sepolia:")) {
                return {
                    staticMarket: [
                        createBootStaticMarket(ARB_STABLE_MARKET, [
                            { cToken: ARB_USDC_CTOKEN, symbol: "USDC" },
                            { cToken: ARB_AUSD_CTOKEN, symbol: "AUSD" },
                        ]),
                    ],
                    dynamicMarket: [
                        createBootDynamicMarket(ARB_STABLE_MARKET, [ARB_USDC_CTOKEN, ARB_AUSD_CTOKEN]),
                    ],
                    userData: {
                        locks: [],
                        markets: [
                            createBootUserMarket(ARB_STABLE_MARKET, [ARB_USDC_CTOKEN, ARB_AUSD_CTOKEN]),
                        ],
                    },
                };
            }

            throw new Error(`Unexpected setup boot reader context: ${context.batchKey}`);
        },
        fetch: async (url) => {
            assert.equal(url, "https://api.monad-e2e.example/asset/143");
            return {
                ok: true,
                json: async () => [],
            };
        },
    });

    const monadResult = await setupChain("monad-mainnet", null, "https://api.monad-e2e.example", {
        account: MONAD_ACCOUNT,
        readProvider: createDecimalsReadProvider(143n) as any,
    });
    const monadMarket = monadResult.markets[0];
    assert.ok(monadMarket);
    const monadUsdc = monadMarket.tokens.find(
        (token) => token.address.toLowerCase() === MONAD_USDC_CTOKEN.toLowerCase(),
    );
    assert.ok(monadUsdc);

    const quoteCalls: Array<{
        wallet: string;
        tokenIn: string;
        tokenOut: string;
        amount: bigint;
        feeBps: bigint | undefined;
        feeReceiver: string | undefined;
    }> = [];
    (monadResult.dexAgg as any).quote = async (
        wallet: string,
        tokenIn: string,
        tokenOut: string,
        amount: bigint,
        _slippage: bigint,
        feeBps?: bigint,
        feeReceiver?: address,
    ) => {
        quoteCalls.push({ wallet, tokenIn, tokenOut, amount, feeBps, feeReceiver });
        return {
            to: tokenOut as address,
            calldata: "0x" as bytes,
            min_out: 1n,
            out: 2n,
        };
    };

    const arbResult = await setupChain("arb-sepolia", null, "https://api.arb-after-monad.example", {
        account: ARB_ACCOUNT,
        readProvider: createDecimalsReadProvider(421614n) as any,
    });
    assert.equal(setup_config.chain, "arb-sepolia");
    assert.equal(all_markets, arbResult.markets);

    const depositTokens = await monadUsdc.getDepositTokens();
    assert.deepEqual(monadUsdc.zapTypes, ["simple"]);
    assert.deepEqual(monadUsdc.leverageTypes, ["simple"]);
    assert.equal(monadUsdc.canZap, true);
    assert.equal(monadUsdc.canLeverage, true);

    const simpleAddresses = depositTokens
        .filter((token) => token.type === "simple")
        .map((token) => token.interface.address.toLowerCase());
    const quoteableDexSimpleOptions = depositTokens.filter(
        (token) => token.type === "simple" && token.interface.address.toLowerCase() !== NATIVE_ADDRESS.toLowerCase(),
    );

    assert.ok(
        simpleAddresses.includes(MONAD_WRAPPED_NATIVE.toLowerCase()),
        "older Monad token route discovery should still use the Monad boot markets",
    );
    assert.equal(
        simpleAddresses.includes(ARB_USDC_CTOKEN.toLowerCase()) || simpleAddresses.includes(ARB_AUSD_CTOKEN.toLowerCase()),
        false,
        "older Monad token route discovery must not read Arbitrum singleton markets after a later boot",
    );
    assert.ok(quoteableDexSimpleOptions.length > 0, "expected at least one DEX-sourced simple zap option");
    assert.equal(
        quoteableDexSimpleOptions.every((token) => typeof token.quote === "function"),
        true,
        "every advertised DEX-sourced simple zap option must expose a quote callback",
    );

    const wrappedNativeZap = depositTokens.find(
        (token) => token.type === "simple" && token.interface.address.toLowerCase() === MONAD_WRAPPED_NATIVE.toLowerCase(),
    );
    assert.ok(wrappedNativeZap?.quote);
    await wrappedNativeZap.quote(MONAD_WRAPPED_NATIVE, MONAD_USDC_ASSET, Decimal(1), Decimal(0.01));

    assert.deepEqual(quoteCalls, [{
        wallet: MONAD_ACCOUNT,
        tokenIn: MONAD_WRAPPED_NATIVE,
        tokenOut: MONAD_USDC_ASSET,
        amount: 1_000_000_000_000_000_000n,
        feeBps: CURVANCE_FEE_BPS,
        feeReceiver: BOOT_DAO_FEE_RECEIVER,
    }]);
    assert.deepEqual(harness.merklCalls, [
        { action: undefined, chainId: 143 },
        { action: undefined, chainId: 421614 },
    ]);
    assert.deepEqual(harness.externalFetchCalls, ["https://api.monad-e2e.example/asset/143"]);
});

test("setupChain exposes a deterministic Monad route matrix from setup assets and deployed plugins", async (t) => {
    const shmonVault = chain_config["monad-mainnet"].native_vaults.find((vault) => vault.name === "shMON");
    const sAusdVault = chain_config["monad-mainnet"].vaults.find((vault) => vault.name === "sAUSD");
    assert.ok(shmonVault);
    assert.ok(sAusdVault);

    installSetupChainBootHarness(t, {
        marketData: (context) => {
            assert.ok(context.batchKey?.startsWith("monad-mainnet:"));
            return {
                staticMarket: [
                    createBootStaticMarket(MONAD_MARKET, [
                        { cToken: MONAD_WMON_CTOKEN, symbol: "WMON", asset: MONAD_WRAPPED_NATIVE },
                        { cToken: MONAD_USDC_CTOKEN, symbol: "USDC", asset: MONAD_USDC_ASSET },
                    ]),
                    createBootStaticMarket(MONAD_SHMON_MARKET, [
                        { cToken: MONAD_SHMON_CTOKEN, symbol: "shMON", asset: shmonVault.contract },
                        { cToken: MONAD_SHMON_WMON_CTOKEN, symbol: "WMON", asset: MONAD_WRAPPED_NATIVE },
                    ]),
                    createBootStaticMarket(MONAD_SAUSD_MARKET, [
                        { cToken: MONAD_SAUSD_CTOKEN, symbol: "sAUSD", asset: sAusdVault.contract },
                        { cToken: MONAD_AUSD_CTOKEN, symbol: "AUSD", asset: sAusdVault.underlying },
                    ]),
                ],
                dynamicMarket: [
                    createBootDynamicMarket(MONAD_MARKET, [MONAD_WMON_CTOKEN, MONAD_USDC_CTOKEN]),
                    createBootDynamicMarket(MONAD_SHMON_MARKET, [MONAD_SHMON_CTOKEN, MONAD_SHMON_WMON_CTOKEN]),
                    createBootDynamicMarket(MONAD_SAUSD_MARKET, [MONAD_SAUSD_CTOKEN, MONAD_AUSD_CTOKEN]),
                ],
                userData: {
                    locks: [],
                    markets: [
                        createBootUserMarket(MONAD_MARKET, [MONAD_WMON_CTOKEN, MONAD_USDC_CTOKEN]),
                        createBootUserMarket(MONAD_SHMON_MARKET, [MONAD_SHMON_CTOKEN, MONAD_SHMON_WMON_CTOKEN]),
                        createBootUserMarket(MONAD_SAUSD_MARKET, [MONAD_SAUSD_CTOKEN, MONAD_AUSD_CTOKEN]),
                    ],
                },
            };
        },
        fetch: async (url) => {
            assert.equal(url, "https://api.monad-route-matrix.example/v1/monad/native_apy");
            return {
                ok: true,
                json: async () => ({ native_apy: [] }),
            };
        },
    });

    const result = await setupChain("monad-mainnet", null, "https://api.monad-route-matrix.example", {
        account: MONAD_ACCOUNT,
        readProvider: createDecimalsReadProvider(143n) as any,
    });

    const dexTokenRows = [{
        interface: { address: MONAD_WRAPPED_NATIVE, symbol: "WMON", name: "Wrapped Monad", decimals: 18n },
        type: "simple",
        quote: async () => ({
            minOut_raw: 1n,
            output_raw: 2n,
            minOut: Decimal(1),
            output: Decimal(2),
        }),
    }, {
        interface: { address: MONAD_USDC_ASSET, symbol: "USDC", name: "USD Coin", decimals: 6n },
        type: "simple",
        quote: async () => ({
            minOut_raw: 3n,
            output_raw: 4n,
            minOut: Decimal(3),
            output: Decimal(4),
        }),
    }, {
        interface: { address: MONAD_SAUSD_CTOKEN, symbol: "sAUSD", name: "Staked AUSD", decimals: 18n },
        type: "simple",
        quote: async () => ({
            minOut_raw: 5n,
            output_raw: 6n,
            minOut: Decimal(5),
            output: Decimal(6),
        }),
    }];
    (result.dexAgg as any).getAvailableTokens = async () => dexTokenRows;

    const tokenByAddress = new Map(
        result.markets.flatMap((market) => market.tokens)
            .map((token) => [token.address.toLowerCase(), token]),
    );
    const wmon = tokenByAddress.get(MONAD_WMON_CTOKEN.toLowerCase());
    const usdc = tokenByAddress.get(MONAD_USDC_CTOKEN.toLowerCase());
    const shmon = tokenByAddress.get(MONAD_SHMON_CTOKEN.toLowerCase());
    const sAusd = tokenByAddress.get(MONAD_SAUSD_CTOKEN.toLowerCase());
    assert.ok(wmon);
    assert.ok(usdc);
    assert.ok(shmon);
    assert.ok(sAusd);

    assert.deepEqual(wmon.zapTypes, ["native-simple", "simple"]);
    assert.deepEqual(wmon.leverageTypes, ["simple"]);
    assert.deepEqual(summarizeDepositTokens(await wmon.getDepositTokens()), [
        { type: "none", address: MONAD_WRAPPED_NATIVE.toLowerCase(), quoteable: false },
        { type: "native-simple", address: NATIVE_ADDRESS.toLowerCase(), quoteable: false },
        { type: "simple", address: MONAD_USDC_ASSET.toLowerCase(), quoteable: true },
    ]);

    assert.deepEqual(usdc.zapTypes, ["simple"]);
    assert.deepEqual(usdc.leverageTypes, ["simple"]);
    assert.deepEqual(summarizeDepositTokens(await usdc.getDepositTokens()), [
        { type: "none", address: MONAD_USDC_ASSET.toLowerCase(), quoteable: false },
        { type: "simple", address: MONAD_WRAPPED_NATIVE.toLowerCase(), quoteable: true },
        { type: "simple", address: NATIVE_ADDRESS.toLowerCase(), quoteable: false },
    ]);

    const originalExcludedZapSymbols = [...chain_config["monad-mainnet"].excluded_zap_symbols];
    t.after(() => {
        chain_config["monad-mainnet"].excluded_zap_symbols.splice(
            0,
            chain_config["monad-mainnet"].excluded_zap_symbols.length,
            ...originalExcludedZapSymbols,
        );
    });
    chain_config["monad-mainnet"].excluded_zap_symbols.push("USDC");
    usdc.refreshRouteCapabilities();
    assert.deepEqual(usdc.zapTypes, ["simple"]);
    assert.deepEqual(usdc.leverageTypes, ["simple"]);
    assert.deepEqual(
        summarizeDepositTokens(await usdc.getDepositTokens()),
        [
            { type: "none", address: MONAD_USDC_ASSET.toLowerCase(), quoteable: false },
            { type: "simple", address: MONAD_WRAPPED_NATIVE.toLowerCase(), quoteable: true },
            { type: "simple", address: NATIVE_ADDRESS.toLowerCase(), quoteable: false },
        ],
        "returned tokens should keep setup-time zap exclusions after exported chain config moves",
    );

    assert.deepEqual(shmon.zapTypes, ["native-vault", "simple"]);
    assert.deepEqual(shmon.leverageTypes, ["native-vault", "simple"]);
    assert.deepEqual(summarizeDepositTokens(await shmon.getDepositTokens()), [
        { type: "none", address: shmonVault.contract.toLowerCase(), quoteable: false },
        { type: "native-vault", address: NATIVE_ADDRESS.toLowerCase(), quoteable: false },
        { type: "simple", address: MONAD_WRAPPED_NATIVE.toLowerCase(), quoteable: true },
        { type: "simple", address: MONAD_USDC_ASSET.toLowerCase(), quoteable: true },
    ]);

    assert.deepEqual(sAusd.zapTypes, []);
    assert.deepEqual(sAusd.leverageTypes, []);
    assert.deepEqual(summarizeDepositTokens(await sAusd.getDepositTokens()), [
        { type: "none", address: sAusdVault.contract.toLowerCase(), quoteable: false },
    ]);
});

test("setupChain suppresses every configured Monad zap-excluded deployed market", async (t) => {
    const excludedFixtures = getMonadExcludedZapMarketFixtures();
    const configuredExclusions = chain_config["monad-mainnet"].excluded_zap_symbols
        .map((symbol) => symbol.toLowerCase())
        .sort();
    const fixtureSymbols = [...new Set(excludedFixtures
        .map((fixture) => fixture.symbol.toLowerCase()))]
        .sort();
    assert.deepEqual(fixtureSymbols, configuredExclusions);

    installSetupChainBootHarness(t, {
        marketData: () => ({
            staticMarket: excludedFixtures.map((fixture) => createBootStaticMarket(fixture.market, [{
                cToken: fixture.cToken,
                symbol: fixture.symbol.toUpperCase(),
                asset: fixture.asset,
            }])),
            dynamicMarket: excludedFixtures.map((fixture) => createBootDynamicMarket(fixture.market, [fixture.cToken])),
            userData: {
                locks: [],
                markets: excludedFixtures.map((fixture) => createBootUserMarket(fixture.market, [fixture.cToken])),
            },
        }),
        fetch: async (url) => {
            assert.equal(url, "https://api.monad-exclusions.example/v1/monad/native_apy");
            return {
                ok: true,
                json: async () => ({ native_apy: [] }),
            };
        },
    });

    const result = await setupChain("monad-mainnet", null, "https://api.monad-exclusions.example", {
        account: MONAD_ACCOUNT,
        readProvider: createDecimalsReadProvider(143n) as any,
    });
    let dexAvailableCalls = 0;
    (result.dexAgg as any).getAvailableTokens = async () => {
        dexAvailableCalls += 1;
        return [{
            interface: { address: MONAD_USDC_ASSET, symbol: "USDC", name: "USD Coin", decimals: 6n },
            type: "simple",
            quote: async () => ({
                minOut_raw: 1n,
                output_raw: 2n,
                minOut: Decimal(1),
                output: Decimal(2),
            }),
        }];
    };

    const tokens = result.markets.flatMap((market) => market.tokens);
    assert.equal(tokens.length, excludedFixtures.length);
    for (const fixture of excludedFixtures) {
        const token = tokens.find((candidate) => candidate.address.toLowerCase() === fixture.cToken.toLowerCase());
        assert.ok(token, `expected booted token for ${fixture.symbol}`);
        assert.deepEqual(token.zapTypes, [], `${fixture.symbol} must not advertise zap routes`);
        assert.deepEqual(token.leverageTypes, [], `${fixture.symbol} must not advertise leverage routes`);
        assert.deepEqual(summarizeDepositTokens(await token.getDepositTokens()), [{
            type: "none",
            address: fixture.asset.toLowerCase(),
            quoteable: false,
        }]);
    }
    assert.equal(dexAvailableCalls, 0, "excluded route targets should not query DEX deposit options");
});

test("setupChain recomputes token route metadata after context-bound DEX adapter attaches", async (t) => {
    const originalMonadDexAgg = chain_config["monad-mainnet"].dexAgg;
    const contextBindings: string[][] = [];

    (chain_config["monad-mainnet"] as any).dexAgg = {
        dao: BOOT_DAO_FEE_RECEIVER,
        router: EMPTY_ADDRESS,
        withContext(context: any) {
            contextBindings.push(context.markets.map((market: any) => market.address));
            return {
                dao: BOOT_DAO_FEE_RECEIVER,
                router: MONAD_TEST_TOKEN,
                getAvailableTokens: async () => [{
                    interface: { address: MONAD_WRAPPED_NATIVE, symbol: "WMON" },
                    type: "simple",
                }],
                quoteAction: async () => {
                    throw new Error("quoteAction is not used by this test");
                },
                quoteMin: async () => 1n,
                quote: async () => ({
                    to: MONAD_TEST_TOKEN,
                    calldata: "0x" as bytes,
                    min_out: 1n,
                    out: 2n,
                }),
            };
        },
        getAvailableTokens: async () => {
            throw new Error("unbound DEX adapter should not discover setup routes");
        },
        quoteAction: async () => {
            throw new Error("unbound DEX adapter should not quote");
        },
        quoteMin: async () => {
            throw new Error("unbound DEX adapter should not quote");
        },
        quote: async () => {
            throw new Error("unbound DEX adapter should not quote");
        },
    };

    const harness = installSetupChainBootHarness(t, {
        marketData: (context) => {
            assert.match(context.batchKey ?? "", /^monad-mainnet:/);
            return {
                staticMarket: [
                    createBootStaticMarket(MONAD_MARKET, [
                        { cToken: MONAD_WMON_CTOKEN, symbol: "WMON", asset: MONAD_WRAPPED_NATIVE },
                        { cToken: MONAD_USDC_CTOKEN, symbol: "USDC", asset: MONAD_USDC_ASSET },
                    ]),
                ],
                dynamicMarket: [
                    createBootDynamicMarket(MONAD_MARKET, [MONAD_WMON_CTOKEN, MONAD_USDC_CTOKEN]),
                ],
                userData: {
                    locks: [],
                    markets: [
                        createBootUserMarket(MONAD_MARKET, [MONAD_WMON_CTOKEN, MONAD_USDC_CTOKEN]),
                    ],
                },
            };
        },
        fetch: async (url) => {
            assert.equal(url, "https://api.monad-context-router.example/v1/monad/native_apy");
            return {
                ok: true,
                json: async () => ({ native_apy: [] }),
            };
        },
    });

    t.after(() => {
        (chain_config["monad-mainnet"] as any).dexAgg = originalMonadDexAgg;
    });

    const result = await setupChain("monad-mainnet", null, "https://api.monad-context-router.example", {
        account: MONAD_ACCOUNT,
        readProvider: createDecimalsReadProvider(143n) as any,
    });
    const market = result.markets[0];
    const usdc = market?.tokens.find(
        (token) => token.address.toLowerCase() === MONAD_USDC_CTOKEN.toLowerCase(),
    );
    assert.ok(usdc);

    assert.deepEqual(contextBindings, [[MONAD_MARKET]]);
    assert.deepEqual(usdc.zapTypes, ["simple"]);
    assert.deepEqual(usdc.leverageTypes, ["simple"]);
    assert.equal(usdc.canZap, true);
    assert.equal(usdc.canLeverage, true);
    assert.deepEqual(
        (await usdc.getDepositTokens()).map((token) => ({
            type: token.type,
            address: token.interface.address,
        })),
        [
            { type: "none", address: MONAD_USDC_ASSET },
            { type: "simple", address: MONAD_WRAPPED_NATIVE },
            { type: "simple", address: NATIVE_ADDRESS },
        ],
    );
    assert.deepEqual(harness.merklCalls, [
        { action: undefined, chainId: 143 },
    ]);
});

test("setupChain treats differently-cased empty DEX routers as unsupported", async (t) => {
    const originalMonadDexAgg = chain_config["monad-mainnet"].dexAgg;
    const emptyRouter = EMPTY_ADDRESS.toUpperCase() as address;
    let getAvailableCalls = 0;

    const emptyDexAgg = {
        dao: BOOT_DAO_FEE_RECEIVER,
        router: emptyRouter,
        withContext() {
            return {
                dao: BOOT_DAO_FEE_RECEIVER,
                router: emptyRouter,
                getAvailableTokens: async () => {
                    getAvailableCalls++;
                    return [{
                        interface: { address: MONAD_WRAPPED_NATIVE, symbol: "WMON" },
                        type: "simple",
                    }];
                },
                quoteAction: async () => {
                    throw new Error("empty-router DEX adapter should not quote actions");
                },
                quoteMin: async () => {
                    throw new Error("empty-router DEX adapter should not quote min output");
                },
                quote: async () => {
                    throw new Error("empty-router DEX adapter should not quote");
                },
            };
        },
        getAvailableTokens: async () => {
            throw new Error("unbound empty-router DEX adapter should not discover setup routes");
        },
        quoteAction: async () => {
            throw new Error("unbound empty-router DEX adapter should not quote actions");
        },
        quoteMin: async () => {
            throw new Error("unbound empty-router DEX adapter should not quote min output");
        },
        quote: async () => {
            throw new Error("unbound empty-router DEX adapter should not quote");
        },
    };

    (chain_config["monad-mainnet"] as any).dexAgg = emptyDexAgg;

    installSetupChainBootHarness(t, {
        marketData: (context) => {
            assert.ok(context.batchKey?.startsWith("monad-mainnet:"));
            return {
                staticMarket: [
                    createBootStaticMarket(MONAD_MARKET, [
                        { cToken: MONAD_WMON_CTOKEN, symbol: "WMON", asset: MONAD_WRAPPED_NATIVE },
                        { cToken: MONAD_USDC_CTOKEN, symbol: "USDC", asset: MONAD_USDC_ASSET },
                    ]),
                ],
                dynamicMarket: [
                    createBootDynamicMarket(MONAD_MARKET, [MONAD_WMON_CTOKEN, MONAD_USDC_CTOKEN]),
                ],
                userData: {
                    locks: [],
                    markets: [
                        createBootUserMarket(MONAD_MARKET, [MONAD_WMON_CTOKEN, MONAD_USDC_CTOKEN]),
                    ],
                },
            };
        },
        fetch: async (url) => {
            assert.equal(url, "https://api.monad-empty-router.example/v1/monad/native_apy");
            return {
                ok: true,
                json: async () => ({ native_apy: [] }),
            };
        },
    });

    t.after(() => {
        (chain_config["monad-mainnet"] as any).dexAgg = originalMonadDexAgg;
    });

    const result = await setupChain("monad-mainnet", null, "https://api.monad-empty-router.example", {
        account: MONAD_ACCOUNT,
        readProvider: createDecimalsReadProvider(143n) as any,
    });
    const usdc = result.markets[0]?.tokens.find(
        (token) => token.address.toLowerCase() === MONAD_USDC_CTOKEN.toLowerCase(),
    );
    assert.ok(usdc);

    assert.equal(result.dexAgg.router, emptyRouter);
    assert.equal(usdc.canZap, false);
    assert.deepEqual(usdc.zapTypes, []);
    assert.equal(usdc.canLeverage, false);
    assert.deepEqual(usdc.leverageTypes, []);
    assert.deepEqual(
        (await usdc.getDepositTokens()).map((token) => ({
            type: token.type,
            address: token.interface.address,
        })),
        [{ type: "none", address: MONAD_USDC_ASSET }],
    );
    assert.equal(getAvailableCalls, 0);
});

test("direct Market.getAll markets do not fall back to the mutable chain DEX singleton", async (t) => {
    installSetupChainBootHarness(t, {
        marketData: (context) => {
            assert.ok(context.batchKey?.startsWith("monad-mainnet:"));
            return {
                staticMarket: [
                    createBootStaticMarket(MONAD_MARKET, [
                        { cToken: MONAD_WMON_CTOKEN, symbol: "WMON", asset: MONAD_WRAPPED_NATIVE },
                        { cToken: MONAD_USDC_CTOKEN, symbol: "USDC", asset: MONAD_USDC_ASSET },
                    ]),
                ],
                dynamicMarket: [
                    createBootDynamicMarket(MONAD_MARKET, [MONAD_WMON_CTOKEN, MONAD_USDC_CTOKEN]),
                ],
                userData: {
                    locks: [],
                    markets: [
                        createBootUserMarket(MONAD_MARKET, [MONAD_WMON_CTOKEN, MONAD_USDC_CTOKEN]),
                    ],
                },
            };
        },
        fetch: async () => ({
            ok: true,
            json: async () => ({ native_apy: [] }),
        }),
    });

    const provider = createDecimalsReadProvider(143n) as any;
    const setup = {
        chain: "monad-mainnet",
        chainId: 143,
        environment: "production-mainnet",
        assets: {
            native_symbol: chain_config["monad-mainnet"].native_symbol,
            native_name: chain_config["monad-mainnet"].native_name,
            wrapped_native: chain_config["monad-mainnet"].wrapped_native,
            native_vaults: [...chain_config["monad-mainnet"].native_vaults],
            vaults: [...chain_config["monad-mainnet"].vaults],
            excluded_zap_symbols: [...chain_config["monad-mainnet"].excluded_zap_symbols],
            excluded_zap_addresses: [...(chain_config["monad-mainnet"].excluded_zap_addresses ?? [])],
        },
        services: {
            curvanceApi: {
                rewardsSlug: "monad-mainnet",
                rewardChainAliases: ["monad"],
                nativeYieldSlug: "monad",
                suppressedNativeYieldSymbols: ["USDC"],
            },
            dexAggregators: {
                kyberSwap: { ...chain_config["monad-mainnet"].services.dexAggregators.kyberSwap! },
            },
        },
        contracts: getContractAddresses("monad-mainnet"),
        readProvider: provider,
        signer: null,
        account: MONAD_ACCOUNT,
        provider,
        api_url: "https://api.direct-market.example",
        feePolicy: flatFeePolicy({
            bps: CURVANCE_FEE_BPS,
            feeReceiver: BOOT_DAO_FEE_RECEIVER,
            chain: "monad-mainnet",
        }),
    } as any;
    const reader = new ProtocolReader(setup.contracts.ProtocolReader, provider, setup.chain);
    const oracle = new OracleManager(setup.contracts.OracleManager, provider);
    const markets = await Market.getAll(
        reader,
        oracle,
        provider,
        null,
        MONAD_ACCOUNT,
        {},
        {},
        setup,
    );
    const usdc = markets[0]?.tokens.find(
        (token) => token.address.toLowerCase() === MONAD_USDC_CTOKEN.toLowerCase(),
    );
    assert.ok(usdc);

    assert.equal(usdc.canZap, false);
    assert.equal(usdc.canLeverage, false);
    assert.deepEqual(usdc.zapTypes, []);
    assert.deepEqual(usdc.leverageTypes, []);
    assert.deepEqual(
        (await usdc.getDepositTokens()).map((token) => ({
            type: token.type,
            address: token.interface.address,
        })),
        [{ type: "none", address: MONAD_USDC_ASSET }],
    );
});

test("setupChain advertises MultiDex simple routes when a later child is executable", async (t) => {
    const originalMonadDexAgg = chain_config["monad-mainnet"].dexAgg;
    const contextBindings: string[][] = [];
    const quoteCalls: Array<{
        tokenIn: string;
        tokenOut: string;
        amount: bigint;
        feeBps: bigint | undefined;
        feeReceiver: string | undefined;
    }> = [];

    const executableChild = {
        dao: BOOT_DAO_FEE_RECEIVER,
        router: EMPTY_ADDRESS,
        withContext(context: any) {
            contextBindings.push(context.markets.map((market: any) => market.address));
            return {
                dao: BOOT_DAO_FEE_RECEIVER,
                router: MONAD_TEST_TOKEN,
                getAvailableTokens: async () => [{
                    interface: { address: MONAD_WRAPPED_NATIVE, symbol: "WMON" },
                    type: "simple",
                }],
                quoteAction: async () => {
                    throw new Error("quoteAction is not used by this test");
                },
                quoteMin: async () => 1n,
                quote: async (
                    _wallet: string,
                    tokenIn: string,
                    tokenOut: string,
                    amount: bigint,
                    _slippage: bigint,
                    feeBps?: bigint,
                    feeReceiver?: address,
                ) => {
                    quoteCalls.push({ tokenIn, tokenOut, amount, feeBps, feeReceiver });
                    return {
                        to: MONAD_TEST_TOKEN,
                        calldata: "0x" as bytes,
                        min_out: 1n,
                        out: 2n,
                    };
                },
            };
        },
        getAvailableTokens: async () => {
            throw new Error("unbound executable child should not discover setup routes");
        },
        quoteAction: async () => {
            throw new Error("unbound executable child should not quote");
        },
        quoteMin: async () => {
            throw new Error("unbound executable child should not quote");
        },
        quote: async () => {
            throw new Error("unbound executable child should not quote");
        },
    };

    (chain_config["monad-mainnet"] as any).dexAgg = new MultiDexAgg([
        new UnsupportedDexAgg("monad-empty-primary"),
        executableChild as any,
    ]);

    installSetupChainBootHarness(t, {
        marketData: (context) => {
            if (context.batchKey?.startsWith("monad-mainnet:")) {
                return {
                    staticMarket: [
                        createBootStaticMarket(MONAD_MARKET, [
                            { cToken: MONAD_WMON_CTOKEN, symbol: "WMON", asset: MONAD_WRAPPED_NATIVE },
                            { cToken: MONAD_USDC_CTOKEN, symbol: "USDC", asset: MONAD_USDC_ASSET },
                        ]),
                    ],
                    dynamicMarket: [
                        createBootDynamicMarket(MONAD_MARKET, [MONAD_WMON_CTOKEN, MONAD_USDC_CTOKEN]),
                    ],
                    userData: {
                        locks: [],
                        markets: [
                            createBootUserMarket(MONAD_MARKET, [MONAD_WMON_CTOKEN, MONAD_USDC_CTOKEN]),
                        ],
                    },
                };
            }

            if (context.batchKey?.startsWith("arb-sepolia:")) {
                return {
                    staticMarket: [
                        createBootStaticMarket(ARB_STABLE_MARKET, [
                            { cToken: ARB_USDC_CTOKEN, symbol: "USDC" },
                            { cToken: ARB_AUSD_CTOKEN, symbol: "AUSD" },
                        ]),
                    ],
                    dynamicMarket: [
                        createBootDynamicMarket(ARB_STABLE_MARKET, [ARB_USDC_CTOKEN, ARB_AUSD_CTOKEN]),
                    ],
                    userData: {
                        locks: [],
                        markets: [
                            createBootUserMarket(ARB_STABLE_MARKET, [ARB_USDC_CTOKEN, ARB_AUSD_CTOKEN]),
                        ],
                    },
                };
            }

            throw new Error(`Unexpected setup batch key: ${context.batchKey}`);
        },
        fetch: async (url) => {
            assert.equal(url, "https://api.monad-multidex-secondary.example/v1/monad/native_apy");
            return {
                ok: true,
                json: async () => ({ native_apy: [] }),
            };
        },
    });

    t.after(() => {
        (chain_config["monad-mainnet"] as any).dexAgg = originalMonadDexAgg;
    });

    const result = await setupChain("monad-mainnet", null, "https://api.monad-multidex-secondary.example", {
        account: MONAD_ACCOUNT,
        readProvider: createDecimalsReadProvider(143n) as any,
    });
    const arbResult = await setupChain("arb-sepolia", null, "https://api.arb-after-secondary.example", {
        account: ARB_ACCOUNT,
        readProvider: createDecimalsReadProvider(421614n) as any,
    });
    assert.equal(setup_config.chain, "arb-sepolia");
    assert.equal(all_markets[0], arbResult.markets[0]);

    const market = result.markets[0];
    const usdc = market?.tokens.find(
        (token) => token.address.toLowerCase() === MONAD_USDC_CTOKEN.toLowerCase(),
    );
    assert.ok(usdc);

    assert.equal(result.dexAgg.router, MONAD_TEST_TOKEN);
    assert.deepEqual(contextBindings, [[MONAD_MARKET]]);
    assert.deepEqual(usdc.zapTypes, ["simple"]);
    assert.deepEqual(usdc.leverageTypes, ["simple"]);
    assert.equal(usdc.canZap, true);
    assert.equal(usdc.canLeverage, true);

    const depositTokens = await usdc.getDepositTokens();
    const wrappedNativeZap = depositTokens.find(
        (token) => token.type === "simple" && token.interface.address.toLowerCase() === MONAD_WRAPPED_NATIVE.toLowerCase(),
    );
    assert.ok(wrappedNativeZap);
    await result.dexAgg.quote(
        MONAD_ACCOUNT,
        MONAD_WRAPPED_NATIVE,
        MONAD_USDC_ASSET,
        1_000_000_000_000_000_000n,
        100n,
        CURVANCE_FEE_BPS,
        BOOT_DAO_FEE_RECEIVER,
    );
    assert.deepEqual(quoteCalls, [{
        tokenIn: MONAD_WRAPPED_NATIVE,
        tokenOut: MONAD_USDC_ASSET,
        amount: 1_000_000_000_000_000_000n,
        feeBps: CURVANCE_FEE_BPS,
        feeReceiver: CHECKSUM_BOOT_DAO_FEE_RECEIVER,
    }]);
});

test("setupChain preserves quoteable MultiDex duplicate routes after singleton moves", async (t) => {
    const originalMonadDexAgg = chain_config["monad-mainnet"].dexAgg;
    const routeQuoteCalls: Array<{
        label: string;
        chain: string;
        tokenIn: string;
        tokenOut: string;
        amount: string;
        slippage: string;
    }> = [];

    function duplicateTokenChild(label: string, withQuote: boolean, router: address) {
        return {
            dao: BOOT_DAO_FEE_RECEIVER,
            router,
            withContext(context: any) {
                const chain = context.markets[0]?.setup?.chain ?? "unknown";
                return {
                    dao: BOOT_DAO_FEE_RECEIVER,
                    router,
                    getAvailableTokens: async () => [{
                        interface: { address: MONAD_WRAPPED_NATIVE, symbol: "WMON" },
                        type: "simple",
                        ...(withQuote ? {
                            quote: async (
                                tokenIn: string,
                                tokenOut: string,
                                amount: Decimal,
                                slippage: Decimal,
                            ) => {
                                routeQuoteCalls.push({
                                    label,
                                    chain,
                                    tokenIn,
                                    tokenOut,
                                    amount: amount.toString(),
                                    slippage: slippage.toString(),
                                });
                                return {
                                    minOut_raw: 10n,
                                    output_raw: 11n,
                                    minOut: Decimal(10),
                                    output: Decimal(11),
                                };
                            },
                        } : {}),
                    }],
                    quoteAction: async () => {
                        throw new Error("quoteAction is not used by this test");
                    },
                    quoteMin: async () => 1n,
                    quote: async () => ({
                        to: router,
                        calldata: "0x" as bytes,
                        min_out: 1n,
                        out: 2n,
                    }),
                };
            },
            getAvailableTokens: async () => {
                throw new Error(`${label} child was used before setup context binding`);
            },
            quoteAction: async () => {
                throw new Error(`${label} child was used before setup context binding`);
            },
            quoteMin: async () => {
                throw new Error(`${label} child was used before setup context binding`);
            },
            quote: async () => {
                throw new Error(`${label} child was used before setup context binding`);
            },
        };
    }

    (chain_config["monad-mainnet"] as any).dexAgg = new MultiDexAgg([
        duplicateTokenChild("unquoteable-primary", false, MONAD_TEST_TOKEN) as any,
        duplicateTokenChild("quoteable-secondary", true, MONAD_TEST_OUTPUT_TOKEN) as any,
    ]);

    installSetupChainBootHarness(t, {
        marketData: (context) => {
            if (context.batchKey?.startsWith("monad-mainnet:")) {
                return {
                    staticMarket: [
                        createBootStaticMarket(MONAD_MARKET, [
                            { cToken: MONAD_WMON_CTOKEN, symbol: "WMON", asset: MONAD_WRAPPED_NATIVE },
                            { cToken: MONAD_USDC_CTOKEN, symbol: "USDC", asset: MONAD_USDC_ASSET },
                        ]),
                    ],
                    dynamicMarket: [
                        createBootDynamicMarket(MONAD_MARKET, [MONAD_WMON_CTOKEN, MONAD_USDC_CTOKEN]),
                    ],
                    userData: {
                        locks: [],
                        markets: [
                            createBootUserMarket(MONAD_MARKET, [MONAD_WMON_CTOKEN, MONAD_USDC_CTOKEN]),
                        ],
                    },
                };
            }

            if (context.batchKey?.startsWith("arb-sepolia:")) {
                return {
                    staticMarket: [
                        createBootStaticMarket(ARB_STABLE_MARKET, [
                            { cToken: ARB_USDC_CTOKEN, symbol: "USDC" },
                            { cToken: ARB_AUSD_CTOKEN, symbol: "AUSD" },
                        ]),
                    ],
                    dynamicMarket: [
                        createBootDynamicMarket(ARB_STABLE_MARKET, [ARB_USDC_CTOKEN, ARB_AUSD_CTOKEN]),
                    ],
                    userData: {
                        locks: [],
                        markets: [
                            createBootUserMarket(ARB_STABLE_MARKET, [ARB_USDC_CTOKEN, ARB_AUSD_CTOKEN]),
                        ],
                    },
                };
            }

            throw new Error(`Unexpected setup batch key: ${context.batchKey}`);
        },
        fetch: async (url) => {
            assert.equal(url, "https://api.monad-multidex-duplicate.example/v1/monad/native_apy");
            return {
                ok: true,
                json: async () => ({ native_apy: [] }),
            };
        },
    });

    t.after(() => {
        (chain_config["monad-mainnet"] as any).dexAgg = originalMonadDexAgg;
    });

    const monadResult = await setupChain("monad-mainnet", null, "https://api.monad-multidex-duplicate.example", {
        account: MONAD_ACCOUNT,
        readProvider: createDecimalsReadProvider(143n) as any,
    });
    const arbResult = await setupChain("arb-sepolia", null, "https://api.arb-after-duplicate.example", {
        account: ARB_ACCOUNT,
        readProvider: createDecimalsReadProvider(421614n) as any,
    });
    assert.equal(setup_config.chain, "arb-sepolia");
    assert.equal(all_markets[0], arbResult.markets[0]);

    const usdc = monadResult.markets[0]?.tokens.find(
        (token) => token.address.toLowerCase() === MONAD_USDC_CTOKEN.toLowerCase(),
    );
    assert.ok(usdc);

    const wrappedNativeZap = (await usdc.getDepositTokens()).find(
        (token) => token.type === "simple" && token.interface.address.toLowerCase() === MONAD_WRAPPED_NATIVE.toLowerCase(),
    );
    assert.ok(wrappedNativeZap?.quote);
    const quote = await wrappedNativeZap.quote(
        MONAD_WRAPPED_NATIVE,
        MONAD_USDC_ASSET,
        Decimal("1.5"),
        Decimal("0.02"),
    );

    assert.equal(quote.minOut_raw, 10n);
    assert.deepEqual(routeQuoteCalls, [{
        label: "quoteable-secondary",
        chain: "monad-mainnet",
        tokenIn: MONAD_WRAPPED_NATIVE,
        tokenOut: MONAD_USDC_ASSET,
        amount: "1.5",
        slippage: "0.02",
    }]);
});

test("explicit active-user refresh helpers keep older result markets bound after a later chain boot", async (t) => {
    installSetupChainBootHarness(t, {
        marketData: (context) => {
            if (context.batchKey?.startsWith("monad-mainnet:")) {
                return {
                    staticMarket: [
                        createBootStaticMarket(MONAD_MARKET, [
                            { cToken: MONAD_WMON_CTOKEN, symbol: "WMON", asset: MONAD_WRAPPED_NATIVE },
                            { cToken: MONAD_USDC_CTOKEN, symbol: "USDC", asset: MONAD_USDC_ASSET },
                        ]),
                    ],
                    dynamicMarket: [
                        createBootDynamicMarket(MONAD_MARKET, [MONAD_WMON_CTOKEN, MONAD_USDC_CTOKEN]),
                    ],
                    userData: {
                        locks: [],
                        markets: [
                            createBootUserMarket(MONAD_MARKET, [MONAD_WMON_CTOKEN, MONAD_USDC_CTOKEN]),
                        ],
                    },
                };
            }

            if (context.batchKey?.startsWith("arb-sepolia:")) {
                return {
                    staticMarket: [
                        createBootStaticMarket(ARB_STABLE_MARKET, [
                            { cToken: ARB_USDC_CTOKEN, symbol: "USDC" },
                            { cToken: ARB_AUSD_CTOKEN, symbol: "AUSD" },
                        ]),
                    ],
                    dynamicMarket: [
                        createBootDynamicMarket(ARB_STABLE_MARKET, [ARB_USDC_CTOKEN, ARB_AUSD_CTOKEN]),
                    ],
                    userData: {
                        locks: [],
                        markets: [
                            createBootUserMarket(ARB_STABLE_MARKET, [ARB_USDC_CTOKEN, ARB_AUSD_CTOKEN]),
                        ],
                    },
                };
            }

            throw new Error(`Unexpected setup boot reader context: ${context.batchKey}`);
        },
        fetch: async () => ({
            ok: true,
            json: async () => ({ native_apy: [] }),
        }),
    });

    const monadResult = await setupChain("monad-mainnet", null, "https://api.monad-active.example", {
        account: MONAD_ACCOUNT,
        readProvider: createDecimalsReadProvider(143n) as any,
    });
    const monadMarket = monadResult.markets[0];
    assert.ok(monadMarket);

    const arbResult = await setupChain("arb-sepolia", null, "https://api.arb-active.example", {
        account: ARB_ACCOUNT,
        readProvider: createDecimalsReadProvider(421614n) as any,
    });
    assert.equal(setup_config.chain, "arb-sepolia");
    assert.equal(all_markets, arbResult.markets);

    const monadFullRefreshCalls: Array<{ addresses: string[]; account: string }> = [];
    const monadSummaryRefreshCalls: Array<{ addresses: string[]; account: string }> = [];
    const arbRefreshCalls: Array<{ addresses: string[]; account: string }> = [];

    (monadMarket.reader as any).getMarketStates = async (addresses: string[], account: string) => {
        monadFullRefreshCalls.push({ addresses, account });
        return {
            dynamicMarkets: [
                createBootDynamicMarket(MONAD_MARKET, [MONAD_WMON_CTOKEN, MONAD_USDC_CTOKEN]),
            ],
            userMarkets: [
                createBootUserMarket(MONAD_MARKET, [MONAD_WMON_CTOKEN, MONAD_USDC_CTOKEN]),
            ],
        };
    };
    (monadMarket.reader as any).getMarketSummaries = async (addresses: string[], account: string) => {
        monadSummaryRefreshCalls.push({ addresses, account });
        return [{
            address: MONAD_MARKET,
            collateral: 11n,
            maxDebt: 12n,
            debt: 0n,
            positionHealth: 13n,
            cooldown: 1200n,
            errorCodeHit: false,
            priceStale: false,
        }];
    };
    (arbResult.markets[0]!.reader as any).getMarketStates = async (addresses: string[], account: string) => {
        arbRefreshCalls.push({ addresses, account });
        return {
            dynamicMarkets: [
                createBootDynamicMarket(ARB_STABLE_MARKET, [ARB_USDC_CTOKEN, ARB_AUSD_CTOKEN]),
            ],
            userMarkets: [
                createBootUserMarket(ARB_STABLE_MARKET, [ARB_USDC_CTOKEN, ARB_AUSD_CTOKEN]),
            ],
        };
    };
    (arbResult.markets[0]!.reader as any).getMarketSummaries = async (addresses: string[], account: string) => {
        arbRefreshCalls.push({ addresses, account });
        return [{
            address: ARB_STABLE_MARKET,
            collateral: 21n,
            maxDebt: 22n,
            debt: 0n,
            positionHealth: 23n,
            cooldown: 1200n,
            errorCodeHit: false,
            priceStale: false,
        }];
    };

    const activeMonadMarkets = await refreshActiveUserMarkets(MONAD_ACCOUNT, monadResult.markets);
    const summaryMonadMarkets = await refreshActiveUserMarketSummaries(MONAD_ACCOUNT, monadResult.markets);

    assert.deepEqual(activeMonadMarkets, [monadMarket]);
    assert.deepEqual(summaryMonadMarkets, [monadMarket]);
    assert.deepEqual(monadFullRefreshCalls, [{
        addresses: [MONAD_MARKET],
        account: MONAD_ACCOUNT,
    }]);
    assert.deepEqual(monadSummaryRefreshCalls, [{
        addresses: [MONAD_MARKET],
        account: MONAD_ACCOUNT,
    }]);
    assert.deepEqual(arbRefreshCalls, []);
    assert.equal(setup_config.chain, "arb-sepolia");
    assert.equal(all_markets, arbResult.markets);
    assert.equal(monadMarket.setup.chain, "monad-mainnet");
    assert.equal(monadMarket.account, MONAD_ACCOUNT);
    assert.equal(monadMarket.userDataScope, "summary");

    const arbMarket = arbResult.markets[0]!;
    const currentDefaultActiveMarkets = await refreshActiveUserMarkets(ARB_ACCOUNT);
    const currentDefaultSummaryMarkets = await refreshActiveUserMarketSummaries(ARB_ACCOUNT);

    assert.deepEqual(currentDefaultActiveMarkets, [arbMarket]);
    assert.deepEqual(currentDefaultSummaryMarkets, [arbMarket]);
    assert.deepEqual(monadFullRefreshCalls, [{
        addresses: [MONAD_MARKET],
        account: MONAD_ACCOUNT,
    }]);
    assert.deepEqual(monadSummaryRefreshCalls, [{
        addresses: [MONAD_MARKET],
        account: MONAD_ACCOUNT,
    }]);
    assert.deepEqual(arbRefreshCalls, [
        {
            addresses: [ARB_STABLE_MARKET],
            account: ARB_ACCOUNT,
        },
        {
            addresses: [ARB_STABLE_MARKET],
            account: ARB_ACCOUNT,
        },
    ]);
    assert.equal(setup_config.chain, "arb-sepolia");
    assert.equal(all_markets, arbResult.markets);

    const mixedChainRefreshed = await Market.reloadUserMarkets([monadMarket, arbMarket], MONAD_ACCOUNT);

    assert.deepEqual(mixedChainRefreshed, [monadMarket, arbMarket]);
    assert.deepEqual(monadFullRefreshCalls, [
        {
            addresses: [MONAD_MARKET],
            account: MONAD_ACCOUNT,
        },
        {
            addresses: [MONAD_MARKET],
            account: MONAD_ACCOUNT,
        },
    ]);
    assert.deepEqual(arbRefreshCalls, [
        {
            addresses: [ARB_STABLE_MARKET],
            account: ARB_ACCOUNT,
        },
        {
            addresses: [ARB_STABLE_MARKET],
            account: ARB_ACCOUNT,
        },
        {
            addresses: [ARB_STABLE_MARKET],
            account: MONAD_ACCOUNT,
        },
    ]);
    assert.equal(monadMarket.account, MONAD_ACCOUNT);
    assert.equal(arbMarket.account, MONAD_ACCOUNT);
    assert.equal(monadMarket.setup.chain, "monad-mainnet");
    assert.equal(arbMarket.setup.chain, "arb-sepolia");
    assert.equal(setup_config.chain, "arb-sepolia");
    assert.equal(all_markets, arbResult.markets);

    const mixedChainSummaryRefreshed = await Market.reloadUserMarketSummaries(
        [monadMarket, arbMarket],
        MONAD_ACCOUNT,
    );

    assert.deepEqual(mixedChainSummaryRefreshed, [monadMarket, arbMarket]);
    assert.deepEqual(monadSummaryRefreshCalls, [
        {
            addresses: [MONAD_MARKET],
            account: MONAD_ACCOUNT,
        },
        {
            addresses: [MONAD_MARKET],
            account: MONAD_ACCOUNT,
        },
    ]);
    assert.deepEqual(arbRefreshCalls, [
        {
            addresses: [ARB_STABLE_MARKET],
            account: ARB_ACCOUNT,
        },
        {
            addresses: [ARB_STABLE_MARKET],
            account: ARB_ACCOUNT,
        },
        {
            addresses: [ARB_STABLE_MARKET],
            account: MONAD_ACCOUNT,
        },
        {
            addresses: [ARB_STABLE_MARKET],
            account: MONAD_ACCOUNT,
        },
    ]);
    assert.equal(monadMarket.account, MONAD_ACCOUNT);
    assert.equal(arbMarket.account, MONAD_ACCOUNT);
    assert.equal(monadMarket.userDataScope, "summary");
    assert.equal(arbMarket.userDataScope, "summary");
    assert.equal(monadMarket.setup.chain, "monad-mainnet");
    assert.equal(arbMarket.setup.chain, "arb-sepolia");
    assert.equal(setup_config.chain, "arb-sepolia");
    assert.equal(all_markets, arbResult.markets);
});

test("older returned cToken writes execute with result signer and refresh result reader after singleton moves", async (t) => {
    installSetupChainBootHarness(t, {
        marketData: (context) => {
            if (context.batchKey?.startsWith("monad-mainnet:")) {
                return {
                    staticMarket: [
                        createBootStaticMarket(MONAD_MARKET, [
                            { cToken: MONAD_WMON_CTOKEN, symbol: "WMON", asset: MONAD_WRAPPED_NATIVE },
                            { cToken: MONAD_USDC_CTOKEN, symbol: "USDC", asset: MONAD_USDC_ASSET, isBorrowable: true },
                            {
                                cToken: MONAD_NATIVE_VAULT_CTOKEN,
                                symbol: "aprMON",
                                asset: chain_config["monad-mainnet"].native_vaults[0]!.contract,
                            },
                            {
                                cToken: MONAD_VAULT_CTOKEN,
                                symbol: "sAUSD",
                                asset: chain_config["monad-mainnet"].vaults[0]!.contract,
                            },
                        ]),
                    ],
                    dynamicMarket: [
                        createBootDynamicMarket(MONAD_MARKET, [
                            MONAD_WMON_CTOKEN,
                            MONAD_USDC_CTOKEN,
                            MONAD_NATIVE_VAULT_CTOKEN,
                            MONAD_VAULT_CTOKEN,
                        ]),
                    ],
                    userData: {
                        locks: [],
                        markets: [
                            createBootUserMarket(MONAD_MARKET, [
                                MONAD_WMON_CTOKEN,
                                MONAD_USDC_CTOKEN,
                                MONAD_NATIVE_VAULT_CTOKEN,
                                MONAD_VAULT_CTOKEN,
                            ]),
                        ],
                    },
                };
            }

            if (context.batchKey?.startsWith("arb-sepolia:")) {
                return {
                    staticMarket: [
                        createBootStaticMarket(ARB_STABLE_MARKET, [
                            { cToken: ARB_USDC_CTOKEN, symbol: "USDC" },
                            { cToken: ARB_AUSD_CTOKEN, symbol: "AUSD" },
                        ]),
                    ],
                    dynamicMarket: [
                        createBootDynamicMarket(ARB_STABLE_MARKET, [ARB_USDC_CTOKEN, ARB_AUSD_CTOKEN]),
                    ],
                    userData: {
                        locks: [],
                        markets: [
                            createBootUserMarket(ARB_STABLE_MARKET, [ARB_USDC_CTOKEN, ARB_AUSD_CTOKEN]),
                        ],
                    },
                };
            }

            throw new Error(`Unexpected setup boot reader context: ${context.batchKey}`);
        },
        fetch: async () => ({
            ok: true,
            json: async () => ({ native_apy: [] }),
        }),
    });

    const monadTransactions: Array<{ to: string; data: string; value?: bigint }> = [];
    const monadSimulations: Array<{ to: string; data: string; from: string }> = [];
    let monadWaits = 0;
    const monadSigner = {
        address: MONAD_ACCOUNT,
        provider: createDecimalsReadProvider(143n) as any,
        sendTransaction: async (tx: { to: string; data: string; value?: bigint }) => {
            monadTransactions.push(tx);
            return {
                hash: "0xmonad-write",
                wait: async () => {
                    monadWaits += 1;
                    return { status: 1 };
                },
            };
        },
        call: async (tx: { to: string; data: string; from: string }) => {
            monadSimulations.push(tx);
            return "0x";
        },
    };
    const arbSigner = {
        address: ARB_ACCOUNT,
        provider: createDecimalsReadProvider(421614n) as any,
        sendTransaction: async () => {
            throw new Error("Arbitrum singleton signer should not execute older Monad token writes");
        },
    };

    const monadResult = await setupChain("monad-mainnet", monadSigner as any, "https://api.monad-write.example");
    const monadMarket = monadResult.markets[0];
    assert.ok(monadMarket);
    const monadWmon = monadMarket.tokens.find(
        (token) => token.address.toLowerCase() === MONAD_WMON_CTOKEN.toLowerCase(),
    );
    assert.ok(monadWmon);
    const monadNativeVault = monadMarket.tokens.find(
        (token) => token.address.toLowerCase() === MONAD_NATIVE_VAULT_CTOKEN.toLowerCase(),
    );
    const monadVault = monadMarket.tokens.find(
        (token) => token.address.toLowerCase() === MONAD_VAULT_CTOKEN.toLowerCase(),
    );
    assert.ok(monadNativeVault);
    assert.ok(monadVault);

    const arbResult = await setupChain("arb-sepolia", arbSigner as any, "https://api.arb-write.example");
    const arbMarket = arbResult.markets[0];
    assert.ok(arbMarket);
    assert.equal(setup_config.chain, "arb-sepolia");
    assert.equal(setup_config.signer, arbSigner);
    assert.equal(all_markets, arbResult.markets);

    const monadRefreshCalls: Array<{ addresses: string[]; account: string }> = [];
    const arbRefreshCalls: Array<{ addresses: string[]; account: string }> = [];
    (monadMarket.reader as any).getMarketStates = async (addresses: string[], account: string) => {
        monadRefreshCalls.push({ addresses, account });
        return {
            dynamicMarkets: [
                createBootDynamicMarket(MONAD_MARKET, [
                    MONAD_WMON_CTOKEN,
                    MONAD_USDC_CTOKEN,
                    MONAD_NATIVE_VAULT_CTOKEN,
                    MONAD_VAULT_CTOKEN,
                ]),
            ],
            userMarkets: [
                createBootUserMarket(MONAD_MARKET, [
                    MONAD_WMON_CTOKEN,
                    MONAD_USDC_CTOKEN,
                    MONAD_NATIVE_VAULT_CTOKEN,
                    MONAD_VAULT_CTOKEN,
                ]),
            ],
        };
    };
    (arbMarket.reader as any).getMarketStates = async (addresses: string[], account: string) => {
        arbRefreshCalls.push({ addresses, account });
        throw new Error("Arbitrum reader should not refresh older Monad token writes");
    };
    (arbMarket.reader as any).maxRedemptionOf = async () => {
        throw new Error("Arbitrum reader should not preflight older Monad collateral removals");
    };
    (monadWmon as any).ensureUnderlyingAmount = async (amount: Decimal) => amount;
    (monadWmon as any)._checkDepositApprovals = async () => {};

    const tx = await monadWmon.deposit(Decimal(1), "none");

    assert.deepEqual(tx, {
        hash: "0xmonad-write",
        wait: tx.wait,
    });
    assert.equal(monadTransactions.length, 1);
    assert.equal(monadTransactions[0]?.to, MONAD_WMON_CTOKEN);
    assert.match(monadTransactions[0]?.data ?? "", /^0x[0-9a-f]+$/i);
    assert.equal(monadWaits, 1);
    assert.deepEqual(monadRefreshCalls, [{
        addresses: [MONAD_MARKET],
        account: MONAD_ACCOUNT,
    }]);
    assert.deepEqual(arbRefreshCalls, []);
    assert.equal(monadMarket.account, MONAD_ACCOUNT);
    assert.equal(monadMarket.setup.chain, "monad-mainnet");
    assert.equal(setup_config.chain, "arb-sepolia");
    assert.equal(setup_config.signer, arbSigner);
    assert.equal(all_markets, arbResult.markets);

    const quoteCalls: Array<{
        wallet: string;
        tokenIn: string;
        tokenOut: string;
        amount: bigint;
        feeBps: bigint | undefined;
        feeReceiver: string | undefined;
    }> = [];
    (monadResult.dexAgg as any).quote = async (
        wallet: string,
        tokenIn: string,
        tokenOut: string,
        amount: bigint,
        _slippage: bigint,
        feeBps?: bigint,
        feeReceiver?: address,
    ) => {
        quoteCalls.push({ wallet, tokenIn, tokenOut, amount, feeBps, feeReceiver });
        return {
            to: MONAD_TEST_OUTPUT_TOKEN,
            calldata: "0xabcdef" as bytes,
            min_out: 1_000_000_000_000_000_000n,
            out: 1_010_000_000_000_000_000n,
        };
    };
    (monadWmon as any).convertToShares = async (assets: bigint) => assets;

    const simpleZapTx = await monadWmon.deposit(Decimal(2), {
        type: "simple",
        inputToken: MONAD_USDC_ASSET,
        slippage: Decimal("0.01"),
    });

    assert.equal(simpleZapTx.hash, "0xmonad-write");
    assert.equal(monadTransactions.length, 2);
    assert.equal(
        monadTransactions[1]?.to,
        monadResult.setupConfigSnapshot.contracts.zappers.simpleZapper,
    );
    assert.match(monadTransactions[1]?.data ?? "", /^0x[0-9a-f]+$/i);
    assert.equal(monadWaits, 2);
    assert.deepEqual(quoteCalls, [{
        wallet: monadResult.setupConfigSnapshot.contracts.zappers.simpleZapper as string,
        tokenIn: MONAD_USDC_ASSET,
        tokenOut: MONAD_WRAPPED_NATIVE,
        amount: 2_000_000_000_000_000_000n,
        feeBps: CURVANCE_FEE_BPS,
        feeReceiver: BOOT_DAO_FEE_RECEIVER,
    }]);
    assert.deepEqual(monadRefreshCalls, [
        {
            addresses: [MONAD_MARKET],
            account: MONAD_ACCOUNT,
        },
        {
            addresses: [MONAD_MARKET],
            account: MONAD_ACCOUNT,
        },
    ]);
    assert.deepEqual(arbRefreshCalls, []);
    assert.equal(setup_config.chain, "arb-sepolia");
    assert.equal(setup_config.signer, arbSigner);
    assert.equal(all_markets, arbResult.markets);

    const simulation = await monadWmon.simulateDeposit(Decimal(3), {
        type: "simple",
        inputToken: MONAD_USDC_ASSET,
        slippage: Decimal("0.01"),
    });

    assert.deepEqual(simulation, { success: true });
    assert.equal(monadTransactions.length, 2, "simulation should not submit another transaction");
    assert.equal(monadSimulations.length, 1);
    assert.equal(monadSimulations[0]?.to, monadResult.setupConfigSnapshot.contracts.zappers.simpleZapper);
    assert.equal(monadSimulations[0]?.from, MONAD_ACCOUNT);
    assert.match(monadSimulations[0]?.data ?? "", /^0x[0-9a-f]+$/i);
    assert.deepEqual(quoteCalls, [
        {
            wallet: monadResult.setupConfigSnapshot.contracts.zappers.simpleZapper as string,
            tokenIn: MONAD_USDC_ASSET,
            tokenOut: MONAD_WRAPPED_NATIVE,
            amount: 2_000_000_000_000_000_000n,
            feeBps: CURVANCE_FEE_BPS,
            feeReceiver: BOOT_DAO_FEE_RECEIVER,
        },
        {
            wallet: monadResult.setupConfigSnapshot.contracts.zappers.simpleZapper as string,
            tokenIn: MONAD_USDC_ASSET,
            tokenOut: MONAD_WRAPPED_NATIVE,
            amount: 3_000_000_000_000_000_000n,
            feeBps: CURVANCE_FEE_BPS,
            feeReceiver: BOOT_DAO_FEE_RECEIVER,
        },
    ]);
    assert.deepEqual(monadRefreshCalls, [
        {
            addresses: [MONAD_MARKET],
            account: MONAD_ACCOUNT,
        },
        {
            addresses: [MONAD_MARKET],
            account: MONAD_ACCOUNT,
        },
    ]);
    assert.deepEqual(arbRefreshCalls, []);
    assert.equal(setup_config.chain, "arb-sepolia");
    assert.equal(setup_config.signer, arbSigner);
    assert.equal(all_markets, arbResult.markets);

    const monadBorrowable = monadMarket.tokens.find(
        (token) => token.address.toLowerCase() === MONAD_USDC_CTOKEN.toLowerCase(),
    );
    assert.ok(monadBorrowable);
    assert.equal(monadBorrowable.isBorrowable, true);

    const borrowTx = await (monadBorrowable as any).borrow(Decimal(4));

    assert.equal(borrowTx.hash, "0xmonad-write");
    assert.equal(monadTransactions.length, 3);
    assert.equal(monadTransactions[2]?.to, MONAD_USDC_CTOKEN);
    assert.match(monadTransactions[2]?.data ?? "", /^0x[0-9a-f]+$/i);
    const borrowCall = (monadBorrowable as any).contract.interface.parseTransaction({
        data: monadTransactions[2]!.data,
    });
    assert.equal(borrowCall?.name, "borrow");
    assert.equal(borrowCall?.args[0], 4_000_000_000_000_000_000n);
    assert.equal(String(borrowCall?.args[1]).toLowerCase(), MONAD_ACCOUNT.toLowerCase());
    assert.equal(monadWaits, 3);
    assert.deepEqual(monadRefreshCalls, [
        {
            addresses: [MONAD_MARKET],
            account: MONAD_ACCOUNT,
        },
        {
            addresses: [MONAD_MARKET],
            account: MONAD_ACCOUNT,
        },
        {
            addresses: [MONAD_MARKET],
            account: MONAD_ACCOUNT,
        },
    ]);
    assert.deepEqual(arbRefreshCalls, []);
    assert.equal(setup_config.chain, "arb-sepolia");
    assert.equal(setup_config.signer, arbSigner);
    assert.equal(all_markets, arbResult.markets);

    (monadBorrowable as any).checkRepayApproval = async () => {};
    const repayTx = await (monadBorrowable as any).repay(Decimal(1));

    assert.equal(repayTx.hash, "0xmonad-write");
    assert.equal(monadTransactions.length, 4);
    assert.equal(monadTransactions[3]?.to, MONAD_USDC_CTOKEN);
    assert.match(monadTransactions[3]?.data ?? "", /^0x[0-9a-f]+$/i);
    const repayCall = (monadBorrowable as any).contract.interface.parseTransaction({
        data: monadTransactions[3]!.data,
    });
    assert.equal(repayCall?.name, "repay");
    assert.equal(repayCall?.args[0], 1_000_000_000_000_000_000n);
    assert.equal(monadWaits, 4);
    assert.deepEqual(monadRefreshCalls, [
        {
            addresses: [MONAD_MARKET],
            account: MONAD_ACCOUNT,
        },
        {
            addresses: [MONAD_MARKET],
            account: MONAD_ACCOUNT,
        },
        {
            addresses: [MONAD_MARKET],
            account: MONAD_ACCOUNT,
        },
        {
            addresses: [MONAD_MARKET],
            account: MONAD_ACCOUNT,
        },
    ]);
    assert.deepEqual(arbRefreshCalls, []);
    assert.equal(setup_config.chain, "arb-sepolia");
    assert.equal(setup_config.signer, arbSigner);
    assert.equal(all_markets, arbResult.markets);

    const redeemTx = await monadWmon.redeemShares(1n);

    assert.equal(redeemTx.hash, "0xmonad-write");
    assert.equal(monadTransactions.length, 5);
    assert.equal(monadTransactions[4]?.to, MONAD_WMON_CTOKEN);
    assert.match(monadTransactions[4]?.data ?? "", /^0x[0-9a-f]+$/i);
    assert.equal(monadWaits, 5);
    assert.deepEqual(monadRefreshCalls, [
        {
            addresses: [MONAD_MARKET],
            account: MONAD_ACCOUNT,
        },
        {
            addresses: [MONAD_MARKET],
            account: MONAD_ACCOUNT,
        },
        {
            addresses: [MONAD_MARKET],
            account: MONAD_ACCOUNT,
        },
        {
            addresses: [MONAD_MARKET],
            account: MONAD_ACCOUNT,
        },
        {
            addresses: [MONAD_MARKET],
            account: MONAD_ACCOUNT,
        },
    ]);
    assert.deepEqual(arbRefreshCalls, []);
    assert.equal(setup_config.chain, "arb-sepolia");
    assert.equal(setup_config.signer, arbSigner);
    assert.equal(all_markets, arbResult.markets);

    const transferTx = await monadWmon.transfer(ARB_ACCOUNT, Decimal(1));

    assert.equal(transferTx.hash, "0xmonad-write");
    assert.equal(monadTransactions.length, 6);
    assert.equal(monadTransactions[5]?.to, MONAD_WMON_CTOKEN);
    assert.match(monadTransactions[5]?.data ?? "", /^0x[0-9a-f]+$/i);
    assert.equal(monadWaits, 6);
    assert.deepEqual(monadRefreshCalls, [
        {
            addresses: [MONAD_MARKET],
            account: MONAD_ACCOUNT,
        },
        {
            addresses: [MONAD_MARKET],
            account: MONAD_ACCOUNT,
        },
        {
            addresses: [MONAD_MARKET],
            account: MONAD_ACCOUNT,
        },
        {
            addresses: [MONAD_MARKET],
            account: MONAD_ACCOUNT,
        },
        {
            addresses: [MONAD_MARKET],
            account: MONAD_ACCOUNT,
        },
        {
            addresses: [MONAD_MARKET],
            account: MONAD_ACCOUNT,
        },
    ]);
    assert.deepEqual(arbRefreshCalls, []);
    assert.equal(setup_config.chain, "arb-sepolia");
    assert.equal(setup_config.signer, arbSigner);
    assert.equal(all_markets, arbResult.markets);

    let collateralFetches = 0;
    (monadWmon as any).balanceOf = async (account: address) => {
        assert.equal(account, MONAD_ACCOUNT);
        return 10n ** 30n;
    };
    (monadWmon as any).fetchUserCollateral = async () => {
        collateralFetches += 1;
        return 0n;
    };
    (monadWmon as any).assertCollateralCapacity = () => {};

    const postCollateralTx = await monadWmon.postCollateral(Decimal(1));

    assert.equal(postCollateralTx.hash, "0xmonad-write");
    assert.equal(monadTransactions.length, 7);
    assert.equal(monadTransactions[6]?.to, MONAD_WMON_CTOKEN);
    assert.match(monadTransactions[6]?.data ?? "", /^0x[0-9a-f]+$/i);
    assert.equal(monadWaits, 7);
    assert.equal(collateralFetches, 2);
    assert.deepEqual(monadRefreshCalls.slice(5), [
        {
            addresses: [MONAD_MARKET],
            account: MONAD_ACCOUNT,
        },
        {
            addresses: [MONAD_MARKET],
            account: MONAD_ACCOUNT,
        },
    ]);
    assert.deepEqual(arbRefreshCalls, []);
    assert.equal(setup_config.chain, "arb-sepolia");
    assert.equal(setup_config.signer, arbSigner);
    assert.equal(all_markets, arbResult.markets);

    const maxRedemptionCalls: Array<{ account: string; token: string; bufferTime: bigint }> = [];
    (monadMarket.reader as any).maxRedemptionOf = async (
        account: string,
        token: { address: string },
        bufferTime: bigint,
    ) => {
        maxRedemptionCalls.push({ account, token: token.address, bufferTime });
        return {
            maxCollateralizedShares: 1_000n,
            maxUncollateralizedShares: 0n,
            errorCodeHit: false,
        };
    };

    const removeCollateralTx = await monadWmon.removeCollateralExact(Decimal(1));

    assert.equal(removeCollateralTx.hash, "0xmonad-write");
    assert.equal(monadTransactions.length, 8);
    assert.equal(monadTransactions[7]?.to, MONAD_WMON_CTOKEN);
    assert.match(monadTransactions[7]?.data ?? "", /^0x[0-9a-f]+$/i);
    assert.equal(monadWaits, 8);
    assert.equal(collateralFetches, 3);
    assert.deepEqual(maxRedemptionCalls, [{
        account: MONAD_ACCOUNT,
        token: MONAD_WMON_CTOKEN,
        bufferTime: 0n,
    }]);
    assert.deepEqual(monadRefreshCalls.slice(5), [
        {
            addresses: [MONAD_MARKET],
            account: MONAD_ACCOUNT,
        },
        {
            addresses: [MONAD_MARKET],
            account: MONAD_ACCOUNT,
        },
        {
            addresses: [MONAD_MARKET],
            account: MONAD_ACCOUNT,
        },
    ]);
    assert.deepEqual(arbRefreshCalls, []);
    assert.equal(setup_config.chain, "arb-sepolia");
    assert.equal(setup_config.signer, arbSigner);
    assert.equal(all_markets, arbResult.markets);

    const delegatedRedeemOwner = "0x0000000000000000000000000000000000000d01" as address;
    const delegatedRedeemReceiver = "0x0000000000000000000000000000000000000d02" as address;
    const delegateChecks: Array<{ owner: string; delegate: string }> = [];
    const beforeDelegatedRedeemTransactionCount = monadTransactions.length;
    const beforeDelegatedRedeemRefreshCount = monadRefreshCalls.length;
    Object.defineProperty((monadWmon as any).contract, "isDelegate", {
        configurable: true,
        value: async (owner: string, delegate: string) => {
            delegateChecks.push({ owner, delegate });
            return true;
        },
    });
    Object.defineProperty((monadWmon as any).contract, "allowance", {
        configurable: true,
        value: async () => {
            throw new Error("share allowance should not be checked for delegated older Monad redeemCollateral");
        },
    });

    const delegatedRedeemTx = await monadWmon.redeemCollateral(
        Decimal(1),
        delegatedRedeemReceiver,
        delegatedRedeemOwner,
    );

    assert.equal(delegatedRedeemTx.hash, "0xmonad-write");
    assert.equal(monadTransactions.length, beforeDelegatedRedeemTransactionCount + 1);
    assert.equal(monadTransactions[beforeDelegatedRedeemTransactionCount]?.to, MONAD_WMON_CTOKEN);
    assert.match(monadTransactions[beforeDelegatedRedeemTransactionCount]?.data ?? "", /^0x[0-9a-f]+$/i);
    assert.equal(monadWaits, beforeDelegatedRedeemTransactionCount + 1);
    assert.deepEqual(delegateChecks, [{
        owner: delegatedRedeemOwner,
        delegate: MONAD_ACCOUNT,
    }]);
    const delegatedRedeemCall = (monadWmon as any).contract.interface.parseTransaction({
        data: monadTransactions[beforeDelegatedRedeemTransactionCount]!.data,
    });
    assert.equal(delegatedRedeemCall?.name, "redeemCollateralFor");
    assert.ok(delegatedRedeemCall?.args[0] > 0n);
    assert.equal(delegatedRedeemCall?.args[1], delegatedRedeemReceiver);
    assert.equal(delegatedRedeemCall?.args[2], delegatedRedeemOwner);
    assert.deepEqual(monadRefreshCalls.slice(beforeDelegatedRedeemRefreshCount), [
        { addresses: [MONAD_MARKET], account: MONAD_ACCOUNT },
    ]);
    assert.deepEqual(arbRefreshCalls, []);
    assert.equal(setup_config.chain, "arb-sepolia");
    assert.equal(setup_config.signer, arbSigner);
    assert.equal(all_markets, arbResult.markets);

    const beforeMaxRemovalTransactionCount = monadTransactions.length;
    const beforeMaxRemovalRefreshCount = monadRefreshCalls.length;
    const beforeMaxRemovalPreflightCount = maxRedemptionCalls.length;
    const beforeMaxRemovalCollateralFetches = collateralFetches;

    const removeMaxCollateralTx = await monadWmon.removeMaxCollateral();

    assert.equal(removeMaxCollateralTx.hash, "0xmonad-write");
    assert.equal(monadTransactions.length, beforeMaxRemovalTransactionCount + 1);
    assert.equal(monadTransactions[beforeMaxRemovalTransactionCount]?.to, MONAD_WMON_CTOKEN);
    assert.match(monadTransactions[beforeMaxRemovalTransactionCount]?.data ?? "", /^0x[0-9a-f]+$/i);
    assert.equal(monadWaits, beforeMaxRemovalTransactionCount + 1);
    assert.equal(collateralFetches, beforeMaxRemovalCollateralFetches + 1);
    assert.deepEqual(maxRedemptionCalls.slice(beforeMaxRemovalPreflightCount), [{
        account: MONAD_ACCOUNT,
        token: MONAD_WMON_CTOKEN,
        bufferTime: 0n,
    }]);
    assert.deepEqual(monadRefreshCalls.slice(beforeMaxRemovalRefreshCount), [
        { addresses: [MONAD_MARKET], account: MONAD_ACCOUNT },
    ]);
    assert.deepEqual(arbRefreshCalls, []);
    assert.equal(setup_config.chain, "arb-sepolia");
    assert.equal(setup_config.signer, arbSigner);
    assert.equal(all_markets, arbResult.markets);

    const priorTransactionCount = monadTransactions.length;
    const priorRefreshCount = monadRefreshCalls.length;
    const directZapper = new Zapper(
        monadResult.setupConfigSnapshot.contracts.zappers.simpleZapper as address,
        monadSigner as any,
        "simple",
        monadResult.setupConfigSnapshot,
        monadResult.dexAgg,
    );
    await directZapper.simpleZap(
        monadWmon,
        MONAD_USDC_ASSET,
        MONAD_WRAPPED_NATIVE,
        4_000_000_000_000_000_000n,
        false,
        100n,
        MONAD_ACCOUNT,
    );

    const nativeSimpleTx = await monadWmon.deposit(Decimal(5), "native-simple");
    assert.equal(nativeSimpleTx.hash, "0xmonad-write");

    for (const zapToken of [monadNativeVault, monadVault]) {
        (zapToken as any).ensureUnderlyingAmount = async (amount: Decimal) => amount;
        (zapToken as any)._checkDepositApprovals = async () => {};
        (zapToken as any).assertCollateralCapacity = () => {};
        (zapToken as any).getExpectedVaultShares = async (amount: bigint) => amount - 1n;
        (zapToken as any).convertToShares = async (amount: bigint) => amount;
    }
    (monadVault as any).getUnderlyingVault = () => ({
        fetchAsset: async (asErc20: boolean) => asErc20
            ? {
                address: chain_config["monad-mainnet"].vaults[0]!.underlying,
                decimals: 18n,
                contract: { decimals: async () => 18n },
            }
            : chain_config["monad-mainnet"].vaults[0]!.underlying,
    });

    const nativeVaultTx = await monadNativeVault.depositAsCollateral(Decimal(6), "native-vault");
    const vaultTx = await monadVault.depositAsCollateral(Decimal(7), "vault");
    assert.equal(nativeVaultTx.hash, "0xmonad-write");
    assert.equal(vaultTx.hash, "0xmonad-write");

    assert.equal(monadTransactions.length, priorTransactionCount + 4);
    assert.equal(monadTransactions[priorTransactionCount]?.to, monadResult.setupConfigSnapshot.contracts.zappers.simpleZapper);
    assert.equal(monadTransactions[priorTransactionCount]?.value, undefined);
    assert.equal(monadTransactions[priorTransactionCount + 1]?.to, monadResult.setupConfigSnapshot.contracts.zappers.simpleZapper);
    assert.equal(monadTransactions[priorTransactionCount + 1]?.value, 5_000_000_000_000_000_000n);
    assert.equal(monadTransactions[priorTransactionCount + 2]?.to, monadResult.setupConfigSnapshot.contracts.zappers.nativeVaultZapper);
    assert.equal(monadTransactions[priorTransactionCount + 2]?.value, 6_000_000_000_000_000_000n);
    assert.equal(monadTransactions[priorTransactionCount + 3]?.to, monadResult.setupConfigSnapshot.contracts.zappers.vaultZapper);
    assert.equal(monadTransactions[priorTransactionCount + 3]?.value, undefined);
    assert.deepEqual(quoteCalls.slice(2), [{
        wallet: monadResult.setupConfigSnapshot.contracts.zappers.simpleZapper as string,
        tokenIn: MONAD_USDC_ASSET,
        tokenOut: MONAD_WRAPPED_NATIVE,
        amount: 4_000_000_000_000_000_000n,
        feeBps: CURVANCE_FEE_BPS,
        feeReceiver: BOOT_DAO_FEE_RECEIVER,
    }]);
    assert.deepEqual(
        monadRefreshCalls.slice(priorRefreshCount),
        [
            { addresses: [MONAD_MARKET], account: MONAD_ACCOUNT },
            { addresses: [MONAD_MARKET], account: MONAD_ACCOUNT },
            { addresses: [MONAD_MARKET], account: MONAD_ACCOUNT },
            { addresses: [MONAD_MARKET], account: MONAD_ACCOUNT },
        ],
    );
    assert.deepEqual(arbRefreshCalls, []);
    assert.equal(setup_config.chain, "arb-sepolia");
    assert.equal(setup_config.signer, arbSigner);
    assert.equal(all_markets, arbResult.markets);

    const fullRepayDebtLookups: Array<{ account: string; token: string; timestamp: bigint }> = [];
    const fullRepayApprovalChecks: bigint[] = [];
    const beforeFullRepayTransactionCount = monadTransactions.length;
    const beforeFullRepayRefreshCount = monadRefreshCalls.length;
    (monadMarket.reader as any).debtBalanceAtTimestamp = async (
        account: string,
        token: string,
        timestamp: bigint,
    ) => {
        fullRepayDebtLookups.push({ account, token, timestamp });
        return 9_876n;
    };
    (arbMarket.reader as any).debtBalanceAtTimestamp = async () => {
        throw new Error("Arbitrum reader should not project older Monad full-repay debt");
    };
    (monadBorrowable as any).checkRepayApproval = async (assets: bigint) => {
        fullRepayApprovalChecks.push(assets);
    };

    const fullRepayTx = await (monadBorrowable as any).repay(Decimal(0));

    assert.equal(fullRepayTx.hash, "0xmonad-write");
    assert.equal(monadTransactions.length, beforeFullRepayTransactionCount + 1);
    assert.equal(monadTransactions[beforeFullRepayTransactionCount]?.to, MONAD_USDC_CTOKEN);
    assert.match(monadTransactions[beforeFullRepayTransactionCount]?.data ?? "", /^0x[0-9a-f]+$/i);
    const fullRepayCall = (monadBorrowable as any).contract.interface.parseTransaction({
        data: monadTransactions[beforeFullRepayTransactionCount]!.data,
    });
    assert.equal(fullRepayCall?.name, "repay");
    assert.equal(fullRepayCall?.args[0], 0n);
    assert.equal(monadWaits, beforeFullRepayTransactionCount + 1);
    assert.equal(fullRepayDebtLookups.length, 1);
    assert.equal(fullRepayDebtLookups[0]!.account, MONAD_ACCOUNT);
    assert.equal(fullRepayDebtLookups[0]!.token, MONAD_USDC_CTOKEN);
    assert.ok(fullRepayDebtLookups[0]!.timestamp > 0n);
    assert.deepEqual(fullRepayApprovalChecks, [9_876n]);
    assert.deepEqual(monadRefreshCalls.slice(beforeFullRepayRefreshCount), [
        { addresses: [MONAD_MARKET], account: MONAD_ACCOUNT },
    ]);
    assert.deepEqual(arbRefreshCalls, []);
    assert.equal(setup_config.chain, "arb-sepolia");
    assert.equal(setup_config.signer, arbSigner);
    assert.equal(all_markets, arbResult.markets);

    const beforeSimCollateralTransactionCount = monadTransactions.length;
    const beforeSimCollateralSimulationCount = monadSimulations.length;
    const beforeSimCollateralRefreshCount = monadRefreshCalls.length;
    const beforeSimCollateralQuoteCount = quoteCalls.length;
    const collateralSimulation = await monadWmon.simulateDepositAsCollateral(Decimal(8), {
        type: "simple",
        inputToken: MONAD_USDC_ASSET,
        slippage: Decimal("0.01"),
    });

    assert.deepEqual(collateralSimulation, { success: true });
    assert.equal(monadTransactions.length, beforeSimCollateralTransactionCount);
    assert.equal(monadSimulations.length, beforeSimCollateralSimulationCount + 1);
    assert.equal(monadSimulations[beforeSimCollateralSimulationCount]?.to, monadResult.setupConfigSnapshot.contracts.zappers.simpleZapper);
    assert.equal(monadSimulations[beforeSimCollateralSimulationCount]?.from, MONAD_ACCOUNT);
    assert.match(monadSimulations[beforeSimCollateralSimulationCount]?.data ?? "", /^0x[0-9a-f]+$/i);
    assert.deepEqual(quoteCalls.slice(beforeSimCollateralQuoteCount), [{
        wallet: monadResult.setupConfigSnapshot.contracts.zappers.simpleZapper as string,
        tokenIn: MONAD_USDC_ASSET,
        tokenOut: MONAD_WRAPPED_NATIVE,
        amount: 8_000_000_000_000_000_000n,
        feeBps: CURVANCE_FEE_BPS,
        feeReceiver: BOOT_DAO_FEE_RECEIVER,
    }]);
    assert.deepEqual(monadRefreshCalls.slice(beforeSimCollateralRefreshCount), []);
    assert.deepEqual(arbRefreshCalls, []);
    assert.equal(setup_config.chain, "arb-sepolia");
    assert.equal(setup_config.signer, arbSigner);
    assert.equal(all_markets, arbResult.markets);
});

test("older returned approval helpers keep result signer and setup targets after singleton moves", async (t) => {
    installSetupChainBootHarness(t, {
        marketData: (context) => {
            if (context.batchKey?.startsWith("monad-mainnet:")) {
                return {
                    staticMarket: [
                        createBootStaticMarket(MONAD_MARKET, [
                            { cToken: MONAD_WMON_CTOKEN, symbol: "WMON", asset: MONAD_WRAPPED_NATIVE },
                            { cToken: MONAD_USDC_CTOKEN, symbol: "USDC", asset: MONAD_USDC_ASSET, isBorrowable: true },
                        ]),
                    ],
                    dynamicMarket: [
                        createBootDynamicMarket(MONAD_MARKET, [MONAD_WMON_CTOKEN, MONAD_USDC_CTOKEN]),
                    ],
                    userData: {
                        locks: [],
                        markets: [
                            createBootUserMarket(MONAD_MARKET, [MONAD_WMON_CTOKEN, MONAD_USDC_CTOKEN]),
                        ],
                    },
                };
            }

            if (context.batchKey?.startsWith("arb-sepolia:")) {
                return {
                    staticMarket: [
                        createBootStaticMarket(ARB_STABLE_MARKET, [
                            { cToken: ARB_USDC_CTOKEN, symbol: "USDC" },
                            { cToken: ARB_AUSD_CTOKEN, symbol: "AUSD" },
                        ]),
                    ],
                    dynamicMarket: [
                        createBootDynamicMarket(ARB_STABLE_MARKET, [ARB_USDC_CTOKEN, ARB_AUSD_CTOKEN]),
                    ],
                    userData: {
                        locks: [],
                        markets: [
                            createBootUserMarket(ARB_STABLE_MARKET, [ARB_USDC_CTOKEN, ARB_AUSD_CTOKEN]),
                        ],
                    },
                };
            }

            throw new Error(`Unexpected setup boot reader context: ${context.batchKey}`);
        },
        fetch: async () => ({
            ok: true,
            json: async () => ({ native_apy: [] }),
        }),
    });

    const monadSigner = {
        address: MONAD_ACCOUNT,
        provider: createDecimalsReadProvider(143n) as any,
        sendTransaction: async () => {
            throw new Error("approval helper test stubs ERC20/plugin writes directly");
        },
    };
    const arbSigner = {
        address: ARB_ACCOUNT,
        provider: createDecimalsReadProvider(421614n) as any,
        sendTransaction: async () => {
            throw new Error("Arbitrum singleton signer should not execute older Monad approvals");
        },
    };

    const monadResult = await setupChain("monad-mainnet", monadSigner as any, "https://api.monad-approval.example");
    const monadMarket = monadResult.markets[0];
    assert.ok(monadMarket);
    const monadWmon = monadMarket.tokens.find(
        (token) => token.address.toLowerCase() === MONAD_WMON_CTOKEN.toLowerCase(),
    );
    assert.ok(monadWmon);

    const arbResult = await setupChain("arb-sepolia", arbSigner as any, "https://api.arb-approval.example");
    assert.equal(setup_config.chain, "arb-sepolia");
    assert.equal(setup_config.signer, arbSigner);
    assert.equal(all_markets, arbResult.markets);

    const approvalCalls: Array<{
        token: string;
        spender: string;
        amount: string | null;
        signer: unknown;
        provider: unknown;
    }> = [];
    const originalApprove = ERC20.prototype.approve;
    (ERC20.prototype as any).approve = async function(
        this: ERC20,
        spender: address,
        amount: unknown,
    ) {
        approvalCalls.push({
            token: this.address,
            spender,
            amount: amount == null ? null : String(amount),
            signer: (this as any).signer,
            provider: (this as any).provider,
        });
        return { hash: "0xapproval" } as any;
    };
    t.after(() => {
        ERC20.prototype.approve = originalApprove;
    });

    const pluginApprovalCalls: Array<{ plugin: string; approved: boolean; signer: unknown }> = [];
    (monadWmon as any).getWriteContract = function(this: typeof monadWmon) {
        return {
            setDelegateApproval: async (plugin: string, approved: boolean) => {
                pluginApprovalCalls.push({
                    plugin,
                    approved,
                    signer: (this as any).signer,
                });
                return { hash: "0xplugin-approval" };
            },
        };
    };

    await monadWmon.approveUnderlying(Decimal(1));
    await monadWmon.approve(Decimal(2), MONAD_TEST_OUTPUT_TOKEN);
    await monadWmon.approveZapAsset({
        type: "simple",
        inputToken: MONAD_USDC_ASSET,
        slippage: Decimal("0.01"),
    }, Decimal(3));
    await monadWmon.approvePlugin("simple", "zapper");

    assert.deepEqual(
        approvalCalls.map((call) => ({
            token: call.token.toLowerCase(),
            spender: call.spender.toLowerCase(),
            amount: call.amount,
            signer: call.signer,
            provider: call.provider,
        })),
        [
            {
                token: MONAD_WRAPPED_NATIVE.toLowerCase(),
                spender: MONAD_WMON_CTOKEN.toLowerCase(),
                amount: "1",
                signer: monadSigner,
                provider: monadResult.setupConfigSnapshot.readProvider,
            },
            {
                token: MONAD_WMON_CTOKEN.toLowerCase(),
                spender: MONAD_TEST_OUTPUT_TOKEN.toLowerCase(),
                amount: "2",
                signer: monadSigner,
                provider: monadResult.setupConfigSnapshot.readProvider,
            },
            {
                token: MONAD_USDC_ASSET.toLowerCase(),
                spender: String(monadResult.setupConfigSnapshot.contracts.zappers.simpleZapper).toLowerCase(),
                amount: "3",
                signer: monadSigner,
                provider: monadResult.setupConfigSnapshot.readProvider,
            },
        ],
    );
    assert.deepEqual(pluginApprovalCalls, [{
        plugin: monadResult.setupConfigSnapshot.contracts.zappers.simpleZapper as string,
        approved: true,
        signer: monadSigner,
    }]);
    assert.equal(setup_config.chain, "arb-sepolia");
    assert.equal(setup_config.signer, arbSigner);
    assert.equal(all_markets, arbResult.markets);
});

test("older returned cToken leverage paths execute with result context after singleton moves", async (t) => {
    const wad = 10n ** 18n;

    installSetupChainBootHarness(t, {
        marketData: (context) => {
            if (context.batchKey?.startsWith("monad-mainnet:")) {
                return {
                    staticMarket: [
                        createBootStaticMarket(MONAD_MARKET, [
                            { cToken: MONAD_WMON_CTOKEN, symbol: "WMON", asset: MONAD_WRAPPED_NATIVE },
                            { cToken: MONAD_USDC_CTOKEN, symbol: "USDC", asset: MONAD_USDC_ASSET, isBorrowable: true },
                        ]),
                    ],
                    dynamicMarket: [
                        createBootDynamicMarket(MONAD_MARKET, [MONAD_WMON_CTOKEN, MONAD_USDC_CTOKEN]),
                    ],
                    userData: {
                        locks: [],
                        markets: [
                            createBootUserMarket(MONAD_MARKET, [MONAD_WMON_CTOKEN, MONAD_USDC_CTOKEN]),
                        ],
                    },
                };
            }

            if (context.batchKey?.startsWith("arb-sepolia:")) {
                return {
                    staticMarket: [
                        createBootStaticMarket(ARB_STABLE_MARKET, [
                            { cToken: ARB_USDC_CTOKEN, symbol: "USDC" },
                            { cToken: ARB_AUSD_CTOKEN, symbol: "AUSD" },
                        ]),
                    ],
                    dynamicMarket: [
                        createBootDynamicMarket(ARB_STABLE_MARKET, [ARB_USDC_CTOKEN, ARB_AUSD_CTOKEN]),
                    ],
                    userData: {
                        locks: [],
                        markets: [
                            createBootUserMarket(ARB_STABLE_MARKET, [ARB_USDC_CTOKEN, ARB_AUSD_CTOKEN]),
                        ],
                    },
                };
            }

            throw new Error(`Unexpected setup boot reader context: ${context.batchKey}`);
        },
        fetch: async () => ({
            ok: true,
            json: async () => ({ native_apy: [] }),
        }),
    });

    const monadTransactions: Array<{ to: string; data: string; value?: bigint }> = [];
    const monadSimulations: Array<{ to: string; data: string; from: string }> = [];
    let monadWaits = 0;
    const monadSigner = {
        address: MONAD_ACCOUNT,
        provider: createDecimalsReadProvider(143n) as any,
        sendTransaction: async (tx: { to: string; data: string; value?: bigint }) => {
            monadTransactions.push(tx);
            return {
                hash: "0xmonad-leverage",
                wait: async () => {
                    monadWaits += 1;
                    return { status: 1 };
                },
            };
        },
        call: async (tx: { to: string; data: string; from: string }) => {
            monadSimulations.push(tx);
            return "0x";
        },
    };
    const arbSigner = {
        address: ARB_ACCOUNT,
        provider: createDecimalsReadProvider(421614n) as any,
        sendTransaction: async () => {
            throw new Error("Arbitrum singleton signer should not execute older Monad leverage writes");
        },
    };

    const monadResult = await setupChain("monad-mainnet", monadSigner as any, "https://api.monad-leverage.example");
    const monadMarket = monadResult.markets[0];
    assert.ok(monadMarket);
    const monadWmon = monadMarket.tokens.find(
        (token) => token.address.toLowerCase() === MONAD_WMON_CTOKEN.toLowerCase(),
    );
    const monadBorrowable = monadMarket.tokens.find(
        (token) => token.address.toLowerCase() === MONAD_USDC_CTOKEN.toLowerCase(),
    );
    assert.ok(monadWmon);
    assert.ok(monadBorrowable);
    assert.equal(monadBorrowable.isBorrowable, true);

    const arbResult = await setupChain("arb-sepolia", arbSigner as any, "https://api.arb-after-leverage.example");
    assert.ok(arbResult.markets[0]);
    assert.equal(setup_config.chain, "arb-sepolia");
    assert.equal(setup_config.signer, arbSigner);
    assert.equal(all_markets, arbResult.markets);

    const monadRefreshCalls: Array<{ addresses: string[]; account: string }> = [];
    const arbRefreshCalls: Array<{ addresses: string[]; account: string }> = [];
    (monadMarket.reader as any).getMarketStates = async (addresses: string[], account: string) => {
        monadRefreshCalls.push({ addresses, account });
        return {
            dynamicMarkets: [
                createBootDynamicMarket(MONAD_MARKET, [MONAD_WMON_CTOKEN, MONAD_USDC_CTOKEN]),
            ],
            userMarkets: [
                createBootUserMarket(MONAD_MARKET, [MONAD_WMON_CTOKEN, MONAD_USDC_CTOKEN]),
            ],
        };
    };
    (arbResult.markets[0]!.reader as any).getMarketStates = async (addresses: string[], account: string) => {
        arbRefreshCalls.push({ addresses, account });
        throw new Error("Arbitrum reader should not refresh older Monad leverage writes");
    };
    (arbResult.markets[0]!.reader as any).getLeverageSnapshot = async () => {
        throw new Error("Arbitrum reader should not snapshot older Monad leverage writes");
    };

    const leverageSnapshotCalls: Array<{
        account: string;
        collateralToken: string;
        borrowToken: string;
        bufferTime: bigint;
    }> = [];
    (monadMarket.reader as any).getLeverageSnapshot = async (
        account: string,
        collateralToken: string,
        borrowToken: string,
        bufferTime: bigint,
    ) => {
        leverageSnapshotCalls.push({ account, collateralToken, borrowToken, bufferTime });
        return {
            collateralUsd: 100n * wad,
            debtUsd: 40n * wad,
            collateralAssetPrice: wad,
            sharePrice: 2n * wad,
            debtAssetPrice: wad,
            debtTokenBalance: 100n * wad,
            oracleError: false,
        };
    };

    const quoteActionCalls: Array<{
        manager: string;
        inputToken: string;
        outputToken: string;
        inputAmount: bigint;
        slippage: bigint;
        feeBps: bigint;
        feeReceiver: string | undefined;
    }> = [];
    (monadResult.dexAgg as any).quoteAction = async (
        manager: string,
        inputToken: string,
        outputToken: string,
        inputAmount: bigint,
        slippage: bigint,
        feeBps: bigint,
        feeReceiver?: address,
    ) => {
        quoteActionCalls.push({ manager, inputToken, outputToken, inputAmount, slippage, feeBps, feeReceiver });
        return {
            action: {
                inputToken,
                inputAmount,
                outputToken,
                target: monadResult.dexAgg.router,
                slippage: 0n,
                call: "0xabcdef" as bytes,
            },
            quote: { min_out: 1_000_000_000_000_000_000n },
        };
    };

    const primeLeverageState = () => {
        (monadMarket as any).cache.user.collateral = 100n * wad;
        (monadMarket as any).cache.user.debt = 40n * wad;
        (monadMarket as any).cache.user.maxDebt = 500n * wad;
        (monadMarket as any).cache.user.errorCodeHit = false;
        (monadMarket as any).cache.user.priceStale = false;

        Object.assign((monadWmon as any).cache, {
            maxLeverage: 100_000n,
            userCollateral: 100n * wad,
            totalAssets: 200n * wad,
            totalSupply: 100n * wad,
            assetPrice: wad,
            assetPriceLower: wad,
            sharePrice: 2n * wad,
            sharePriceLower: 2n * wad,
        });
        (monadWmon as any).markUserCacheFresh?.();

        Object.assign((monadBorrowable as any).cache, {
            debtCap: 1_000n * wad,
            debt: 0n,
            liquidity: 1_000n * wad,
            totalAssets: 1_000n * wad,
            totalSupply: 1_000n * wad,
            assetPrice: wad,
            assetPriceLower: wad,
            sharePrice: wad,
            sharePriceLower: wad,
        });
        (monadBorrowable as any).markUserCacheFresh?.();
    };
    (monadBorrowable as any).fetchLiquidity = async () => 1_000n * wad;
    (monadBorrowable as any).marketOutstandingDebt = async () => 0n;
    (monadWmon as any).ensureUnderlyingAmount = async (amount: Decimal) => amount;
    (monadWmon as any)._checkTokenApproval = async () => {};

    const expectedManager = monadWmon.getPluginAddress("simple", "positionManager");
    assert.ok(expectedManager);

    primeLeverageState();
    const leverageUpTx = await monadWmon.leverageUp(monadBorrowable as any, Decimal(2), "simple", Decimal(0.01));
    primeLeverageState();
    const leverageDownTx = await monadWmon.leverageDown(
        monadBorrowable as any,
        Decimal("1.6666666667"),
        Decimal("1.5"),
        "simple",
        Decimal(0.01),
    );
    primeLeverageState();
    const depositAndLeverageTx = await monadWmon.depositAndLeverage(
        Decimal(10),
        monadBorrowable as any,
        Decimal("1.6"),
        "simple",
        Decimal(0.01),
    );

    assert.deepEqual(
        [leverageUpTx.hash, leverageDownTx.hash, depositAndLeverageTx.hash],
        ["0xmonad-leverage", "0xmonad-leverage", "0xmonad-leverage"],
    );
    assert.equal(monadWaits, 3);
    assert.deepEqual(
        monadTransactions.map((tx) => ({ to: tx.to, hasData: /^0x[0-9a-f]+$/i.test(tx.data), value: tx.value })),
        [
            { to: expectedManager, hasData: true, value: undefined },
            { to: expectedManager, hasData: true, value: undefined },
            { to: expectedManager, hasData: true, value: undefined },
        ],
    );

    const deleverageFeeGrossedCollateral = (10n * wad * 10_000n + (10_000n - CURVANCE_FEE_BPS) - 1n)
        / (10_000n - CURVANCE_FEE_BPS);
    assert.deepEqual(quoteActionCalls, [
        {
            manager: expectedManager,
            inputToken: MONAD_USDC_ASSET,
            outputToken: MONAD_WRAPPED_NATIVE,
            inputAmount: 20n * wad,
            slippage: 110n,
            feeBps: CURVANCE_FEE_BPS,
            feeReceiver: BOOT_DAO_FEE_RECEIVER,
        },
        {
            manager: expectedManager,
            inputToken: MONAD_WRAPPED_NATIVE,
            outputToken: MONAD_USDC_ASSET,
            inputAmount: deleverageFeeGrossedCollateral,
            slippage: 100n,
            feeBps: CURVANCE_FEE_BPS,
            feeReceiver: BOOT_DAO_FEE_RECEIVER,
        },
        {
            manager: expectedManager,
            inputToken: MONAD_USDC_ASSET,
            outputToken: MONAD_WRAPPED_NATIVE,
            inputAmount: 2n * wad,
            slippage: 110n,
            feeBps: CURVANCE_FEE_BPS,
            feeReceiver: BOOT_DAO_FEE_RECEIVER,
        },
    ]);
    assert.deepEqual(leverageSnapshotCalls, [
        { account: MONAD_ACCOUNT, collateralToken: MONAD_WMON_CTOKEN, borrowToken: MONAD_USDC_CTOKEN, bufferTime: 120n },
        { account: MONAD_ACCOUNT, collateralToken: MONAD_WMON_CTOKEN, borrowToken: MONAD_USDC_CTOKEN, bufferTime: 120n },
        { account: MONAD_ACCOUNT, collateralToken: MONAD_WMON_CTOKEN, borrowToken: MONAD_USDC_CTOKEN, bufferTime: 120n },
    ]);
    assert.deepEqual(monadRefreshCalls, [
        { addresses: [MONAD_MARKET], account: MONAD_ACCOUNT },
        { addresses: [MONAD_MARKET], account: MONAD_ACCOUNT },
        { addresses: [MONAD_MARKET], account: MONAD_ACCOUNT },
    ]);

    const priorQuoteCount = quoteActionCalls.length;
    const priorSnapshotCount = leverageSnapshotCalls.length;
    const priorRefreshCount = monadRefreshCalls.length;
    const priorTransactionCount = monadTransactions.length;
    primeLeverageState();
    const leverageUpSimulation = await monadWmon.leverageUp(
        monadBorrowable as any,
        Decimal(2),
        "simple",
        Decimal(0.01),
        true,
    );
    primeLeverageState();
    const leverageDownSimulation = await monadWmon.leverageDown(
        monadBorrowable as any,
        Decimal("1.6666666667"),
        Decimal("1.5"),
        "simple",
        Decimal(0.01),
        true,
    );
    primeLeverageState();
    const depositAndLeverageSimulation = await monadWmon.depositAndLeverage(
        Decimal(10),
        monadBorrowable as any,
        Decimal("1.6"),
        "simple",
        Decimal(0.01),
        true,
    );

    assert.deepEqual(
        [leverageUpSimulation, leverageDownSimulation, depositAndLeverageSimulation],
        [{ success: true }, { success: true }, { success: true }],
    );
    assert.equal(monadTransactions.length, priorTransactionCount, "simulations should not submit transactions");
    assert.equal(monadWaits, 3, "simulations should not wait for receipts");
    assert.deepEqual(
        monadSimulations.map((call) => ({
            to: call.to,
            from: call.from,
            hasData: /^0x[0-9a-f]+$/i.test(call.data),
        })),
        [
            { to: expectedManager, from: MONAD_ACCOUNT, hasData: true },
            { to: expectedManager, from: MONAD_ACCOUNT, hasData: true },
            { to: expectedManager, from: MONAD_ACCOUNT, hasData: true },
        ],
    );
    assert.deepEqual(monadRefreshCalls.slice(priorRefreshCount), []);
    assert.deepEqual(quoteActionCalls.slice(priorQuoteCount), quoteActionCalls.slice(0, 3));
    assert.deepEqual(leverageSnapshotCalls.slice(priorSnapshotCount), leverageSnapshotCalls.slice(0, 3));
    assert.deepEqual(arbRefreshCalls, []);
    assert.equal(monadMarket.setup.chain, "monad-mainnet");
    assert.equal(monadMarket.reader.batchKey?.startsWith("monad-mainnet:"), true);
    assert.equal(setup_config.chain, "arb-sepolia");
    assert.equal(setup_config.signer, arbSigner);
    assert.equal(all_markets, arbResult.markets);
});

test("explicit portfolio snapshots keep older result markets bound after a later chain boot", async (t) => {
    installSetupChainBootHarness(t, {
        marketData: (context) => {
            if (context.batchKey?.startsWith("monad-mainnet:")) {
                return {
                    staticMarket: [
                        createBootStaticMarket(MONAD_MARKET, [
                            { cToken: MONAD_WMON_CTOKEN, symbol: "WMON", asset: MONAD_WRAPPED_NATIVE },
                            { cToken: MONAD_USDC_CTOKEN, symbol: "USDC", asset: MONAD_USDC_ASSET },
                        ]),
                    ],
                    dynamicMarket: [
                        createBootDynamicMarket(MONAD_MARKET, [MONAD_WMON_CTOKEN, MONAD_USDC_CTOKEN]),
                    ],
                    userData: {
                        locks: [],
                        markets: [
                            createBootUserMarket(MONAD_MARKET, [MONAD_WMON_CTOKEN, MONAD_USDC_CTOKEN]),
                        ],
                    },
                };
            }

            if (context.batchKey?.startsWith("arb-sepolia:")) {
                return {
                    staticMarket: [
                        createBootStaticMarket(ARB_STABLE_MARKET, [
                            { cToken: ARB_USDC_CTOKEN, symbol: "USDC" },
                            { cToken: ARB_AUSD_CTOKEN, symbol: "AUSD" },
                        ]),
                    ],
                    dynamicMarket: [
                        createBootDynamicMarket(ARB_STABLE_MARKET, [ARB_USDC_CTOKEN, ARB_AUSD_CTOKEN]),
                    ],
                    userData: {
                        locks: [],
                        markets: [
                            createBootUserMarket(ARB_STABLE_MARKET, [ARB_USDC_CTOKEN, ARB_AUSD_CTOKEN]),
                        ],
                    },
                };
            }

            throw new Error(`Unexpected setup boot reader context: ${context.batchKey}`);
        },
        fetch: async () => ({
            ok: true,
            json: async () => ({ native_apy: [] }),
        }),
    });

    const monadResult = await setupChain("monad-mainnet", null, "https://api.monad-snapshot.example", {
        account: MONAD_ACCOUNT,
        readProvider: createDecimalsReadProvider(143n) as any,
    });
    const monadMarket = monadResult.markets[0];
    assert.ok(monadMarket);

    const arbResult = await setupChain("arb-sepolia", null, "https://api.arb-after-snapshot.example", {
        account: ARB_ACCOUNT,
        readProvider: createDecimalsReadProvider(421614n) as any,
    });
    const arbMarket = arbResult.markets[0];
    assert.ok(arbMarket);
    assert.equal(setup_config.chain, "arb-sepolia");
    assert.equal(all_markets, arbResult.markets);

    const monadSnapshotRefreshCalls: Array<{ account: string }> = [];
    const arbSnapshotRefreshCalls: Array<{ account: string }> = [];

    (monadMarket.reader as any).getAllDynamicState = async (account: string) => {
        monadSnapshotRefreshCalls.push({ account });
        return {
            dynamicMarket: [
                createBootDynamicMarket(MONAD_MARKET, [MONAD_WMON_CTOKEN, MONAD_USDC_CTOKEN]),
            ],
            userData: {
                markets: [
                    createBootUserMarket(MONAD_MARKET, [MONAD_WMON_CTOKEN, MONAD_USDC_CTOKEN]),
                ],
            },
        };
    };
    (arbMarket.reader as any).getAllDynamicState = async (account: string) => {
        arbSnapshotRefreshCalls.push({ account });
        return {
            dynamicMarket: [
                createBootDynamicMarket(ARB_STABLE_MARKET, [ARB_USDC_CTOKEN, ARB_AUSD_CTOKEN]),
            ],
            userData: {
                markets: [
                    createBootUserMarket(ARB_STABLE_MARKET, [ARB_USDC_CTOKEN, ARB_AUSD_CTOKEN]),
                ],
            },
        };
    };

    const olderMonadSnapshot = await takePortfolioSnapshot(MONAD_ACCOUNT, {
        markets: monadResult.markets,
        refresh: true,
    });

    assert.equal(olderMonadSnapshot.chain, "monad-mainnet");
    assert.deepEqual(
        olderMonadSnapshot.markets.map((market) => ({
            address: market.marketAddress,
            chain: market.chain,
            chainId: market.chainId,
        })),
        [{ address: MONAD_MARKET, chain: "monad-mainnet", chainId: 143 }],
    );
    assert.deepEqual(monadSnapshotRefreshCalls, [{ account: MONAD_ACCOUNT }]);
    assert.deepEqual(arbSnapshotRefreshCalls, []);
    assert.equal(setup_config.chain, "arb-sepolia");
    assert.equal(all_markets, arbResult.markets);
    assert.equal(monadMarket.setup.chain, "monad-mainnet");
    assert.equal(monadMarket.account, MONAD_ACCOUNT);

    const currentDefaultSnapshot = await takePortfolioSnapshot(ARB_ACCOUNT, { refresh: true });

    assert.equal(currentDefaultSnapshot.chain, "arb-sepolia");
    assert.deepEqual(
        currentDefaultSnapshot.markets.map((market) => ({
            address: market.marketAddress,
            chain: market.chain,
            chainId: market.chainId,
        })),
        [{ address: ARB_STABLE_MARKET, chain: "arb-sepolia", chainId: 421614 }],
    );
    assert.deepEqual(monadSnapshotRefreshCalls, [{ account: MONAD_ACCOUNT }]);
    assert.deepEqual(arbSnapshotRefreshCalls, [{ account: ARB_ACCOUNT }]);
    assert.equal(all_markets, arbResult.markets);

    const monadSummaryRefreshCalls: Array<{ addresses: string[]; account: string }> = [];
    const monadSummaryPromotionCalls: Array<{ addresses: string[]; account: string }> = [];

    (monadMarket.reader as any).getMarketSummaries = async (addresses: string[], account: string) => {
        monadSummaryRefreshCalls.push({ addresses, account });
        return [{
            address: MONAD_MARKET,
            collateral: 31n,
            maxDebt: 32n,
            debt: 0n,
            positionHealth: 33n,
            cooldown: 1200n,
            errorCodeHit: false,
            priceStale: false,
        }];
    };
    (monadMarket.reader as any).getMarketStates = async (addresses: string[], account: string) => {
        monadSummaryPromotionCalls.push({ addresses, account });
        return {
            dynamicMarkets: [
                createBootDynamicMarket(MONAD_MARKET, [MONAD_WMON_CTOKEN, MONAD_USDC_CTOKEN]),
            ],
            userMarkets: [
                createBootUserMarket(MONAD_MARKET, [MONAD_WMON_CTOKEN, MONAD_USDC_CTOKEN]),
            ],
        };
    };

    const summaryScopedMonadMarkets = await refreshActiveUserMarketSummaries(
        MONAD_ACCOUNT,
        monadResult.markets,
    );
    assert.equal(monadMarket.userDataScope, "summary");

    const promotedSummarySnapshot = await takePortfolioSnapshot(MONAD_ACCOUNT, {
        markets: summaryScopedMonadMarkets,
    });

    assert.equal(promotedSummarySnapshot.chain, "monad-mainnet");
    assert.deepEqual(
        promotedSummarySnapshot.markets.map((market) => ({
            address: market.marketAddress,
            chain: market.chain,
            chainId: market.chainId,
        })),
        [{ address: MONAD_MARKET, chain: "monad-mainnet", chainId: 143 }],
    );
    assert.deepEqual(monadSummaryRefreshCalls, [{
        addresses: [MONAD_MARKET],
        account: MONAD_ACCOUNT,
    }]);
    assert.deepEqual(monadSummaryPromotionCalls, [{
        addresses: [MONAD_MARKET],
        account: MONAD_ACCOUNT,
    }]);
    assert.deepEqual(monadSnapshotRefreshCalls, [{ account: MONAD_ACCOUNT }]);
    assert.deepEqual(arbSnapshotRefreshCalls, [{ account: ARB_ACCOUNT }]);
    assert.equal(monadMarket.account, MONAD_ACCOUNT);
    assert.equal(monadMarket.userDataScope, "full");
    assert.equal(setup_config.chain, "arb-sepolia");
    assert.equal(all_markets, arbResult.markets);

    const arbSummaryRefreshCalls: Array<{ addresses: string[]; account: string }> = [];
    const arbSummaryPromotionCalls: Array<{ addresses: string[]; account: string }> = [];

    (arbMarket.reader as any).getMarketSummaries = async (addresses: string[], account: string) => {
        arbSummaryRefreshCalls.push({ addresses, account });
        return [{
            address: ARB_STABLE_MARKET,
            collateral: 41n,
            maxDebt: 42n,
            debt: 0n,
            positionHealth: 43n,
            cooldown: 1200n,
            errorCodeHit: false,
            priceStale: false,
        }];
    };
    (arbMarket.reader as any).getMarketStates = async (addresses: string[], account: string) => {
        arbSummaryPromotionCalls.push({ addresses, account });
        return {
            dynamicMarkets: [
                createBootDynamicMarket(ARB_STABLE_MARKET, [ARB_USDC_CTOKEN, ARB_AUSD_CTOKEN]),
            ],
            userMarkets: [
                createBootUserMarket(ARB_STABLE_MARKET, [ARB_USDC_CTOKEN, ARB_AUSD_CTOKEN]),
            ],
        };
    };

    const summaryScopedMixedMarkets = await Market.reloadUserMarketSummaries(
        [monadMarket, arbMarket],
        MONAD_ACCOUNT,
    );
    assert.equal(monadMarket.userDataScope, "summary");
    assert.equal(arbMarket.userDataScope, "summary");

    const promotedMixedSnapshot = await takePortfolioSnapshot(MONAD_ACCOUNT, {
        markets: summaryScopedMixedMarkets,
        allowMixedChains: true,
    });

    assert.equal(promotedMixedSnapshot.chain, "multi");
    assert.deepEqual(
        promotedMixedSnapshot.markets.map((market) => ({
            address: market.marketAddress,
            chain: market.chain,
            chainId: market.chainId,
        })),
        [
            { address: MONAD_MARKET, chain: "monad-mainnet", chainId: 143 },
            { address: ARB_STABLE_MARKET, chain: "arb-sepolia", chainId: 421614 },
        ],
    );
    assert.deepEqual(monadSummaryRefreshCalls, [
        {
            addresses: [MONAD_MARKET],
            account: MONAD_ACCOUNT,
        },
        {
            addresses: [MONAD_MARKET],
            account: MONAD_ACCOUNT,
        },
    ]);
    assert.deepEqual(arbSummaryRefreshCalls, [{
        addresses: [ARB_STABLE_MARKET],
        account: MONAD_ACCOUNT,
    }]);
    assert.deepEqual(monadSummaryPromotionCalls, [
        {
            addresses: [MONAD_MARKET],
            account: MONAD_ACCOUNT,
        },
        {
            addresses: [MONAD_MARKET],
            account: MONAD_ACCOUNT,
        },
    ]);
    assert.deepEqual(arbSummaryPromotionCalls, [{
        addresses: [ARB_STABLE_MARKET],
        account: MONAD_ACCOUNT,
    }]);
    assert.deepEqual(monadSnapshotRefreshCalls, [{ account: MONAD_ACCOUNT }]);
    assert.deepEqual(arbSnapshotRefreshCalls, [{ account: ARB_ACCOUNT }]);
    assert.equal(monadMarket.userDataScope, "full");
    assert.equal(arbMarket.userDataScope, "full");
    assert.equal(setup_config.chain, "arb-sepolia");
    assert.equal(all_markets, arbResult.markets);
});

test("multiHoldExpiresAt rejects mixed-chain explicit market batches before reader RPC", async (t) => {
    installSetupChainBootHarness(t, {
        marketData: (context) => {
            if (context.batchKey?.startsWith("monad-mainnet:")) {
                return {
                    staticMarket: [
                        createBootStaticMarket(MONAD_MARKET, [
                            { cToken: MONAD_WMON_CTOKEN, symbol: "WMON", asset: MONAD_WRAPPED_NATIVE },
                            { cToken: MONAD_USDC_CTOKEN, symbol: "USDC", asset: MONAD_USDC_ASSET },
                        ]),
                    ],
                    dynamicMarket: [
                        createBootDynamicMarket(MONAD_MARKET, [MONAD_WMON_CTOKEN, MONAD_USDC_CTOKEN]),
                    ],
                    userData: {
                        locks: [],
                        markets: [
                            createBootUserMarket(MONAD_MARKET, [MONAD_WMON_CTOKEN, MONAD_USDC_CTOKEN]),
                        ],
                    },
                };
            }

            if (context.batchKey?.startsWith("arb-sepolia:")) {
                return {
                    staticMarket: [
                        createBootStaticMarket(ARB_STABLE_MARKET, [
                            { cToken: ARB_USDC_CTOKEN, symbol: "USDC" },
                            { cToken: ARB_AUSD_CTOKEN, symbol: "AUSD" },
                        ]),
                    ],
                    dynamicMarket: [
                        createBootDynamicMarket(ARB_STABLE_MARKET, [ARB_USDC_CTOKEN, ARB_AUSD_CTOKEN]),
                    ],
                    userData: {
                        locks: [],
                        markets: [
                            createBootUserMarket(ARB_STABLE_MARKET, [ARB_USDC_CTOKEN, ARB_AUSD_CTOKEN]),
                        ],
                    },
                };
            }

            throw new Error(`Unexpected setup boot reader context: ${context.batchKey}`);
        },
        fetch: async () => ({
            ok: true,
            json: async () => ({ native_apy: [] }),
        }),
    });

    const monadResult = await setupChain("monad-mainnet", null, "https://api.monad-cooldown.example", {
        account: MONAD_ACCOUNT,
        readProvider: createDecimalsReadProvider(143n) as any,
    });
    const monadMarket = monadResult.markets[0];
    assert.ok(monadMarket);

    const arbResult = await setupChain("arb-sepolia", null, "https://api.arb-cooldown.example", {
        account: ARB_ACCOUNT,
        readProvider: createDecimalsReadProvider(421614n) as any,
    });
    const arbMarket = arbResult.markets[0];
    assert.ok(arbMarket);
    assert.equal(setup_config.chain, "arb-sepolia");
    assert.equal(all_markets, arbResult.markets);

    const cooldownCalls: Array<{ addresses: string[]; account: string }> = [];
    (monadMarket.reader as any).marketMultiCooldown = async (addresses: string[], account: string) => {
        cooldownCalls.push({ addresses, account });
        return [monadMarket.cooldownLength];
    };

    const sameChainCooldowns = await monadMarket.multiHoldExpiresAt([monadMarket]);
    assert.deepEqual(cooldownCalls, [{
        addresses: [MONAD_MARKET],
        account: MONAD_ACCOUNT,
    }]);
    assert.equal(sameChainCooldowns[MONAD_MARKET], null);

    const otherMonadReaderMarket = {
        ...monadMarket,
        address: "0x0000000000000000000000000000000000000f0f",
        setup: monadMarket.setup,
        reader: {
            address: "0x0000000000000000000000000000000000000d1f",
        },
    } as any;

    await assert.rejects(
        () => monadMarket.multiHoldExpiresAt([monadMarket, otherMonadReaderMarket]),
        /Cannot batch cooldowns across different ProtocolReader deployments/i,
    );
    assert.deepEqual(cooldownCalls, [{
        addresses: [MONAD_MARKET],
        account: MONAD_ACCOUNT,
    }]);

    const sameAddressDetachedReaderMarket = {
        ...monadMarket,
        address: "0x0000000000000000000000000000000000000f10",
        setup: monadMarket.setup,
        reader: {
            address: monadMarket.reader.address,
            batchKey: null,
        },
    } as any;

    await assert.rejects(
        () => monadMarket.multiHoldExpiresAt([monadMarket, sameAddressDetachedReaderMarket]),
        /Cannot batch cooldowns across different ProtocolReader deployments/i,
    );
    assert.deepEqual(cooldownCalls, [{
        addresses: [MONAD_MARKET],
        account: MONAD_ACCOUNT,
    }]);

    await assert.rejects(
        () => monadMarket.multiHoldExpiresAt([monadMarket, arbMarket]),
        /Cannot batch cooldowns across chains: base=monad-mainnet market=arb-sepolia/i,
    );
    assert.deepEqual(cooldownCalls, [{
        addresses: [MONAD_MARKET],
        account: MONAD_ACCOUNT,
    }]);

    const positionHealthCalls: Array<{ depositToken: string; borrowToken: string }> = [];
    (monadMarket.reader as any).getPositionHealth = async (
        _market: string,
        _account: string,
        depositToken: string,
        borrowToken: string,
    ) => {
        positionHealthCalls.push({ depositToken, borrowToken });
        return {
            positionHealth: 2n * (10n ** 18n),
            errorCodeHit: false,
        };
    };

    const assetImpactCalls: Array<{ collateralToken: string; debtToken: string }> = [];
    (monadMarket.reader as any).previewAssetImpact = async (
        _account: string,
        collateralToken: string,
        debtToken: string,
    ) => {
        assetImpactCalls.push({ collateralToken, debtToken });
        return { supply: 0n, borrow: 0n };
    };

    const monadToken = monadMarket.tokens[0]!;
    const arbToken = arbMarket.tokens[0]!;
    const sameMarketHealth = await monadMarket.previewPositionHealth(monadToken, null, true, Decimal(1));

    assert.equal(sameMarketHealth?.toString(), "1");
    assert.deepEqual(positionHealthCalls, [{
        depositToken: MONAD_WMON_CTOKEN,
        borrowToken: "0x0000000000000000000000000000000000000000",
    }]);

    await assert.rejects(
        () => monadMarket.previewPositionHealth(arbToken as any, null, true, Decimal(1)),
        /Deposit token .* belongs to market .* on arb-sepolia, not market .* on monad-mainnet/i,
    );
    assert.deepEqual(positionHealthCalls, [{
        depositToken: MONAD_WMON_CTOKEN,
        borrowToken: "0x0000000000000000000000000000000000000000",
    }]);

    const sameAddressDifferentReaderToken = {
        ...monadToken,
        market: {
            ...monadMarket,
            reader: {
                address: monadMarket.reader.address,
                batchKey: null,
            },
        },
        convertTokenInputToShares: () => {
            throw new Error("same-address reader guard should run before token amount conversion");
        },
    } as any;

    await assert.rejects(
        () => monadMarket.previewPositionHealth(sameAddressDifferentReaderToken, null, true, Decimal(1)),
        /Deposit token .* with the same reader deployment/i,
    );
    assert.deepEqual(positionHealthCalls, [{
        depositToken: MONAD_WMON_CTOKEN,
        borrowToken: "0x0000000000000000000000000000000000000000",
    }]);

    await assert.rejects(
        () => monadMarket.previewAssetImpact(
            MONAD_ACCOUNT,
            monadToken,
            arbToken as any,
            Decimal(1),
            Decimal(0),
            "day",
        ),
        /Debt token .* belongs to market .* on arb-sepolia, not market .* on monad-mainnet/i,
    );
    assert.deepEqual(assetImpactCalls, []);

    const leverageSnapshotCalls: Array<{ collateralToken: string; borrowToken: string }> = [];
    (monadMarket.reader as any).getLeverageSnapshot = async (
        _account: string,
        collateralToken: string,
        borrowToken: string,
    ) => {
        leverageSnapshotCalls.push({ collateralToken, borrowToken });
        throw new Error("mixed-chain leverage guard should run before snapshot RPC");
    };

    assert.throws(
        () => monadToken.previewLeverageUp(Decimal(2), arbToken as any),
        /Borrow token .* belongs to market .* on arb-sepolia, not market .* on monad-mainnet/i,
    );
    assert.throws(
        () => monadToken.previewLeverageDown(Decimal(1.5), Decimal(2), arbToken as any),
        /Borrow token .* belongs to market .* on arb-sepolia, not market .* on monad-mainnet/i,
    );
    await assert.rejects(
        () => monadToken.leverageUp(arbToken as any, Decimal(2), "simple", Decimal(0.01)),
        /Borrow token .* belongs to market .* on arb-sepolia, not market .* on monad-mainnet/i,
    );
    await assert.rejects(
        () => monadToken.leverageDown(arbToken as any, Decimal(2), Decimal(1.5), "simple", Decimal(0.01)),
        /Borrow token .* belongs to market .* on arb-sepolia, not market .* on monad-mainnet/i,
    );
    await assert.rejects(
        () => monadToken.depositAndLeverage(Decimal(1), arbToken as any, Decimal(2), "simple", Decimal(0.01)),
        /Borrow token .* belongs to market .* on arb-sepolia, not market .* on monad-mainnet/i,
    );

    const monadBorrowToken = monadMarket.tokens[1]!;
    const sameAddressDifferentReaderBorrowToken = {
        ...monadBorrowToken,
        market: {
            ...monadMarket,
            reader: {
                address: monadMarket.reader.address,
                batchKey: null,
            },
        },
    } as any;

    assert.throws(
        () => monadToken.previewLeverageUp(Decimal(2), sameAddressDifferentReaderBorrowToken),
        /Borrow token .* with the same reader deployment/i,
    );
    assert.deepEqual(leverageSnapshotCalls, []);

    const expectedVaultShareCalls: bigint[] = [];
    (monadToken as any).getExpectedVaultShares = async (assets: bigint) => {
        expectedVaultShareCalls.push(assets);
        return 4_242n;
    };

    assert.equal(
        await PositionManager.getVaultExpectedShares(monadToken, monadBorrowToken, Decimal(1)),
        4_242n,
    );
    assert.deepEqual(expectedVaultShareCalls, [1_000_000_000_000_000_000n]);

    await assert.rejects(
        () => PositionManager.getVaultExpectedShares(monadToken, arbToken as any, Decimal(1)),
        /Vault expected shares for deposit token .* on monad-mainnet market .* cannot use borrow token .* from arb-sepolia market/i,
    );
    assert.deepEqual(expectedVaultShareCalls, [1_000_000_000_000_000_000n]);

    await assert.rejects(
        () => PositionManager.getVaultExpectedShares(monadToken, sameAddressDifferentReaderBorrowToken, Decimal(1)),
        /Vault expected shares for deposit token .* with a different reader deployment/i,
    );
    assert.deepEqual(expectedVaultShareCalls, [1_000_000_000_000_000_000n]);

    const directReaderCalls: string[] = [];
    (monadMarket.reader as any).contract = {
        maxRedemptionOf: async () => {
            directReaderCalls.push("maxRedemptionOf");
            return [0n, 0n, false];
        },
        hypotheticalRedemptionOf: async () => {
            directReaderCalls.push("hypotheticalRedemptionOf");
            return [0n, 0n, true, false];
        },
        hypotheticalBorrowOf: async () => {
            directReaderCalls.push("hypotheticalBorrowOf");
            return [0n, 0n, true, false, false];
        },
        hypotheticalLeverageOf: async () => {
            directReaderCalls.push("hypotheticalLeverageOf");
            return [0n, 0n, 0n, 0n, false, false];
        },
    };

    await monadMarket.reader.hypotheticalBorrowOf(MONAD_ACCOUNT, monadToken as any, 1n);
    assert.deepEqual(directReaderCalls, ["hypotheticalBorrowOf"]);

    await assert.rejects(
        () => monadMarket.reader.maxRedemptionOf(MONAD_ACCOUNT, arbToken as any),
        /ProtocolReader .* cannot read redemption token .* on arb-sepolia/i,
    );
    await assert.rejects(
        () => monadMarket.reader.hypotheticalRedemptionOf(MONAD_ACCOUNT, arbToken as any, 1n),
        /ProtocolReader .* cannot read redemption token .* on arb-sepolia/i,
    );
    await assert.rejects(
        () => monadMarket.reader.hypotheticalBorrowOf(MONAD_ACCOUNT, arbToken as any, 1n),
        /ProtocolReader .* cannot read borrow token .* on arb-sepolia/i,
    );
    await assert.rejects(
        () => monadMarket.reader.hypotheticalLeverageOf(MONAD_ACCOUNT, monadToken, arbToken as any, Decimal(1)),
        /ProtocolReader .* cannot read borrow token .* on arb-sepolia/i,
    );
    assert.deepEqual(directReaderCalls, ["hypotheticalBorrowOf"]);

    const zapperCalldataCalls: Array<{ method: string; ctoken: string }> = [];
    const monadZapper = Object.create(Zapper.prototype) as Zapper;
    (monadZapper as any).address = "0x0000000000000000000000000000000000000d0d" as address;
    (monadZapper as any).type = "simple";
    (monadZapper as any).signer = { address: MONAD_ACCOUNT };
    (monadZapper as any).setup = monadResult.setupConfigSnapshot;
    (monadZapper as any).dexAgg = {
        quote: async () => {
            throw new Error("mixed-chain zapper guard should run before DEX quote");
        },
    };
    (monadZapper as any).getCallData = (method: string, args: unknown[]) => {
        zapperCalldataCalls.push({ method, ctoken: String(args[0]) });
        return "0xzapper";
    };
    (monadToken as any).convertToShares = async () => 1n;
    (arbToken as any).convertToShares = async () => {
        throw new Error("mixed-chain zapper guard should run before foreign token conversion");
    };

    const sameChainZapCalldata = await monadZapper.getSimpleZapCalldata(
        monadToken,
        monadToken.asset.address,
        monadToken.asset.address,
        1n,
        false,
        50n,
        MONAD_ACCOUNT,
    );
    assert.equal(sameChainZapCalldata, "0xzapper");
    assert.deepEqual(zapperCalldataCalls, [{
        method: "swapAndDeposit",
        ctoken: MONAD_WMON_CTOKEN,
    }]);

    await assert.rejects(
        () => monadZapper.getSimpleZapCalldata(
            arbToken as any,
            (arbToken as any).asset.address,
            (arbToken as any).asset.address,
            1n,
            false,
            50n,
            MONAD_ACCOUNT,
        ),
        /simple Zapper on monad-mainnet cannot build calldata for token .* on arb-sepolia/i,
    );
    await assert.rejects(
        () => monadZapper.getNativeZapCalldata(arbToken as any, 1n, false, false, MONAD_ACCOUNT),
        /simple Zapper on monad-mainnet cannot build calldata for token .* on arb-sepolia/i,
    );
    await assert.rejects(
        () => monadZapper.simpleZap(
            arbToken as any,
            (arbToken as any).asset.address,
            (arbToken as any).asset.address,
            1n,
            false,
            50n,
            MONAD_ACCOUNT,
        ),
        /simple Zapper on monad-mainnet cannot build calldata for token .* on arb-sepolia/i,
    );
    const sameChainDifferentSetupToken = {
        ...monadToken,
        market: {
            ...monadMarket,
            setup: {
                ...monadResult.setupConfigSnapshot,
            },
        },
        convertToShares: async () => {
            throw new Error("same-chain setup-snapshot zapper guard should run before token conversion");
        },
    } as any;

    await assert.rejects(
        () => monadZapper.getSimpleZapCalldata(
            sameChainDifferentSetupToken,
            monadToken.asset.address,
            monadToken.asset.address,
            1n,
            false,
            50n,
            MONAD_ACCOUNT,
        ),
        /simple Zapper on monad-mainnet cannot build calldata for token .* without the same setup snapshot/i,
    );
    assert.deepEqual(zapperCalldataCalls, [{
        method: "swapAndDeposit",
        ctoken: MONAD_WMON_CTOKEN,
    }]);
    assert.equal(setup_config.chain, "arb-sepolia");
    assert.equal(all_markets, arbResult.markets);
});

test("explicit native-yield API calls keep older setup snapshots bound after a later chain boot", async (t) => {
    const harness = installSetupChainBootHarness(t, {
        marketData: (context) => {
            if (context.batchKey?.startsWith("monad-mainnet:")) {
                return {
                    staticMarket: [
                        createBootStaticMarket(MONAD_MARKET, [
                            { cToken: MONAD_WMON_CTOKEN, symbol: "WMON", asset: MONAD_WRAPPED_NATIVE },
                            { cToken: MONAD_USDC_CTOKEN, symbol: "USDC", asset: MONAD_USDC_ASSET },
                        ]),
                    ],
                    dynamicMarket: [
                        createBootDynamicMarket(MONAD_MARKET, [MONAD_WMON_CTOKEN, MONAD_USDC_CTOKEN]),
                    ],
                    userData: {
                        locks: [],
                        markets: [
                            createBootUserMarket(MONAD_MARKET, [MONAD_WMON_CTOKEN, MONAD_USDC_CTOKEN]),
                        ],
                    },
                };
            }

            if (context.batchKey?.startsWith("arb-sepolia:")) {
                return {
                    staticMarket: [
                        createBootStaticMarket(ARB_STABLE_MARKET, [
                            { cToken: ARB_USDC_CTOKEN, symbol: "USDC" },
                            { cToken: ARB_AUSD_CTOKEN, symbol: "AUSD" },
                        ]),
                    ],
                    dynamicMarket: [
                        createBootDynamicMarket(ARB_STABLE_MARKET, [ARB_USDC_CTOKEN, ARB_AUSD_CTOKEN]),
                    ],
                    userData: {
                        locks: [],
                        markets: [
                            createBootUserMarket(ARB_STABLE_MARKET, [ARB_USDC_CTOKEN, ARB_AUSD_CTOKEN]),
                        ],
                    },
                };
            }

            throw new Error(`Unexpected setup boot reader context: ${context.batchKey}`);
        },
        fetch: async (url) => {
            assert.equal(url, "https://api.monad-native.example/asset/143");
            return {
                ok: true,
                json: async () => [{
                    chain_id: 143,
                    token: MONAD_WMON_CTOKEN,
                    symbol: "WMON",
                    token_image: "wmon.svg",
                    market_address: MONAD_MARKET,
                    vault: false,
                    percent_native_apy: 3.14,
                    points: [],
                }],
            };
        },
    });

    const monadResult = await setupChain("monad-mainnet", null, "https://api.monad-native.example", {
        account: MONAD_ACCOUNT,
        readProvider: createDecimalsReadProvider(143n) as any,
    });
    const arbResult = await setupChain("arb-sepolia", null, "https://api.arb-native.example", {
        account: ARB_ACCOUNT,
        readProvider: createDecimalsReadProvider(421614n) as any,
    });

    assert.equal(setup_config.chain, "arb-sepolia");
    assert.equal(all_markets, arbResult.markets);
    assert.deepEqual(harness.externalFetchCalls, ["https://api.monad-native.example/asset/143"]);

    const olderMonadWmon = monadResult.markets[0]!.tokens.find(
        (token) => token.address.toLowerCase() === MONAD_WMON_CTOKEN.toLowerCase(),
    );
    const currentArbUsdc = arbResult.markets[0]!.tokens.find(
        (token) => token.address.toLowerCase() === ARB_USDC_CTOKEN.toLowerCase(),
    );
    assert.ok(olderMonadWmon);
    assert.ok(currentArbUsdc);
    assert.equal(olderMonadWmon.nativeApy.toString(), "0.0314");
    assert.equal(currentArbUsdc.nativeApy.toString(), "0");

    const olderMonadYields = await Api.fetchNativeYields(monadResult.setupConfigSnapshot);
    const explicitArbYields = await Api.fetchNativeYields(arbResult.setupConfigSnapshot);
    const currentDefaultYields = await Api.fetchNativeYields();

    assert.deepEqual(olderMonadYields, [{ symbol: "WMON", apy: 3.14, token: MONAD_WMON_CTOKEN.toLowerCase() }]);
    assert.deepEqual(explicitArbYields, []);
    assert.deepEqual(currentDefaultYields, []);
    assert.deepEqual(harness.externalFetchCalls, [
        "https://api.monad-native.example/asset/143",
    ]);
    assert.equal(setup_config.chain, "arb-sepolia");
    assert.equal(all_markets, arbResult.markets);
});

test("explicit API2 asset calls keep using their setup snapshot after the active chain moves", async (t) => {
    const harness = installSetupChainBootHarness(t, {
        rewards: false,
        marketData: (context) => {
            if (context.batchKey?.startsWith("monad-mainnet:")) {
                return {
                    staticMarket: [
                        createBootStaticMarket(MONAD_MARKET, [
                            { cToken: MONAD_WMON_CTOKEN, symbol: "WMON", asset: MONAD_WRAPPED_NATIVE },
                        ]),
                    ],
                    dynamicMarket: [
                        createBootDynamicMarket(MONAD_MARKET, [MONAD_WMON_CTOKEN]),
                    ],
                    userData: {
                        locks: [],
                        markets: [
                            createBootUserMarket(MONAD_MARKET, [MONAD_WMON_CTOKEN]),
                        ],
                    },
                };
            }

            if (context.batchKey?.startsWith("arb-sepolia:")) {
                return {
                    staticMarket: [
                        createBootStaticMarket(ARB_STABLE_MARKET, [
                            { cToken: ARB_USDC_CTOKEN, symbol: "USDC" },
                        ]),
                    ],
                    dynamicMarket: [
                        createBootDynamicMarket(ARB_STABLE_MARKET, [ARB_USDC_CTOKEN]),
                    ],
                    userData: {
                        locks: [],
                        markets: [
                            createBootUserMarket(ARB_STABLE_MARKET, [ARB_USDC_CTOKEN]),
                        ],
                    },
                };
            }

            throw new Error(`Unexpected setup boot reader context: ${context.batchKey}`);
        },
        fetch: async (url) => {
            if (url === "https://api.monad-rewards-slug.example/asset/143") {
                return {
                    ok: true,
                    json: async () => [],
                };
            }

            if (url === "https://api.arb-rewards-slug.example/asset/421614") {
                return {
                    ok: true,
                    json: async () => [],
                };
            }

            throw new Error(`Unexpected rewards fetch URL: ${url}`);
        },
    });

    const monadResult = await setupChain("monad-mainnet", null, "https://api.monad-rewards-slug.example", {
        account: MONAD_ACCOUNT,
        readProvider: createDecimalsReadProvider(143n) as any,
        feePolicy: flatFeePolicy({
            chain: "monad-mainnet",
            bps: CURVANCE_FEE_BPS,
            feeReceiver: BOOT_DAO_FEE_RECEIVER,
        }),
    });
    const arbResult = await setupChain("arb-sepolia", null, "https://api.arb-rewards-slug.example", {
        account: ARB_ACCOUNT,
        readProvider: createDecimalsReadProvider(421614n) as any,
    });

    await Api.getRewards(monadResult.setupConfigSnapshot);
    await Api.getRewards(arbResult.setupConfigSnapshot);

    assert.equal(setup_config.chain, "arb-sepolia");
    assert.equal(all_markets, arbResult.markets);
    assert.deepEqual(harness.externalFetchCalls, [
        "https://api.monad-rewards-slug.example/asset/143",
        "https://api.arb-rewards-slug.example/asset/421614",
    ]);
});

test("explicit LendingOptimizer read providers do not inherit a later singleton signer", async (t) => {
    installSetupChainBootHarness(t, {
        marketData: (context) => {
            if (context.batchKey?.startsWith("monad-mainnet:")) {
                return {
                    staticMarket: [
                        createBootStaticMarket(MONAD_MARKET, [
                            { cToken: MONAD_WMON_CTOKEN, symbol: "WMON", asset: MONAD_WRAPPED_NATIVE },
                            { cToken: MONAD_USDC_CTOKEN, symbol: "USDC", asset: MONAD_USDC_ASSET },
                        ]),
                    ],
                    dynamicMarket: [
                        createBootDynamicMarket(MONAD_MARKET, [MONAD_WMON_CTOKEN, MONAD_USDC_CTOKEN]),
                    ],
                    userData: {
                        locks: [],
                        markets: [
                            createBootUserMarket(MONAD_MARKET, [MONAD_WMON_CTOKEN, MONAD_USDC_CTOKEN]),
                        ],
                    },
                };
            }

            if (context.batchKey?.startsWith("arb-sepolia:")) {
                return {
                    staticMarket: [
                        createBootStaticMarket(ARB_STABLE_MARKET, [
                            { cToken: ARB_USDC_CTOKEN, symbol: "USDC" },
                            { cToken: ARB_AUSD_CTOKEN, symbol: "AUSD" },
                        ]),
                    ],
                    dynamicMarket: [
                        createBootDynamicMarket(ARB_STABLE_MARKET, [ARB_USDC_CTOKEN, ARB_AUSD_CTOKEN]),
                    ],
                    userData: {
                        locks: [],
                        markets: [
                            createBootUserMarket(ARB_STABLE_MARKET, [ARB_USDC_CTOKEN, ARB_AUSD_CTOKEN]),
                        ],
                    },
                };
            }

            throw new Error(`Unexpected setup boot reader context: ${context.batchKey}`);
        },
        fetch: async () => ({
            ok: true,
            json: async () => ({ native_apy: [] }),
        }),
    });

    const monadSignerTransactions: Array<{ to: string; data: string }> = [];
    const monadSigner = {
        address: "0x0000000000000000000000000000000000000a01" as address,
        provider: createDecimalsReadProvider(143n) as any,
        sendTransaction: async (tx: { to: string; data: string }) => {
            monadSignerTransactions.push(tx);
            return { hash: "0xmonad" };
        },
    };
    const arbSigner = {
        address: "0x0000000000000000000000000000000000000b01" as address,
        provider: createDecimalsReadProvider(421614n) as any,
        sendTransaction: async () => {
            throw new Error("Arbitrum singleton signer should not be used by detached optimizer");
        },
    };

    const monadResult = await setupChain("monad-mainnet", monadSigner as any, "https://api.monad-optimizer.example");
    const monadReadProvider = monadResult.setupConfigSnapshot.readProvider;
    await setupChain("arb-sepolia", arbSigner as any, "https://api.arb-optimizer.example");

    assert.equal(setup_config.chain, "arb-sepolia");
    assert.equal(setup_config.signer, arbSigner);

    const asset = new ERC20(
        monadReadProvider,
        MONAD_TEST_TOKEN,
        {
            address: MONAD_TEST_TOKEN,
            name: "Monad Optimizer Asset",
            symbol: "MOA",
            decimals: 18n,
            totalSupply: 0n,
        },
        monadResult.setupConfigSnapshot.contracts.OracleManager as address,
    );
    const optimizer = new LendingOptimizer(OPTIMIZER_TEST_ADDRESS, asset, monadReadProvider);

    assert.equal(optimizer.provider, monadReadProvider);
    assert.equal(optimizer.signer, null);
    await assert.rejects(
        () => optimizer.deposit(Decimal(1)),
        /Provider is not a signer/i,
    );
    assert.equal(monadSignerTransactions.length, 0);

    const implicitOptimizer = new LendingOptimizer(OPTIMIZER_TEST_ADDRESS, asset);
    assert.equal(implicitOptimizer.provider, monadReadProvider);
    assert.equal(implicitOptimizer.signer, null);
    await assert.rejects(
        () => implicitOptimizer.deposit(Decimal(1)),
        /Provider is not a signer/i,
    );
    assert.equal(monadSignerTransactions.length, 0);

    const signerBoundAsset = {
        provider: monadReadProvider,
        signer: monadSigner,
        decimals: 0n,
        symbol: "MOA",
        allowance: async (owner: address, spender: address) => {
            assert.equal(owner, monadSigner.address);
            assert.equal(spender, OPTIMIZER_TEST_ADDRESS);
            return 10n;
        },
    };
    const optimizerInterface = new Interface([
        "function deposit(uint256 assets,address receiver)",
        "function rebalance((address cToken,int256 assetsOrBps)[] actions,(address cToken,uint256 minBps,uint256 maxBps)[] bounds)",
    ]);
    const signerBoundOptimizer = new LendingOptimizer(OPTIMIZER_TEST_ADDRESS, signerBoundAsset as any);
    const signerBoundTx = await signerBoundOptimizer.deposit(Decimal(2));

    assert.equal(signerBoundOptimizer.provider, monadReadProvider);
    assert.equal(signerBoundOptimizer.signer, monadSigner);
    assert.deepEqual(signerBoundTx, { hash: "0xmonad" });
    assert.equal(monadSignerTransactions.length, 1);
    const signerBoundDepositCall = optimizerInterface.decodeFunctionData(
        "deposit(uint256,address)",
        monadSignerTransactions[0]!.data,
    );
    assert.equal(signerBoundDepositCall[0], 2n);
    assert.equal(String(signerBoundDepositCall[1]).toLowerCase(), monadSigner.address.toLowerCase());

    const signerBoundRebalanceTx = await signerBoundOptimizer.rebalance({
        actions: [
            { cToken: MONAD_WMON_CTOKEN, assetsOrBps: 1_250n },
            { cToken: MONAD_USDC_CTOKEN, assetsOrBps: -750n },
        ],
        bounds: [
            { cToken: MONAD_WMON_CTOKEN, minBps: 4_000n, maxBps: 6_000n },
            { cToken: MONAD_USDC_CTOKEN, minBps: 4_000n, maxBps: 6_000n },
        ],
    });
    const rebalanceCall = optimizerInterface.decodeFunctionData(
        "rebalance",
        monadSignerTransactions[1]!.data,
    );

    assert.deepEqual(signerBoundRebalanceTx, { hash: "0xmonad" });
    assert.equal(monadSignerTransactions.length, 2);
    assert.deepEqual(
        rebalanceCall[0].map((action: { cToken: string; assetsOrBps: bigint }) => ({
            cToken: action.cToken.toLowerCase(),
            assetsOrBps: action.assetsOrBps,
        })),
        [
            { cToken: MONAD_WMON_CTOKEN.toLowerCase(), assetsOrBps: 1_250n },
            { cToken: MONAD_USDC_CTOKEN.toLowerCase(), assetsOrBps: -750n },
        ],
    );
    assert.deepEqual(
        rebalanceCall[1].map((bound: { cToken: string; minBps: bigint; maxBps: bigint }) => ({
            cToken: bound.cToken.toLowerCase(),
            minBps: bound.minBps,
            maxBps: bound.maxBps,
        })),
        [
            { cToken: MONAD_WMON_CTOKEN.toLowerCase(), minBps: 4_000n, maxBps: 6_000n },
            { cToken: MONAD_USDC_CTOKEN.toLowerCase(), minBps: 4_000n, maxBps: 6_000n },
        ],
    );

    const writableAsset = {
        decimals: 0n,
        symbol: "MOA",
        allowance: async (owner: address, spender: address) => {
            assert.equal(owner, monadSigner.address);
            assert.equal(spender, OPTIMIZER_TEST_ADDRESS);
            return 10n;
        },
    };
    const writableOptimizer = new LendingOptimizer(
        OPTIMIZER_TEST_ADDRESS,
        writableAsset as any,
        monadReadProvider,
        monadSigner as any,
    );
    const tx = await writableOptimizer.deposit(Decimal(2));

    assert.equal(writableOptimizer.provider, monadReadProvider);
    assert.equal(writableOptimizer.signer, monadSigner);
    assert.deepEqual(tx, { hash: "0xmonad" });
    assert.equal(monadSignerTransactions.length, 3);
    assert.equal(monadSignerTransactions[0]?.to, OPTIMIZER_TEST_ADDRESS);
    assert.equal(monadSignerTransactions[1]?.to, OPTIMIZER_TEST_ADDRESS);
    assert.equal(monadSignerTransactions[2]?.to, OPTIMIZER_TEST_ADDRESS);
    const writableDepositCall = optimizerInterface.decodeFunctionData(
        "deposit(uint256,address)",
        monadSignerTransactions[2]!.data,
    );
    assert.equal(writableDepositCall[0], 2n);
    assert.equal(String(writableDepositCall[1]).toLowerCase(), monadSigner.address.toLowerCase());
    assert.equal(setup_config.chain, "arb-sepolia");
    assert.equal(setup_config.signer, arbSigner);
});

test("default supporting readers capture the setup read provider before singleton movement", async (t) => {
    installSetupChainBootHarness(t, {
        marketData: (context) => {
            if (context.batchKey?.startsWith("monad-mainnet:")) {
                return {
                    staticMarket: [
                        createBootStaticMarket(MONAD_MARKET, [
                            { cToken: MONAD_WMON_CTOKEN, symbol: "WMON", asset: MONAD_WRAPPED_NATIVE },
                        ]),
                    ],
                    dynamicMarket: [
                        createBootDynamicMarket(MONAD_MARKET, [MONAD_WMON_CTOKEN]),
                    ],
                    userData: {
                        locks: [],
                        markets: [
                            createBootUserMarket(MONAD_MARKET, [MONAD_WMON_CTOKEN]),
                        ],
                    },
                };
            }

            if (context.batchKey?.startsWith("arb-sepolia:")) {
                return {
                    staticMarket: [
                        createBootStaticMarket(ARB_STABLE_MARKET, [
                            { cToken: ARB_USDC_CTOKEN, symbol: "USDC" },
                        ]),
                    ],
                    dynamicMarket: [
                        createBootDynamicMarket(ARB_STABLE_MARKET, [ARB_USDC_CTOKEN]),
                    ],
                    userData: {
                        locks: [],
                        markets: [
                            createBootUserMarket(ARB_STABLE_MARKET, [ARB_USDC_CTOKEN]),
                        ],
                    },
                };
            }

            throw new Error(`Unexpected supporting reader setup context: ${context.batchKey}`);
        },
        fetch: async () => ({
            ok: true,
            json: async () => ({ native_apy: [] }),
        }),
    });

    const monadResult = await setupChain("monad-mainnet", null, "https://api.supporting-readers-monad.example", {
        account: MONAD_ACCOUNT,
        readProvider: createDecimalsReadProvider(143n) as any,
    });
    const monadDefaultReader = new ProtocolReader(
        monadResult.setupConfigSnapshot.contracts.ProtocolReader as address,
        undefined,
        "monad-mainnet",
    );
    const monadDefaultOracle = new OracleManager(
        monadResult.setupConfigSnapshot.contracts.OracleManager as address,
    );
    const monadDefaultOptimizerReader = new OptimizerReader(
        monadResult.setupConfigSnapshot.contracts.ProtocolReader as address,
    );

    const arbResult = await setupChain("arb-sepolia", null, "https://api.supporting-readers-arb.example", {
        account: ARB_ACCOUNT,
        readProvider: createDecimalsReadProvider(421614n) as any,
    });
    const arbDefaultReader = new ProtocolReader(
        arbResult.setupConfigSnapshot.contracts.ProtocolReader as address,
        undefined,
        "arb-sepolia",
    );

    assert.equal(setup_config.chain, "arb-sepolia");
    assert.equal(all_markets, arbResult.markets);
    assert.equal(monadDefaultReader.provider, monadResult.setupConfigSnapshot.readProvider);
    assert.equal(monadDefaultOracle.provider, monadResult.setupConfigSnapshot.readProvider);
    assert.equal(monadDefaultOptimizerReader.provider, monadResult.setupConfigSnapshot.readProvider);
    assert.equal(arbDefaultReader.provider, arbResult.setupConfigSnapshot.readProvider);
    assert.notEqual(monadDefaultReader.provider, arbDefaultReader.provider);
    assert.notEqual(monadDefaultReader.batchKey, arbDefaultReader.batchKey);
});

test("cross-chain setup races keep returned-result provenance after singleton moves", async (t) => {
    const rewardsA = defer<{ milestones: Record<string, any>; incentives: Record<string, any> }>();
    const rewardsB = defer<{ milestones: Record<string, any>; incentives: Record<string, any> }>();

    const originalGetRewards = Api.getRewards;
    const originalGetAll = Market.getAll;
    let rewardsCall = 0;

    Api.getRewards = (async () => {
        rewardsCall += 1;
        return rewardsCall === 1 ? rewardsA.promise : rewardsB.promise;
    }) as typeof Api.getRewards;
    Market.getAll = (async (_reader, _oracleManager, _provider, _signer, _account, _milestones, _incentives, setup) => {
        return [{ setup, marker: setup!.chain }] as any;
    }) as typeof Market.getAll;

    t.after(() => {
        Api.getRewards = originalGetRewards;
        Market.getAll = originalGetAll;
    });

    const olderMonad = setupChain("monad-mainnet", null, "https://api.monad-race.example");
    const newerArb = setupChain("arb-sepolia", null, "https://api.arb-race.example");

    rewardsB.resolve({ milestones: {}, incentives: {} });
    const arbResult = await newerArb;
    assert.equal(setup_config.chain, "arb-sepolia");

    rewardsA.resolve({ milestones: {}, incentives: {} });
    const monadResult = await olderMonad;

    assert.equal(arbResult.chain, "arb-sepolia");
    assert.equal(arbResult.setupConfigSnapshot.chain, "arb-sepolia");
    assert.equal(monadResult.chain, "monad-mainnet");
    assert.equal(monadResult.chainId, 143);
    assert.equal(monadResult.setupConfigSnapshot.chain, "monad-mainnet");
    assert.equal((monadResult.markets[0] as any).setup.chain, "monad-mainnet");
    assert.equal(setup_config.chain, "arb-sepolia");
    assert.deepEqual(all_markets, arbResult.markets);
});

test("setupChain returns DEX aggregators bound to the result markets and fee policy after singleton moves", async (t) => {
    const originalGetRewards = Api.getRewards;
    const originalGetAll = Market.getAll;

    Api.getRewards = (async () => ({ milestones: {}, incentives: {} })) as typeof Api.getRewards;
    Market.getAll = (async (_reader, _oracleManager, _provider, _signer, _account, _milestones, _incentives, setup) => {
        const market = setup!.chain === "monad-mainnet"
            ? createZapMarket("Monad Token", "MONA", MONAD_TEST_TOKEN)
            : createZapMarket("Arbitrum Token", "ARBA", ARB_TEST_TOKEN);
        market.setup = setup as any;
        return [market] as any;
    }) as typeof Market.getAll;

    t.after(() => {
        Api.getRewards = originalGetRewards;
        Market.getAll = originalGetAll;
    });

    const monadResult = await setupChain("monad-mainnet", null, "https://api.monad-dex.example");
    const arbResult = await setupChain("arb-sepolia", null, "https://api.arb-dex.example");

    assert.equal(setup_config.chain, "arb-sepolia");
    assert.equal(all_markets[0], arbResult.markets[0]);

    const quoteCalls: Array<{ amount: bigint; feeBps: bigint | undefined; feeReceiver: string | undefined }> = [];
    (monadResult.dexAgg as any).quote = async (
        _wallet: string,
        _tokenIn: string,
        _tokenOut: string,
        amount: bigint,
        _slippage: bigint,
        feeBps?: bigint,
        feeReceiver?: address,
    ) => {
        quoteCalls.push({ amount, feeBps, feeReceiver });
        return {
            to: MONAD_TEST_TOKEN,
            calldata: "0x" as bytes,
            min_out: 1n,
            out: 2n,
        };
    };

    const zapTokens = await monadResult.dexAgg.getAvailableTokens(
        createDecimalsProvider() as any,
        null,
        "0x0000000000000000000000000000000000000abc" as address,
    );

    assert.deepEqual(
        zapTokens.map((token) => token.interface.address),
        [MONAD_TEST_TOKEN],
        "returned Monad DEX adapter must not read Arbitrum markets from the moved singleton",
    );

    assert.ok(zapTokens[0]?.quote, "expected contextual zap token quote closure");
    await zapTokens[0].quote!(
        MONAD_TEST_TOKEN,
        MONAD_TEST_OUTPUT_TOKEN,
        Decimal(1),
        Decimal(0.01),
    );

    assert.deepEqual(quoteCalls, [{
        amount: 1_000_000_000_000_000_000n,
        feeBps: CURVANCE_FEE_BPS,
        feeReceiver: BOOT_DAO_FEE_RECEIVER,
    }]);
});

test("setupChain keeps older same-chain DEX adapter context after a newer same-chain boot", async (t) => {
    const originalGetRewards = Api.getRewards;
    const originalGetAll = Market.getAll;
    const originalGetDaoAddress = ProtocolReader.prototype.getDaoAddress;
    const originalMonadDexAgg = chain_config["monad-mainnet"].dexAgg;
    const firstDao = "0x0000000000000000000000000000000000000dA1" as address;
    const secondDao = "0x0000000000000000000000000000000000000dA2" as address;
    const contextBindings: Array<{
        apiUrl: string;
        checkerDao: string | undefined;
        feeReceiver: string;
        marketSymbols: string[];
    }> = [];
    const quoteCalls: Array<{
        apiUrl: string;
        feeBps: bigint;
        feeReceiver: string;
        checkerDao: string | undefined;
    }> = [];
    let daoLookup = 0;

    Api.getRewards = (async () => ({ milestones: {}, incentives: {} })) as typeof Api.getRewards;
    Market.getAll = (async (_reader, _oracleManager, _provider, _signer, _account, _milestones, _incentives, setup) => {
        const market = createZapMarket(
            setup!.api_url.includes("first") ? "First Monad Market" : "Second Monad Market",
            setup!.api_url.includes("first") ? "FIRST" : "SECOND",
            MONAD_TEST_TOKEN,
        );
        market.setup = setup as any;
        return [market] as any;
    }) as typeof Market.getAll;
    ProtocolReader.prototype.getDaoAddress = async () => {
        daoLookup += 1;
        return daoLookup === 1 ? firstDao : secondDao;
    };
    (chain_config["monad-mainnet"] as any).dexAgg = {
        dao: BOOT_DAO_FEE_RECEIVER,
        router: MONAD_TEST_TOKEN,
        withContext(context: any) {
            const binding = {
                apiUrl: context.markets[0]?.setup?.api_url,
                checkerDao: context.checkerDao,
                feeReceiver: context.feePolicy.feeReceiver,
                marketSymbols: context.markets.map((market: any) => market.symbol),
            };
            contextBindings.push(binding);

            return {
                dao: context.checkerDao,
                router: MONAD_TEST_TOKEN,
                getAvailableTokens: async () => [{
                    interface: { address: MONAD_TEST_TOKEN, symbol: binding.marketSymbols[0] },
                    type: "simple",
                    quote: async (_tokenIn: address, _tokenOut: address, amount: Decimal, _slippage: Decimal) => {
                        const feeBps = context.feePolicy.getFeeBps({
                            operation: "zap",
                            inputToken: MONAD_TEST_TOKEN,
                            outputToken: MONAD_TEST_OUTPUT_TOKEN,
                            inputAmount: 1n,
                            currentLeverage: null,
                            targetLeverage: null,
                        });
                        quoteCalls.push({
                            apiUrl: binding.apiUrl,
                            feeBps,
                            feeReceiver: context.feePolicy.feeReceiver,
                            checkerDao: context.checkerDao,
                        });
                        return {
                            minOut_raw: 1n,
                            output_raw: 2n,
                            minOut: amount,
                            output: amount.mul(2),
                        };
                    },
                }],
                quoteAction: async () => {
                    throw new Error("quoteAction is not used by this test");
                },
                quoteMin: async () => 1n,
                quote: async () => ({
                    to: MONAD_TEST_TOKEN,
                    calldata: "0x" as bytes,
                    min_out: 1n,
                    out: 2n,
                }),
            };
        },
        getAvailableTokens: async () => {
            throw new Error("unbound same-chain aggregator was used");
        },
        quoteAction: async () => {
            throw new Error("unbound same-chain aggregator was used");
        },
        quoteMin: async () => {
            throw new Error("unbound same-chain aggregator was used");
        },
        quote: async () => {
            throw new Error("unbound same-chain aggregator was used");
        },
    };

    t.after(() => {
        Api.getRewards = originalGetRewards;
        Market.getAll = originalGetAll;
        ProtocolReader.prototype.getDaoAddress = originalGetDaoAddress;
        (chain_config["monad-mainnet"] as any).dexAgg = originalMonadDexAgg;
    });

    const firstResult = await setupChain("monad-mainnet", null, "https://api.same-chain-first.example");
    const secondResult = await setupChain("monad-mainnet", null, "https://api.same-chain-second.example");

    assert.equal(setup_config.api_url, "https://api.same-chain-second.example");
    assert.equal(all_markets[0], secondResult.markets[0]);
    assert.notEqual(firstResult.dexAgg, secondResult.dexAgg);
    assert.deepEqual(contextBindings, [
        {
            apiUrl: "https://api.same-chain-first.example",
            checkerDao: firstDao,
            feeReceiver: firstDao,
            marketSymbols: ["FIRST"],
        },
        {
            apiUrl: "https://api.same-chain-second.example",
            checkerDao: secondDao,
            feeReceiver: secondDao,
            marketSymbols: ["SECOND"],
        },
    ]);

    const firstZapTokens = await firstResult.dexAgg.getAvailableTokens(createDecimalsProvider() as any, null, MONAD_ACCOUNT);
    const secondZapTokens = await secondResult.dexAgg.getAvailableTokens(createDecimalsProvider() as any, null, MONAD_ACCOUNT);
    assert.deepEqual(firstZapTokens.map((token) => token.interface.symbol), ["FIRST"]);
    assert.deepEqual(secondZapTokens.map((token) => token.interface.symbol), ["SECOND"]);

    await firstZapTokens[0]!.quote!(
        MONAD_TEST_TOKEN,
        MONAD_TEST_OUTPUT_TOKEN,
        Decimal(1),
        Decimal(0.01),
    );
    await secondZapTokens[0]!.quote!(
        MONAD_TEST_TOKEN,
        MONAD_TEST_OUTPUT_TOKEN,
        Decimal(1),
        Decimal(0.01),
    );

    assert.deepEqual(quoteCalls, [
        {
            apiUrl: "https://api.same-chain-first.example",
            feeBps: CURVANCE_FEE_BPS,
            feeReceiver: firstDao,
            checkerDao: firstDao,
        },
        {
            apiUrl: "https://api.same-chain-second.example",
            feeBps: CURVANCE_FEE_BPS,
            feeReceiver: secondDao,
            checkerDao: secondDao,
        },
    ]);
});

test("setupChain keeps older same-chain CToken route quotes bound after a newer same-chain boot", async (t) => {
    const originalMonadDexAgg = chain_config["monad-mainnet"].dexAgg;
    const firstDao = "0x0000000000000000000000000000000000000dB1" as address;
    const secondDao = "0x0000000000000000000000000000000000000dB2" as address;
    const quoteCalls: Array<{
        setupApiUrl: string;
        checkerDao: string | undefined;
        feeBps: bigint;
        feeReceiver: string;
    }> = [];
    let daoLookup = 0;

    installSetupChainBootHarness(t, {
        daoAddress: () => {
            daoLookup += 1;
            return daoLookup === 1 ? firstDao : secondDao;
        },
        marketData: () => ({
            staticMarket: [
                createBootStaticMarket(MONAD_MARKET, [
                    { cToken: MONAD_WMON_CTOKEN, symbol: "WMON", asset: MONAD_WRAPPED_NATIVE },
                    { cToken: MONAD_USDC_CTOKEN, symbol: "USDC", asset: MONAD_USDC_ASSET },
                ]),
            ],
            dynamicMarket: [
                createBootDynamicMarket(MONAD_MARKET, [MONAD_WMON_CTOKEN, MONAD_USDC_CTOKEN]),
            ],
            userData: {
                locks: [],
                markets: [
                    createBootUserMarket(MONAD_MARKET, [MONAD_WMON_CTOKEN, MONAD_USDC_CTOKEN]),
                ],
            },
        }),
        fetch: async (url) => {
            if (
                url === "https://api.same-chain-token-first.example/v1/monad/native_apy" ||
                url === "https://api.same-chain-token-second.example/v1/monad/native_apy"
            ) {
                return {
                    ok: true,
                    json: async () => ({ native_apy: [] }),
                };
            }

            throw new Error(`Unexpected same-chain token fetch URL: ${url}`);
        },
    });

    (chain_config["monad-mainnet"] as any).dexAgg = {
        dao: BOOT_DAO_FEE_RECEIVER,
        router: MONAD_WRAPPED_NATIVE,
        withContext(context: any) {
            return {
                dao: context.checkerDao,
                router: MONAD_WRAPPED_NATIVE,
                getAvailableTokens: async () => [{
                    interface: {
                        address: MONAD_WRAPPED_NATIVE,
                        symbol: "WMON",
                        name: "Wrapped Monad",
                        decimals: 18n,
                    },
                    type: "simple",
                    quote: async () => {
                        quoteCalls.push({
                            setupApiUrl: context.markets[0].setup.api_url,
                            checkerDao: context.checkerDao,
                            feeBps: context.feePolicy.getFeeBps({
                                operation: "zap",
                                inputToken: MONAD_WRAPPED_NATIVE,
                                outputToken: MONAD_USDC_ASSET,
                                inputAmount: 1n,
                                currentLeverage: null,
                                targetLeverage: null,
                            }),
                            feeReceiver: context.feePolicy.feeReceiver,
                        });
                        return {
                            minOut_raw: 1n,
                            output_raw: 2n,
                            minOut: Decimal(1),
                            output: Decimal(2),
                        };
                    },
                }],
                quoteAction: async () => {
                    throw new Error("quoteAction is not used by this test");
                },
                quoteMin: async () => 1n,
                quote: async () => ({
                    to: MONAD_WRAPPED_NATIVE,
                    calldata: "0x" as bytes,
                    min_out: 1n,
                    out: 2n,
                }),
            };
        },
        getAvailableTokens: async () => {
            throw new Error("unbound same-chain token DEX adapter was used");
        },
        quoteAction: async () => {
            throw new Error("unbound same-chain token DEX adapter was used");
        },
        quoteMin: async () => {
            throw new Error("unbound same-chain token DEX adapter was used");
        },
        quote: async () => {
            throw new Error("unbound same-chain token DEX adapter was used");
        },
    };

    t.after(() => {
        (chain_config["monad-mainnet"] as any).dexAgg = originalMonadDexAgg;
    });

    const firstResult = await setupChain("monad-mainnet", null, "https://api.same-chain-token-first.example", {
        account: MONAD_ACCOUNT,
        readProvider: createDecimalsReadProvider(143n) as any,
    });
    const secondResult = await setupChain("monad-mainnet", null, "https://api.same-chain-token-second.example", {
        account: MONAD_ACCOUNT,
        readProvider: createDecimalsReadProvider(143n) as any,
    });

    assert.equal(setup_config.api_url, "https://api.same-chain-token-second.example");
    assert.equal(all_markets[0], secondResult.markets[0]);

    const firstUsdc = firstResult.markets[0]!.tokens.find(
        (token) => token.address.toLowerCase() === MONAD_USDC_CTOKEN.toLowerCase(),
    );
    const secondUsdc = secondResult.markets[0]!.tokens.find(
        (token) => token.address.toLowerCase() === MONAD_USDC_CTOKEN.toLowerCase(),
    );
    assert.ok(firstUsdc);
    assert.ok(secondUsdc);
    assert.notEqual(firstUsdc.market.dexAgg, secondUsdc.market.dexAgg);

    const firstWrappedRoute = (await firstUsdc.getDepositTokens()).find(
        (token) => token.type === "simple" && token.interface.address.toLowerCase() === MONAD_WRAPPED_NATIVE.toLowerCase(),
    );
    const secondWrappedRoute = (await secondUsdc.getDepositTokens()).find(
        (token) => token.type === "simple" && token.interface.address.toLowerCase() === MONAD_WRAPPED_NATIVE.toLowerCase(),
    );
    assert.ok(firstWrappedRoute?.quote);
    assert.ok(secondWrappedRoute?.quote);

    await firstWrappedRoute.quote(MONAD_WRAPPED_NATIVE, MONAD_USDC_ASSET, Decimal(1), Decimal(0.01));
    await secondWrappedRoute.quote(MONAD_WRAPPED_NATIVE, MONAD_USDC_ASSET, Decimal(1), Decimal(0.01));

    assert.deepEqual(quoteCalls, [
        {
            setupApiUrl: "https://api.same-chain-token-first.example",
            checkerDao: firstDao,
            feeBps: CURVANCE_FEE_BPS,
            feeReceiver: firstDao,
        },
        {
            setupApiUrl: "https://api.same-chain-token-second.example",
            checkerDao: secondDao,
            feeBps: CURVANCE_FEE_BPS,
            feeReceiver: secondDao,
        },
    ]);
});

test("setupChain propagates result context through composed DEX aggregators after singleton moves", async (t) => {
    const originalGetRewards = Api.getRewards;
    const originalGetAll = Market.getAll;
    const originalMonadDexAgg = chain_config["monad-mainnet"].dexAgg;
    const contextBindings: Array<{ label: string; chain: string; markets: string[] }> = [];
    const availableTokenCalls: Array<{ label: string; chain: string; account: string | null | undefined }> = [];
    const quoteCalls: Array<{
        label: string;
        chain: string;
        tokenIn: string;
        tokenOut: string;
        amount: bigint;
        feeBps: bigint | undefined;
        feeReceiver: string | undefined;
    }> = [];

    function createContextualAgg(label: string, tokenAddress: address, minOut: bigint) {
        const unbound = {
            dao: BOOT_DAO_FEE_RECEIVER,
            router: tokenAddress,
            withContext(context: any) {
                const chain = context.markets[0]?.setup?.chain ?? "unknown";
                const markets = context.markets.map((market: any) => market.symbol);
                contextBindings.push({ label, chain, markets });

                return {
                    dao: BOOT_DAO_FEE_RECEIVER,
                    router: tokenAddress,
                    getAvailableTokens: async (_provider: any, _query: string | null, account: address | null = null) => {
                        availableTokenCalls.push({ label, chain, account });
                        return [{
                            interface: { address: tokenAddress, symbol: label },
                            type: "simple",
                        }];
                    },
                    quoteAction: async () => {
                        throw new Error("quoteAction is not used by this test");
                    },
                    quoteMin: async () => minOut,
                    quote: async (
                        _wallet: string,
                        tokenIn: string,
                        tokenOut: string,
                        amount: bigint,
                        _slippage: bigint,
                        feeBps?: bigint,
                        feeReceiver?: address,
                    ) => {
                        quoteCalls.push({ label, chain, tokenIn, tokenOut, amount, feeBps, feeReceiver });
                        return {
                            to: tokenAddress,
                            calldata: "0x" as bytes,
                            min_out: minOut,
                            out: minOut + 1n,
                        };
                    },
                };
            },
            getAvailableTokens: async () => {
                throw new Error(`${label} aggregator was used before setup context binding`);
            },
            quoteAction: async () => {
                throw new Error(`${label} aggregator was used before setup context binding`);
            },
            quoteMin: async () => {
                throw new Error(`${label} aggregator was used before setup context binding`);
            },
            quote: async () => {
                throw new Error(`${label} aggregator was used before setup context binding`);
            },
        };

        return unbound;
    }

    Api.getRewards = (async () => ({ milestones: {}, incentives: {} })) as typeof Api.getRewards;
    Market.getAll = (async (_reader, _oracleManager, _provider, _signer, _account, _milestones, _incentives, setup) => {
        const market = setup!.chain === "monad-mainnet"
            ? createZapMarket("Monad Context Market", "MONCTX", MONAD_TEST_TOKEN)
            : createZapMarket("Arbitrum Context Market", "ARBCTX", ARB_TEST_TOKEN);
        market.setup = setup as any;
        return [market] as any;
    }) as typeof Market.getAll;
    (chain_config["monad-mainnet"] as any).dexAgg = new MultiDexAgg([
        createContextualAgg("primary", MONAD_TEST_TOKEN, 90n) as any,
        createContextualAgg("secondary", MONAD_TEST_OUTPUT_TOKEN, 120n) as any,
    ]);

    t.after(() => {
        Api.getRewards = originalGetRewards;
        Market.getAll = originalGetAll;
        (chain_config["monad-mainnet"] as any).dexAgg = originalMonadDexAgg;
    });

    const monadResult = await setupChain("monad-mainnet", null, "https://api.monad-multidex.example");
    const arbResult = await setupChain("arb-sepolia", null, "https://api.arb-after-multidex.example");

    assert.equal(setup_config.chain, "arb-sepolia");
    assert.equal(all_markets[0], arbResult.markets[0]);
    assert.deepEqual(contextBindings, [
        { label: "primary", chain: "monad-mainnet", markets: ["MONCTX"] },
        { label: "secondary", chain: "monad-mainnet", markets: ["MONCTX"] },
    ]);

    const availableTokens = await monadResult.dexAgg.getAvailableTokens(
        createDecimalsProvider() as any,
        null,
        MONAD_ACCOUNT,
    );
    assert.deepEqual(
        availableTokens.map((token) => token.interface.address),
        [MONAD_TEST_TOKEN, MONAD_TEST_OUTPUT_TOKEN],
    );

    const quote = await monadResult.dexAgg.quote(
        MONAD_ACCOUNT,
        MONAD_TEST_TOKEN,
        MONAD_TEST_OUTPUT_TOKEN,
        1_000n,
        50n,
        CURVANCE_FEE_BPS,
        BOOT_DAO_FEE_RECEIVER,
    );

    assert.equal(quote.to, MONAD_TEST_OUTPUT_TOKEN);
    assert.equal(quote.min_out, 120n);
    assert.deepEqual(availableTokenCalls, [
        { label: "primary", chain: "monad-mainnet", account: MONAD_ACCOUNT },
        { label: "secondary", chain: "monad-mainnet", account: MONAD_ACCOUNT },
    ]);
    assert.deepEqual(quoteCalls, [
        {
            label: "primary",
            chain: "monad-mainnet",
            tokenIn: MONAD_TEST_TOKEN,
            tokenOut: MONAD_TEST_OUTPUT_TOKEN,
            amount: 1_000n,
            feeBps: CURVANCE_FEE_BPS,
            feeReceiver: CHECKSUM_BOOT_DAO_FEE_RECEIVER,
        },
        {
            label: "secondary",
            chain: "monad-mainnet",
            tokenIn: MONAD_TEST_TOKEN,
            tokenOut: MONAD_TEST_OUTPUT_TOKEN,
            amount: 1_000n,
            feeBps: CURVANCE_FEE_BPS,
            feeReceiver: CHECKSUM_BOOT_DAO_FEE_RECEIVER,
        },
    ]);
});

test("setupChain publishes the newest successful invocation after newer pending setups fail", async (t) => {
    const rewardsA = defer<{ milestones: Record<string, any>; incentives: Record<string, any> }>();
    const rewardsB = defer<{ milestones: Record<string, any>; incentives: Record<string, any> }>();

    const originalGetRewards = Api.getRewards;
    const originalGetAll = Market.getAll;

    let rewardsCall = 0;

    Api.getRewards = (async () => {
        rewardsCall += 1;
        return rewardsCall === 1 ? rewardsA.promise : rewardsB.promise;
    }) as typeof Api.getRewards;

    Market.getAll = (async (_reader, _oracleManager, _provider, _signer, _account, _milestones, _incentives, setup) => {
        const activeSetup = setup!;
        return [{ marker: activeSetup.api_url }] as any;
    }) as typeof Market.getAll;

    t.after(() => {
        Api.getRewards = originalGetRewards;
        Market.getAll = originalGetAll;
    });

    const olderSetup = setupChain("monad-mainnet", null, "https://api.recover.example");
    const newerSetup = setupChain("monad-mainnet", null, "https://api.fail.example");

    rewardsA.resolve({ milestones: {}, incentives: {} });
    const olderResult = await olderSetup;

    assert.equal(setup_config.api_url, "https://api.recover.example");
    assert.deepEqual(all_markets, olderResult.markets);

    rewardsB.promise.catch(() => undefined);
    rewardsB.reject(new Error("newer setup failed"));
    await assert.rejects(() => newerSetup, /newer setup failed/i);

    assert.equal(setup_config.api_url, "https://api.recover.example");
    assert.deepEqual(all_markets, olderResult.markets);
});

test("setupChain lets a newer success supersede an older success that published while it was pending", async (t) => {
    const rewardsA = defer<{ milestones: Record<string, any>; incentives: Record<string, any> }>();
    const rewardsB = defer<{ milestones: Record<string, any>; incentives: Record<string, any> }>();

    const originalGetRewards = Api.getRewards;
    const originalGetAll = Market.getAll;

    let rewardsCall = 0;

    Api.getRewards = (async () => {
        rewardsCall += 1;
        return rewardsCall === 1 ? rewardsA.promise : rewardsB.promise;
    }) as typeof Api.getRewards;

    Market.getAll = (async (_reader, _oracleManager, _provider, _signer, _account, _milestones, _incentives, setup) => {
        const activeSetup = setup!;
        return [{ marker: activeSetup.api_url }] as any;
    }) as typeof Market.getAll;

    t.after(() => {
        Api.getRewards = originalGetRewards;
        Market.getAll = originalGetAll;
    });

    const olderSetup = setupChain("monad-mainnet", null, "https://api.temporary.example");
    const newerSetup = setupChain("monad-mainnet", null, "https://api.final.example");

    rewardsA.resolve({ milestones: {}, incentives: {} });
    const olderResult = await olderSetup;

    assert.equal(setup_config.api_url, "https://api.temporary.example");
    assert.deepEqual(all_markets, olderResult.markets);

    rewardsB.resolve({ milestones: {}, incentives: {} });
    const newerResult = await newerSetup;

    assert.equal(setup_config.api_url, "https://api.final.example");
    assert.deepEqual(all_markets, newerResult.markets);
});

test("setupChain preserves call-start order when an older setup validates slowly", async (t) => {
    const validationA = defer<{ chainId: bigint; name: string }>();

    const originalGetRewards = Api.getRewards;
    const originalGetAll = Market.getAll;

    Api.getRewards = (async () => ({ milestones: {}, incentives: {} })) as typeof Api.getRewards;
    Market.getAll = (async (_reader, _oracleManager, _provider, _signer, _account, _milestones, _incentives, setup) => {
        const activeSetup = setup!;
        return [{ marker: activeSetup.api_url }] as any;
    }) as typeof Market.getAll;

    t.after(() => {
        Api.getRewards = originalGetRewards;
        Market.getAll = originalGetAll;
    });

    const olderSetup = setupChain("monad-mainnet", null, "https://api.slow-validation.example", {
        readProvider: {
            getNetwork: async () => validationA.promise,
        } as any,
    });
    const newerResult = await setupChain("monad-mainnet", null, "https://api.fast-validation.example", {
        readProvider: {
            getNetwork: async () => ({ chainId: 143n, name: "monad-mainnet" }),
        } as any,
    });

    assert.equal(setup_config.api_url, "https://api.fast-validation.example");
    assert.deepEqual(all_markets, newerResult.markets);

    validationA.resolve({ chainId: 143n, name: "monad-mainnet" });
    const olderResult = await olderSetup;

    assert.equal((olderResult.markets[0] as any).marker, "https://api.slow-validation.example");
    assert.equal(setup_config.api_url, "https://api.fast-validation.example");
    assert.deepEqual(all_markets, newerResult.markets);
});

test("setupChain keeps signer writes separate from dedicated read transport", async (t) => {
    const originalGetRewards = Api.getRewards;
    const originalGetAll = Market.getAll;
    const fakeSigner = {
        address: "0x000000000000000000000000000000000000dEaD",
    } as any;

    let captured: {
        provider: any;
        signer: any;
        account: any;
        setup: typeof setup_config | null;
    } = {
        provider: null,
        signer: null,
        account: null,
        setup: null,
    };

    Api.getRewards = (async () => ({ milestones: {}, incentives: {} })) as typeof Api.getRewards;
    Market.getAll = (async (_reader, _oracleManager, provider, signer, account, _milestones, _incentives, setup) => {
        captured = {
            provider,
            signer,
            account,
            setup: setup ?? null,
        };
        return [] as any;
    }) as typeof Market.getAll;

    t.after(() => {
        Api.getRewards = originalGetRewards;
        Market.getAll = originalGetAll;
    });

    await setupChain("monad-mainnet", fakeSigner, "https://api.example");

    assert.equal(setup_config.signer, fakeSigner);
    assert.equal(setup_config.account, fakeSigner.address);
    assert.equal(setup_config.provider, fakeSigner);
    assert.notEqual(setup_config.readProvider, fakeSigner);
    assert.equal(captured.signer, fakeSigner);
    assert.equal(captured.account, fakeSigner.address);
    assert.equal(captured.setup, setup_config);
    assert.equal(captured.provider, setup_config.readProvider);
    assert.notEqual(captured.provider, fakeSigner);
});

test("setupChain supports user-specific public reads without a signer", async (t) => {
    const originalGetRewards = Api.getRewards;
    const originalGetAll = Market.getAll;
    const account = "0x0000000000000000000000000000000000000abc";

    let captured: {
        provider: any;
        signer: any;
        account: any;
        setup: typeof setup_config | null;
    } = {
        provider: null,
        signer: null,
        account: null,
        setup: null,
    };

    Api.getRewards = (async () => ({ milestones: {}, incentives: {} })) as typeof Api.getRewards;
    Market.getAll = (async (_reader, _oracleManager, provider, signer, nextAccount, _milestones, _incentives, setup) => {
        captured = {
            provider,
            signer,
            account: nextAccount,
            setup: setup ?? null,
        };
        return [] as any;
    }) as typeof Market.getAll;

    t.after(() => {
        Api.getRewards = originalGetRewards;
        Market.getAll = originalGetAll;
    });

    await setupChain("monad-mainnet", null, "https://api.example", { account: account as any });

    assert.equal(setup_config.signer, null);
    assert.equal(setup_config.account, account);
    assert.equal(setup_config.provider, setup_config.readProvider);
    assert.equal(captured.signer, null);
    assert.equal(captured.account, account);
    assert.equal(captured.provider, setup_config.readProvider);
});

test("setupChain defaults every chain to the setup-resolved Curvance fee policy", async (t) => {
    const originalGetRewards = Api.getRewards;
    const originalGetAll = Market.getAll;
    const previousGetDaoAddress = ProtocolReader.prototype.getDaoAddress;
    const configuredChains = Object.keys(chain_config) as Array<keyof typeof chain_config>;
    const chainDaos = configuredChains.map((chain, index) => [
        chain,
        `0x${(index + 1).toString(16).padStart(40, "0")}` as address,
    ] as const);
    let currentDao: address = BOOT_DAO_FEE_RECEIVER;
    let daoLookups = 0;

    Api.getRewards = (async () => ({ milestones: {}, incentives: {} })) as typeof Api.getRewards;
    Market.getAll = (async () => [] as any) as typeof Market.getAll;
    ProtocolReader.prototype.getDaoAddress = async () => {
        daoLookups += 1;
        return currentDao;
    };

    t.after(() => {
        Api.getRewards = originalGetRewards;
        Market.getAll = originalGetAll;
        ProtocolReader.prototype.getDaoAddress = previousGetDaoAddress;
    });

    for (const [chain, dao] of chainDaos) {
        currentDao = dao;
        await setupChain(chain, null, "https://api.example");

        assert.equal(setup_config.feePolicy.chain, chain);
        assert.equal(
            setup_config.feePolicy.getFeeBps({
                operation: "zap",
                inputToken: "0x0000000000000000000000000000000000000001" as any,
                outputToken: "0x0000000000000000000000000000000000000002" as any,
                inputAmount: 1n,
                currentLeverage: null,
                targetLeverage: null,
            }),
            CURVANCE_FEE_BPS,
        );
        assert.equal(setup_config.feePolicy.feeReceiver, dao);
    }
    assert.equal(daoLookups, chainDaos.length);
});

test("setupChain validates explicit Kyber fee policies against the checker DAO before booting markets", async (t) => {
    const originalGetRewards = Api.getRewards;
    const originalGetAll = Market.getAll;
    const previousGetDaoAddress = ProtocolReader.prototype.getDaoAddress;
    let daoLookups = 0;
    let rewardsCalls = 0;
    let marketCalls = 0;

    Api.getRewards = (async () => {
        rewardsCalls += 1;
        return { milestones: {}, incentives: {} };
    }) as typeof Api.getRewards;
    Market.getAll = (async () => {
        marketCalls += 1;
        return [] as any;
    }) as typeof Market.getAll;
    ProtocolReader.prototype.getDaoAddress = async () => {
        daoLookups += 1;
        return BOOT_DAO_FEE_RECEIVER;
    };

    t.after(() => {
        Api.getRewards = originalGetRewards;
        Market.getAll = originalGetAll;
        ProtocolReader.prototype.getDaoAddress = previousGetDaoAddress;
    });

    await assert.rejects(
        () => setupChain("monad-mainnet", null, "https://api.example", { feePolicy: NO_FEE_POLICY }),
        /KyberSwap checker for monad-mainnet requires feeBps=4 and feeReceiver=0x0000000000000000000000000000000000000da0; got feeBps=0/i,
    );
    assert.equal(daoLookups, 1);
    assert.equal(rewardsCalls, 0);
    assert.equal(marketCalls, 0);

    const wrongReceiverPolicy = flatFeePolicy({
        bps: CURVANCE_FEE_BPS,
        feeReceiver: "0x0000000000000000000000000000000000000bad" as address,
        chain: "monad-mainnet",
    });
    await assert.rejects(
        () => setupChain("monad-mainnet", null, "https://api.example", { feePolicy: wrongReceiverPolicy }),
        /feeReceiver=0x0000000000000000000000000000000000000da0/i,
    );
    assert.equal(daoLookups, 2);
    assert.equal(rewardsCalls, 0);
    assert.equal(marketCalls, 0);
});

test("setupChain accepts checker-compatible explicit Kyber fee policies", async (t) => {
    const originalGetRewards = Api.getRewards;
    const originalGetAll = Market.getAll;
    const previousGetDaoAddress = ProtocolReader.prototype.getDaoAddress;
    const explicitPolicy = flatFeePolicy({
        bps: CURVANCE_FEE_BPS,
        feeReceiver: BOOT_DAO_FEE_RECEIVER,
        chain: "monad-mainnet",
    });
    let daoLookups = 0;

    Api.getRewards = (async () => ({ milestones: {}, incentives: {} })) as typeof Api.getRewards;
    Market.getAll = (async () => [] as any) as typeof Market.getAll;
    ProtocolReader.prototype.getDaoAddress = async () => {
        daoLookups += 1;
        return BOOT_DAO_FEE_RECEIVER;
    };

    t.after(() => {
        Api.getRewards = originalGetRewards;
        Market.getAll = originalGetAll;
        ProtocolReader.prototype.getDaoAddress = previousGetDaoAddress;
    });

    await setupChain("monad-mainnet", null, "https://api.example", { feePolicy: explicitPolicy });

    assert.equal(daoLookups, 1);
    assert.equal(setup_config.feePolicy, explicitPolicy);
    assert.equal(setup_config.feePolicy.feeReceiver, BOOT_DAO_FEE_RECEIVER);
});

test("setupChain rejects context-dependent Kyber fee policies before booting rewards or markets", async (t) => {
    const originalGetRewards = Api.getRewards;
    const originalGetAll = Market.getAll;
    const previousGetDaoAddress = ProtocolReader.prototype.getDaoAddress;
    let daoLookups = 0;
    let rewardsCalls = 0;
    let marketCalls = 0;

    const lowerStableTierPolicy = flatFeePolicy({
        bps: CURVANCE_FEE_BPS,
        stableToStableBps: CURVANCE_FEE_BPS - 1n,
        feeReceiver: BOOT_DAO_FEE_RECEIVER,
        chain: "monad-mainnet",
        classify: () => "stable",
    });

    Api.getRewards = (async () => {
        rewardsCalls += 1;
        return { milestones: {}, incentives: {} };
    }) as typeof Api.getRewards;
    Market.getAll = (async () => {
        marketCalls += 1;
        return [] as any;
    }) as typeof Market.getAll;
    ProtocolReader.prototype.getDaoAddress = async () => {
        daoLookups += 1;
        return BOOT_DAO_FEE_RECEIVER;
    };

    t.after(() => {
        Api.getRewards = originalGetRewards;
        Market.getAll = originalGetAll;
        ProtocolReader.prototype.getDaoAddress = previousGetDaoAddress;
    });

    await assert.rejects(
        () => setupChain("monad-mainnet", null, "https://api.example", { feePolicy: lowerStableTierPolicy }),
        /Context-dependent policies are not allowed on checker-bound routes/i,
    );
    assert.equal(daoLookups, 1);
    assert.equal(rewardsCalls, 0);
    assert.equal(marketCalls, 0);
});

test("setupChain does not query the DAO address when an explicit fee policy is provided for unsupported DEX chains", async (t) => {
    const originalGetRewards = Api.getRewards;
    const originalGetAll = Market.getAll;
    const previousGetDaoAddress = ProtocolReader.prototype.getDaoAddress;

    Api.getRewards = (async () => ({ milestones: {}, incentives: {} })) as typeof Api.getRewards;
    Market.getAll = (async () => [] as any) as typeof Market.getAll;
    ProtocolReader.prototype.getDaoAddress = async () => {
        throw new Error("unsupported-Dex explicit fee policy should not resolve DAO address");
    };

    t.after(() => {
        Api.getRewards = originalGetRewards;
        Market.getAll = originalGetAll;
        ProtocolReader.prototype.getDaoAddress = previousGetDaoAddress;
    });

    await setupChain("arb-sepolia", null, "https://api.example", { feePolicy: NO_FEE_POLICY });

    assert.equal(setup_config.chain, "arb-sepolia");
    assert.equal(setup_config.feePolicy, NO_FEE_POLICY);
});

test("setupChain preserves the previous setup when a later default DAO lookup fails", async (t) => {
    const originalGetRewards = Api.getRewards;
    const originalGetAll = Market.getAll;
    const previousGetDaoAddress = ProtocolReader.prototype.getDaoAddress;
    let daoLookups = 0;
    let rewardsCalls = 0;
    let marketCalls = 0;

    ProtocolReader.prototype.getDaoAddress = async () => {
        daoLookups += 1;
        if (daoLookups === 2) {
            throw new Error("DAO lookup failed");
        }
        return BOOT_DAO_FEE_RECEIVER;
    };
    Api.getRewards = (async () => {
        rewardsCalls += 1;
        return { milestones: {}, incentives: {} };
    }) as typeof Api.getRewards;
    Market.getAll = (async (_reader, _oracleManager, _provider, _signer, _account, _milestones, _incentives, setup) => {
        marketCalls += 1;
        return [{ marker: setup!.api_url }] as any;
    }) as typeof Market.getAll;

    t.after(() => {
        Api.getRewards = originalGetRewards;
        Market.getAll = originalGetAll;
        ProtocolReader.prototype.getDaoAddress = previousGetDaoAddress;
    });

    const olderResult = await setupChain("monad-mainnet", null, "https://api.dao-ok.example");

    assert.equal(setup_config.api_url, "https://api.dao-ok.example");
    assert.deepEqual(all_markets, olderResult.markets);
    assert.equal((olderResult.markets[0] as any).marker, "https://api.dao-ok.example");

    await assert.rejects(
        () => setupChain("monad-mainnet", null, "https://api.dao-fail.example"),
        /DAO lookup failed/i,
    );

    assert.equal(daoLookups, 2);
    assert.equal(rewardsCalls, 1, "failed DAO lookup should not fetch rewards");
    assert.equal(marketCalls, 1, "failed DAO lookup should not boot markets");
    assert.equal(setup_config.api_url, "https://api.dao-ok.example");
    assert.deepEqual(all_markets, olderResult.markets);
});

test("setupChain rejects known chain-bound fee policies for the wrong chain", async () => {
    const monadPolicy = flatFeePolicy({
        bps: CURVANCE_FEE_BPS,
        feeReceiver: BOOT_DAO_FEE_RECEIVER,
        chain: "monad-mainnet",
    });

    await assert.rejects(
        () => setupChain("arb-sepolia", null, "https://api.example", { feePolicy: monadPolicy }),
        /Fee policy for monad-mainnet cannot be used with setupChain\('arb-sepolia'\)\./,
    );
});

test("setupChain rejects invalid API URLs before provider validation or fetch", async () => {
    const originalFetch = globalThis.fetch;
    const poisonReadProvider = new JsonRpcProvider("https://poison-read-provider.example");
    let networkCalls = 0;
    let fetchCalls = 0;

    poisonReadProvider.getNetwork = async () => {
        networkCalls += 1;
        throw new Error("provider validation should not run for an invalid API URL");
    };
    globalThis.fetch = (async () => {
        fetchCalls += 1;
        throw new Error("reward/native-yield fetch should not run for an invalid API URL");
    }) as typeof fetch;

    try {
        await assert.rejects(
            () => setupChain("monad-mainnet", poisonReadProvider as any, "http://api.invalid.example"),
            /api_url must use HTTPS/i,
        );
        assert.equal(networkCalls, 0);
        assert.equal(fetchCalls, 0);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("setupChain wraps explicit read-provider overrides with chain fallbacks", async (t) => {
    const originalGetRewards = Api.getRewards;
    const originalGetAll = Market.getAll;
    const fakeSigner = {
        address: "0x000000000000000000000000000000000000dEaD",
    } as any;
    const customReadProvider = new JsonRpcProvider("https://wallet-rpc.example");
    customReadProvider.getNetwork = async () => ({ chainId: 143n, name: "monad-mainnet" } as any);
    const customAccount = fakeSigner.address;

    let captured: {
        provider: any;
        signer: any;
        account: any;
    } = {
        provider: null,
        signer: null,
        account: null,
    };

    resetRpcDebugState();
    Api.getRewards = (async () => ({ milestones: {}, incentives: {} })) as typeof Api.getRewards;
    Market.getAll = (async (_reader, _oracleManager, provider, signer, account) => {
        captured = { provider, signer, account };
        return [] as any;
    }) as typeof Market.getAll;

    t.after(() => {
        Api.getRewards = originalGetRewards;
        Market.getAll = originalGetAll;
        resetRpcDebugState();
    });

    await setupChain("monad-mainnet", fakeSigner, "https://api.example", {
        account: customAccount as any,
        readProvider: customReadProvider,
    });

    const snapshot = getRpcDebugSnapshot();
    const urls = snapshot.endpoints.map((endpoint) => endpoint.url).filter((url): url is string => url != null);
    const monadRpc = getChainRpcConfig("monad-mainnet");

    assert.equal(setup_config.signer, fakeSigner);
    assert.equal(setup_config.account, customAccount);
    assert.notEqual(setup_config.readProvider, customReadProvider);
    assert.ok(isRetryableReadProvider(setup_config.readProvider));
    assert.equal(captured.signer, fakeSigner);
    assert.equal(captured.account, customAccount);
    assert.equal(captured.provider, setup_config.readProvider);
    assert.ok(urls.includes("https://wallet-rpc.example"));
    assert.ok(urls.includes(monadRpc.primary.replace(/\/+$/, "")));
    for (const fallback of monadRpc.fallbacks.map((url) => url.replace(/\/+$/, ""))) {
        assert.ok(urls.includes(fallback));
    }
});

test("setupChain rejects mismatched signer and explicit account", async (t) => {
    const originalGetRewards = Api.getRewards;
    const originalGetAll = Market.getAll;
    const fakeSigner = {
        address: "0x000000000000000000000000000000000000dEaD",
    } as any;

    Api.getRewards = (async () => ({ milestones: {}, incentives: {} })) as typeof Api.getRewards;
    Market.getAll = (async () => {
        throw new Error("should fail before Market.getAll");
    }) as typeof Market.getAll;

    t.after(() => {
        Api.getRewards = originalGetRewards;
        Market.getAll = originalGetAll;
    });

    await assert.rejects(
        () =>
            setupChain("monad-mainnet", fakeSigner, "https://api.example", {
                account: "0x0000000000000000000000000000000000000def" as any,
            }),
        /cannot boot with signer .* and read account/i,
    );
});

test("setupChain re-wraps an already retry-wrapped explicit read provider per invocation", async (t) => {
    const originalGetRewards = Api.getRewards;
    const originalGetAll = Market.getAll;
    const baseProvider = new JsonRpcProvider("https://wallet-rpc.example");
    baseProvider.getNetwork = async () => ({ chainId: 143n, name: "monad-mainnet" } as any);

    Api.getRewards = (async () => ({ milestones: {}, incentives: {} })) as typeof Api.getRewards;
    Market.getAll = (async () => [] as any) as typeof Market.getAll;

    t.after(() => {
        Api.getRewards = originalGetRewards;
        Market.getAll = originalGetAll;
        resetRpcDebugState();
    });

    const firstWrapped = await (async () => {
        await setupChain("monad-mainnet", null, "https://api.first.example", {
            readProvider: baseProvider,
        });
        return setup_config.readProvider;
    })();

    await setupChain("monad-mainnet", null, "https://api.second.example", {
        readProvider: firstWrapped,
    });

    assert.ok(isRetryableReadProvider(firstWrapped));
    assert.ok(isRetryableReadProvider(setup_config.readProvider));
    assert.notEqual(setup_config.readProvider, firstWrapped);
});

test("setupChain validates a retry-wrapped signer against its primary wallet transport", async (t) => {
    const originalGetRewards = Api.getRewards;
    const originalGetAll = Market.getAll;
    const walletPrimary = new JsonRpcProvider("https://wallet-primary.example");
    walletPrimary.getNetwork = async () => {
        throw new Error("wallet getNetwork timeout");
    };
    const healthyFallback = new JsonRpcProvider("https://healthy-fallback.example");
    healthyFallback.getNetwork = async () => ({ chainId: 143n, name: "monad-mainnet" } as any);
    const wrappedWalletProvider = wrapProviderWithRetries(walletPrimary, healthyFallback);
    const fakeSigner = {
        address: "0x000000000000000000000000000000000000dEaD",
        provider: wrappedWalletProvider,
    } as any;

    let rewardsCalls = 0;
    let marketCalls = 0;
    Api.getRewards = (async () => {
        rewardsCalls += 1;
        return { milestones: {}, incentives: {} };
    }) as typeof Api.getRewards;
    Market.getAll = (async () => {
        marketCalls += 1;
        return [] as any;
    }) as typeof Market.getAll;

    t.after(() => {
        Api.getRewards = originalGetRewards;
        Market.getAll = originalGetAll;
        resetRpcDebugState();
    });

    await assert.rejects(
        () => setupChain("monad-mainnet", fakeSigner, "https://api.example"),
        /wallet getNetwork timeout/i,
    );
    assert.equal(rewardsCalls, 0);
    assert.equal(marketCalls, 0);
});

test("setupChain removes fallback origins that duplicate the selected read primary", async (t) => {
    const originalGetRewards = Api.getRewards;
    const originalGetAll = Market.getAll;
    const monadRpc = getChainRpcConfig("monad-mainnet");
    const primaryOverride = new JsonRpcProvider(monadRpc.primary);
    primaryOverride.getNetwork = async () => ({ chainId: 143n, name: "monad-mainnet" } as any);

    resetRpcDebugState();
    Api.getRewards = (async () => ({ milestones: {}, incentives: {} })) as typeof Api.getRewards;
    Market.getAll = (async () => [] as any) as typeof Market.getAll;

    t.after(() => {
        Api.getRewards = originalGetRewards;
        Market.getAll = originalGetAll;
        resetRpcDebugState();
    });

    await setupChain("monad-mainnet", null, "https://api.example", {
        readProvider: primaryOverride,
    });

    const primaryUrl = monadRpc.primary.replace(/\/+$/, "");
    const snapshot = getRpcDebugSnapshot();
    const primary = snapshot.endpoints.find((e) => e.role === "primary");
    const fallbackUrls = snapshot.endpoints
        .filter((e) => e.role === "fallback")
        .map((e) => e.url)
        .filter((url): url is string => url != null);

    assert.equal(primary?.url, primaryUrl);
    assert.equal(
        fallbackUrls.filter((url) => url === primaryUrl).length,
        0,
        "selected primary RPC must not also appear as fallback",
    );
    for (const fallback of monadRpc.fallbacks.map((url) => url.replace(/\/+$/, ""))) {
        assert.ok(fallbackUrls.includes(fallback));
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Wallet-primary reads.
//
// When a signer is connected, the wallet's own provider should be the primary
// read source — the SDK's configured chain RPC + fallbacks serve as fallback
// only. This matches the pre-`358d46b` architecture (which explicitly named
// Rabby as the motivating unreliable-wallet case in an inline comment) and
// distributes read load across users' wallet-configured RPCs instead of
// funneling every Curvance user's reads through the single `chain_config`
// primary origin.
//
// Graceful degradation: wallet provider errors → retry wrapper falls through
// to chainReadProvider → chain fallbacks. Users with broken or missing wallet
// RPCs never lose access.
// ─────────────────────────────────────────────────────────────────────────────

test("setupChain uses the wallet's own provider as the read primary when signer has one", async (t) => {
    const originalGetRewards = Api.getRewards;
    const originalGetAll = Market.getAll;
    const walletRpcProvider = new JsonRpcProvider("https://wallet-rpc.example");
    walletRpcProvider.getNetwork = async () => ({ chainId: 143n, name: "monad-mainnet" } as any);
    const fakeSigner = {
        address: "0x000000000000000000000000000000000000dEaD",
        provider: walletRpcProvider,
    } as any;

    resetRpcDebugState();
    Api.getRewards = (async () => ({ milestones: {}, incentives: {} })) as typeof Api.getRewards;
    Market.getAll = (async () => [] as any) as typeof Market.getAll;

    t.after(() => {
        Api.getRewards = originalGetRewards;
        Market.getAll = originalGetAll;
        resetRpcDebugState();
    });

    await setupChain("monad-mainnet", fakeSigner, "https://api.example");

    const snapshot = getRpcDebugSnapshot();
    const monadRpc = getChainRpcConfig("monad-mainnet");
    const primary = snapshot.endpoints.find((e) => e.role === "primary");
    const fallbackUrls = snapshot.endpoints
        .filter((e) => e.role === "fallback")
        .map((e) => e.url)
        .filter((url): url is string => url != null);

    // Signer is still the write path.
    assert.equal(setup_config.signer, fakeSigner);
    assert.equal(setup_config.account, fakeSigner.address);
    // Read primary is the wallet's own provider — load distributes across users.
    assert.equal(
        primary?.url,
        "https://wallet-rpc.example",
        "wallet's provider must be the read primary when a signer is connected",
    );
    // Chain's configured primary is a fallback (catches wallet RPC failures).
    assert.ok(
        fallbackUrls.includes(monadRpc.primary.replace(/\/+$/, "")),
        "chain primary must be in the fallback chain behind the wallet provider",
    );
    // Chain's configured fallbacks are also in the fallback chain.
    for (const fallback of monadRpc.fallbacks.map((url) => url.replace(/\/+$/, ""))) {
        assert.ok(
            fallbackUrls.includes(fallback),
            `chain fallback ${fallback} must be in the fallback chain`,
        );
    }
});

test("setupChain falls back to chain provider when the signer has no .provider", async (t) => {
    const originalGetRewards = Api.getRewards;
    const originalGetAll = Market.getAll;
    const fakeSignerNoProvider = {
        address: "0x000000000000000000000000000000000000dEaD",
        // no .provider — defensive path for Wallet signers constructed without
        // a connected provider, or any non-standard signer implementation.
    } as any;

    resetRpcDebugState();
    Api.getRewards = (async () => ({ milestones: {}, incentives: {} })) as typeof Api.getRewards;
    Market.getAll = (async () => [] as any) as typeof Market.getAll;

    t.after(() => {
        Api.getRewards = originalGetRewards;
        Market.getAll = originalGetAll;
        resetRpcDebugState();
    });

    await setupChain("monad-mainnet", fakeSignerNoProvider, "https://api.example");

    const snapshot = getRpcDebugSnapshot();
    const monadRpc = getChainRpcConfig("monad-mainnet");
    const primary = snapshot.endpoints.find((e) => e.role === "primary");

    assert.equal(setup_config.signer, fakeSignerNoProvider);
    assert.equal(
        primary?.url,
        monadRpc.primary.replace(/\/+$/, ""),
        "signer without .provider must degrade to chain primary",
    );
});

test("explicit readProvider option wins over the signer's own provider", async (t) => {
    const originalGetRewards = Api.getRewards;
    const originalGetAll = Market.getAll;
    const walletRpcProvider = new JsonRpcProvider("https://wallet-rpc.example");
    walletRpcProvider.getNetwork = async () => ({ chainId: 143n, name: "monad-mainnet" } as any);
    const fakeSigner = {
        address: "0x000000000000000000000000000000000000dEaD",
        provider: walletRpcProvider,
    } as any;
    const overrideProvider = new JsonRpcProvider("https://override-rpc.example");
    overrideProvider.getNetwork = async () => ({ chainId: 143n, name: "monad-mainnet" } as any);

    resetRpcDebugState();
    Api.getRewards = (async () => ({ milestones: {}, incentives: {} })) as typeof Api.getRewards;
    Market.getAll = (async () => [] as any) as typeof Market.getAll;

    t.after(() => {
        Api.getRewards = originalGetRewards;
        Market.getAll = originalGetAll;
        resetRpcDebugState();
    });

    await setupChain("monad-mainnet", fakeSigner, "https://api.example", {
        readProvider: overrideProvider,
    });

    const snapshot = getRpcDebugSnapshot();
    const primary = snapshot.endpoints.find((e) => e.role === "primary");
    const fallbackUrls = snapshot.endpoints
        .filter((e) => e.role === "fallback")
        .map((e) => e.url)
        .filter((url): url is string => url != null);

    // Explicit option wins — wallet's provider is ignored for reads.
    assert.equal(
        primary?.url,
        "https://override-rpc.example",
        "explicit readProvider option must take precedence over signer.provider",
    );
    assert.ok(
        !fallbackUrls.includes("https://wallet-rpc.example"),
        "wallet's provider must not appear in the fallback chain when an explicit override was given",
    );
});

test("setupChain fails fast when an explicit read provider is connected to a different chain", async (t) => {
    const originalGetRewards = Api.getRewards;
    const originalGetAll = Market.getAll;
    const wrongReadProvider = new JsonRpcProvider("https://wrong-chain.example");
    wrongReadProvider.getNetwork = async () => ({ chainId: 421614n, name: "arb-sepolia" } as any);

    let rewardsCalls = 0;
    let marketCalls = 0;
    Api.getRewards = (async () => {
        rewardsCalls += 1;
        return { milestones: {}, incentives: {} };
    }) as typeof Api.getRewards;
    Market.getAll = (async () => {
        marketCalls += 1;
        return [] as any;
    }) as typeof Market.getAll;

    t.after(() => {
        Api.getRewards = originalGetRewards;
        Market.getAll = originalGetAll;
    });

    await assert.rejects(
        () => setupChain("monad-mainnet", null, "https://api.example", {
            readProvider: wrongReadProvider,
        }),
        /Read provider is connected to chainId 421614 but setupChain\('monad-mainnet'\) expects 143\./i,
    );
    assert.equal(rewardsCalls, 0);
    assert.equal(marketCalls, 0);
});

test("setupChain times out a hanging explicit readProvider during chain validation", async (t) => {
    const originalGetRewards = Api.getRewards;
    const originalGetAll = Market.getAll;
    const hangingReadProvider = new JsonRpcProvider("https://hanging-rpc.example");
    hangingReadProvider.getNetwork = async () => new Promise(() => undefined);

    let rewardsCalls = 0;
    let marketCalls = 0;
    configureRetries({
        ...DEFAULT_RETRY_CONFIG,
        maxRetries: 0,
        baseDelay: 0,
        maxDelay: 0,
        timeoutMs: 25,
    });
    Api.getRewards = (async () => {
        rewardsCalls += 1;
        return { milestones: {}, incentives: {} };
    }) as typeof Api.getRewards;
    Market.getAll = (async () => {
        marketCalls += 1;
        return [] as any;
    }) as typeof Market.getAll;

    t.after(() => {
        Api.getRewards = originalGetRewards;
        Market.getAll = originalGetAll;
        configureRetries(DEFAULT_RETRY_CONFIG);
        resetRpcDebugState();
    });

    const startedAt = Date.now();
    await assert.rejects(
        () => setupChain("monad-mainnet", null, "https://api.example", {
            readProvider: hangingReadProvider,
        }),
        /Read provider getNetwork: timeout after 25ms/i,
    );

    assert.ok(Date.now() - startedAt < 500, "chain validation should use the configured read timeout");
    assert.equal(rewardsCalls, 0);
    assert.equal(marketCalls, 0);
});

test("setupChain treats timeoutMs=0 as timeout disabled during chain validation", async (t) => {
    const originalGetRewards = Api.getRewards;
    const originalGetAll = Market.getAll;
    const slowReadProvider = new JsonRpcProvider("https://slow-rpc.example");
    slowReadProvider.getNetwork = async () => new Promise((resolve) => {
        setTimeout(() => resolve({ chainId: 143n, name: "monad-mainnet" } as any), 10);
    });

    let rewardsCalls = 0;
    let marketCalls = 0;
    configureRetries({
        ...DEFAULT_RETRY_CONFIG,
        maxRetries: 0,
        baseDelay: 0,
        maxDelay: 0,
        timeoutMs: 0,
    });
    Api.getRewards = (async () => {
        rewardsCalls += 1;
        return { milestones: {}, incentives: {} };
    }) as typeof Api.getRewards;
    Market.getAll = (async () => {
        marketCalls += 1;
        return [] as any;
    }) as typeof Market.getAll;

    t.after(() => {
        Api.getRewards = originalGetRewards;
        Market.getAll = originalGetAll;
        configureRetries(DEFAULT_RETRY_CONFIG);
        resetRpcDebugState();
    });

    await setupChain("monad-mainnet", null, "https://api.example", {
        readProvider: slowReadProvider,
    });

    assert.equal(rewardsCalls, 1);
    assert.equal(marketCalls, 1);
});

test("setupChain fails fast when the signer provider is connected to a different chain", async (t) => {
    const originalGetRewards = Api.getRewards;
    const originalGetAll = Market.getAll;
    const walletRpcProvider = new JsonRpcProvider("https://wallet-rpc.example");
    walletRpcProvider.getNetwork = async () => ({ chainId: 421614n, name: "arb-sepolia" } as any);

    const overrideProvider = new JsonRpcProvider("https://override-rpc.example");
    overrideProvider.getNetwork = async () => ({ chainId: 143n, name: "monad-mainnet" } as any);

    const fakeSigner = {
        address: "0x000000000000000000000000000000000000dEaD",
        provider: walletRpcProvider,
    } as any;

    let rewardsCalls = 0;
    let marketCalls = 0;

    Api.getRewards = (async () => {
        rewardsCalls += 1;
        return { milestones: {}, incentives: {} };
    }) as typeof Api.getRewards;
    Market.getAll = (async () => {
        marketCalls += 1;
        return [] as any;
    }) as typeof Market.getAll;

    t.after(() => {
        Api.getRewards = originalGetRewards;
        Market.getAll = originalGetAll;
    });

    await assert.rejects(
        () => setupChain("monad-mainnet", fakeSigner, "https://api.example", {
            readProvider: overrideProvider,
        }),
        /Signer provider is connected to chainId 421614 but setupChain\('monad-mainnet'\) expects 143\./i,
    );
    assert.equal(rewardsCalls, 0);
    assert.equal(marketCalls, 0);
});
