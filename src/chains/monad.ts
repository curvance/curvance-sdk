import { address } from "../types";
import { KyberSwap } from "../classes/DexAggregators/KyberSwap";
import { EMPTY_ADDRESS } from "../helpers";
import { ChainConfig } from ".";
import { createChainFallbackProviders, createChainPrimaryProvider, getChainRpcConfig } from "./rpc";
import { MONAD_KYBER_SWAP_SERVICE } from "./services";

const kyberSwap = MONAD_KYBER_SWAP_SERVICE;

export const mainnet: ChainConfig = {
    chainId: 143,
    environment: "production-mainnet",
    services: {
        curvanceApi: {
            rewardsSlug: "monad-mainnet",
            rewardChainAliases: ["monad"],
            nativeYieldSlug: "monad",
            suppressedNativeYieldSymbols: ["USDC"],
        },
        dexAggregators: {
            kyberSwap,
        },
    },
    dexAgg: new KyberSwap(EMPTY_ADDRESS, kyberSwap.router, kyberSwap.chainSlug, kyberSwap.apiBase),
    rpc: getChainRpcConfig("monad-mainnet"),
    provider: createChainPrimaryProvider("monad-mainnet"),
    fallbackProviders: createChainFallbackProviders("monad-mainnet"),
    native_symbol: 'MON',
    native_name: 'Monad',
    wrapped_native: "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A" as address,
    native_vaults: [
        { name: "aprMON", contract: "0x0c65A0BC65a5D819235B71F554D210D3F80E0852" as address },
        { name: "shMON", contract: "0x1B68626dCa36c7fE922fD2d55E4f631d962dE19c" as address },
    ],
    vaults: [
        { name: "sAUSD", contract: "0xD793c04B87386A6bb84ee61D98e0065FdE7fdA5E" as address, underlying: "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a" as address }
    ],
    excluded_zap_symbols: [
        'eBTC',
        'vUSD',
        'ezETH',
        'YZM',
        'wsrUSD',
        'sAUSD',
        'earnAUSD',
        'hyAUSD',
        'aguaUSDCgc',
        // Illiquid secondary-market routes; direct token actions remain available.
        'muBOND',
        'loAZND',
        'PT-AUSD-8OCT2026',
        'PT-earnAUSD-8OCT2026',
        'PT-AUSD-17DEC2026',
        'PT-USDat-14JAN2027',
        'aprMON'
    ],
    excluded_zap_addresses: [
        "0xaD663aC84052b52BE4ed1b27BA416505e84a00Bf" as address,
        "0x2ABc42250154752273a4560e875c858623F83ecC" as address,
        "0x336D414754967C6682B5A665C7DAF6F1409E63e8" as address, // muBOND
        "0x9c82eB49B51F7Dc61e22Ff347931CA32aDc6cd90" as address, // loAZND
        "0x9FC74f8Ed616B5BaF52a170caa97d6d3898602d1" as address, // PT-AUSD-8OCT2026
        "0xDaf216939826AcABA0C2312F7E30A890213845CD" as address, // PT-earnAUSD-8OCT2026
        "0x8B562578b2f9Aa8C14cCda3c5d6CBCEaD3B06a57" as address, // PT-AUSD-17DEC2026
        "0xa08a69ab9dd3b04d0992bc7afb2c0b907bbdc147" as address, // PT-USDat-14JAN2027
        "0x0c65A0BC65a5D819235B71F554D210D3F80E0852" as address, // aprMON
    ],
};
