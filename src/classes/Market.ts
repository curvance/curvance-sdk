import { aggregateMerklAprByToken, BPS, ChangeRate, contractSetup, EMPTY_ADDRESS, getRateSeconds, requireAccount, toBigInt, toDecimal, UINT256_MAX, WAD, WAD_DECIMAL } from "../helpers";
import { Contract } from "ethers";
import {
    DynamicMarketData,
    DynamicMarketToken,
    ProtocolReader,
    StaticMarketData,
    StaticMarketToken,
    UserMarket,
    UserMarketSummary,
    UserMarketToken,
} from "./ProtocolReader";
import { AccountSnapshot, CToken } from "./CToken";
import abi from '../abis/MarketManagerIsolated.json';
import { Decimal } from "decimal.js";
import { address, curvance_read_provider, curvance_signer, Percentage, TokenInput, USD } from "../types";
import { OracleManager } from "./OracleManager";
import type { SetupConfigSnapshot } from "../setup";
import { fetchMerklOpportunities, MerklOpportunity } from "../integrations/merkl";
import { BorrowableCToken } from "./BorrowableCToken";
import FormatConverter from "./FormatConverter";
import { Api, IncentiveResponse, Incentives, MilestoneResponse, Milestones } from "./Api";
import type { PositionManagerTypes } from "./PositionManager";
import { validateAddress } from "../validation";
import type IDexAgg from "./DexAggregators/IDexAgg";

export type MarketToken = CToken | BorrowableCToken;
export type PluginTypes = 'zapper' | 'positionManager';

export interface Plugins {
    simplePositionManager?: address;
    vaultPositionManager?: address;
    nativeVaultPositionManager?: address;
}

export interface Zappers {
    simpleZapper?: address;
    vaultZapper?: address;
    nativeVaultZapper?: address;
}

export interface StatusOf {
    collateral: bigint;
    maxDebt: bigint;
    debt: bigint;
}

export interface DeployData {
    name: string,
    plugins: { [key: string]: address }
}

export interface HypotheticalLiquidityOf {
    collateral: bigint;
    maxDebt: bigint;
    debt: bigint;
    collateralSurplus: bigint;
    liquidityDeficit: bigint;
    loanSizeError: boolean;
    oracleError: boolean;
}

export type UserDataScope = "full" | "summary";

export interface IMarket {
    accountAssets(account: address): Promise<bigint>;
    MIN_HOLD_PERIOD(): Promise<bigint>;
    statusOf(account: address): Promise<StatusOf>;
    redeemPaused(): Promise<bigint>;
    actionsPaused(cToken: address): Promise<[
        mintPaused: boolean,
        collateralizationPaused: boolean,
        borrowPaused: boolean,
    ]>;
    collateralCaps(cToken: address): Promise<bigint>;
}

type NativeYield = Awaited<ReturnType<typeof Api.fetchNativeYields>>[number];

function resolveDefaultSetupConfig(context: string): SetupConfigSnapshot {
    const config = (require("../setup") as typeof import("../setup")).setup_config;
    if (config == undefined) {
        throw new Error(
            `Setup config is not configured for ${context}. ` +
            `Pass setup/provider context explicitly or initialize setupChain() first.`
        );
    }

    return config;
}

export class Market {
    provider: curvance_read_provider;
    signer: curvance_signer | null;
    account: address | null;
    address: address;
    contract: Contract & IMarket;
    tokens: (CToken | BorrowableCToken)[] = [];
    oracle_manager: OracleManager;
    reader: ProtocolReader;
    setup: SetupConfigSnapshot;
    dexAgg?: IDexAgg;
    cache: { static: StaticMarketData, dynamic: DynamicMarketData, user: UserMarket, deploy: DeployData };
    milestone: MilestoneResponse | null = null;
    incentives: Array<IncentiveResponse> = [];
    private _userDataScope?: UserDataScope;

    constructor(
        provider: curvance_read_provider,
        signer: curvance_signer | null,
        account: address | null,
        static_data: StaticMarketData,
        dynamic_data: DynamicMarketData,
        user_data: UserMarket,
        deploy_data: DeployData,
        oracle_manager: OracleManager,
        reader: ProtocolReader,
        setup: SetupConfigSnapshot
    ) {
        this.provider = provider;
        this.signer = signer;
        this.account = account;
        this.address = static_data.address;
        this.oracle_manager = oracle_manager;
        this.reader = reader;
        this.setup = setup;
        this.contract = contractSetup<IMarket>(provider, this.address, abi);
        this.cache = { static: static_data, dynamic: dynamic_data, user: user_data, deploy: deploy_data };
        this._userDataScope = "full";

        for(const tokenData of Market.mergeTokenPayloads(static_data, dynamic_data, user_data)) {
            // @NOTE: Merged fields from the 3 types, so you wanna make sure there is no collisions
            // Otherwise we will have some dataloss
            if(tokenData.isBorrowable) {
                const ctoken = new BorrowableCToken(provider, tokenData.address, tokenData, this);
                this.tokens.push(ctoken);
            } else {
                const ctoken = new CToken(provider, tokenData.address, tokenData, this);
                this.tokens.push(ctoken);
            }
        }
    }

    private getAccountOrThrow(): address {
        return requireAccount(this.account, this.signer);
    }

    private assertTokenBelongsToMarket(token: CToken | null | undefined, label: string) {
        if (token == null) {
            return;
        }

        const tokenMarket = (token as CToken & { market?: Market }).market;
        if (tokenMarket == undefined) {
            return;
        }

        if (tokenMarket === this) {
            return;
        }

        const tokenChain = tokenMarket.setup?.chain;
        const marketChain = this.setup?.chain;
        const sameMarket = tokenMarket.address?.toLowerCase() === this.address.toLowerCase();
        const sameChain = tokenChain != null && marketChain != null && tokenChain === marketChain;
        const tokenReaderKey = tokenMarket.reader?.batchKey ?? null;
        const readerKey = this.reader?.batchKey ?? null;
        const sameReaderDeployment =
            tokenMarket.reader === this.reader ||
            (tokenReaderKey != null && tokenReaderKey === readerKey);

        if (!sameMarket || !sameChain || !sameReaderDeployment) {
            throw new Error(
                `${label} token ${token.address} belongs to market ${tokenMarket.address} ` +
                `on ${tokenChain ?? "unknown"}, not market ${this.address} on ${marketChain ?? "unknown"} ` +
                `with the same reader deployment.`
            );
        }
    }

