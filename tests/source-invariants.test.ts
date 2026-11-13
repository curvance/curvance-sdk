import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { chain_config, chain_rpc_config } from "../src/chains";
import { chains } from "../src/contracts";

const repoRoot = path.resolve(__dirname, "..");

function readRepoFile(relativePath: string): string {
    return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function listFiles(relativeDir: string): string[] {
    const absoluteDir = path.join(repoRoot, relativeDir);
    const files: string[] = [];

    for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
        const relativePath = path.join(relativeDir, entry.name).replace(/\\/g, "/");
        if (entry.isDirectory()) {
            files.push(...listFiles(relativePath));
        } else {
            files.push(relativePath);
        }
    }

    return files;
}

function extractBlock(source: string, needle: string): string {
    const start = source.indexOf(needle);
    assert.notEqual(start, -1, `Could not find source block: ${needle}`);

    const firstBrace = source.indexOf("{", start);
    assert.notEqual(firstBrace, -1, `Could not find opening brace for: ${needle}`);

    let depth = 0;
    for (let i = firstBrace; i < source.length; i++) {
        const char = source[i];
        if (char === "{") depth++;
        if (char === "}") depth--;

        if (depth === 0) {
            return source.slice(firstBrace + 1, i);
        }
    }

    throw new Error(`Could not extract source block: ${needle}`);
}

test("test:transport includes every deterministic test file", () => {
    const packageJson = JSON.parse(readRepoFile("package.json"));
    const transportScript = packageJson.scripts["test:transport"] as string;
    const manualOrEnvBackedTests = new Set([
        "arb-basic.test.ts",
        "basic.test.ts",
        "dual-fork-switch.test.ts",
        "leverage.test.ts",
        "optimizer.test.ts",
        "optimizer-zap.test.ts",
        "zap.test.ts",
    ]);

    const missing = readdirSync(path.join(repoRoot, "tests"))
        .filter((file) => file.endsWith(".test.ts"))
        .filter((file) => !manualOrEnvBackedTests.has(file))
        .filter((file) => !transportScript.includes(`tests/${file}`));

    assert.deepEqual(missing, []);
});

test("test:fork includes every env-backed fork test file", () => {
    const packageJson = JSON.parse(readRepoFile("package.json"));
    const forkScript = packageJson.scripts["test:fork"] as string;
    const expectedForkTests = [
        "fork-integration.ts",
        "basic.test.ts",
        "arb-basic.test.ts",
        "optimizer.test.ts",
        "optimizer-zap.test.ts",
        "leverage.test.ts",
        "zap.test.ts",
        "zap-repay-fork.ts",
        "zap-exits-fork.ts",
        "dual-fork-switch.test.ts",
    ];

    const missing = expectedForkTests
        .filter((file) => !forkScript.includes(`tests/${file}`));

    assert.deepEqual(missing, []);
});

