import assert from 'node:assert/strict';
import test from 'node:test';
import Decimal from 'decimal.js';
import fixture from './fixtures/hyausd-target-apr.json';
import { fetchMerklCampaignsBySymbol, fetchMerklOpportunities, type MerklCampaign, type MerklOpportunity } from '../src/integrations/merkl';
import { fetchMerklVaultCampaigns, getVaultApyBreakdown } from '../src/integrations/vault-apy';

const VAULT = fixture.opportunity.identifier;
const NOW = 1793916000;
const campaign: MerklCampaign = {
    ...fixture.campaign,
    targetAprConfig: {
        targetToken: VAULT, targetApr: 0.1, mode: 'MAX_APR', lookbackWindow: 259200,
        whitelist: [], blacklist: fixture.campaign.params.blacklist,
    },
};
const opportunity: MerklOpportunity = fixture.opportunity;
const inputs = {
    vaultAddress: VAULT, chainId: 143, nativeApy: '0.050677865021088',
    totalAssetsUsd: '11838632.283092', opportunities: [opportunity], campaigns: [campaign], nowTimestamp: NOW,
};
const reported = new Decimal(inputs.nativeApy).add(new Decimal(opportunity.apr).div(100));

test('live hyAUSD fixture reaches 10% with an exactly reconciled reward breakdown', () => {
    const result = getVaultApyBreakdown(inputs);
    assert.equal(result.totalApy.toString(), '0.1');
    assert.equal(result.nativeApy.toString(), inputs.nativeApy);
    assert.equal(result.rewards.length, 1);
    assert.equal(result.rewards[0]?.symbol, 'cWMON');
    assert.equal(result.rewards[0]?.apy.add(result.nativeApy).toString(), '0.1');
    assert.equal(result.reportedMerklApy.toString(), new Decimal(opportunity.apr).div(100).toString());
    assert.equal(result.campaignTargetApy?.toString(), '0.1');
});

test('does not double count campaigns, underlying LEND rewards, or repeated opportunities', () => {
    const result = getVaultApyBreakdown({ ...inputs,
        opportunities: [opportunity, { ...opportunity }, { ...opportunity, id: 'lend', action: 'LEND', apr: 25 }],
        campaigns: [campaign, { ...campaign }],
    });
    assert.equal(result.totalApy.toString(), '0.1');
    assert.equal(result.reportedMerklApy.toString(), new Decimal(opportunity.apr).div(100).toString());
});

test('keeps higher reported yields, and does not add the whole 10% on top', () => {
    const result = getVaultApyBreakdown({ ...inputs, nativeApy: '0.11' });
    assert.equal(result.totalApy.toString(), new Decimal('0.11').add(new Decimal(opportunity.apr).div(100)).toString());
    assert.equal(result.campaignTargetApy, undefined);
});

test('caps the adjustment to the funded rate when TVL cannot sustain the target', () => {
    const result = getVaultApyBreakdown({ ...inputs, nativeApy: '0.04' });
    const capacity = new Decimal(campaign.amount!).div(1e18).mul(campaign.rewardToken.price!)
        .mul(31536000).div(campaign.endTimestamp! - campaign.startTimestamp!).div(inputs.totalAssetsUsd);
    const ownApr = opportunity.aprRecord!.breakdowns[0]!.value;
    const expected = new Decimal('0.04').add(new Decimal(opportunity.apr).div(100)).add(capacity).sub(new Decimal(ownApr).div(100));
    assert(result.totalApy.lt('0.1'));
    assert(result.totalApy.sub(expected).abs().lt('1e-18'));
});

test('expired, future, ineligible, mismatched, or incomplete campaigns cannot set a floor', () => {
    const variants: Partial<typeof inputs & { accountAddress: string }>[] = [
        { nowTimestamp: campaign.startTimestamp! - 1 },
        { nowTimestamp: campaign.endTimestamp! },
        { accountAddress: campaign.targetAprConfig!.blacklist[0]! },
        { campaigns: [] },
        { totalAssetsUsd: '0' },
        { campaigns: [{ ...campaign, amount: '0' }] },
        { campaigns: [{ ...campaign, rewardToken: { ...campaign.rewardToken, price: 0 } }] },
        { campaigns: [{ ...campaign, computeChainId: 1 }] },
        { campaigns: [{ ...campaign, opportunityId: 'another-opportunity' }] },
        { campaigns: [{ ...campaign, targetAprConfig: { ...campaign.targetAprConfig!, targetToken: '0xother' } }] },
        { campaigns: [{ ...campaign, targetAprConfig: { ...campaign.targetAprConfig!, whitelist: ['0xsomeone'] } }] },
        { opportunities: [{ ...opportunity, aprRecord: { breakdowns: [] } }] },
    ];
    for (const variant of variants) {
        const result = getVaultApyBreakdown({ ...inputs, ...variant });
        assert.equal(result.totalApy.toString(), reported.toString(), JSON.stringify(variant));
        assert.equal(result.campaignTargetApy, undefined);
    }
    assert.equal(getVaultApyBreakdown({ ...inputs, nowTimestamp: campaign.startTimestamp! }).totalApy.toString(), '0.1');
});