    assertRefreshAccountCompatible(account: address, allowSignerMismatch = false) {
        if (allowSignerMismatch) {
            return;
        }

        const signerAddress = this.signer?.address as address | undefined;
        if (signerAddress == null || signerAddress.toLowerCase() === account.toLowerCase()) {
            return;
        }

        throw new Error(
            `Cannot refresh signer-backed market ${this.address} for ${account}; ` +
            `the active signer is ${signerAddress}.`,
        );
    }

    bindRefreshedAccount(account: address, allowSignerMismatch = false) {
        this.assertRefreshAccountCompatible(account, allowSignerMismatch);
        this.account = account;
    }

    private requireFullUserTokenData(accessLabel: string) {
        if (this.userDataScope !== "summary") {
            return;
        }

        throw new Error(
            `Market-level token-derived user data is stale for ${this.address} after a summary-only refresh. ` +
            `Call market.reloadUserData(account) or Market.reloadUserMarkets(...) before ${accessLabel}.`
        );
    }

    private requireValidCachedUserHealth(accessLabel: string) {
        if (this.cache.user.errorCodeHit || this.cache.user.priceStale) {
            throw new Error(
                `Cached market user data for ${this.address} is not reliable for ${accessLabel} because ` +
                `the reader reported an oracle error or stale price.`
            );
        }
    }

    private cooldownDateFromUnlockTime(unlockTime: bigint, cooldownLength: bigint = this.cooldownLength): Date | null {
        if (unlockTime === cooldownLength) {
            return null;
        }

        const now = BigInt(Math.floor(Date.now() / 1000));
        if (unlockTime <= now) {
            return null;
        }

        return new Date(Number(unlockTime * 1000n));
    }

    /** @returns {string} - The name of the market at deployment. */
    get name() { return this.cache.deploy.name; }
    /** @returns {Plugins} - The address of the market's plugins by deploy name. */
    get plugins():Plugins { return this.cache.deploy.plugins ?? {}; }
    /** @returns {bigint} - The length of the cooldown period in seconds. */
    get cooldownLength() { return this.cache.static.cooldownLength; }
    /** @returns {bigint[]} - A list of oracle identifiers which can be mapped to AdaptorTypes enum */
    get adapters() { return this.cache.static.adapters; }
    /** @returns {Date | null} - Market cooldown, activated by Collateralization or Borrowing. Lasts as long as {this.cooldownLength} which is currently 20mins */
    get cooldown() { return this.cooldownDateFromUnlockTime(this.cache.user.cooldown); }
    /** @returns The scope of the latest whole-market user refresh. */
    get userDataScope(): UserDataScope { return this._userDataScope ?? "full"; }
    /** @returns {Decimal} - The user's collateral in Shares. */
    get userCollateral() {
        this.requireValidCachedUserHealth("reading userCollateral");
        return toDecimal(this.cache.user.collateral, 18n);
    }
    /** @returns {USD} - The user's debt in USD. */
    get userDebt() {
        this.requireValidCachedUserHealth("reading userDebt");
        return toDecimal(this.cache.user.debt, 18n);
    }
    /** @returns {USD} - The user's maximum debt in USD. */
    get userMaxDebt() {
        this.requireValidCachedUserHealth("reading userMaxDebt");
        return toDecimal(this.cache.user.maxDebt, 18n);
    }
    /** @returns {USD} - The user's remaining credit with a .1% buffer in USD */
    get userRemainingCredit(): USD {
        this.requireValidCachedUserHealth("reading userRemainingCredit");
        const remaining = this.cache.user.maxDebt - this.cache.user.debt;
        return toDecimal(remaining, 18n).mul(.999);
    }

    /**
     * Get the user's position health.
     * @returns {Percentage | null} - The user's position health Percentage or null if infinity
     */
    get positionHealth() {
        this.requireValidCachedUserHealth("reading positionHealth");
        if (this.cache.user.positionHealth == UINT256_MAX) {
            return null;
        }

        return this.formatPositionHealth(this.cache.user.positionHealth);
    }

    /**
     * Get the total user deposits in USD.
     * @returns {USD} - The total user deposits in USD.
     */
    get userDeposits() {
        this.requireFullUserTokenData("reading userDeposits");
        let total_deposits = Decimal(0);
        for(const token of this.tokens) {
            total_deposits = total_deposits.add(token.getUserAssetBalance(true));
        }

        return total_deposits;
    }

    /**
     * Get the user's net position in USD.
     * @returns {USD} - The user's net position in USD.
     */
    get userNet() {
        this.requireFullUserTokenData("reading userNet");
        return this.userDeposits.sub(this.userDebt);
    }

    /** @returns Market LTV */
    get ltv() {
        if (this.tokens.length === 0) {
            return { min: new Decimal(0), max: new Decimal(0) };
        }

        let min = this.tokens[0]!.ltv();
        let max = min;

        for (const token of this.tokens) {
            const ltv = new Decimal(token.ltv());
            if (ltv.lessThan(min)) {
                min = ltv;
            }
            if (ltv.greaterThan(max)) {
                max = ltv;
            }
        }

        if(min == max) {
            return `${min.mul(100)}%`;
        }

        return `${min.mul(100)}% - ${max.mul(100)}%`;
    }

    /** @returns Total market deposits in USD, summed across the market's tokens.
     *  Renamed from `tvl` to match the sibling getter naming
     *  (`totalDebt`, `totalCollateral`). Backed by the per-token
     *  `getDeposits` (which now values via `totalAssets`, not `totalSupply`,
     *  so the liquidity ≤ deposits invariant holds). */
    get totalDeposits() {
        let total = new Decimal(0);
        for(const token of this.tokens) {
            total = total.add(token.getDeposits(true));
        }
        return total;
    }

    /** @returns Total market debt */
    get totalDebt() {
        let marketDebt = new Decimal(0);
        for(const token of this.tokens) {
            if(token.isBorrowable) {
                marketDebt = marketDebt.add(token.getDebt(true));
            }
        }
        return marketDebt;
    }

    /** @returns Total market collateral */
    get totalCollateral() {
        let marketCollateral = new Decimal(0);
        for(const token of this.tokens) {
            marketCollateral = marketCollateral.add(token.getTotalCollateral(true));
        }
        return marketCollateral;
    }

