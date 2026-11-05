import { fetchWithTimeout, validateAddress } from "../validation";

const MERKL_API_BASE_URL = 'https://api.merkl.xyz/v4';
const MERKL_PROXY_URL = 'https://api2.curvance.com/merkl/proxy';
const PROTOCOL_ID = 'curvance';
const MERKL_OPPORTUNITIES_PAGE_SIZE = 100;
const MERKL_OPPORTUNITIES_COALESCE_MS = 30_000;

export type MerklChainInfo = {
    id: number;
    name: string;
    icon?: string;
    explorer?: { url: string }[];
    liveCampaigns?: number;
    endOfDisputePeriod?: number;
};

export type MerklRewardToken = {
    id?: string;
    name?: string;
    symbol: string;
    address: string;
    chainId: number;
    decimals: number;
    icon?: string;
    price?: number;
    priceSource?: string;
};

export type MerklRewardBreakdown = {
    campaignId: string;
    amount: string;
    claimed: string;
    pending?: string;
    reason?: string;
};

export type MerklRewardRecordToken = Partial<MerklRewardToken>;

export type MerklRewardRecordBreakdown = {
    token: MerklRewardRecordToken;
    amount?: string;
    value?: number;
    distributionType?: string;
    onChainCampaignId?: string;
    id?: string;
    timestamp?: string;
    campaignId?: string;
    dailyRewardsRecordId?: string;
};

export type MerklReward = {
    distributionChainId: number;
    root: string;
    recipient: string;
    amount: string;
    claimed: string;
    pending?: string;
    token: MerklRewardToken;
    breakdowns?: MerklRewardBreakdown[];
};

export type MerklUserRewardsResponse = Array<{
    chain: MerklChainInfo;
    rewards: MerklReward[];
}>;

export type MerklCampaign = {
    id: string;
    campaignId: string;
    computeChainId: number;
    distributionChainId: number;
    chain: MerklChainInfo;
    distributionChain?: MerklChainInfo;
    rewardToken: MerklRewardToken;
    opportunityId?: string;
    startTimestamp?: number;
    endTimestamp?: number;
    amount?: string;
    distributionType?: string;
    /** Validated settings for capped ERC-4626 total-yield campaigns. */
    targetAprConfig?: {
        targetToken: string;
        /** Fractional total rate: 0.1 means 10%, including native yield and other rewards. */
        targetApr: number;
        mode: 'MAX_APR';
        lookbackWindow: number;
        whitelist: string[];
        blacklist: string[];
    };
};

type FetchOptions = {
    signal?: AbortSignal;
};

export type MerklOpportunity = {
    id?: string;
    status?: string;
    name: string;
    apr: number;
    action?: 'LEND' | 'BORROW' | string;
    identifier: string;
    type: string;
    chain?: MerklChainInfo;
    chainId?: number;
    computeChainId?: number;
    distributionChainId?: number;
    tokens: { address: string; symbol: string }[];
    aprRecord?: {
        breakdowns: { identifier: string; value: number }[];
    };
    rewardsRecord?: {
        id?: string;
        total?: number;
        timestamp?: string;
        breakdowns?: MerklRewardRecordBreakdown[];
    };
};

type FetchRewardsParams = FetchOptions & {
    wallet: string;
    chainId?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value != null;
}

