import Decimal from 'decimal.js';
import {
    fetchMerklCampaignsBySymbol,
    filterMerklOpportunitiesByChain,
    type MerklCampaign,
    type MerklOpportunity,
} from './merkl';

const TARGET_DISTRIBUTION = 'ERC4626_TARGET_APR_WITH_MERKL';
const YEAR_SECONDS = 31_536_000;
const key = (value: string | null | undefined) => value?.trim().toLowerCase() ?? '';

export interface VaultRewardRate {
    address: string;
    symbol: string;
    /** Fractional rate, before display rounding. */
    apy: Decimal;
    opportunity: Pick<MerklOpportunity, 'type' | 'identifier'>;
}

export interface VaultApyBreakdown {
    nativeApy: Decimal;
    reportedMerklApy: Decimal;
    merklApy: Decimal;
    totalApy: Decimal;
    rewards: VaultRewardRate[];
    /** Present only when an eligible, funded campaign increases the headline. */
    campaignTargetApy?: Decimal;
}

function vaultOpportunities(opportunities: MerklOpportunity[], vaultAddress: string, chainId: number) {
    const seen = new Set<string>();
    return filterMerklOpportunitiesByChain(opportunities, chainId).filter((opportunity) => {
        if (key(opportunity.action) !== 'hold') return false;
        if (opportunity.status && opportunity.status !== 'LIVE') return false;
        const identifiesAddress = /^0x[a-fA-F0-9]{40}$/.test(opportunity.identifier);
        if (key(opportunity.identifier) !== key(vaultAddress) &&
            (identifiesAddress || !opportunity.tokens.some((token) => key(token.address) === key(vaultAddress)))) return false;
        const identity = opportunity.id ?? JSON.stringify([
            opportunity.type, key(opportunity.identifier), opportunity.apr, opportunity.rewardsRecord,
        ]);
        if (seen.has(identity)) return false;
        seen.add(identity);
        return true;
    });
}

/** Only fetch campaign metadata for reward tokens advertising a vault target campaign. */
export async function fetchMerklVaultCampaigns({
    vaultAddress, chainId, opportunities, signal,
}: {
    vaultAddress: string;
    chainId: number;
    opportunities: MerklOpportunity[];
    signal?: AbortSignal | undefined;
}): Promise<MerklCampaign[]> {
    const symbols = new Set(vaultOpportunities(opportunities, vaultAddress, chainId).flatMap((opportunity) =>
        (opportunity.rewardsRecord?.breakdowns ?? []).flatMap((reward) =>
            reward.distributionType === TARGET_DISTRIBUTION && reward.token.symbol?.trim()
                ? [reward.token.symbol.trim()] : [])));
    const campaigns = await Promise.all(Array.from(symbols, (tokenSymbol) =>
        fetchMerklCampaignsBySymbol({ tokenSymbol, chainId, status: 'LIVE', ...(signal ? { signal } : {}) })));
    return campaigns.flat().filter((campaign) => key(campaign.targetAprConfig?.targetToken) === key(vaultAddress));
}

function nonnegative(value: Decimal.Value | undefined): Decimal {
    try {
        const number = new Decimal(value ?? 0);
        return number.isFinite() && number.gte(0) ? number : new Decimal(0);
    } catch {
        return new Decimal(0);
    }
}

/**
 * Current native yield plus HOLD rewards, adjusted toward an active total-APR target.
 * MAX_APR campaigns have a uniform per-second budget: top-ups cannot exceed the
 * funded rate at current vault TVL and reward-token price. Missing metadata leaves
 * the reported yield intact. Rates remain fractional and are not compounded.
 * Underlying LEND incentives are already passed through by HOLD campaigns and must
 * not be added again. This does not change OptimizerReader's raw/native APY model.
 */