    /**
     * Returns what tokens eligible and ineligible to borrow from
     * @returns What tokens can and cannot be borrowed from
     */
    getBorrowableCTokens() {
        this.requireFullUserTokenData("reading borrowable token eligibility");
        const result: {
            eligible: BorrowableCToken[],
            ineligible: BorrowableCToken[]
        } = {
            eligible: [],
            ineligible: []
        };

        const users_market_collateral = this.userCollateral;

        for(const token of this.tokens) {
            if(token.isBorrowable && token.getDebtCap(true).greaterThan(0)) {
                if(token.getUserCollateral(false).greaterThan(0) || users_market_collateral.lessThanOrEqualTo(0)) {
                    result.ineligible.push(token as BorrowableCToken);
                } else {
                    result.eligible.push(token as BorrowableCToken);
                }
            }
        }

        return result;
    }

    /**
     * Get the total user deposits change based on the provided rate.
     * @param rate - What rate to calculate the change for (ex: 'day')
     * @returns The total user deposits change (ex: 50, which would be $50/day)
     */
    getUserDepositsChange(rate: ChangeRate) {
        this.requireFullUserTokenData(`reading user deposit change for rate ${rate}`);
        let total_change = Decimal(0);
        for(const token of this.tokens) {
            const amount = token.getUserAssetBalance(true);
            total_change = total_change.add(token.earnChange(amount, rate));
        }

        return total_change;
    }


    /**
     * Get the total user debt change based on the provided rate.
     * @param rate - What rate to calculate the change for (ex: 'day')
     * @returns The total user debt change (ex: 50, which would be $50/day)
     */
    getUserDebtChange(rate: ChangeRate) {
        this.requireFullUserTokenData(`reading user debt change for rate ${rate}`);
        let total_change = Decimal(0);
        for(const token of this.tokens) {
            if(!token.isBorrowable) {
                continue;
            }

            const amount = token.getUserDebt(true);
            total_change = total_change.add((token as BorrowableCToken).borrowChange(amount, rate));
        }

        return total_change;
    }

    /**
     * Get the total user net change based on the provided rate.
     * @param rate - What rate to calculate the change for (ex: 'day')
     * @returns The total user net change (ex: 50, which would be $50/day)
     */
    getUserNetChange(rate: ChangeRate) {
        this.requireFullUserTokenData(`reading user net change for rate ${rate}`);
        const earn = this.getUserDepositsChange(rate);
        const debt = this.getUserDebtChange(rate);
        return earn.sub(debt);
    }

    /**
     * Searchs through all tokens and finds highest APY
     * @returns The highest APY among all tokens
     */
    highestApy(): Percentage {
        let maxApy = new Decimal(0);
        for(const token of this.tokens) {
            const tokenApy = token.getApy();
            if(tokenApy.greaterThan(maxApy)) {
                maxApy = tokenApy;
            }
        }
        return maxApy;
    }

    /**
     * Does this market have the ability to borrow
     * @returns True if borrowing is allowed, false otherwise
     */
    hasBorrowing() {
        let canBorrow = false;
        for(const token of this.tokens) {
            if(token.isBorrowable) {
                canBorrow = true;
                break;
            }
        }
        return canBorrow;
    }

    /**
     * Gets the market status of
     * @param account - Wallet address
     * @returns collateral, max debt, debt for the market
     */
    async getSnapshots(account: address): Promise<AccountSnapshot[]> {
        // Each ctoken.getSnapshot is an independent view call — dispatch in
        // parallel so N tokens is one round-trip latency, not N.
        return Promise.all(this.tokens.map((token) => token.getSnapshot(account)));
    }

    hasUserActivity() {
        this.requireFullUserTokenData("determining user activity");
        return this.tokens.some((token) =>
            token.cache.userAssetBalance > 0n ||
            token.cache.userShareBalance > 0n ||
            token.cache.userCollateral > 0n ||
            token.cache.userDebt > 0n
        );
    }

    private requireRefreshTokenRows<T extends { address: address }>(rows: T[], label: string): Map<string, T> {
        if (rows.length !== this.tokens.length) {
            throw new Error(
                `Token row count mismatch for market ${this.address} during refresh: ` +
                `expected=${this.tokens.length} ${label}=${rows.length}.`
            );
        }

        const rowsByAddress = new Map<string, T>();
        for (const row of rows) {
            const key = row.address.toLowerCase();
            if (rowsByAddress.has(key)) {
                throw new Error(
                    `Duplicate ${label} token data for ${row.address} in market ${this.address} during refresh.`
                );
            }
            rowsByAddress.set(key, row);
        }

        for (const token of this.tokens) {
            if (!rowsByAddress.has(token.address.toLowerCase())) {
                throw new Error(`Missing ${label} token data for ${token.address} in market ${this.address} during refresh.`);
            }
        }

        return rowsByAddress;
    }

    private requireRefreshMarketAddress(row: { address: address }, label: string) {
        if (row.address.toLowerCase() !== this.address.toLowerCase()) {
            throw new Error(
                `Mismatched ${label} market data during refresh: expected=${this.address} received=${row.address}.`
            );
        }
    }

    private validateStateRows(dynamicData: DynamicMarketData, userData?: UserMarket) {
        this.requireRefreshMarketAddress(dynamicData, "dynamic");
        if (userData != undefined) {
            this.requireRefreshMarketAddress(userData, "user");
        }

        this.requireRefreshTokenRows(dynamicData.tokens, "dynamic");
        if (userData != undefined) {
            this.requireRefreshTokenRows(userData.tokens, "user");
        }
    }

    validateRefreshState(dynamicData: DynamicMarketData, userData?: UserMarket) {
        this.validateStateRows(dynamicData, userData);
    }

    private static requireMarketRow<T extends { address: address }>(
        rows: T[],
        market: Market,
        label: string,
    ): T {
        const row = this.buildRefreshMarketRowIndex(rows, label).get(market.address.toLowerCase());
        if (row == undefined) {
            throw new Error(`Could not reload ${label} data for market ${market.address}.`);
        }
        return row;
    }

