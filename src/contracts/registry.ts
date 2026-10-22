import { getContractAddresses } from '../helpers';
import { validateAddress } from '../validation';

export interface ContractConfiguration {
    schema_version: 1;
    chain_id: number;
    revision: string;
    contracts: ReturnType<typeof getContractAddresses>;
}

function record(value: unknown, context: string): Record<string, unknown> {
    if (value == null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${context}`);
    return value as Record<string, unknown>;
}

/** Validate and clone a complete chain snapshot before it can affect transaction addresses. */
export function validateContractConfiguration(value: unknown, chainId: number): ContractConfiguration {
    const envelope = record(value, 'contract configuration');
    if (envelope.schema_version !== 1 || envelope.chain_id !== chainId) throw new Error('Contract configuration version or chain mismatch');
    if (typeof envelope.revision !== 'string' || !/^[a-f0-9]{64}$/.test(envelope.revision)) throw new Error('Invalid configuration revision');
    const config = record(envelope.contracts, 'contracts');
    const address = (value: unknown, context: string) => {
        if (typeof value !== 'string' || /^0x0{40}$/i.test(value)) throw new Error(`Invalid ${context}`);
        return validateAddress(value, context);
    };
    const addressMap = (value: unknown, context: string) => Object.fromEntries(
        Object.entries(record(value, context)).map(([key, value]) => [key, address(value, `${context}.${key}`)]),
    );
    const result: Record<string, unknown> = Object.create(null);
    for (const [key, value] of Object.entries(config)) {
        if (key === 'markets') continue;
        result[key] = ['adaptors', 'calldataCheckers', 'zappers', 'Optimizers'].includes(key)
            ? addressMap(value, key) : address(value, key);
    }
    for (const key of ['CentralRegistry', 'OracleManager', 'ProtocolReader']) address(result[key], key);
    for (const key of ['adaptors', 'calldataCheckers', 'zappers']) result[key] ??= {};
    const seen = new Set<string>();
    result.markets = Object.fromEntries(Object.entries(record(config.markets, 'markets')).flatMap(([name, raw]) => {
      try {
        if (!name.trim() || name.length > 255) throw new Error('Invalid market name');
        const market = record(raw, `market ${name}`);
        const manager = address(market.address, `market ${name}`);
        if (seen.has(manager.toLowerCase())) throw new Error('Duplicate market address in configuration');
        const tokens = addressMap(market.tokens, `${name}.tokens`);
        const irms = addressMap(market.irms, `${name}.irms`);
        if (Object.keys(tokens).length !== 2 || new Set(Object.values(tokens)).size !== 2
            || Object.keys(irms).length !== 2 || Object.keys(tokens).some(key => !Object.prototype.hasOwnProperty.call(irms, key))) {
            throw new Error(`Incomplete token/IRM associations for ${name}`);
        }
        const plugins = addressMap(market.plugins ?? {}, `${name}.plugins`);
        if (Object.keys(plugins).some(key => !['simplePositionManager', 'vaultPositionManager', 'nativeVaultPositionManager'].includes(key))) throw new Error(`Unsupported plugin role for ${name}`);
        seen.add(manager.toLowerCase());
        return [[name, { address: manager, tokens, irms, plugins }]];
      } catch {
        // A malformed market cannot redirect transactions or take healthy markets offline.
        console.warn('Ignoring an invalid market in the contract registry:', JSON.stringify(name));
        return [];
      }
    }));
    if (result.Optimizers && Object.keys(result.Optimizers).length && !result.OptimizerReader) throw new Error('OptimizerReader is required for optimizers');
    return { schema_version: 1, chain_id: chainId, revision: envelope.revision, contracts: result as unknown as ReturnType<typeof getContractAddresses> };
}