test('rejects unrelated HOLD opportunities and preserves unlabelled reward rates alongside known tokens', () => {
    const result = getVaultApyBreakdown({ ...inputs, campaigns: [], opportunities: [
        opportunity,
        { ...opportunity, id: 'other-chain', chainId: 1 },
        { ...opportunity, id: 'past', status: 'PAST' },
        { ...opportunity, id: 'other-vault', identifier: 'other', tokens: [] },
        { ...opportunity, id: 'unknown-reward', apr: 1, rewardsRecord: { breakdowns: [] } },
    ] });
    assert.equal(result.totalApy.toString(), reported.add('0.01').toString());
    assert.equal(result.rewards.find((reward) => reward.symbol === 'Rewards')?.apy.toString(), '0.01');
    assert.equal(result.rewards.reduce((sum, reward) => sum.add(reward.apy), new Decimal(0)).toString(), result.merklApy.toString());
});

test('public API normalization retains the target metadata and discovery fetches cWMON, not hyAUSD', async (t) => {
    const originalFetch = globalThis.fetch;
    const requests: URL[] = [];
    globalThis.fetch = (async (input: any) => {
        const url = new URL(new URL(String(input)).searchParams.get('url')!);
        requests.push(url);
        return { ok: true, json: async () => url.pathname.endsWith('opportunities') ? [fixture.opportunity] : [fixture.campaign] } as Response;
    }) as typeof fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    const opportunities = await fetchMerklOpportunities({ chainId: 143, signal: new AbortController().signal });
    const campaigns = await fetchMerklVaultCampaigns({ vaultAddress: VAULT, chainId: 143, opportunities });
    assert.equal(requests.length, 2);
    assert.equal(requests[1]?.searchParams.get('tokenSymbol'), 'cWMON');
    // All Curvance campaigns pay cWMON, so only live rows on a full page keep the target reachable.
    assert.equal(requests[1]?.searchParams.get('status'), 'LIVE');
    assert.equal(requests[1]?.searchParams.get('items'), '100');
    assert.equal(campaigns[0]?.targetAprConfig?.targetApr, 0.1);
    assert.equal(campaigns[0]?.endTimestamp, campaign.endTimestamp);
    assert.equal(getVaultApyBreakdown({ ...inputs, opportunities, campaigns }).totalApy.toString(), '0.1');
    await fetchMerklVaultCampaigns({ vaultAddress: VAULT, chainId: 143, opportunities: [] });
    assert.equal(requests.length, 2);
});

test('unsupported or malformed campaign settings never become an active target', async (t) => {
    const originalFetch = globalThis.fetch;
    const params = fixture.campaign.params;
    const method = params.distributionMethodParameters;
    const settings = method.distributionSettings;
    const variants = [
        { ...params, hooks: ['custom-eligibility'] },
        { ...params, whitelist: ['invalid'] },
        { ...params, targetToken: '0xother' },
        ...[{ targetAPR: 'NaN' }, { targetAPR: '-1' }, { mode: 'UNKNOWN' }, { rewardTokenPricing: false }].map((override) => ({
            ...params, distributionMethodParameters: { ...method, distributionSettings: { ...settings, ...override } },
        })),
    ];
    globalThis.fetch = (async () => ({ ok: true, json: async () => variants.map((params) => ({ ...fixture.campaign, params })) } as Response)) as typeof fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    const rows = await fetchMerklCampaignsBySymbol({ tokenSymbol: 'cWMON', chainId: 143 });
    assert.equal(rows.length, variants.length);
    assert(rows.every((row) => row.targetAprConfig === undefined));
});