test("zap repay fork gate fails closed instead of passing through a skipped suite", () => {
    const packageJson = JSON.parse(readRepoFile("package.json"));
    const gateScript = readRepoFile("tests/run-zap-repay-fork-gate.cjs");
    const forkTest = readRepoFile("tests/zap-repay-fork.ts");

    assert.equal(
        packageJson.scripts["test:zap-repay-fork"],
        "node tests/run-zap-repay-fork-gate.cjs",
    );
    assert.match(gateScript, /require\("dotenv"\)\.config/);
    assert.match(gateScript, /if \(!rpcUrl\)/);
    assert.match(gateScript, /CURVANCE_REQUIRE_ZAP_REPAY_FORK: "1"/);
    assert.match(gateScript, /tests\/zap-repay-fork\.ts/);
    assert.match(gateScript, /expectedCases/);
    assert.match(gateScript, /# skipped 0/);
    assert.match(forkTest, /REQUIRE_FORK_ENV && !HAS_FORK_ENV/);
    assert.match(forkTest, /refusing to report a skipped suite as passing/);
});

test("package lifecycle rebuilds dist before pack and publish", () => {
    const packageJson = JSON.parse(readRepoFile("package.json"));
    const distSmokeSource = readRepoFile("tests/dist-smoke.cjs");

    assert.equal(packageJson.scripts.prepack, "npm run build");
    assert.equal(packageJson.scripts.prepublishOnly, "npm run build");
    assert.doesNotMatch(distSmokeSource, /--ignore-scripts/);
    assert.match(distSmokeSource, /require\(packageRoot\)/);
    assert.doesNotMatch(
        distSmokeSource,
        /require\(["']\.\.\/dist\/classes\//,
        "dist smoke should exercise the packed package root instead of local dist class modules",
    );
    assert.match(distSmokeSource, /dist\/chains\/services\.js/);
    assert.match(distSmokeSource, /dist\/chains\/services\.d\.ts/);
});

test("test scripts that name concrete test files point to existing files", () => {
    const packageJson = JSON.parse(readRepoFile("package.json"));
    const missing: string[] = [];

    for (const [scriptName, command] of Object.entries(packageJson.scripts as Record<string, string>)) {
        if (!scriptName.startsWith("test:")) {
            continue;
        }

        for (const match of command.matchAll(/tests[\/\\]([^\s"'`]+\.(?:ts|cjs|mjs|js))/g)) {
            const testPath = match[0];
            if (testPath.includes("*")) {
                continue;
            }
            if (!existsSync(path.join(repoRoot, testPath))) {
                missing.push(`${scriptName}:${testPath}`);
            }
        }
    }

    assert.deepEqual(missing, []);
});

test("chain config, RPC config, and contract manifests stay aligned", () => {
    const configuredChains = Object.keys(chain_config).sort();
    const rpcChains = Object.keys(chain_rpc_config).sort();
    const contractChains = Object.keys(chains).sort();

    assert.deepEqual(configuredChains, rpcChains);
    assert.deepEqual(configuredChains, contractChains);

    const chainIds = new Map<number, string>();
    for (const [chain, config] of Object.entries(chain_config)) {
        assert.ok(
            Number.isSafeInteger(config.chainId) && config.chainId > 0,
            `${chain} chainId must be a positive safe integer`,
        );
        const duplicateChain = chainIds.get(config.chainId);
        assert.equal(
            duplicateChain,
            undefined,
            `${chain} chainId duplicates ${duplicateChain}`,
        );
        chainIds.set(config.chainId, chain);
        assert.ok(config.environment, `${chain} must declare an environment`);
        assert.ok(config.services?.curvanceApi, `${chain} must declare Curvance API service aliases`);
        assert.ok(
            typeof config.services.curvanceApi.rewardsSlug === "string" &&
            config.services.curvanceApi.rewardsSlug.trim().length > 0,
            `${chain} rewardsSlug must be an explicit non-empty string`,
        );
        assert.ok(
            Array.isArray(config.services.curvanceApi.rewardChainAliases),
            `${chain} rewardChainAliases must be explicit`,
        );
        assert.ok(
            config.services.curvanceApi.rewardChainAliases.every((alias) => (
                typeof alias === "string" && alias.trim().length > 0
            )),
            `${chain} rewardChainAliases must be non-empty strings`,
        );
        assert.ok(
            typeof config.services.curvanceApi.nativeYieldSlug === "string" ||
            config.services.curvanceApi.nativeYieldSlug === null,
            `${chain} nativeYieldSlug must be explicit string or null`,
        );
        if (typeof config.services.curvanceApi.nativeYieldSlug === "string") {
            assert.ok(
                config.services.curvanceApi.nativeYieldSlug.trim().length > 0,
                `${chain} nativeYieldSlug must be non-empty when enabled`,
            );
        }
        assert.ok(
            Array.isArray(config.services.curvanceApi.suppressedNativeYieldSymbols),
            `${chain} suppressedNativeYieldSymbols must be explicit`,
        );
        assert.ok(
            config.services.curvanceApi.suppressedNativeYieldSymbols.every((symbol) => (
                typeof symbol === "string" && symbol.trim().length > 0
            )),
            `${chain} suppressedNativeYieldSymbols must be non-empty strings`,
        );
        assert.ok(
            Array.isArray(config.excluded_zap_symbols),
            `${chain} excluded_zap_symbols must be explicit`,
        );
        assert.ok(
            config.excluded_zap_symbols.every((symbol) => (
                typeof symbol === "string" && symbol.trim().length > 0
            )),
            `${chain} excluded_zap_symbols must be non-empty strings`,
        );
        const normalizedExcludedZapSymbols = config.excluded_zap_symbols.map((symbol) => symbol.toLowerCase());
        assert.equal(
            new Set(normalizedExcludedZapSymbols).size,
            normalizedExcludedZapSymbols.length,
            `${chain} excluded_zap_symbols must not contain case-insensitive duplicates`,
        );
        assert.ok(
            Array.isArray(config.excluded_zap_addresses),
            `${chain} excluded_zap_addresses must be explicit`,
        );
        const excludedZapAddresses = config.excluded_zap_addresses ?? [];
        assert.ok(
            excludedZapAddresses.every((token) => /^0x[0-9a-f]{40}$/i.test(token)),
            `${chain} excluded_zap_addresses must contain valid addresses`,
        );
        const normalizedExcludedZapAddresses = excludedZapAddresses.map((token) => token.toLowerCase());
        assert.equal(
            new Set(normalizedExcludedZapAddresses).size,
            normalizedExcludedZapAddresses.length,
            `${chain} excluded_zap_addresses must not contain case-insensitive duplicates`,
        );
        assert.ok(
            config.services.dexAggregators,
            `${chain} must explicitly declare DEX aggregator service config`,
        );
        const kyberSwap = config.services.dexAggregators.kyberSwap;
        if (kyberSwap != null) {
            assert.ok(
                typeof kyberSwap.chainSlug === "string" && kyberSwap.chainSlug.trim().length > 0,
                `${chain} KyberSwap chainSlug must be an explicit non-empty string`,
            );
            assert.ok(
                typeof kyberSwap.apiBase === "string" && kyberSwap.apiBase.trim().length > 0,
                `${chain} KyberSwap apiBase must be an explicit non-empty string`,
            );
            assert.ok(
                typeof kyberSwap.router === "string" && kyberSwap.router.trim().length > 0,
                `${chain} KyberSwap router must be an explicit non-empty string`,
            );
        }
        assert.ok((chains as any)[chain].ProtocolReader, `${chain} contracts must include ProtocolReader`);
        assert.ok((chains as any)[chain].OracleManager, `${chain} contracts must include OracleManager`);
    }
});

test("Curvance API reward aliases are unambiguous across configured chains", () => {
    const aliasOwners = new Map<string, string>();
    const collisions: string[] = [];

    for (const [chain, config] of Object.entries(chain_config)) {
        const aliases = [
            chain,
            config.services.curvanceApi.rewardsSlug,
            ...config.services.curvanceApi.rewardChainAliases,
        ];
        const normalizedAliases = Array.from(
            new Set(aliases.map((alias) => alias.trim().toLowerCase().replace(/[\s_]+/g, "-"))),
        );

        for (const alias of normalizedAliases) {
            const owner = aliasOwners.get(alias);
            if (owner != null && owner !== chain) {
                collisions.push(`${alias}:${owner}/${chain}`);
            } else {
                aliasOwners.set(alias, chain);
            }
        }
    }

    assert.deepEqual(
        collisions,
        [],
        "Curvance API reward aliases must uniquely identify one configured chain",
    );
});

test("external service configuration stays in chain config and API2 uses numeric chain ids", () => {
    const apiSource = readRepoFile("src/classes/Api.ts");
    const marketSource = readRepoFile("src/classes/Market.ts");
    const monadChainSource = readRepoFile("src/chains/monad.ts");
    const chainServicesSource = readRepoFile("src/chains/services.ts");
    const kyberSource = readRepoFile("src/classes/DexAggregators/KyberSwap.ts");

    assert.match(apiSource, /resolveCurvanceApiServices/);
    assert.match(apiSource, /chain_config\[config\.chain\]\?\.services\.curvanceApi/);
    assert.match(apiSource, /resolveCurvanceApiServices\(resolvedConfig\)\.nativeYieldSlug/);
    assert.match(apiSource, /`\$\{apiUrl\}\/asset\/\$\{chainId\}`/);
    assert.doesNotMatch(apiSource, /\/v1\/rewards\/active|\/native_apy/);
    assert.match(marketSource, /setup\.services\.curvanceApi\.suppressedNativeYieldSymbols/);
    assert.doesNotMatch(apiSource, /normalized === "monad-mainnet"|normalized === "arb-sepolia"/);
    assert.doesNotMatch(apiSource, /chain == 'monad-mainnet'|\['monad'\]\.includes/);
    assert.doesNotMatch(
        marketSource,
        /chain === "monad-mainnet" && yieldEntry\.symbol\.toUpperCase\(\) === "USDC"/,
    );
    assert.match(chainServicesSource, /export const MONAD_KYBER_SWAP_SERVICE: KyberSwapServiceConfig = \{/);
    assert.match(chainServicesSource, /chainSlug: "monad"/);
    assert.match(monadChainSource, /new KyberSwap\(EMPTY_ADDRESS,\s*kyberSwap\.router,\s*kyberSwap\.chainSlug,\s*kyberSwap\.apiBase\)/);
    assert.match(kyberSource, /router: address = MONAD_KYBER_SWAP_SERVICE\.router/);
    assert.doesNotMatch(kyberSource, /https:\/\/aggregator-api\.kyberswap\.com/);
});

test("production RPC origins have fallback or explicit non-production environment", () => {
    const missingFallbacks = Object.entries(chain_config)
        .filter(([, config]) => config.environment === "production-mainnet")
        .filter(([chain]) => chain_rpc_config[chain as keyof typeof chain_rpc_config].fallbacks.length === 0)
        .map(([chain]) => chain);

    assert.deepEqual(missingFallbacks, []);
});

test("CToken market-bound ERC20 helpers pass the market OracleManager explicitly", () => {
    const source = readRepoFile("src/classes/CToken.ts");
    const helperCalls = [...source.matchAll(/new ERC20\(\s*this\.provider,[\s\S]*?this\.signer,\s*\)/g)]
        .map((match) => match[0]);
    const missingOracleManager = helperCalls
        .filter((call) => !call.includes("this.setup.contracts.OracleManager as address"));

    assert.ok(helperCalls.length > 0, "expected to find CToken market-bound ERC20 helper constructors");
    assert.deepEqual(missingOracleManager, []);
});

test("deployment manifests do not declare duplicate market addresses", () => {
    const duplicates: string[] = [];

    for (const [chain, config] of Object.entries(chains)) {
        const seen = new Map<string, string>();
        const markets = (config as any).markets as Record<string, any>;
        for (const [name, market] of Object.entries(markets)) {
            if (typeof market !== "object" || market == null || typeof market.address !== "string") {
                continue;
            }
            const key = market.address.toLowerCase();
            const existing = seen.get(key);
            if (existing != undefined) {
                duplicates.push(`${chain}:${existing}/${name}:${key}`);
            }
            seen.set(key, name);
        }
    }

    assert.deepEqual(duplicates, []);
});

test("deployment manifests store every market token IRM in the canonical irms map", () => {
    const missingIrmEntries: string[] = [];
    const legacyIrmKeys: string[] = [];
    const misorderedIrmKeys: string[] = [];
    const misorderedMarketKeys: string[] = [];
    const canonicalMarketKeyOrder = ["address", "tokens", "irms", "plugins"];

    for (const [chain, config] of Object.entries(chains)) {
        const markets = (config as any).markets as Record<string, any>;
        for (const [marketName, market] of Object.entries(markets)) {
            const expectedMarketKeys = canonicalMarketKeyOrder.filter((key) => key in market);
            const actualMarketKeys = Object.keys(market).slice(0, expectedMarketKeys.length);
            if (actualMarketKeys.join(",") !== expectedMarketKeys.join(",")) {
                misorderedMarketKeys.push(`${chain}:${marketName}:${actualMarketKeys.join(",")}`);
            }

            for (const key of Object.keys(market)) {
                if (key.endsWith("-DynamicIRM")) {
                    legacyIrmKeys.push(`${chain}:${marketName}:${key}`);
                }
            }

            const irms = market.irms as Record<string, unknown> | undefined;
            const tokenSymbols = Object.keys(market.tokens ?? {});
            if (Object.keys(irms ?? {}).slice(0, tokenSymbols.length).join(",") !== tokenSymbols.join(",")) {
                misorderedIrmKeys.push(`${chain}:${marketName}`);
            }

            for (const tokenSymbol of tokenSymbols) {
                if (typeof irms?.[tokenSymbol] !== "string") {
                    missingIrmEntries.push(`${chain}:${marketName}:${tokenSymbol}`);
                }
            }
        }
    }

    assert.deepEqual(legacyIrmKeys, []);
    assert.deepEqual(missingIrmEntries, []);
    assert.deepEqual(misorderedIrmKeys, []);
    assert.deepEqual(misorderedMarketKeys, []);
});

test("Monad mainnet manifest uses the current oracle and optimizer rollout", () => {
    const monad = (chains as any)["monad-mainnet"];

    assert.equal(monad.OracleManager, "0x65ADF8aE8420A58278De066593E6fF1713A137c5");
    assert.deepEqual(monad.adaptors, {
        ChainlinkAdaptor: "0x42B318abFDE82a43B3685eB65a5863B9367B22e1",
        RedstoneClassicAdaptor: "0x4d48676f7B407A7715E84862dbA42b276B8851aE",
    });
    assert.deepEqual(monad.Optimizers, {
        "High Yield AUSD": "0xaD663aC84052b52BE4ed1b27BA416505e84a00Bf",
    });
    assert.ok(chain_config["monad-mainnet"].excluded_zap_symbols.includes("hyAUSD"));
    assert.ok(chain_config["monad-mainnet"].excluded_zap_symbols.includes("aguaUSDCgc"));
    for (const symbol of ["muBOND", "loAZND", "PT-AUSD-8OCT2026", "PT-earnAUSD-8OCT2026", "PT-AUSD-17DEC2026", "PT-USDat-14JAN2027", "aprMON"]) {
        assert.ok(chain_config["monad-mainnet"].excluded_zap_symbols.includes(symbol));
    }
    assert.deepEqual(
        chain_config["monad-mainnet"].excluded_zap_addresses,
        [
            monad.Optimizers["High Yield AUSD"],
            "0x2ABc42250154752273a4560e875c858623F83ecC",
            "0x336D414754967C6682B5A665C7DAF6F1409E63e8",
            "0x9c82eB49B51F7Dc61e22Ff347931CA32aDc6cd90",
            "0x9FC74f8Ed616B5BaF52a170caa97d6d3898602d1",
            "0xDaf216939826AcABA0C2312F7E30A890213845CD",
            "0x8B562578b2f9Aa8C14cCda3c5d6CBCEaD3B06a57",
            "0xa08a69ab9dd3b04d0992bc7afb2c0b907bbdc147",
            "0x0c65A0BC65a5D819235B71F554D210D3F80E0852",
        ],
    );
    assert.equal(monad["CombinedAggregator-ezETH"], "0xC54481C5425f091DfBE7A8e2B264D7dCf4783cD4");
    assert.equal(monad["CombinedAggregator-earnAUSD"], "0x4a048D2dFd6cd75A7e239393a14CE913d756f992");
    assert.equal(monad["CombinedAggregator-savUSD"], "0x7CB9a321c30c753c3F7C6af7Ae8776E5C1524999");
    assert.equal(monad["StaticPriceAggregator-loAZND"], "0x6eCb16faf9b0c0F7098204e0FE685D2960b4C0Ba");
    assert.equal(monad["StaticPriceAggregator-sAUSD"], "0x57B546362e562DfccAE46AB69b953cE07F4ffd8a");
    assert.equal(monad["VaultAggregator-USDC-YZM"], "0xae3E9D51f1384a86C44fa7958b61F92be23cb284");
    assert.equal(monad["VaultAggregator-AUSD-vUSD"], "0xDa13c308E5bd054C5cfF7bC3Fa67cB7f8b2dFe3c");
    assert.equal(monad["VaultAggregator-AUSD-sAUSD"], undefined);
    assert.equal(monad.oracleMigration, undefined);
    assert.equal(monad.adaptors.RedstoneCoreAdaptor, undefined);
});

test("README public examples stay multichain-safe", () => {
    const readme = readRepoFile("README.md");
    const merklSectionStart = readme.indexOf("### Merkl rewards");
    const merklSectionEnd = readme.indexOf("### Portfolio snapshots");
    assert.notEqual(merklSectionStart, -1, "README Merkl section must exist");
    assert.notEqual(merklSectionEnd, -1, "README snapshot section must exist");
    const merklSection = readme.slice(merklSectionStart, merklSectionEnd);

    assert.match(readme, /chain:\s*ChainRpcPrefix/);
    assert.match(readme, /chainId:\s*number/);
    assert.match(readme, /setupConfigSnapshot:\s*Readonly<SetupConfigSnapshot>/);
    assert.match(readme, /chain\?:\s*"monad-mainnet"\s*\|\s*"arb-sepolia"\s*\|\s*"any"/);
    assert.match(readme, /checkerCompatibility\?:\s*\{/);
    assert.doesNotMatch(readme, /bps:\s*10n/);
    const feePolicyExampleStart = readme.indexOf("const feePolicy = flatFeePolicy({");
    const feePolicyExampleEnd = readme.indexOf("const { markets }", feePolicyExampleStart);
    assert.notEqual(feePolicyExampleStart, -1, "README checker-compatible fee policy example must exist");
    assert.notEqual(feePolicyExampleEnd, -1, "README checker-compatible fee policy example must be bounded");
    const feePolicyExample = readme.slice(feePolicyExampleStart, feePolicyExampleEnd);
    assert.doesNotMatch(feePolicyExample, /stableToStableBps/);
    assert.match(merklSection, /fetchMerklOpportunities\(\{\s*chainId:\s*143\s*\}\)/);
    assert.match(merklSection, /fetchMerklUserRewards\(\{\s*wallet:\s*address,\s*chainId:\s*143\s*\}\)/);
    assert.match(merklSection, /fetchMerklCampaignsBySymbol\(\{\s*tokenSymbol:\s*"USDC",\s*chainId:\s*143\s*\}\)/);
    assert.doesNotMatch(readme, /fetchMerklUserRewards\(\{[^}]*chainId:\s*undefined/s);
});

test("default fee receiver is setup-resolved instead of hardcoded in production source", () => {
    const feePolicySource = readRepoFile("src/feePolicy.ts");
    const setupSource = readRepoFile("src/setup.ts");
    const kyberSource = readRepoFile("src/classes/DexAggregators/KyberSwap.ts");

    assert.doesNotMatch(feePolicySource, /CURVANCE_DAO_FEE_RECEIVER/);
    assert.doesNotMatch(feePolicySource, /0x0Acb7eF4D8733C719d60e0992B489b629bc55C02/i);
    assert.match(setupSource, /await reader\.getDaoAddress\(\)/);
    assert.match(
        setupSource,
        /const setupDaoAddress = options\.feePolicy == null \|\| requiresCheckerPolicy[\s\S]*\? await reader\.getDaoAddress\(\)[\s\S]*: null;/,
    );
    assert.match(setupSource, /validateCheckerFeePolicy\(nextSetupConfig,\s*setupDaoAddress\);/);
    assert.match(kyberSource, /new KyberSwap\(context\.checkerDao \?\? this\.dao,/);
});

test("runtime source keeps deployment addresses in chain config and manifests", () => {
    const runtimeFiles = [
        ...listFiles("src/classes").filter((file) => file.endsWith(".ts")),
        ...listFiles("src/integrations").filter((file) => file.endsWith(".ts")),
        ...listFiles("src/format").filter((file) => file.endsWith(".ts")),
        "src/setup.ts",
        "src/feePolicy.ts",
        "src/helpers.ts",
        "src/validation.ts",
    ];
    const allowedLiterals = new Map<string, Set<string>>([
        [
            "src/helpers.ts",
            new Set([
                "0x0000000000000000000000000000000000000000",
                "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
            ]),
        ],
        [
            "src/setup.ts",
            new Set([
                "0x0000000000000000000000000000000000000001",
                "0x0000000000000000000000000000000000000002",
            ]),
        ],
    ]);
    const unexpected: string[] = [];

    for (const file of runtimeFiles) {
        const source = readRepoFile(file);
        const allowedForFile = allowedLiterals.get(file) ?? new Set<string>();
        for (const match of source.matchAll(/0x[a-fA-F0-9]{40}/g)) {
            const literal = match[0];
            if (!allowedForFile.has(literal)) {
                unexpected.push(`${file}:${literal}`);
            }
        }
    }

    assert.deepEqual(
        unexpected,
        [],
        "runtime source should resolve chain-specific addresses from config/manifests instead of inline literals",
    );
});

test("Kyber current-router calldata validation fails closed in source", () => {
    const source = readRepoFile("src/classes/DexAggregators/KyberSwap.ts");
    const validator = extractBlock(source, "function validateSwapCalldata");

    assert.match(source, /this\.apiBase = validateApiUrl\(api\)\.replace\(\/\\\/\+\$\/,\s*""\);/);
    assert.match(source, /this\.api = `\$\{this\.apiBase\}\/\$\{this\.chain\}`;/);
    assert.match(source, /if \(amount <= 0n\) \{[\s\S]*KyberSwap quote amount must be positive/);
    assert.match(source, /const validatedWallet = validateAddress\(wallet, 'KyberSwap wallet'\);/);
    assert.match(source, /const validatedTokenIn = validateAddress\(tokenIn, 'KyberSwap tokenIn'\);/);
    assert.match(source, /const validatedTokenOut = validateAddress\(tokenOut, 'KyberSwap tokenOut'\);/);
    assert.match(source, /const validatedFeeReceiver = feeReceiver == undefined[\s\S]*?validateAddress\(feeReceiver, 'KyberSwap feeReceiver'\);/);
    assert.match(
        source,
        /validateSwapCalldata\((?:build_data|buildData)\.data\.data,\s*\{[\s\S]*tokenIn: validatedTokenIn,[\s\S]*tokenOut: validatedTokenOut,[\s\S]*amount,[\s\S]*recipient: validatedWallet,[\s\S]*minReturnAmount: min_out,[\s\S]*feeBps: feeBps \?\? 0n,[\s\S]*feeReceiver: validatedFeeReceiver,[\s\S]*\}\);/,
    );
    assert.doesNotMatch(source, /console\.warn/);
    assert.match(validator, /validateEqualAddress\(desc\.srcToken,\s*expected\.tokenIn,\s*'srcToken'\);/);
    assert.match(validator, /validateEqualAddress\(desc\.dstToken,\s*expected\.tokenOut,\s*'dstToken'\);/);
    assert.match(validator, /validateRecipientAddress\(desc\.dstReceiver,\s*expected\.recipient\);/);
    assert.match(validator, /BigInt\(desc\.amount\) !== expected\.amount/);
    assert.match(validator, /BigInt\(desc\.minReturnAmount\) < expected\.minReturnAmount/);
    assert.match(validator, /execution\.approveTarget/);
    assert.match(validator, /execution\.targetData/);
    assert.match(validator, /desc\.permit/);
    assert.match(validator, /desc\.srcReceivers/);
    assert.match(validator, /throw new Error\(`KyberSwap calldata could not be decoded for fee validation:/);
});

test("deposit approval source keeps zap delegation branch-specific", () => {
    const source = readRepoFile("src/classes/CToken.ts");
    const body = extractBlock(source, "private async _checkDepositApprovals");
    const beforeCollateralizeBranch = body.slice(0, body.indexOf("if (collateralize)"));

    assert.match(body, /if\(zapType != 'none'\)/);
    assert.match(body, /if \(collateralize\)/);
    assert.match(body, /await this\._checkZapperApproval\(zapper\);/);
    assert.match(
        body,
        /await this\._checkDelegateApproval\(receiverAddress,\s*signer\.address as address,\s*"the connected signer"\);/,
    );
    assert.match(
        body,
        /await this\._checkDelegateApproval\(receiverAddress,\s*zapper\.address,\s*`\$\{zapper\.type\} Zapper`\);/,
    );
    assert.match(
        body,
        /else if \(collateralize && receiver && receiver\.toLowerCase\(\) !== signer\.address\.toLowerCase\(\)\)/,
    );
    assert.doesNotMatch(beforeCollateralizeBranch, /_checkZapperApproval|_checkDelegateApproval/);
});

test("CToken DEX execution paths stay behind the market-bound adapter getter", () => {
    const source = readRepoFile("src/classes/CToken.ts");
    const zapperSource = readRepoFile("src/classes/Zapper.ts");
    const zapPolicySource = readRepoFile("src/zapPolicy.ts");
    const nativeTokenSource = readRepoFile("src/classes/NativeToken.ts");
    const directStaticDexReads = [...source.matchAll(/currentChainConfig\.dexAgg/g)].map((match) => match.index);

    assert.equal(
        directStaticDexReads.length,
        0,
        "CToken should not fall back to mutable chain_config.dexAgg for route discovery or execution",
    );
    assert.match(source, /private get boundDexAgg\(\): IDexAgg \| null \{ return this\.market\.dexAgg \?\? null; \}/);
    assert.match(source, /DEX aggregator is not bound for token/);
    assert.match(source, /private get currentChainAssets\(\) \{ return this\.setup\.assets; \}/);
    assert.match(source, /isZapTokenExcluded\(this\.currentChainAssets, this\.asset\)/);
    assert.match(zapPolicySource, /excluded_zap_symbols/);
    assert.match(zapPolicySource, /excluded_zap_addresses/);
    assert.doesNotMatch(source, /EXCLUDED_ZAP_SYMBOLS/);
    assert.match(source, /const chainSettings = this\.currentChainAssets;/);
    assert.match(source, /\? this\.currentChainAssets\.wrapped_native/);
    assert.doesNotMatch(
        source,
        /currentChainConfig\.(wrapped_native|native_vaults|vaults)/,
        "CToken route and vault/native asset logic should use the setup snapshot, not mutable exported chain config",
    );
    assert.match(source, /const supportsNativeVaultZaps =[\s\S]{0,160}?nativeVaultZapper\.toLowerCase\(\) !== EMPTY_ADDRESS\.toLowerCase\(\);/);
    assert.match(source, /const supportsVaultZaps =[\s\S]{0,160}?vaultZapper\.toLowerCase\(\) !== EMPTY_ADDRESS\.toLowerCase\(\);/);
    assert.match(source, /const router = this\.boundDexAgg\?\.router;/);
    assert.match(source, /typeof router === "string" && router\.toLowerCase\(\) !== EMPTY_ADDRESS\.toLowerCase\(\)/);
    assert.match(source, /const supportsSimpleZaps =[\s\S]{0,240}?this\.hasExecutableDexRoute;/);
    assert.match(source, /if\(supportsNativeVaultZaps && this\.isNativeVault\) this\.zapTypes\.push\('native-vault'\);/);
    assert.match(source, /if\(supportsVaultZaps && this\.isVault\) this\.zapTypes\.push\('vault'\);/);
    assert.match(source, /if\(supportsSimpleZaps\) this\.zapTypes\.push\('simple'\);/);
    assert.match(source, /if\(supportsSimpleZaps && "simplePositionManager" in this\.market\.plugins\) this\.leverageTypes\.push\('simple'\);/);
    assert.match(source, /if\(this\.zapTypes\.includes\('simple'\) && this\.hasExecutableDexRoute\)/);
    const nativeTokenConstructorArgs = [...source.matchAll(/new NativeToken\(([\s\S]*?)\)/g)]
        .map((match) => match[1] ?? "");
    assert.ok(nativeTokenConstructorArgs.length > 0, "CToken should construct native token helpers");
    for (const args of nativeTokenConstructorArgs) {
        assert.match(
            args,
            /this\.currentChainAssets/,
            "Every CToken-created NativeToken should use setup snapshot metadata",
        );
    }
    assert.match(nativeTokenSource, /nativeMetadata\?: NativeTokenMetadata/);
    assert.match(nativeTokenSource, /const metadata = nativeMetadata \?\? chain_config\[chain\]/);
    assert.doesNotMatch(
        source,
        /(?:const|let|var)\s+\w+\s*=\s*this\.currentChainConfig[\s\S]{0,400}?\w+\.dexAgg\.quoteAction/,
    );
    assert.match(
        source,
        /new Zapper\(zap_contract,\s*signer,\s*type,\s*this\.setup,\s*this\.currentDexAgg\)/,
    );
    assert.doesNotMatch(
        zapperSource,
        /getChainConfig/,
        "Zapper should not fall back to mutable chain config for DEX routing",
    );
    assert.match(zapperSource, /constructor\(address: address, signer: curvance_signer, type: ZapperTypes, setup: SetupConfigSnapshot, dexAgg: IDexAgg\)/);
    assert.match(zapperSource, /requires a setup-bound DEX aggregator/);
    assert.doesNotMatch(zapperSource, /config\.dexAgg\.quote/);
    assert.match(zapperSource, /this\.dexAgg\.quote/);
    assert.match(zapperSource, /const wrappedNative = this\.setup\.assets\.wrapped_native;/);
    assert.match(zapperSource, /outputToken\.toLowerCase\(\) === wrappedNative\.toLowerCase\(\)/);
    assert.doesNotMatch(
        zapperSource,
        /config\.wrapped_native/,
        "Zapper native/wrapped calldata should use the setup snapshot, not mutable exported chain config",
    );
});

test("setupChain result types expose typed global milestone data", () => {
    const source = readRepoFile("src/setup.ts");
    const classesIndex = readRepoFile("src/classes/index.ts");

    assert.match(source, /import type \{ MilestoneResponse \} from "\.\/classes\/Api";/);
    assert.match(source, /global_milestone: MilestoneResponse \| null;/);
    assert.match(classesIndex, /export \* from '\.\/Api';/);
});

test("portfolio snapshots read market provenance from setup snapshots", () => {
    const source = readRepoFile("src/integrations/snapshot.ts");

    assert.match(source, /const chainId = market\.setup\.chainId;/);
    assert.doesNotMatch(
        source,
        /chain_config/,
        "Snapshot chain ids should come from each market setup snapshot, not exported chain config",
    );
});

// Guard behavior + strictness (foreign-by-address rejected before RPC, no chain-null
// loophole) is covered functionally in market-boot.test.ts. This structural check pins
// only the exhaustive wiring — that EVERY preview entry point calls the guard — which a
// representative functional test cannot enforce when a new preview method is added.
test("every market preview path is wired to the foreign-token ownership guard", () => {
    const source = readRepoFile("src/classes/Market.ts");
    const guardedMethods = [
        "async previewAssetImpact",
        "async previewPositionHealthLeverageDown",
        "async previewPositionHealthLeverageUp",
        "async previewPositionHealthDepositAndLeverage",
        "async previewPositionHealth(",
        "async previewPositionHealthRedeem",
        "async previewPositionHealthBorrow",
        "async previewPositionHealthRepay",
    ];
    for (const method of guardedMethods) {
        const body = extractBlock(source, method);
        assert.match(body, /this\.assertTokenBelongsToMarket\(/, `${method} must validate token ownership`);
    }
});

// Borrow-token guard behavior + strictness is covered functionally in market-boot.test.ts
// (CToken.previewLeverageDown rejects a foreign-market borrow token before any work). This
// structural check pins the exhaustive wiring + preflight ordering — every leverage helper
// calls the guard, and public leverage methods guard BEFORE execution work — which
// representative functional tests cannot enforce across all call sites.
test("every CToken leverage path is wired to the borrow-token ownership guard before execution", () => {
    const source = readRepoFile("src/classes/CToken.ts");
    const guardedHelpers = [
        "private async _getLeverageSnapshot",
        "private assertSimpleLeverageSwapAssetsDiffer",
        "private async assertLeverageBorrowCapacity",
        "private assertSelectedBorrowDebtCanDeleverage",
        "previewLeverageDown(",
    ];

    assert.match(source, /private assertBorrowTokenBelongsToMarket/);
    assert.match(
        source,
        /private resolveLeverageUpPreview\(\{[\s\S]*?\}: ResolveLeverageUpPreviewParams\): LeverageUpPreview \{\s*this\.assertBorrowTokenBelongsToMarket\(borrow\);/,
        "resolveLeverageUpPreview must validate borrow token ownership",
    );
    for (const method of guardedHelpers) {
        const body = extractBlock(source, method);
        assert.match(body, /this\.assertBorrowTokenBelongsToMarket\(/, `${method} must validate borrow token ownership`);
    }

    for (const method of ["async leverageUp", "async leverageDown", "async depositAndLeverage"]) {
        const body = extractBlock(source, method);
        const firstSignerOrApproval = body.search(/this\.requireSigner\(|ensureUnderlyingAmount|_checkTokenApproval|_getLeverageSnapshot|quoteAction/);
        assert.notEqual(firstSignerOrApproval, -1, `${method} should have an execution boundary`);
        const preflight = body.slice(0, firstSignerOrApproval);
        assert.match(preflight, /this\.assertBorrowTokenBelongsToMarket\(/, `${method} must guard before execution work`);
    }
});

test("Market cooldown batching accepts only same reader instance or deployment key", () => {
    const source = readRepoFile("src/classes/Market.ts");
    const body = extractBlock(source, "async multiHoldExpiresAt");

    assert.match(body, /market\.reader === this\.reader/);
    assert.match(body, /marketReaderKey != null && marketReaderKey === readerKey/);
    assert.match(body, /Cannot batch cooldowns across chains/);
    assert.match(body, /Cannot batch cooldowns across different ProtocolReader deployments/);
    assert.doesNotMatch(
        body,
        /reader\.address\.toLowerCase\(\)/,
        "cooldown batching must not treat same raw ProtocolReader addresses as equivalent without a deployment key",
    );
});

// Guard behavior + strictness (foreign setup snapshot rejected before calldata) is covered
// functionally in zapper-calldata.test.ts. This structural check pins only the exhaustive
// wiring — every direct Zapper helper calls the setup-provenance guard — which a
// representative functional test can't enforce when a new helper is added.
test("every Zapper direct helper is wired to the CToken setup-provenance guard", () => {
    const source = readRepoFile("src/classes/Zapper.ts");
    const guardedMethods = [
        "async nativeZap",
        "async simpleZap",
        "async getSimpleZapCalldata",
        "async getVaultZapCalldata",
        "async getZapVaultData",
        "async getNativeZapCalldata",
    ];
    for (const method of guardedMethods) {
        const body = extractBlock(source, method);
        assert.match(body, /this\.assertCTokenBelongsToSetup\(ctoken\);/, `${method} must validate CToken setup provenance`);
    }
});

test("dist smoke keeps extracted package available for lazy internal requires", () => {
    const source = readRepoFile("tests/dist-smoke.cjs");
    const withPackedPackage = extractBlock(source, "function withPackedPackage");

    assert.match(withPackedPackage, /process\.once\("exit"/);
    assert.match(withPackedPackage, /return run\(/);
    assert.doesNotMatch(
        withPackedPackage,
        /finally\s*\{\s*rmSync\(packDir/,
        "dist smoke must not delete the extracted package before lazy requires in packed modules execute",
    );
});