    private static buildRefreshMarketRowIndex<T extends { address: address }>(
        rows: T[],
        label: string,
    ): Map<string, T> {
        const index = new Map<string, T>();

        for (const row of rows) {
            const key = row.address.toLowerCase();
            if (index.has(key)) {
                throw new Error(`Duplicate ${label} market data for ${row.address} during refresh.`);
            }
            index.set(key, row);
        }

        return index;
    }

    applyState(dynamicData: DynamicMarketData, userData?: UserMarket) {
        this.validateStateRows(dynamicData, userData);
        const dynamicRowsByAddress = this.requireRefreshTokenRows(dynamicData.tokens, "dynamic");
        const userRowsByAddress = userData != undefined
            ? this.requireRefreshTokenRows(userData.tokens, "user")
            : undefined;

        this.cache.dynamic = dynamicData;

        if(userData != undefined) {
            this.cache.user = userData;
            this._userDataScope = "full";
        }

        for(const token of this.tokens) {
            const nextDynamic = dynamicRowsByAddress.get(token.address.toLowerCase());
            const nextUser = userRowsByAddress?.get(token.address.toLowerCase());
            token.cache = {
                ...token.cache,
                ...nextDynamic,
                ...(nextUser ?? {}),
            };

            if (nextUser != undefined) {
                (token as any).markUserCacheFresh?.();
            }
        }
    }

    applyUserSummary(userData: UserMarketSummary) {
        this.cache.user = {
            ...this.cache.user,
            ...userData,
        };
        this._userDataScope = "summary";

        for (const token of this.tokens) {
            (token as any).invalidateUserCache?.();
        }
    }

    async reloadMarketData() {
        const dynamic_data = await this.reader.getDynamicMarketData();
        const dynamic = dynamic_data.find(m => m.address.toLowerCase() == this.address.toLowerCase());
        if(dynamic == undefined) {
            throw new Error(`Could not find dynamic data for market ${this.address}.`);
        }
        this.applyState(dynamic);
    }

    async reloadUserData(account: address, options: { allowSignerMismatch?: boolean } = {}) {
        const allowSignerMismatch = options.allowSignerMismatch ?? false;
        this.assertRefreshAccountCompatible(account, allowSignerMismatch);
        const { dynamicMarkets, userMarkets } = await this.reader.getMarketStates([this.address], account);
        const dynamic = Market.requireMarketRow(dynamicMarkets, this, "dynamic");
        const user = Market.requireMarketRow(userMarkets, this, "user");

        this.applyState(dynamic, user);
        this.bindRefreshedAccount(account, allowSignerMismatch);
    }

    async reloadUserSummary(account: address) {
        this.assertRefreshAccountCompatible(account);
        const userMarkets = await this.reader.getMarketSummaries([this.address], account);
        const user = Market.requireMarketRow(userMarkets, this, "user summary");

        this.applyUserSummary(user);
        this.bindRefreshedAccount(account);
    }

    static getActiveUserMarkets(markets: Market[]): Market[] {
        return markets.filter((market) => market.hasUserActivity());
    }

    private static groupByReaderDeployment(markets: Market[]) {
        const groups = new Map<string | ProtocolReader, { reader: ProtocolReader; markets: Market[] }>();

        for (const market of markets) {
            const groupKey = market.reader.batchKey ?? market.reader;
            const existing = groups.get(groupKey);
            if (existing) {
                existing.markets.push(market);
            } else {
                groups.set(groupKey, {
                    reader: market.reader,
                    markets: [market],
                });
            }
        }

        return groups.values();
    }

    static async reloadUserMarkets(markets: Market[], account: address): Promise<Market[]> {
        if(markets.length === 0) {
            return [];
        }

        for (const market of markets) {
            market.assertRefreshAccountCompatible(account);
        }

        const plans: Array<{ market: Market; dynamic: DynamicMarketData; user: UserMarket }> = [];

        for(const { reader, markets: groupedMarkets } of this.groupByReaderDeployment(markets)) {
            const addresses = groupedMarkets.map((market) => market.address);
            const { dynamicMarkets, userMarkets } = await reader.getMarketStates(addresses, account);
            const dynamicByAddress = this.buildRefreshMarketRowIndex(dynamicMarkets, "dynamic");
            const userByAddress = this.buildRefreshMarketRowIndex(userMarkets, "user");

            for(const market of groupedMarkets) {
                const dynamic = dynamicByAddress.get(market.address.toLowerCase());
                const user = userByAddress.get(market.address.toLowerCase());

                if(dynamic == undefined || user == undefined) {
                    throw new Error(`Could not reload market state for ${market.address}.`);
                }

                market.validateStateRows(dynamic, user);
                plans.push({ market, dynamic, user });
            }
        }

        for (const { market, dynamic, user } of plans) {
            market.applyState(dynamic, user);
            market.bindRefreshedAccount(account);
        }

        return markets;
    }

    static async reloadUserMarketSummaries(markets: Market[], account: address): Promise<Market[]> {
        if(markets.length === 0) {
            return [];
        }

        for (const market of markets) {
            market.assertRefreshAccountCompatible(account);
        }

        const plans: Array<{ market: Market; user: UserMarketSummary }> = [];

        for(const { reader, markets: groupedMarkets } of this.groupByReaderDeployment(markets)) {
            const addresses = groupedMarkets.map((market) => market.address);
            const userMarkets = await reader.getMarketSummaries(addresses, account);
            const userByAddress = this.buildRefreshMarketRowIndex(userMarkets, "user summary");

            for(const market of groupedMarkets) {
                const user = userByAddress.get(market.address.toLowerCase());

                if(user == undefined) {
                    throw new Error(`Could not reload market user summary for ${market.address}.`);
                }

                market.requireRefreshMarketAddress(user, "user summary");
                plans.push({ market, user });
            }
        }

        for (const { market, user } of plans) {
            market.applyUserSummary(user);
            market.bindRefreshedAccount(account);
        }

        return markets;
    }

    private static buildDeployDataIndex(setup: SetupConfigSnapshot): Map<string, DeployData> {
        const index = new Map<string, DeployData>();
        const deployments = setup.contracts.markets as unknown as Record<string, any>;

        for (const [name, data] of Object.entries(deployments)) {
            if (typeof data !== 'object' || data == null || typeof data.address !== 'string') {
                continue;
            }

            const key = validateAddress(data.address, `deployment market ${name}`).toLowerCase();
            const existing = index.get(key);
            if (existing != undefined) {
                throw new Error(
                    `Duplicate deployment market address ${data.address} for ${name}; ` +
                    `already used by ${existing.name}.`,
                );
            }
            index.set(key, {
                name,
                plugins: 'plugins' in data ? data.plugins as { [key: string]: address } : {},
            });
        }

        return index;
    }