export function getVaultApyBreakdown({
    vaultAddress, chainId, nativeApy, totalAssetsUsd, opportunities, campaigns = [],
    accountAddress, nowTimestamp = Math.floor(Date.now() / 1000),
}: {
    vaultAddress: string;
    chainId: number;
    nativeApy: Decimal.Value;
    totalAssetsUsd?: Decimal.Value | undefined;
    opportunities: MerklOpportunity[];
    campaigns?: MerklCampaign[] | undefined;
    accountAddress?: string | null | undefined;
    nowTimestamp?: number;
}): VaultApyBreakdown {
    const eligibleOpportunities = vaultOpportunities(opportunities, vaultAddress, chainId);
    const rewards = new Map<string, VaultRewardRate>();
    const primaryRates = new Map<string, Decimal>();
    const addReward = (address: string, symbol: string, apy: Decimal, opportunity: MerklOpportunity) => {
        if (!apy.gt(0)) return;
        const rewardKey = key(address) || key(symbol) || 'rewards';
        const existing = rewards.get(rewardKey);
        if (existing) {
            existing.apy = existing.apy.add(apy);
            if (apy.gt(primaryRates.get(rewardKey)!)) {
                existing.opportunity = opportunity;
                primaryRates.set(rewardKey, apy);
            }
        } else {
            rewards.set(rewardKey, { address, symbol: symbol || 'Rewards', apy, opportunity });
            primaryRates.set(rewardKey, apy);
        }
    };

    let reportedMerklApy = new Decimal(0);
    for (const opportunity of eligibleOpportunities) {
        const rate = nonnegative(opportunity.apr).div(100);
        reportedMerklApy = reportedMerklApy.add(rate);
        const breakdowns = opportunity.rewardsRecord?.breakdowns ?? [];
        const grouped = new Map<string, { address: string; symbol: string; value: Decimal }>();
        for (const reward of breakdowns) {
            const rewardKey = key(reward.token.address) || key(reward.token.symbol) || 'rewards';
            const existing = grouped.get(rewardKey);
            if (existing) existing.value = existing.value.add(nonnegative(reward.value));
            else grouped.set(rewardKey, {
                address: reward.token.address ?? '', symbol: reward.token.symbol ?? '', value: nonnegative(reward.value),
            });
        }
        const entries = Array.from(grouped.values());
        const dollarTotal = entries.reduce((sum, reward) => sum.add(reward.value), new Decimal(0));
        if (!entries.length) {
            addReward('', 'Rewards', rate, opportunity);
        } else {
            let allocated = new Decimal(0);
            entries.forEach((reward, index) => {
                const weight = dollarTotal.gt(0) ? reward.value.div(dollarTotal) : new Decimal(1).div(entries.length);
                const rewardRate = index === entries.length - 1 ? rate.sub(allocated) : rate.mul(weight);
                allocated = allocated.add(rewardRate);
                addReward(reward.address, reward.symbol, rewardRate, opportunity);
            });
        }
    }

    const native = nonnegative(nativeApy);
    let merklApy = reportedMerklApy;
    let campaignTargetApy: Decimal | undefined;
    const tvl = nonnegative(totalAssetsUsd);
    const seenCampaigns = new Set<string>();
    for (const campaign of campaigns) {
        const config = campaign.targetAprConfig;
        if (!config || campaign.distributionType !== TARGET_DISTRIBUTION || config.mode !== 'MAX_APR') continue;
        if (seenCampaigns.has(campaign.campaignId)) continue;
        seenCampaigns.add(campaign.campaignId);
        if (key(config.targetToken) !== key(vaultAddress) ||
            campaign.computeChainId !== chainId || campaign.distributionChainId !== chainId ||
            campaign.chain.id !== chainId || campaign.rewardToken.chainId !== chainId) continue;
        if (campaign.startTimestamp == null || campaign.endTimestamp == null ||
            !Number.isFinite(nowTimestamp) || nowTimestamp < campaign.startTimestamp || nowTimestamp >= campaign.endTimestamp) continue;
        const account = key(accountAddress);
        if (config.whitelist.length && (!account || !config.whitelist.some((address) => key(address) === account))) continue;
        if (account && config.blacklist.some((address) => key(address) === account)) continue;

        const opportunity = eligibleOpportunities.find((row) =>
            row.id === campaign.opportunityId && row.id != null &&
            key(row.identifier) === key(vaultAddress) &&
            row.rewardsRecord?.breakdowns?.some((reward) =>
                reward.distributionType === TARGET_DISTRIBUTION &&
                (reward.onChainCampaignId === campaign.campaignId || reward.campaignId === campaign.id) &&
                key(reward.token.address) === key(campaign.rewardToken.address)));
        // Use the matching APR record, not daily reward dollar amounts, to avoid
        // counting the campaign's already-reported rewards twice against its cap.
        const reportedCampaign = opportunity?.aprRecord?.breakdowns.find((row) =>
            row.identifier === campaign.campaignId || row.identifier === campaign.id);
        if (!opportunity || !reportedCampaign || !tvl.gt(0)) continue;
        const price = nonnegative(campaign.rewardToken.price);
        const decimals = campaign.rewardToken.decimals;
        if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 255 || !price.gt(0)) continue;
        const budget = nonnegative(campaign.amount).div(new Decimal(10).pow(decimals));
        const duration = campaign.endTimestamp - campaign.startTimestamp;
        if (duration <= 0) continue;
        const fundedRate = budget.mul(price).mul(YEAR_SECONDS).div(duration).div(tvl);
        const availableTopUp = Decimal.max(0, fundedRate.sub(nonnegative(reportedCampaign.value).div(100)));
        const target = nonnegative(config.targetApr);
        const shortfall = Decimal.max(0, target.sub(native).sub(merklApy));
        const topUp = Decimal.min(shortfall, availableTopUp);
        if (!topUp.gt(0)) continue;
        addReward(campaign.rewardToken.address, campaign.rewardToken.symbol, topUp, opportunity);
        merklApy = merklApy.add(topUp);
        campaignTargetApy = Decimal.max(campaignTargetApy ?? 0, target);
    }

    return {
        nativeApy: native,
        reportedMerklApy,
        merklApy,
        totalApy: native.add(merklApy),
        rewards: Array.from(rewards.values()),
        ...(campaignTargetApy ? { campaignTargetApy } : {}),
    };
}
