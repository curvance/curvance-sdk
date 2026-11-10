import assert from 'node:assert/strict';
import test from 'node:test';
import Decimal from 'decimal.js';
import fixture from './fixtures/hyausd-target-apr.json';
import { fetchMerklOpportunities, type MerklOpportunity } from '../src/integrations/merkl';
import { getVaultApyBreakdown } from '../src/integrations/vault-apy';

const TARGET = 'ERC4626_TARGET_APR_WITH_MERKL';
const VAULT = fixture.opportunity.identifier;
const END = Number(fixture.opportunity.earliestCampaignEnd);
const NOW = END - 120_000;
// The fixture is the raw Merkl row; this is the shape the SDK normalizes it to.
const opportunity: MerklOpportunity = { ...fixture.opportunity, earliestCampaignEnd: END };
const rows = opportunity.rewardsRecord!.breakdowns!;
const inputs = { vaultAddress: VAULT, chainId: 143, nativeApy: '0.05', opportunities: [opportunity], nowTimestamp: NOW };
const reportedRate = new Decimal(opportunity.apr).div(100);
const reported = new Decimal(inputs.nativeApy).add(reportedRate);
const withRows = (breakdowns: typeof rows): MerklOpportunity => ({
    ...opportunity, rewardsRecord: { ...opportunity.rewardsRecord, breakdowns },
});

test('live hyAUSD fixture reaches 10% with an exactly reconciled reward breakdown', () => {
    const result = getVaultApyBreakdown(inputs);
    assert.equal(result.totalApy.toString(), '0.1');
    assert.equal(result.nativeApy.toString(), inputs.nativeApy);
    assert.equal(result.rewards.length, 1);
    assert.equal(result.rewards[0]?.symbol, 'cWMON');
    assert.equal(result.rewards[0]?.apy.add(result.nativeApy).toString(), '0.1');
    assert.equal(result.reportedMerklApy.toString(), reportedRate.toString());
    assert.equal(result.campaignTargetApy?.toString(), '0.1');
    assert.equal(result.campaignEndTimestamp, END);
});

test('does not double count underlying LEND rewards or repeated opportunities', () => {
    const result = getVaultApyBreakdown({ ...inputs,
        opportunities: [opportunity, { ...opportunity }, { ...opportunity, id: 'lend', action: 'LEND', apr: 25 }],
    });
    assert.equal(result.totalApy.toString(), '0.1');
    assert.equal(result.reportedMerklApy.toString(), reportedRate.toString());
});

test('keeps higher reported yields, and does not add the whole 10% on top', () => {
    const result = getVaultApyBreakdown({ ...inputs, nativeApy: '0.11' });
    assert.equal(result.totalApy.toString(), new Decimal('0.11').add(reportedRate).toString());
    assert.equal(result.campaignTargetApy, undefined);
    assert.equal(result.campaignEndTimestamp, undefined);
});

test('caps the adjustment to the budget the target campaign has not yet paid out', () => {
    const result = getVaultApyBreakdown({ ...inputs, nativeApy: '0.04' });
    const target = rows.find((row) => row.distributionType === TARGET)!;
    const paid = rows.reduce((sum, row) => sum.add(row.value!), new Decimal(0));
    const headroom = reportedRate.mul(new Decimal(target.maxValue!).sub(target.value!)).div(paid);
    assert(result.totalApy.lt('0.1'));
    assert.equal(result.totalApy.toString(), new Decimal('0.04').add(reportedRate).add(headroom).toString());
    assert.equal(result.campaignTargetApy?.toString(), '0.1');
});

test('the funding cap depends on reward proportions, not on the reward token price', () => {
    const repriced = withRows(rows.map((row) => ({ ...row, value: row.value! * 1.57, maxValue: row.maxValue! * 1.57 })));
    const expected = getVaultApyBreakdown({ ...inputs, nativeApy: '0.04' }).totalApy;
    const result = getVaultApyBreakdown({ ...inputs, nativeApy: '0.04', opportunities: [repriced] });
    assert(result.totalApy.sub(expected).abs().lt('1e-15'));
});