function isString(value: unknown): value is string {
    return typeof value === 'string';
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function isNonnegativeFiniteNumber(value: unknown): value is number {
    return isFiniteNumber(value) && value >= 0;
}

function validateOptionalChainId(chainId: number | undefined, context: string): number | undefined {
    if (chainId == undefined) {
        return undefined;
    }
    if (!Number.isSafeInteger(chainId) || chainId <= 0) {
        throw new Error(`Invalid chainId from ${context}: ${chainId}`);
    }
    return chainId;
}

function proxyMerklUrl(url: URL): string {
    const proxyUrl = new URL(MERKL_PROXY_URL);
    proxyUrl.searchParams.set('url', url.toString());
    return proxyUrl.toString();
}

function isAddressLike(value: string): boolean {
    return /^0x[a-fA-F0-9]{40}$/.test(value);
}

function normalizeChainInfo(value: unknown): MerklChainInfo | null {
    if (
        !isRecord(value) ||
        !isFiniteNumber(value.id) ||
        !isString(value.name)
    ) {
        return null;
    }

    const chain: MerklChainInfo = {
        id: value.id,
        name: value.name,
    };
    if (isString(value.icon)) {
        chain.icon = value.icon;
    }
    if (Array.isArray(value.explorer)) {
        const explorer = value.explorer
            .filter((entry): entry is { url: string } => isRecord(entry) && isString(entry.url))
            .map((entry) => ({ url: entry.url }));
        if (explorer.length > 0) {
            chain.explorer = explorer;
        }
    }
    if (isNonnegativeFiniteNumber(value.liveCampaigns)) {
        chain.liveCampaigns = value.liveCampaigns;
    }
    if (isNonnegativeFiniteNumber(value.endOfDisputePeriod)) {
        chain.endOfDisputePeriod = value.endOfDisputePeriod;
    }

    return chain;
}

function normalizeRewardToken(value: unknown): MerklRewardToken | null {
    if (
        !isRecord(value) ||
        !isString(value.symbol) ||
        !isString(value.address) ||
        !isFiniteNumber(value.chainId) ||
        !isNonnegativeFiniteNumber(value.decimals)
    ) {
        return null;
    }

    const token: MerklRewardToken = {
        symbol: value.symbol,
        address: value.address,
        chainId: value.chainId,
        decimals: value.decimals,
    };
    if (isString(value.id)) {
        token.id = value.id;
    }
    if (isString(value.name)) {
        token.name = value.name;
    }
    if (isString(value.icon)) {
        token.icon = value.icon;
    }
    if (isFiniteNumber(value.price)) {
        token.price = value.price;
    }
    if (isString(value.priceSource)) {
        token.priceSource = value.priceSource;
    }

    return token;
}

function normalizeRewardBreakdown(value: unknown): MerklRewardBreakdown | null {
    if (
        !isRecord(value) ||
        !isString(value.campaignId) ||
        !isString(value.amount) ||
        !isString(value.claimed)
    ) {
        return null;
    }

    const breakdown: MerklRewardBreakdown = {
        campaignId: value.campaignId,
        amount: value.amount,
        claimed: value.claimed,
    };
    if (isString(value.pending)) {
        breakdown.pending = value.pending;
    }
    if (isString(value.reason)) {
        breakdown.reason = value.reason;
    }

    return breakdown;
}

function normalizeReward(value: unknown): MerklReward | null {
    if (
        !isRecord(value) ||
        !isFiniteNumber(value.distributionChainId) ||
        !isString(value.root) ||
        !isString(value.recipient) ||
        !isString(value.amount) ||
        !isString(value.claimed)
    ) {
        return null;
    }

    const token = normalizeRewardToken(value.token);
    if (token == null) {
        return null;
    }

    const breakdowns = Array.isArray(value.breakdowns)
        ? value.breakdowns
            .map(normalizeRewardBreakdown)
            .filter((breakdown): breakdown is MerklRewardBreakdown => breakdown != null)
        : undefined;

    const reward: MerklReward = {
        distributionChainId: value.distributionChainId,
        root: value.root,
        recipient: value.recipient,
        amount: value.amount,
        claimed: value.claimed,
        token,
    };
    if (isString(value.pending)) {
        reward.pending = value.pending;
    }
    if (breakdowns != undefined) {
        reward.breakdowns = breakdowns;
    }

    return reward;
}

function normalizeMerklUserRewardsResponse(value: unknown): MerklUserRewardsResponse {
    if (!Array.isArray(value)) {
        return [];
    }

    const rows: MerklUserRewardsResponse = [];
    for (const row of value) {
        if (!isRecord(row) || !Array.isArray(row.rewards)) {
            continue;
        }

        const chain = normalizeChainInfo(row.chain);
        if (chain == null) {
            continue;
        }

        rows.push({
            chain,
            rewards: row.rewards
                .map(normalizeReward)
                .filter((reward): reward is MerklReward => reward != null),
        });
    }

    return rows;
}

function normalizeCampaign(value: unknown): MerklCampaign | null {
    if (
        !isRecord(value) ||
        !isString(value.id) ||
        !isString(value.campaignId) ||
        !isFiniteNumber(value.computeChainId) ||
        !isFiniteNumber(value.distributionChainId)
    ) {
        return null;
    }

    const chain = normalizeChainInfo(value.chain);
    const rewardToken = normalizeRewardToken(value.rewardToken);
    if (chain == null || rewardToken == null) {
        return null;
    }

    const distributionChain = value.distributionChain != undefined
        ? normalizeChainInfo(value.distributionChain)
        : undefined;
    if (value.distributionChain != undefined && distributionChain == null) {
        return null;
    }

    const campaign: MerklCampaign = {
        id: value.id,
        campaignId: value.campaignId,
        computeChainId: value.computeChainId,
        distributionChainId: value.distributionChainId,
        chain,
        rewardToken,
    };
    if (distributionChain != undefined) {
        campaign.distributionChain = distributionChain;
    }
    if (isString(value.opportunityId)) campaign.opportunityId = value.opportunityId;
    if (Number.isSafeInteger(value.startTimestamp) && (value.startTimestamp as number) >= 0) {
        campaign.startTimestamp = value.startTimestamp as number;
    }
    if (Number.isSafeInteger(value.endTimestamp) && (value.endTimestamp as number) > 0) {
        campaign.endTimestamp = value.endTimestamp as number;
    }
    if (isString(value.amount) && /^\d+$/.test(value.amount)) campaign.amount = value.amount;
    if (isString(value.distributionType)) campaign.distributionType = value.distributionType;
    const params = isRecord(value.params) ? value.params : undefined;
    const method = isRecord(params?.distributionMethodParameters)
        ? params.distributionMethodParameters : undefined;
    const settings = isRecord(method?.distributionSettings) ? method.distributionSettings : undefined;
    const targetApr = isString(settings?.targetAPR) || isFiniteNumber(settings?.targetAPR)
        ? Number(settings.targetAPR) : NaN;
    const validAddressList = (list: unknown): list is string[] =>
        Array.isArray(list) && list.every((item) => isString(item) && isAddressLike(item));
    if (
        value.distributionType === 'ERC4626_TARGET_APR_WITH_MERKL' &&
        method?.distributionMethod === value.distributionType &&
        settings?.mode === 'MAX_APR' &&
        isString(settings.targetToken) && isAddressLike(settings.targetToken) &&
        params?.targetToken === settings.targetToken &&
        Number.isFinite(targetApr) && targetApr > 0 &&
        Number.isSafeInteger(settings.lookbackWindow) && (settings.lookbackWindow as number) > 0 &&
        settings.rewardTokenPricing === true && settings.targetTokenPricing === true &&
        validAddressList(params.whitelist) && validAddressList(params.blacklist) &&
        Array.isArray(params.hooks) && params.hooks.length === 0
    ) {
        campaign.targetAprConfig = {
            targetToken: settings.targetToken,
            targetApr,
            mode: 'MAX_APR',
            lookbackWindow: settings.lookbackWindow as number,
            whitelist: params.whitelist,
            blacklist: params.blacklist,
        };
    }

    return campaign;
}

function normalizeMerklCampaigns(value: unknown): MerklCampaign[] {
    if (!Array.isArray(value)) {
        return [];
    }

    return value
        .map(normalizeCampaign)
        .filter((campaign): campaign is MerklCampaign => campaign != null);
}

function normalizeOpportunityToken(value: unknown): { address: string; symbol: string } | null {
    if (!isRecord(value) || !isString(value.address)) {
        return null;
    }

    return {
        address: value.address,
        symbol: isString(value.symbol) ? value.symbol : "",
    };
}

function normalizeRewardRecordBreakdown(value: unknown): MerklRewardRecordBreakdown | null {
    if (!isRecord(value) || !isRecord(value.token)) {
        return null;
    }

    const token: MerklRewardRecordToken = {};
    if (isString(value.token.id)) token.id = value.token.id;
    if (isString(value.token.name)) token.name = value.token.name;
    if (isString(value.token.symbol)) token.symbol = value.token.symbol;
    if (isString(value.token.address)) token.address = value.token.address;
    if (isFiniteNumber(value.token.chainId)) token.chainId = value.token.chainId;
    if (isNonnegativeFiniteNumber(value.token.decimals)) token.decimals = value.token.decimals;
    if (isString(value.token.icon)) token.icon = value.token.icon;
    if (isFiniteNumber(value.token.price)) token.price = value.token.price;
    if (isString(value.token.priceSource)) token.priceSource = value.token.priceSource;

    if (Object.keys(token).length === 0) {
        return null;
    }

    const breakdown: MerklRewardRecordBreakdown = { token };
    if (isString(value.amount)) breakdown.amount = value.amount;
    if (isFiniteNumber(value.value)) breakdown.value = value.value;
    if (isString(value.distributionType)) breakdown.distributionType = value.distributionType;
    if (isString(value.onChainCampaignId)) breakdown.onChainCampaignId = value.onChainCampaignId;
    if (isString(value.id)) breakdown.id = value.id;
    if (isString(value.timestamp)) breakdown.timestamp = value.timestamp;
    if (isString(value.campaignId)) breakdown.campaignId = value.campaignId;
    if (isString(value.dailyRewardsRecordId)) breakdown.dailyRewardsRecordId = value.dailyRewardsRecordId;

    return breakdown;
}

function normalizeMerklOpportunity(value: unknown): MerklOpportunity | null {
    if (
        !isRecord(value) ||
        !isString(value.name) ||
        !isFiniteNumber(value.apr) ||
        !isString(value.identifier) ||
        !isString(value.type)
    ) {
        return null;
    }

    const rawTokens = value.tokens;
    const hasTokenArray = Array.isArray(rawTokens);
    if (!hasTokenArray && !isAddressLike(value.identifier)) {
        return null;
    }

    const tokens = Array.isArray(rawTokens)
        ? rawTokens
            .map(normalizeOpportunityToken)
            .filter((token): token is { address: string; symbol: string } => token != null)
        : [];

    const chain = value.chain != undefined ? normalizeChainInfo(value.chain) : undefined;
    if (value.chain != undefined && chain == null) {
        return null;
    }

    const opportunity: MerklOpportunity = {
        name: value.name,
        apr: value.apr,
        identifier: value.identifier,
        type: value.type,
        tokens,
    };
    if (isString(value.id)) opportunity.id = value.id;
    if (isString(value.status)) opportunity.status = value.status;
    if (isRecord(value.aprRecord) && Array.isArray(value.aprRecord.breakdowns)) {
        opportunity.aprRecord = {
            breakdowns: value.aprRecord.breakdowns.flatMap((row) =>
                isRecord(row) && isString(row.identifier) && isNonnegativeFiniteNumber(row.value)
                    ? [{ identifier: row.identifier, value: row.value }] : []),
        };
    }
    if (value.action != undefined) {
        if (!isString(value.action)) {
            return null;
        }
        opportunity.action = value.action;
    }
    if (chain != undefined) {
        opportunity.chain = chain;
    }
    if (value.chainId != undefined) {
        if (!isFiniteNumber(value.chainId)) {
            return null;
        }
        opportunity.chainId = value.chainId;
    }
    if (value.computeChainId != undefined) {
        if (!isFiniteNumber(value.computeChainId)) {
            return null;
        }
        opportunity.computeChainId = value.computeChainId;
    }
    if (value.distributionChainId != undefined) {
        if (!isFiniteNumber(value.distributionChainId)) {
            return null;
        }
        opportunity.distributionChainId = value.distributionChainId;
    }
    if (isRecord(value.rewardsRecord)) {
        const rewardsRecord: NonNullable<MerklOpportunity["rewardsRecord"]> = {};
        if (isString(value.rewardsRecord.id)) rewardsRecord.id = value.rewardsRecord.id;
        if (isFiniteNumber(value.rewardsRecord.total)) rewardsRecord.total = value.rewardsRecord.total;
        if (isString(value.rewardsRecord.timestamp)) rewardsRecord.timestamp = value.rewardsRecord.timestamp;
        if (Array.isArray(value.rewardsRecord.breakdowns)) {
            rewardsRecord.breakdowns = value.rewardsRecord.breakdowns
                .map(normalizeRewardRecordBreakdown)
                .filter((breakdown): breakdown is MerklRewardRecordBreakdown => breakdown != null);
        }
        opportunity.rewardsRecord = rewardsRecord;
    }

    return opportunity;
}

function getOpportunityChainIds(opportunity: MerklOpportunity): number[] {
    return [
        opportunity.chain?.id,
        opportunity.chainId,
        opportunity.computeChainId,
        opportunity.distributionChainId,
    ].filter((value): value is number => value != undefined);
}

export function filterMerklOpportunitiesByChain(
    opportunities: MerklOpportunity[],
    chainId?: number,
): MerklOpportunity[] {
    const validatedChainId = validateOptionalChainId(chainId, 'Merkl opportunities chainId');
    if (validatedChainId == undefined) {
        return opportunities;
    }

    return opportunities.filter((opportunity) => {
        const opportunityChainIds = getOpportunityChainIds(opportunity);
        return opportunityChainIds.length === 0 ||
            opportunityChainIds.every((opportunityChainId) => opportunityChainId === validatedChainId);
    });
}

type MerklOpportunityAction = 'LEND' | 'BORROW' | 'HOLD';

function filterMerklOpportunitiesByAction(
    opportunities: MerklOpportunity[],
    action?: MerklOpportunityAction,
): MerklOpportunity[] {
    if (action == undefined) {
        return opportunities;
    }

    return opportunities.filter((opportunity) => (
        opportunity.action == undefined ||
        opportunity.action.toUpperCase() === action
    ));
}

function normalizeMerklOpportunities(value: unknown): MerklOpportunity[] {
    if (!Array.isArray(value)) {
        return [];
    }

    return value
        .map(normalizeMerklOpportunity)
        .filter((opportunity): opportunity is MerklOpportunity => opportunity != null);
}

export function filterMerklUserRewardsByChain(
    rewards: MerklUserRewardsResponse,
    chainId?: number,
): MerklUserRewardsResponse {
    const validatedChainId = validateOptionalChainId(chainId, 'Merkl rewards chainId');
    if (validatedChainId == undefined) {
        return rewards;
    }

    return rewards
        .filter(({ chain }) => chain.id === validatedChainId)
        .map((row) => ({
            ...row,
            rewards: row.rewards.filter((reward) => (
                reward.distributionChainId === validatedChainId &&
                reward.token.chainId === validatedChainId
            )),
        }));
}

export async function fetchMerklUserRewards({
    wallet,
    chainId,
    signal,
}: FetchRewardsParams): Promise<MerklUserRewardsResponse> {
    const validatedWallet = validateAddress(wallet, 'Merkl rewards wallet');
    const validatedChainId = validateOptionalChainId(chainId, 'Merkl rewards chainId');
    const url = new URL(`${MERKL_API_BASE_URL}/users/${validatedWallet}/rewards`);
    if (validatedChainId != undefined) {
        url.searchParams.set('chainId', String(validatedChainId));
    }

    const response = await fetchWithTimeout(proxyMerklUrl(url), { signal: signal ?? null, cache: 'no-store' });

    if (!response.ok) {
        throw new Error('Failed to fetch Merkl rewards');
    }

    return filterMerklUserRewardsByChain(
        normalizeMerklUserRewardsResponse(await response.json()),
        validatedChainId,
    );
}

type FetchCampaignsParams = FetchOptions & {
    tokenSymbol: string;
    chainId?: number;
};

function campaignMatchesChain(campaign: MerklCampaign, chainId: number): boolean {
    const chainIds = [
        campaign.chain.id,
        campaign.computeChainId,
        campaign.distributionChainId,
        campaign.distributionChain?.id,
        campaign.rewardToken.chainId,
    ].filter((value): value is number => value != undefined);

    return chainIds.length > 0 && chainIds.every((value) => value === chainId);
}

export async function fetchMerklCampaignsBySymbol({
    tokenSymbol,
    chainId,
    signal,
}: FetchCampaignsParams): Promise<MerklCampaign[]> {
    const validatedChainId = validateOptionalChainId(chainId, 'Merkl campaigns chainId');
    const url = new URL(`${MERKL_API_BASE_URL}/campaigns`);
    url.searchParams.set('mainProtocolId', PROTOCOL_ID);
    url.searchParams.set('tokenSymbol', tokenSymbol);
    if (validatedChainId != undefined) {
        url.searchParams.set('chainId', String(validatedChainId));
    }

    const response = await fetchWithTimeout(proxyMerklUrl(url), { signal: signal ?? null, cache: 'no-store' });

    if (!response.ok) {
        throw new Error('Failed to fetch Merkl campaigns');
    }

    const campaigns = normalizeMerklCampaigns(await response.json());
    return validatedChainId == undefined
        ? campaigns
        : campaigns.filter((campaign) => campaignMatchesChain(campaign, validatedChainId));
}

type FetchOpportunitiesParams = FetchOptions & {
    action?: MerklOpportunityAction;
    chainId?: number;
    search?: string;
};

export async function fetchMerklOpportunities({
    signal,
    action,
    chainId,
    search,
}: FetchOpportunitiesParams): Promise<MerklOpportunity[]> {
    const validatedChainId = validateOptionalChainId(chainId, 'Merkl opportunities chainId');
    const trimmedSearch = search?.trim();
    const cacheKey = getMerklOpportunitiesCoalesceKey({
        signal,
        action,
        chainId: validatedChainId,
        search: trimmedSearch,
    });

    if (cacheKey != undefined) {
        const cached = merklOpportunitiesCoalesceCache.get(cacheKey);
        if (cached != undefined && cached.expiresAt > Date.now()) {
            return cached.promise;
        }

        const promise = fetchMerklOpportunitiesUncached({
            action,
            chainId: validatedChainId,
            search: trimmedSearch,
        });
        merklOpportunitiesCoalesceCache.set(cacheKey, {
            expiresAt: Date.now() + MERKL_OPPORTUNITIES_COALESCE_MS,
            promise,
        });
        promise.catch(() => {
            if (merklOpportunitiesCoalesceCache.get(cacheKey)?.promise === promise) {
                merklOpportunitiesCoalesceCache.delete(cacheKey);
            }
        });
        return promise;
    }

    return fetchMerklOpportunitiesUncached({
        signal,
        action,
        chainId: validatedChainId,
        search: trimmedSearch,
    });
}

type MerklOpportunitiesCoalesceCacheEntry = {
    expiresAt: number;
    promise: Promise<MerklOpportunity[]>;
};

const merklOpportunitiesCoalesceCache = new Map<string, MerklOpportunitiesCoalesceCacheEntry>();

function getMerklOpportunitiesCoalesceKey({
    signal,
    action,
    chainId,
    search,
}: {
    signal?: AbortSignal | undefined;
    action?: MerklOpportunityAction | undefined;
    chainId?: number | undefined;
    search?: string | undefined;
}): string | undefined {
    if (signal != undefined || action != undefined || search || chainId == undefined) {
        return undefined;
    }

    return `chain:${chainId}`;
}

async function fetchMerklOpportunitiesUncached({
    signal,
    action,
    chainId,
    search,
}: {
    signal?: AbortSignal | undefined;
    action?: MerklOpportunityAction | undefined;
    chainId?: number | undefined;
    search?: string | undefined;
}): Promise<MerklOpportunity[]> {
    const opportunities: MerklOpportunity[] = [];
    let page = 0;

    while (true) {
        const pageParams: FetchOpportunitiesPageParams = { page };
        if (signal != undefined) pageParams.signal = signal;
        if (action != undefined) pageParams.action = action;
        if (chainId != undefined) pageParams.chainId = chainId;
        if (search) pageParams.search = search;

        const pageResult = await fetchMerklOpportunitiesPage(pageParams);
        opportunities.push(...pageResult.opportunities);

        if (pageResult.rawRowCount < MERKL_OPPORTUNITIES_PAGE_SIZE) {
            break;
        }

        page += 1;
    }

    return filterMerklOpportunitiesByAction(
        filterMerklOpportunitiesByChain(
            opportunities,
            chainId,
        ),
        action,
    );
}

type FetchOpportunitiesPageParams = FetchOptions & {
    action?: MerklOpportunityAction;
    chainId?: number;
    search?: string;
    page: number;
};

async function fetchMerklOpportunitiesPage({
    signal,
    action,
    chainId,
    search,
    page,
}: FetchOpportunitiesPageParams): Promise<{ opportunities: MerklOpportunity[]; rawRowCount: number }> {
    const url = new URL(`${MERKL_API_BASE_URL}/opportunities`);
    url.searchParams.set('items', String(MERKL_OPPORTUNITIES_PAGE_SIZE));
    url.searchParams.set('page', String(page));
    url.searchParams.set('tokenTypes', 'TOKEN');
    url.searchParams.set('mainProtocolId', PROTOCOL_ID);
    if (action) {
        url.searchParams.set('action', action);
    }
    if (chainId != undefined) {
        url.searchParams.set('chainId', String(chainId));
    }
    if (search) {
        url.searchParams.set('search', search);
    }

    const response = await fetchWithTimeout(proxyMerklUrl(url), { signal: signal ?? null, cache: 'no-store' });

    if (!response.ok) {
        throw new Error('Failed to fetch Merkl opportunities');
    }

    const body = await response.json();
    return {
        opportunities: normalizeMerklOpportunities(body),
        rawRowCount: Array.isArray(body) ? body.length : 0,
    };
}