    private static hasBorrowCapacity(token: StaticMarketToken): boolean {
        return token.isBorrowable && token.debtCap > 0n;
    }

    private static getDisplayTokenSymbol(token: StaticMarketToken | null | undefined): string {
        return token?.asset?.symbol?.trim() || token?.symbol?.trim() || "";
    }

    private static formatDisplayMarketName(staticData: StaticMarketData, fallbackName: string): string {
        if (!fallbackName.includes("|")) {
            return fallbackName;
        }

        const tokens = staticData.tokens;
        if (tokens.length < 2) {
            return fallbackName;
        }

        const firstSymbol = this.getDisplayTokenSymbol(tokens[0]);
        const secondSymbol = this.getDisplayTokenSymbol(tokens[1]);
        const isBidirectional = tokens.length > 1 && tokens.every((token) => this.hasBorrowCapacity(token));

        if (isBidirectional && firstSymbol && secondSymbol) {
            return `${firstSymbol} ⇄ ${secondSymbol}`;
        }

        const collateralToken = tokens.find((token) => !this.hasBorrowCapacity(token)) ?? tokens[0];
        const borrowToken =
            tokens.find((token) => token.address !== collateralToken?.address && this.hasBorrowCapacity(token)) ??
            tokens.find((token) => token.address !== collateralToken?.address) ??
            null;
        const collateralSymbol = this.getDisplayTokenSymbol(collateralToken);
        const borrowSymbol = this.getDisplayTokenSymbol(borrowToken);

        if (collateralSymbol && borrowSymbol) {
            return `${collateralSymbol} → ${borrowSymbol}`;
        }

        return fallbackName;
    }

    private static buildYieldIndex(yields: NativeYield[]): Map<string, NativeYield> {
        const index = new Map<string, NativeYield>();

        for (const yieldEntry of yields) {
            const key = yieldEntry.token ? yieldEntry.token.toLowerCase() : yieldEntry.symbol.toUpperCase();
            if (index.has(key)) {
                throw new Error(`Duplicate native-yield symbol ${yieldEntry.symbol}.`);
            }
            index.set(key, yieldEntry);
        }

        return index;
    }

    private static shouldSuppressNativeYield(yieldEntry: NativeYield, setup: SetupConfigSnapshot): boolean {
        const suppressedSymbols = setup.services.curvanceApi.suppressedNativeYieldSymbols;
        return suppressedSymbols.some(
            (symbol) => symbol.toUpperCase() === yieldEntry.symbol.toUpperCase(),
        );
    }

    private static buildMarketPayloadIndex<T extends { address: address }>(
        entries: T[],
        label: string,
    ): Map<string, T> {
        const index = new Map<string, T>();

        for (const entry of entries) {
            const key = validateAddress(entry.address, `${label} address`).toLowerCase();
            const existing = index.get(key);
            if (existing != undefined) {
                throw new Error(
                    `Duplicate ${label} address ${entry.address}; ` +
                    `already saw ${existing.address}.`,
                );
            }
            index.set(key, entry);
        }

        return index;
    }

    private static requireTokenRow<T extends { address: address }>(
        rowsByAddress: Map<string, T>,
        tokenAddress: address,
        marketAddress: address,
        label: string,
    ): T {
        const row = rowsByAddress.get(tokenAddress.toLowerCase());
        if (row == undefined) {
            throw new Error(`Missing ${label} token data for ${tokenAddress} in market ${marketAddress} during Market boot.`);
        }
        return row;
    }

    private static mergeTokenPayloads(
        staticData: StaticMarketData,
        dynamicData: DynamicMarketData,
        userData: UserMarket,
    ): Array<StaticMarketToken & DynamicMarketToken & UserMarketToken> {
        if (
            staticData.tokens.length !== dynamicData.tokens.length ||
            staticData.tokens.length !== userData.tokens.length
        ) {
            throw new Error(
                `Token row count mismatch for market ${staticData.address} during Market boot: ` +
                `static=${staticData.tokens.length} dynamic=${dynamicData.tokens.length} user=${userData.tokens.length}.`
            );
        }

        this.buildMarketPayloadIndex(staticData.tokens, `static token row in market ${staticData.address}`);
        const dynamicByAddress = this.buildMarketPayloadIndex(
            dynamicData.tokens,
            `dynamic token row in market ${staticData.address}`,
        );
        const userByAddress = this.buildMarketPayloadIndex(
            userData.tokens,
            `user token row in market ${staticData.address}`,
        );

        return staticData.tokens.map((staticToken) => ({
            ...staticToken,
            ...this.requireTokenRow(dynamicByAddress, staticToken.address, staticData.address, "dynamic"),
            ...this.requireTokenRow(userByAddress, staticToken.address, staticData.address, "user"),
        }));
    }

    /**
     * Preview the impact of the user descision for their deposit/borrow/leverage
     * @param user - Wallet address
     * @param collateral_ctoken - The collateral token
     * @param debt_ctoken - The debt token
     * @param deposit_amount - The colalteral amount
     * @param borrow_amount - The debt amount
     * @returns Supply, borrow & earn rates
     */
    async previewAssetImpact(user: address, collateral_ctoken: CToken, debt_ctoken: BorrowableCToken, deposit_amount: TokenInput, borrow_amount: TokenInput, rate_change: ChangeRate) {
        this.assertTokenBelongsToMarket(collateral_ctoken, "Collateral");
        this.assertTokenBelongsToMarket(debt_ctoken, "Debt");

        const amount_in = toBigInt(deposit_amount, collateral_ctoken.asset.decimals);
        const amount_out = toBigInt(borrow_amount, debt_ctoken.asset.decimals);

        let { supply, borrow } = await this.reader.previewAssetImpact(user, collateral_ctoken.address, debt_ctoken.address, amount_in, amount_out);
        if (amount_out > 0n) {
            const irm = await debt_ctoken.dynamicIRM();
            const currentAssetsHeld = await debt_ctoken.contract.assetsHeld();
            const currentDebt = await debt_ctoken.contract.marketOutstandingDebt();
            const projectedAssetsHeld = currentAssetsHeld > amount_out ? currentAssetsHeld - amount_out : 0n;
            borrow = await irm.borrowRate(projectedAssetsHeld, currentDebt + amount_out);
        }

        const supply_apy = Decimal(supply * getRateSeconds('year')).div(WAD);
        const borrow_apy = Decimal(borrow * getRateSeconds('year')).div(WAD);

        const supply_percent = Decimal(supply * getRateSeconds(rate_change)).div(WAD);
        const borrow_percent = Decimal(borrow * getRateSeconds(rate_change)).div(WAD);
        const supply_change = collateral_ctoken.convertTokensToUsd(amount_in).mul(supply_percent);
        const borrow_change = debt_ctoken.convertTokensToUsd(amount_out).mul(borrow_percent);

        return {
            supply: {
                percent: supply_apy,
                change: supply_change
            },
            borrow: {
                percent: borrow_apy,
                change: borrow_change
            },
            earn: {
                percent: supply_apy.sub(borrow_apy),
                change: supply_change.sub(borrow_change)
            }
        }
    }

