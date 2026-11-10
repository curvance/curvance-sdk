import Decimal from 'decimal.js';
import {
    filterMerklOpportunitiesByChain,
    type MerklOpportunity,
    type MerklRewardRecordBreakdown,
} from './merkl';

const TARGET_DISTRIBUTION = 'ERC4626_TARGET_APR_WITH_MERKL';
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
    /** Present only when a live, funded target campaign increases the headline. */
    campaignTargetApy?: Decimal;
    /** Unix seconds after which the increase no longer applies. Set with `campaignTargetApy` when Merkl reports it. */
    campaignEndTimestamp?: number;
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

function nonnegative(value: Decimal.Value | undefined): Decimal {
    try {
        const number = new Decimal(value ?? 0);
        return number.isFinite() && number.gte(0) ? number : new Decimal(0);
    } catch {
        return new Decimal(0);
    }
}

/** Daily reward dollars a campaign could still add before reaching its cap. */
function unusedBudget(reward: MerklRewardRecordBreakdown): Decimal {
    return Decimal.max(0, nonnegative(reward.maxValue).sub(nonnegative(reward.value)));
}

/**
 * Current native yield plus HOLD rewards, adjusted toward an active total-APR target.
 *
 * A target campaign pays `max(target - vault yield - other Merkl rewards, 0)`, where Merkl
 * measures vault yield over a lookback window. Its reported rate therefore trails the
 * current native yield. The adjustment closes that gap, limited to the share of the
 * campaign's budget that Merkl reports as not yet paid out. Everything is read from the
 * vault's own opportunity, so no campaign request is made. Missing or ambiguous metadata
 * leaves the reported yield intact. Rates remain fractional and are not compounded.
 * Underlying LEND incentives are already passed through by HOLD campaigns and must
 * not be added again. This does not change OptimizerReader's raw/native APY model.
 */
export function getVaultApyBreakdown({
    vaultAddress, chainId, nativeApy, opportunities, nowTimestamp = Math.floor(Date.now() / 1000),
}: {
    vaultAddress: string;
    chainId: number;
    nativeApy: Decimal.Value;
    opportunities: MerklOpportunity[];
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
    let campaignEndTimestamp: number | undefined;
    for (const opportunity of eligibleOpportunities) {
        if (opportunity.status !== 'LIVE' || key(opportunity.identifier) !== key(vaultAddress)) continue;
        const end = opportunity.earliestCampaignEnd;
        if (end != null && !(nowTimestamp < end)) continue;
        const breakdowns = opportunity.rewardsRecord?.breakdowns ?? [];
        const targetRewards = breakdowns.filter((reward) => reward.distributionType === TARGET_DISTRIBUTION);
        const targetReward = targetRewards[0];
        if (!targetReward) continue;
        // `maxApr` describes whichever campaign is capped. Only trust it as this target when
        // no other campaign on the opportunity has budget held back by a cap of its own.
        if (breakdowns.some((reward) =>
            reward.distributionType !== TARGET_DISTRIBUTION && unusedBudget(reward).gt(0))) continue;
        // A fraction; a value above 1 would mean the unit changed to percentage points.
        const target = nonnegative(opportunity.maxApr);
        if (!target.gt(0) || target.gt(1)) continue;
        // Reward dollars are used only as proportions of the reported rate, so the
        // result does not depend on the reward token's price or on a separate TVL figure.
        const paid = breakdowns.reduce((sum, reward) => sum.add(nonnegative(reward.value)), new Decimal(0));
        if (!paid.gt(0)) continue;
        const unused = targetRewards.reduce((sum, reward) => sum.add(unusedBudget(reward)), new Decimal(0));
        const fundedHeadroom = nonnegative(opportunity.apr).div(100).mul(unused).div(paid);
        const shortfall = Decimal.max(0, target.sub(native).sub(merklApy));
        const topUp = Decimal.min(shortfall, fundedHeadroom);
        if (!topUp.gt(0)) continue;
        addReward(targetReward.token.address ?? '', targetReward.token.symbol ?? '', topUp, opportunity);
        merklApy = merklApy.add(topUp);
        campaignTargetApy = Decimal.max(campaignTargetApy ?? 0, target);
        if (end != null) campaignEndTimestamp = Math.min(campaignEndTimestamp ?? end, end);
    }

    return {
        nativeApy: native,
        reportedMerklApy,
        merklApy,
        totalApy: native.add(merklApy),
        rewards: Array.from(rewards.values()),
        ...(campaignTargetApy ? { campaignTargetApy } : {}),
        ...(campaignEndTimestamp != null ? { campaignEndTimestamp } : {}),
    };
}
