import assert from 'node:assert/strict';
import test from 'node:test';
import { Api } from '../src/classes/Api';
import { getContractAddresses } from '../src/helpers';
import { validateContractConfiguration } from '../src/contracts/registry';
import { setupChain } from '../src/setup';
import type { address } from '../src/types';
import { createBootStaticMarket, createBootDynamicMarket, createBootUserMarket, createDecimalsReadProvider, installSetupChainBootHarness } from './support/setup-chain-boot-harness';

function fixture() {
    return { schema_version: 1, chain_id: 143, revision: 'a'.repeat(64), contracts: getContractAddresses('monad-mainnet') as any };
}

test('registry accepts both seeded networks and preserves plugin/IRM mappings', () => {
    for (const [chain, chainId] of [['monad-mainnet', 143], ['arb-sepolia', 421614]] as const) {
        const result = validateContractConfiguration({ ...fixture(), chain_id: chainId, contracts: getContractAddresses(chain) }, chainId);
        assert.equal(Object.keys(result.contracts.markets).length, chainId === 143 ? 28 : 2);
    }
});

test('registry rejects invalid chain-level configuration and isolates malformed markets', () => {
    assert.throws(() => validateContractConfiguration(fixture(), 421614), /chain mismatch/);
    const partial = fixture();
    delete Object.values(partial.contracts.markets as Record<string, any>)[0].irms;
    assert.equal(Object.keys(validateContractConfiguration(partial, 143).contracts.markets).length, 27);
    const wrongRole = fixture();
    Object.values(wrongRole.contracts.markets as Record<string, any>)[0].plugins = { typoManager: wrongRole.contracts.CentralRegistry };
    assert.equal(Object.keys(validateContractConfiguration(wrongRole, 143).contracts.markets).length, 27);
    const zero = fixture(); zero.contracts.ProtocolReader = '0x' + '0'.repeat(40);
    assert.throws(() => validateContractConfiguration(zero, 143), /ProtocolReader/);
    const inherited = fixture();
    const inheritedMarket = Object.values(inherited.contracts.markets as Record<string, any>)[0];
    const addresses = Object.values(inheritedMarket.tokens);
    inheritedMarket.tokens = { constructor: addresses[0], B: addresses[1] };
    inheritedMarket.irms = { A: addresses[0], B: addresses[1] };
    assert.equal(Object.keys(validateContractConfiguration(inherited, 143).contracts.markets).length, 27);
});

test('registry transport uses the requested API and chain and fails closed on outage', async t => {
    let url = '';
    t.mock.method(globalThis, 'fetch', async (input: string) => { url = input; return new Response(JSON.stringify(fixture())); });
    const result = await Api.fetchContractConfiguration({ chain: 'monad-mainnet', api_url: 'https://api.example.test/' });
    assert.equal(url, 'https://api.example.test/contracts/143');
    assert.equal(result.revision, 'a'.repeat(64));
    t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 503 }));
    await assert.rejects(Api.fetchContractConfiguration({ chain: 'monad-mainnet', api_url: 'https://api.example.test' }), /503/);
});

test('registry cloning isolates caller mutations and accepts newly registered markets', () => {
    const input = fixture();
    const first = Object.values(input.contracts.markets as Record<string, any>)[0];
    input.contracts.markets.NewMarket = { ...first, address: '0x0000000000000000000000000000000000000999' };
    const result = validateContractConfiguration(input, 143);
    input.contracts.markets.NewMarket.address = 'corrupt';
    assert.equal((result.contracts.markets as any).NewMarket.address.toLowerCase(), '0x0000000000000000000000000000000000000999');
});

test('registry retries transient failures but never retries invalid configuration or permanent responses', async t => {
    for (const firstFailure of [429, 503, 'network'] as const) {
        let attempts = 0;
        t.mock.method(globalThis, 'fetch', async () => {
            if (++attempts === 1) {
                if (firstFailure === 'network') throw new TypeError('Connection reset');
                return new Response('', { status: firstFailure });
            }
            return new Response(JSON.stringify(fixture()));
        });
        await Api.fetchContractConfiguration({ chain: 'monad-mainnet', api_url: 'https://api.test' });
        assert.equal(attempts, 2);
    }
    for (const status of [400, 403, 404, 200]) {
        let attempts = 0;
        t.mock.method(globalThis, 'fetch', async () => { attempts++; return new Response('{}', { status }); });
        await assert.rejects(Api.fetchContractConfiguration({ chain: 'monad-mainnet', api_url: 'https://api.test' }));
        assert.equal(attempts, 1);
    }
    let attempts = 0;
    t.mock.method(globalThis, 'fetch', async () => { attempts++; return new Response('', { status: 503 }); });
    await assert.rejects(Api.fetchContractConfiguration({ chain: 'monad-mainnet', api_url: 'https://api.test' }), /503/);
    assert.equal(attempts, 3);
});

test('default SDK setup boots a newly registered market absent from its bundled JSON', async t => {
    const manager = '0x0000000000000000000000000000000000000777' as address;
    const token0 = '0x0000000000000000000000000000000000000778' as address;
    const token1 = '0x0000000000000000000000000000000000000779' as address;
    const plugin = '0x0000000000000000000000000000000000000780' as address;
    const contracts: any = getContractAddresses('arb-sepolia');
    contracts.markets = { 'New deployment': { address: manager, tokens: { A: token0, B: token1 }, irms: { A: token0, B: token1 }, plugins: { simplePositionManager: plugin } } };
    const envelope = { schema_version: 1, chain_id: 421614, revision: 'b'.repeat(64), contracts };
    t.mock.method(Api, 'fetchNativeYields', async () => []);
    const harness = installSetupChainBootHarness(t, {
        fetch: async url => {
            assert.equal(url, 'https://registry.test/contracts/421614');
            return new Response(JSON.stringify(envelope));
        },
        marketData: () => ({
            staticMarket: [createBootStaticMarket(manager, [{ cToken: token0, symbol: 'A' }, { cToken: token1, symbol: 'B' }])],
            dynamicMarket: [createBootDynamicMarket(manager, [token0, token1])],
            userData: { locks: [], markets: [createBootUserMarket(manager, [token0, token1])] },
        }),
    });
    const result = await setupChain('arb-sepolia', null, 'https://registry.test', { readProvider: createDecimalsReadProvider(421614n) as any });
    assert.equal(result.markets.length, 1);
    const market = result.markets[0];
    assert.ok(market);
    assert.equal(market.address.toLowerCase(), manager);
    assert.equal(market.plugins.simplePositionManager?.toLowerCase(), plugin);
    assert.equal(result.setupConfigSnapshot.contractRevision, 'b'.repeat(64));
    assert.deepEqual(harness.externalFetchCalls, ['https://registry.test/contracts/421614']);
});