    /**
     * Grabs the new position health when doing a redeem
     * @param ctoken - Token you are expecting to redeem on
     * @param amount - Amount of assets being redeemed
     * @returns The new position health
     */
    async previewPositionHealthLeverageDeposit(
        deposit_ctoken: CToken,
        deposit_amount: TokenInput,
        borrow_ctoken: BorrowableCToken,
        borrow_amount: TokenInput
    ) {
        return this.previewPositionHealth(deposit_ctoken, borrow_ctoken, true, deposit_amount, false, borrow_amount);
    }

    async previewPositionHealthLeverageDown(
        deposit_ctoken: CToken,
        borrow_ctoken: BorrowableCToken,
        newLeverage: Decimal,
        currentLeverage: Decimal
    ) {
        // Full deleverage always closes to zero debt → infinite position health aka null.
        this.assertTokenBelongsToMarket(deposit_ctoken, "Deposit");
        this.assertTokenBelongsToMarket(borrow_ctoken, "Borrow");

        if (newLeverage.equals(1)) {
            return null;
        }

        const preview = deposit_ctoken.previewLeverageDown(newLeverage, currentLeverage, borrow_ctoken);
        const repayCollateralAssets = preview.collateralAssetReduction;
        let { collateralAssetReduction } = preview;
        if (preview.feeBps > 0n) {
            collateralAssetReduction = collateralAssetReduction * BPS / (BPS - preview.feeBps);
        }
        const repayUsd = deposit_ctoken.convertTokensToUsd(repayCollateralAssets, true);
        const repayTokens = borrow_ctoken.convertUsdToTokens(repayUsd, true);

        return this.previewPositionHealth(
            deposit_ctoken,
            borrow_ctoken,
            false,
            FormatConverter.bigIntToDecimal(collateralAssetReduction, deposit_ctoken.asset.decimals),
            true,
            repayTokens
        );
    }

    async previewPositionHealthLeverageUp(
        deposit_ctoken: CToken,
        borrow_ctoken: BorrowableCToken,
        newLeverage: Decimal,
        depositAssets?: bigint,
        positionManagerType?: PositionManagerTypes,
    ) {
        this.assertTokenBelongsToMarket(deposit_ctoken, "Deposit");
        this.assertTokenBelongsToMarket(borrow_ctoken, "Borrow");

        if ((depositAssets ?? 0n) > 0n) {
            return this.previewPositionHealthDepositAndLeverage(
                deposit_ctoken,
                borrow_ctoken,
                newLeverage,
                depositAssets!,
                positionManagerType,
            );
        }

        const preview = deposit_ctoken.previewLeverageUp(newLeverage, borrow_ctoken, undefined, positionManagerType);

        return this.previewPositionHealth(
            deposit_ctoken,
            borrow_ctoken,
            true,
            preview.collateralIncreaseInAssets,
            false,
            preview.debtIncreaseInAssets
        );
    }

    async previewPositionHealthDepositAndLeverage(
        deposit_ctoken: CToken,
        borrow_ctoken: BorrowableCToken,
        newLeverage: Decimal,
        depositAssets: bigint,
        positionManagerType?: PositionManagerTypes,
    ) {
        this.assertTokenBelongsToMarket(deposit_ctoken, "Deposit");
        this.assertTokenBelongsToMarket(borrow_ctoken, "Borrow");

        const preview = deposit_ctoken.previewDepositAndLeverage(
            newLeverage,
            borrow_ctoken,
            depositAssets,
            positionManagerType,
        );

        return this.previewPositionHealth(
            deposit_ctoken,
            borrow_ctoken,
            true,
            preview.collateralIncreaseInAssets,
            false,
            preview.debtIncreaseInAssets
        );
    }

    /**
     * A dynamic position health previewer for any action
     * @param deposit_ctoken - Deposit side ctoken
     * @param borrow_ctoken - Borrow side ctoken
     * @param isDeposit - Is this a deposit your previewing?
     * @param collateral_amount - Amount of collateral being deposited, or redeemed if isDeposit is false
     * @param isRepay - Is this a repay your previewing?
     * @param debt_amount - Amount of debt being repayed, or borrowed if isRepay is false
     * @param bufferTime - Buffer time to add onto the price oracle timestamps
     * @returns a position health decimal or null if infinity
     */
    async previewPositionHealth(
        deposit_ctoken: CToken | null = null,
        borrow_ctoken: BorrowableCToken | null = null,
        isDeposit: boolean = false,
        collateral_amount: TokenInput = Decimal(0),
        isRepay: boolean = false,
        debt_amount: TokenInput = Decimal(0),
        bufferTime: bigint = 0n
    ) {
        this.assertTokenBelongsToMarket(deposit_ctoken, "Deposit");
        this.assertTokenBelongsToMarket(borrow_ctoken, "Borrow");

        const user = this.getAccountOrThrow();

        // Pass underlying asset amounts — NOT shares.
        // The on-chain reader's _collateralValue calls previewDeposit(assets) internally,
        // and _debtValue prices assets with the underlying token's oracle price.
        // Passing shares here would cause double-conversion (shares treated as assets).
        const onchain_collateral_amount = deposit_ctoken ? FormatConverter.decimalToBigInt(collateral_amount, deposit_ctoken.asset.decimals) : 0n;
        const onchain_debt_amount = borrow_ctoken ? FormatConverter.decimalToBigInt(debt_amount, borrow_ctoken.asset.decimals) : 0n;

        const data = await this.reader.getPositionHealth(
            this.address,
            user,
            deposit_ctoken ? deposit_ctoken.address : EMPTY_ADDRESS,
            borrow_ctoken ? borrow_ctoken.address : EMPTY_ADDRESS,
            isDeposit,
            onchain_collateral_amount,
            isRepay,
            onchain_debt_amount,
            bufferTime
        );

        if(data.errorCodeHit) {
            throw new Error(`Error code hit when calculating position health preview. This usually means price is stale so we couldn't get a valid health value.`);
        }

        return this.formatPositionHealth(data.positionHealth);
    }

