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
const paid = rows.reduce((sum, row) => sum.add(row.value!), new Decimal(0));
const targetRow = rows.find((row) => row.distributionType === TARGET)!;
// The part of the reported rate that does not come from the target campaign.
const otherRate = reportedRate.sub(reportedRate.mul(new Decimal(targetRow.value!).div(paid)));
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

test('clamps down to the target when the reported sum has drifted above it', () => {
    // Native yield has risen since Merkl set the campaign rate: the plain sum is about 10.2%.
    const result = getVaultApyBreakdown({ ...inputs, nativeApy: '0.055' });
    assert(new Decimal('0.055').add(reportedRate).gt('0.1'));
    assert.equal(result.totalApy.toString(), '0.1');
    assert.equal(result.reportedMerklApy.toString(), reportedRate.toString());
    assert.equal(result.merklApy.toString(), '0.045');
    assert.equal(result.rewards.length, 1);
    assert.equal(result.rewards[0]?.apy.toString(), '0.045');
    assert.equal(result.campaignTargetApy?.toString(), '0.1');
    assert.equal(result.campaignEndTimestamp, END);
});

test('shows native yield plus other rewards once they exceed the target without the campaign', () => {
    const result = getVaultApyBreakdown({ ...inputs, nativeApy: '0.11' });
    assert.equal(result.totalApy.toString(), new Decimal('0.11').add(otherRate).toString());
    assert.equal(result.rewards.length, 1);
    assert.equal(result.rewards[0]?.apy.toString(), otherRate.toString());
    // The campaign pays nothing at this native yield, so it is not presented as a target.
    assert.equal(result.campaignTargetApy, undefined);
    assert.equal(result.campaignEndTimestamp, undefined);
});

test('removes the reward row when the campaign was the only reward and pays nothing', () => {
    const result = getVaultApyBreakdown({ ...inputs, nativeApy: '0.11', opportunities: [withRows([targetRow])] });
    assert.equal(result.totalApy.toString(), '0.11');
    assert.equal(result.merklApy.toString(), '0');
    assert.deepEqual(result.rewards, []);
});

test('caps the campaign at the most its budget can pay', () => {
    const result = getVaultApyBreakdown({ ...inputs, nativeApy: '0.04' });
    const funded = reportedRate.mul(new Decimal(targetRow.maxValue!).div(paid));
    assert(result.totalApy.lt('0.1'));
    assert.equal(result.totalApy.toString(), new Decimal('0.04').add(otherRate).add(funded).toString());
    assert.equal(result.campaignTargetApy?.toString(), '0.1');
});

test('a campaign already paying its maximum cannot be raised, and still reads as a target', () => {
    for (const capped of [
        withRows(rows.map((row) => ({ ...row, maxValue: row.value! }))),
        withRows(rows.map(({ maxValue: _maxValue, ...row }) => row)),
    ]) {
        const result = getVaultApyBreakdown({ ...inputs, opportunities: [capped] });
        assert.equal(result.totalApy.toString(), reported.toString());
        assert.equal(result.campaignTargetApy?.toString(), '0.1');
    }
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
    // Only the extra 1% is counted on top of the fixture, and the campaign nets it off like any other reward.
    assert.equal(result.reportedMerklApy.toString(), reportedRate.add('0.01').toString());
    assert.equal(result.totalApy.toString(), '0.1');
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