test('expired, unconfirmed, ambiguous, or incomplete targets leave the reported yield intact', () => {
    const { status: _status, ...withoutStatus } = opportunity;
    const { maxApr: _maxApr, ...withoutTarget } = opportunity;
    const variants: Partial<typeof inputs>[] = [
        { nowTimestamp: END },
        { nowTimestamp: Number.NaN },
        { opportunities: [withoutStatus] },
        { opportunities: [withoutTarget] },
        { opportunities: [{ ...opportunity, maxApr: 0 }] },
        // Percentage points where a fraction is expected.
        { opportunities: [{ ...opportunity, maxApr: 10 }] },
        // The vault is only one of the opportunity's tokens.
        { opportunities: [{ ...opportunity, identifier: 'hyAUSD wrapper' }] },
        { opportunities: [withRows(rows.map((row) => ({ ...row, distributionType: 'DUTCH_AUCTION' })))] },
        // Another capped campaign could be the one `maxApr` describes.
        { opportunities: [withRows(rows.map((row) =>
            row.distributionType === TARGET ? row : { ...row, maxValue: row.value! + 1 }))] },
        { opportunities: [withRows(rows.map(({ maxValue: _maxValue, ...row }) => row))] },
        { opportunities: [withRows(rows.map((row) => ({ ...row, maxValue: row.value! })))] },
        { opportunities: [withRows(rows.map((row) => ({ ...row, value: 0 })))] },
    ];
    for (const [index, variant] of variants.entries()) {
        const result = getVaultApyBreakdown({ ...inputs, ...variant });
        assert.equal(result.totalApy.toString(), reported.toString(), `variant ${index}`);
        assert.equal(result.campaignTargetApy, undefined, `variant ${index}`);
        assert.equal(result.campaignEndTimestamp, undefined, `variant ${index}`);
    }
    assert.equal(getVaultApyBreakdown({ ...inputs, nowTimestamp: END - 1 }).totalApy.toString(), '0.1');
});

test('an opportunity without an end time still adjusts, and reports no end', () => {
    const { earliestCampaignEnd: _end, ...withoutEnd } = opportunity;
    const result = getVaultApyBreakdown({ ...inputs, opportunities: [withoutEnd] });
    assert.equal(result.totalApy.toString(), '0.1');
    assert.equal(result.campaignEndTimestamp, undefined);
});

test('rejects unrelated HOLD opportunities and preserves unlabelled reward rates alongside known tokens', () => {
    const result = getVaultApyBreakdown({ ...inputs, opportunities: [
        opportunity,
        { ...opportunity, id: 'other-chain', chainId: 1 },
        { ...opportunity, id: 'past', status: 'PAST' },
        { ...opportunity, id: 'other-vault', identifier: 'other', tokens: [] },
        { ...opportunity, id: 'unknown-reward', apr: 1, rewardsRecord: { breakdowns: [] } },
    ] });
    assert.equal(result.totalApy.toString(), reported.add('0.01').toString());
    assert.equal(result.campaignTargetApy, undefined);
    assert.equal(result.rewards.find((reward) => reward.symbol === 'Rewards')?.apy.toString(), '0.01');
    assert.equal(result.rewards.reduce((sum, reward) => sum.add(reward.apy), new Decimal(0)).toString(), result.merklApy.toString());
});

test('public API normalization keeps the target metadata from the one opportunities request', async (t) => {
    const originalFetch = globalThis.fetch;
    const requests: URL[] = [];
    globalThis.fetch = (async (input: any) => {
        requests.push(new URL(new URL(String(input)).searchParams.get('url')!));
        return { ok: true, json: async () => [
            fixture.opportunity,
            { ...fixture.opportunity, id: 'malformed', maxApr: '0.1', earliestCampaignEnd: 'soon' },
        ] } as Response;
    }) as typeof fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    const opportunities = await fetchMerklOpportunities({ chainId: 143, signal: new AbortController().signal });
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.pathname.endsWith('/opportunities'), true);
    const [normalized, malformed] = opportunities;
    assert.equal(normalized?.status, 'LIVE');
    assert.equal(normalized?.maxApr, 0.1);
    assert.equal(normalized?.earliestCampaignEnd, END);
    assert.equal(normalized?.rewardsRecord?.breakdowns?.find((row) => row.distributionType === TARGET)?.maxValue,
        rows.find((row) => row.distributionType === TARGET)!.maxValue);
    assert.equal(malformed?.maxApr, undefined);
    assert.equal(malformed?.earliestCampaignEnd, undefined);
    assert.equal(getVaultApyBreakdown({ ...inputs, opportunities: [normalized!] }).totalApy.toString(), '0.1');
});