    formatPositionHealth(positionHealth: bigint): Percentage | null {
        // Defensive edge case handling where we explicitly update UINT256_MAX to
        // null return which gets processed as infinity position health on the frontend.
        if (positionHealth === UINT256_MAX) {
            return null;
        }

        return Decimal(positionHealth).div(WAD_DECIMAL).sub(1);
    }

    /**
     * Grabs the new position health when doing a redeem
     * @param ctoken - Token you are expecting to redeem on
     * @param amount - Amount of assets being redeemed
     * @returns The new position health
     */
    async previewPositionHealthRedeem(ctoken: CToken, amount: TokenInput) {
        this.assertTokenBelongsToMarket(ctoken, "Redeem");

        const user = this.getAccountOrThrow();
        const redeemShares = ctoken.convertTokenInputToShares(amount);
        const redeemAssets = FormatConverter.decimalToBigInt(amount, ctoken.asset.decimals);
        const existing_collateral = ctoken.getUserCollateralShares();

        if(redeemShares > existing_collateral) {
            throw new Error(`Insufficient collateral: Existing (${existing_collateral}) < Redeem amount (${redeemShares})`);
        }

        const data = await this.reader.getPositionHealth(
            this.address,
            user,
            ctoken.address,
            EMPTY_ADDRESS,
            false,
            redeemAssets,
            false,
            0n,
            0n
        );

        if(data.errorCodeHit) {
            throw new Error(`Error code hit when calculating position health preview. This usually means price is stale so we couldn't get a valid health value.`);
        }

        return this.formatPositionHealth(data.positionHealth);
    }

    /**
     * Grabs the new position health when doing a deposit
     * @param ctoken - Token you are expecting to deposit on
     * @param amount - Amount of assets being deposited
     * @returns The new position health
     */
    async previewPositionHealthDeposit(ctoken: CToken, amount: TokenInput) {
        return this.previewPositionHealth(ctoken, null, true, amount);
    }

    /**
     * Grabs the new position health when doing a borrow
     * @param token - Token you are expecting to borrow on
     * @param amount - Amount of assets being borrowed
     * @returns The new position health
     */
    async previewPositionHealthBorrow(token: BorrowableCToken, amount: TokenInput) {
        this.assertTokenBelongsToMarket(token, "Borrow");

        const user = this.getAccountOrThrow();
        const data = await this.reader.getPositionHealth(
            this.address,
            user,
            EMPTY_ADDRESS,
            token.address,
            false,
            0n,
            false,
            FormatConverter.decimalToBigInt(amount, token.decimals),
            0n
        );

        if(data.errorCodeHit) {
            throw new Error(`Error code hit when calculating position health preview. This usually means price is stale so we couldn't get a valid health value.`);
        }

        return this.formatPositionHealth(data.positionHealth);
    }

    /**
     * Grabs the new position health when doing a repay
     * @param token - Token you are expecting to repay on
     * @param amount - Amount of assets being repayed
     * @returns The new position health
     */
    async previewPositionHealthRepay(token: BorrowableCToken, amount: TokenInput) {
        this.assertTokenBelongsToMarket(token, "Repay");

        const user = this.getAccountOrThrow();
        const repayAssets = amount.eq(0)
            ? UINT256_MAX
            : FormatConverter.decimalToBigInt(amount, token.decimals);
        const data = await this.reader.getPositionHealth(
            this.address,
            user,
            EMPTY_ADDRESS,
            token.address,
            false,
            0n,
            true,
            repayAssets,
            0n
        );

        if(data.errorCodeHit) {
            throw new Error(`Error code hit when calculating position health preview. This usually means price is stale so we couldn't get a valid health value.`);
        }

        return this.formatPositionHealth(data.positionHealth);
    }

    /**
     * Grabs the new liquidity values based on changes
     * @param account - The user's account address
     * @param cTokenModified - The ctoken you are modifiying
     * @param redemptionShares - Shares being redeemed
     * @param borrowAssets - Amount of assets being borrowed
     * @returns An object containing the hypothetical liquidity values
     */
    async hypotheticalLiquidityOf(
        account: address,
        cTokenModified: address = EMPTY_ADDRESS,
        redemptionShares: bigint = 0n,
        borrowAssets: bigint = 0n,
        bufferTime: bigint = 0n,
    ) {
        return this.reader.hypotheticalLiquidityOf(
            this.address,
            account,
            cTokenModified,
            redemptionShares,
            borrowAssets,
            bufferTime,
        );
    }

    /**
     * Fetch the expiration date of a user's cooldown period
     * @param account - The user's account address
     * @param fetch - Whether to fetch the cooldown length from the contract
     * @returns The expiration date of the cooldown period or null if not in cooldown
     */
    async expiresAt(account: address, fetch = false) {
        const cooldownTimestamp = await this.contract.accountAssets(account);
        const cooldownLength = fetch || this.cooldownLength == 0n ? await this.contract.MIN_HOLD_PERIOD() : this.cooldownLength;
        const unlockTime = cooldownTimestamp + cooldownLength;
        return this.cooldownDateFromUnlockTime(unlockTime, cooldownLength);
    }

    /**
     * Fetch multiple market cooldown expirations
     * @param markets - Markets you want to search
     * @returns An object mapping market addresses to their cooldown expiration dates OR null if its not in cooldown
     */
    async multiHoldExpiresAt(markets: Market[]) {
        if(markets.length == 0) {
            throw new Error("You can't fetch expirations for no markets.");
        }

        for (const market of markets) {
            const marketReaderKey = market.reader?.batchKey ?? null;
            const readerKey = this.reader?.batchKey ?? null;
            const sameReaderDeployment =
                market.reader === this.reader ||
                (marketReaderKey != null && marketReaderKey === readerKey);

            if (market.setup?.chain != null && market.setup.chain !== this.setup?.chain) {
                throw new Error(
                    `Cannot batch cooldowns across chains: base=${this.setup?.chain ?? "unknown"} ` +
                    `market=${market.setup.chain}.`
                );
            }

            if (!sameReaderDeployment) {
                throw new Error(
                    `Cannot batch cooldowns across different ProtocolReader deployments: ` +
                    `base=${this.reader?.address ?? "unknown"} market=${market.reader?.address ?? "unknown"}.`
                );
            }
        }

        const account = this.getAccountOrThrow();
        const marketAddresses = markets.map(market => market.address);
        const cooldownTimestamps = await this.reader.marketMultiCooldown(marketAddresses, account);

        let cooldowns: { [address: address]: Date | null } = {};
        for(let i = 0; i < markets.length; i++) {
            const market = markets[i]!;
            const cooldownTimestamp = cooldownTimestamps[i]!;
            const cooldownLength = market.cooldownLength;

            cooldowns[market.address] = market.cooldownDateFromUnlockTime(cooldownTimestamp, cooldownLength);
        }

        return cooldowns;
    }

    /**
     * Grab all the markets available and set them up using the protocol reader efficient RPC calls / API cached calls
     * @param reader  - instace of the ProtocolReader class
     * @param oracle_manager - instance of the OracleManager class
     * @param provider - The RPC provider
     * @returns An array of Market instances setup with protocol reader data
     */
    static async getAll(
        reader: ProtocolReader,
        oracle_manager: OracleManager,
        provider?: curvance_read_provider,
        signer?: curvance_signer | null,
        account?: address | null,
        milestones: Milestones = {},
        incentives: Incentives = {},
        setup?: SetupConfigSnapshot,
    ) {
        const resolvedSetup = setup ?? resolveDefaultSetupConfig("Market.getAll");
        const hasExplicitProvider = provider != null;
        const resolvedProvider = hasExplicitProvider ? provider : resolvedSetup.readProvider;
        const resolvedSigner = signer === undefined
            ? hasExplicitProvider ? null : resolvedSetup.signer
            : signer;
        const resolvedAccount = account === undefined
            ? hasExplicitProvider ? null : resolvedSetup.account
            : account;
        const chainId = resolvedSetup.chainId;

        const all_data = await reader.getAllMarketData(resolvedAccount);
        const [yields, merklOpps] = await Promise.all([
            Api.fetchNativeYields(resolvedSetup).then(y => (
                y.filter(yieldEntry => !this.shouldSuppressNativeYield(yieldEntry, resolvedSetup))
            )),
            fetchMerklOpportunities({ chainId }).catch(() => [] as MerklOpportunity[]),
        ]);
        const merklLendOpps = merklOpps.filter(opportunity => !opportunity.action || opportunity.action === "LEND");
        const merklBorrowOpps = merklOpps.filter(opportunity => opportunity.action === "BORROW");
        const deployIndex = this.buildDeployDataIndex(resolvedSetup);
        const milestonesByAddress = new Map(
            Object.entries(milestones).map(([market, milestone]) => [market.toLowerCase(), milestone]),
        );
        const incentivesByAddress = new Map(
            Object.entries(incentives).map(([market, marketIncentives]) => [market.toLowerCase(), marketIncentives]),
        );
        const lendOppApyByToken = aggregateMerklAprByToken(merklLendOpps, "deposit");
        const borrowOppApyByToken = aggregateMerklAprByToken(merklBorrowOpps, "borrow");
        const yieldIndex = this.buildYieldIndex(yields);
        this.buildMarketPayloadIndex(all_data.staticMarket, "static market");
        const dynamicByAddress = this.buildMarketPayloadIndex(all_data.dynamicMarket, "dynamic market");
        const userByAddress = this.buildMarketPayloadIndex(all_data.userData.markets, "user market");

        let markets: Market[] = [];
        for(const staticData of all_data.staticMarket) {
            const market_address = staticData.address;
            const deploy_data = deployIndex.get(market_address.toLowerCase());
            const dynamicData = dynamicByAddress.get(market_address.toLowerCase());
            const userData = userByAddress.get(market_address.toLowerCase());

            if(deploy_data == undefined) {
                // No SDK metadata (name + plugin addresses) for this on-chain market, so it
                // can't be operated anyway — skip rather than fail.
                console.warn(
                    `Skipping market ${market_address} (${resolvedSetup.chain}): ` +
                    `no SDK deployment metadata.`,
                );
                continue;
            }

            if(dynamicData == undefined) {
                throw new Error(`Missing dynamic market data for ${market_address} during Market.getAll boot.`);
            }

            if(userData == undefined) {
                throw new Error(`Missing user market data for ${market_address} during Market.getAll boot.`);
            }

            const market = new Market(
                resolvedProvider,
                resolvedSigner,
                resolvedAccount,
                staticData,
                dynamicData,
                userData,
                {
                    ...deploy_data,
                    name: this.formatDisplayMarketName(staticData, deploy_data.name),
                },
                oracle_manager,
                reader,
                resolvedSetup,
            );
            const rewardKey = market.address.toLowerCase();
            const milestone = milestonesByAddress.get(rewardKey);
            if(milestone != undefined) {
                market.milestone = milestone;
            }
            const marketIncentives = incentivesByAddress.get(rewardKey);
            if(marketIncentives != undefined) {
                market.incentives = marketIncentives;
            }

            for(const token of market.tokens) {
                const tokenKey = token.address.toLowerCase();
                const lendApy = lendOppApyByToken.get(tokenKey);
                if(lendApy != undefined) {
                    token.incentiveSupplyApy = lendApy;
                }

                const borrowApy = borrowOppApyByToken.get(tokenKey);
                if(borrowApy != undefined) {
                    token.incentiveBorrowApy = borrowApy;
                }

                const api_yield = yieldIndex.get(tokenKey) ?? yieldIndex.get(token.asset.symbol.toUpperCase());
                if(api_yield != undefined) {
                    token.nativeApy = new Decimal(api_yield.apy).div(100);
                }
            }

            markets.push(market);
        }

        return markets;
    }
}
